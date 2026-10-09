// Package transfer implements Markdown export and async zip import (conventions §8).
//
// Export mirrors the page tree as folders of `.md` files with YAML frontmatter, rewrites
// `[[hostidian:<id>|title]]` page links to `[[Current Title]]` and `/api/files/<id>` references to a
// relative `attachments/…` path. Import parses an Obsidian-compatible zip, resolves `[[Title]]` links
// and `![[asset]]` embeds, creates the page tree and hands each page's Markdown to the collab
// service so the Y.Doc is built.
package transfer

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"roci.dev/fracdex"

	"hostidian/backend/internal/apperr"
	"hostidian/backend/internal/collabclient"
	"hostidian/backend/internal/db"
	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/files"
	"hostidian/backend/internal/httpapi/gen"
	"hostidian/backend/internal/perm"
)

const (
	importZipMaxEntries = 20000
	// importMaxEntryBytes caps any single decompressed zip entry; larger entries are skipped with a warning.
	importMaxEntryBytes = 64 << 20
	// importMaxTotalBytes caps the sum of the declared decompressed sizes (disk/zip-bomb guard).
	importMaxTotalBytes = 4 << 30
	// importMaxMarkdownBytes caps the Markdown held in memory at once.
	importMaxMarkdownBytes = 256 << 20
)

// Service holds the export/import use cases.
type Service struct {
	pool    *pgxpool.Pool
	q       *sqlcgen.Queries
	broker  interface{}
	log     *slog.Logger
	collab  collabclient.Importer
	files   *files.Service
	dataDir string
	now     func() time.Time
}

// Options configure NewService.
type Options struct {
	Pool    *pgxpool.Pool
	Q       *sqlcgen.Queries
	Log     *slog.Logger
	Collab  collabclient.Importer
	Files   *files.Service
	DataDir string
	Now     func() time.Time
}

func NewService(o Options) *Service {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Collab == nil {
		o.Collab = collabclient.Noop{}
	}
	return &Service{pool: o.Pool, q: o.Q, log: o.Log, collab: o.Collab, files: o.Files, dataDir: o.DataDir, now: o.Now}
}

// ================================================================ export

type exportPage struct {
	row      sqlcgen.Page
	markdown string
}

// ExportPage returns a zip of the page subtree the caller can view. Needs `view`.
func (s *Service) ExportPage(ctx context.Context, userID, pageID uuid.UUID) (string, []byte, error) {
	acc, err := perm.Require(ctx, s.q, userID, pageID, perm.View)
	if err != nil {
		return "", nil, err
	}
	rows, err := s.q.ListSubtreeForExport(ctx, sqlcgen.ListSubtreeForExportParams{
		WorkspaceID: acc.WorkspaceID, UserID: userID, RootID: pageID,
	})
	if err != nil {
		return "", nil, fmt.Errorf("list subtree: %w", err)
	}
	pages := make([]exportPage, 0, len(rows))
	for _, r := range rows {
		pages = append(pages, exportPage{row: r.Page, markdown: r.Markdown})
	}
	name := "Untitled"
	if len(pages) > 0 {
		name = pages[0].row.Title
	}
	return s.buildZip(ctx, pages, safeName(name))
}

// ExportWorkspace returns a zip of every page the caller can view. Needs workspace membership.
func (s *Service) ExportWorkspace(ctx context.Context, userID, workspaceID uuid.UUID) (string, []byte, error) {
	ws, err := s.q.GetWorkspace(ctx, workspaceID)
	if err != nil {
		if db.IsNotFound(err) {
			return "", nil, perm.ErrWorkspaceNotFound
		}
		return "", nil, fmt.Errorf("get workspace: %w", err)
	}
	if _, err := perm.RequireMember(ctx, s.q, workspaceID, userID); err != nil {
		return "", nil, err
	}
	rows, err := s.q.ListWorkspaceForExport(ctx, sqlcgen.ListWorkspaceForExportParams{WorkspaceID: workspaceID, UserID: userID})
	if err != nil {
		return "", nil, fmt.Errorf("list workspace pages: %w", err)
	}
	pages := make([]exportPage, 0, len(rows))
	for _, r := range rows {
		pages = append(pages, exportPage{row: r.Page, markdown: r.Markdown})
	}
	return s.buildZip(ctx, pages, safeName(ws.Name))
}

var (
	storedLinkRe = regexp.MustCompile(`\[\[hostidian:([0-9a-fA-F-]{36})\\?\|((?:\\.|[^\]\\])*)\]\]`)
	fileURLRe    = regexp.MustCompile(`/api/files/([0-9a-fA-F-]{36})`)
)

func (s *Service) buildZip(ctx context.Context, pages []exportPage, baseName string) (string, []byte, error) {
	byID := make(map[uuid.UUID]*exportPage, len(pages))
	children := map[uuid.UUID][]*exportPage{}
	var roots []*exportPage
	for i := range pages {
		p := &pages[i]
		byID[p.row.ID] = p
		if p.row.ParentID != nil {
			if _, ok := byID[*p.row.ParentID]; ok {
				children[*p.row.ParentID] = append(children[*p.row.ParentID], p)
				continue
			}
		}
		roots = append(roots, p)
	}
	// Children are appended in DB order (position); roots too.
	sort.SliceStable(roots, func(i, j int) bool {
		return roots[i].row.Position < roots[j].row.Position
	})

	// Assign a unique, filesystem-safe title per page (deduplicated among siblings).
	safe := map[uuid.UUID]string{}
	var assign func(list []*exportPage)
	assign = func(list []*exportPage) {
		used := map[string]int{}
		for _, p := range list {
			base := emptyTitle(p.row.Title)
			name := safeName(base)
			if n, ok := used[name]; ok {
				used[name] = n + 1
				name = fmt.Sprintf("%s (%d)", name, n+1)
			} else {
				used[name] = 1
			}
			safe[p.row.ID] = name
		}
		for _, p := range list {
			assign(children[p.row.ID])
		}
	}
	assign(roots)

	// Directory path (inside the zip) that holds each page's own file.
	dir := map[uuid.UUID]string{}
	var walk func(list []*exportPage, parentDir string)
	walk = func(list []*exportPage, parentDir string) {
		for _, p := range list {
			dir[p.row.ID] = parentDir
			walk(children[p.row.ID], parentDir+safe[p.row.ID]+"/")
		}
	}
	walk(roots, "")

	// Wiki path (titles from root to page) used when rewriting links.
	wiki := map[uuid.UUID]string{}
	var wikiWalk func(list []*exportPage, prefix string)
	wikiWalk = func(list []*exportPage, prefix string) {
		for _, p := range list {
			full := safe[p.row.ID]
			if prefix != "" {
				full = prefix + "/" + safe[p.row.ID]
			}
			wiki[p.row.ID] = full
			wikiWalk(children[p.row.ID], full)
		}
	}
	wikiWalk(roots, "")

	// Collect referenced attachments and load their bytes.
	attPath := map[uuid.UUID]string{}
	for i := range pages {
		for _, m := range fileURLRe.FindAllStringSubmatch(pages[i].markdown, -1) {
			id, err := uuid.Parse(m[1])
			if err != nil {
				continue
			}
			if _, ok := attPath[id]; ok {
				continue
			}
			att, err := s.q.GetAttachment(ctx, id)
			if err != nil {
				continue
			}
			idHex := strings.ReplaceAll(att.ID.String(), "-", "")
			attPath[id] = "attachments/" + idHex[:8] + "-" + safeName(att.Filename)
		}
	}

	buf := new(bytes.Buffer)
	zw := zip.NewWriter(buf)

	for i := range pages {
		p := &pages[i]
		body := p.markdown
		body = s.rewriteStoredLinks(body, wiki)
		body = s.rewriteFileURLs(body, attPath, dir[p.row.ID])
		content := frontmatter(p.row) + body
		name := dir[p.row.ID] + safe[p.row.ID] + ".md"
		if err := writeZip(zw, name, []byte(content)); err != nil {
			return "", nil, err
		}
	}
	for id, zp := range attPath {
		att, err := s.q.GetAttachment(ctx, id)
		if err != nil {
			continue
		}
		abs, err := s.files.AbsPath(att.StorageKey)
		if err != nil {
			continue
		}
		data, err := os.ReadFile(abs)
		if err != nil {
			continue
		}
		if err := writeZip(zw, zp, data); err != nil {
			return "", nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return "", nil, fmt.Errorf("close zip: %w", err)
	}
	return baseName + ".zip", buf.Bytes(), nil
}

func (s *Service) rewriteStoredLinks(md string, wiki map[uuid.UUID]string) string {
	return storedLinkRe.ReplaceAllStringFunc(md, func(match string) string {
		sub := storedLinkRe.FindStringSubmatch(match)
		id, err := uuid.Parse(sub[1])
		if err != nil {
			return match
		}
		if target, ok := wiki[id]; ok {
			return "[[" + target + "]]"
		}
		return "[[" + unescapeTitle(sub[2]) + "]]"
	})
}

func (s *Service) rewriteFileURLs(md string, attPath map[uuid.UUID]string, pageDir string) string {
	depth := strings.Count(pageDir, "/")
	prefix := strings.Repeat("../", depth)
	return fileURLRe.ReplaceAllStringFunc(md, func(match string) string {
		sub := fileURLRe.FindStringSubmatch(match)
		id, err := uuid.Parse(sub[1])
		if err != nil {
			return match
		}
		if zp, ok := attPath[id]; ok {
			return prefix + zp
		}
		return match
	})
}

func frontmatter(p sqlcgen.Page) string {
	var b strings.Builder
	b.WriteString("---\n")
	fmt.Fprintf(&b, "id: %s\n", p.ID)
	fmt.Fprintf(&b, "title: %s\n", yamlString(p.Title))
	if p.Icon != nil {
		fmt.Fprintf(&b, "icon: %s\n", yamlString(*p.Icon))
	}
	fmt.Fprintf(&b, "created: %s\n", p.CreatedAt.UTC().Format(time.RFC3339))
	fmt.Fprintf(&b, "updated: %s\n", p.UpdatedAt.UTC().Format(time.RFC3339))
	b.WriteString("---\n\n")
	return b.String()
}

func writeZip(zw *zip.Writer, name string, data []byte) error {
	w, err := zw.Create(name)
	if err != nil {
		return fmt.Errorf("create zip entry %q: %w", name, err)
	}
	if _, err := w.Write(data); err != nil {
		return fmt.Errorf("write zip entry %q: %w", name, err)
	}
	return nil
}

// ================================================================ import

// StartImport stores the uploaded zip, records a job and processes it in the background. Needs
// `edit` on parentID when given, else non-guest workspace membership.
func (s *Service) StartImport(ctx context.Context, userID, workspaceID uuid.UUID, parentID *uuid.UUID, fh *multipart.FileHeader) (gen.ImportJob, error) {
	if parentID != nil {
		acc, err := perm.Require(ctx, s.q, userID, *parentID, perm.Edit)
		if err != nil {
			return gen.ImportJob{}, err
		}
		if acc.WorkspaceID != workspaceID {
			return gen.ImportJob{}, perm.ErrPageNotFound
		}
	} else {
		role, err := perm.RequireMember(ctx, s.q, workspaceID, userID)
		if err != nil {
			return gen.ImportJob{}, err
		}
		if role == perm.Guest {
			return gen.ImportJob{}, apperr.Forbidden("Guests must import into a shared page.")
		}
	}
	jobID, err := uuid.NewRandom()
	if err != nil {
		return gen.ImportJob{}, fmt.Errorf("new job id: %w", err)
	}
	uploadPath, err := s.saveUpload(jobID, fh)
	if err != nil {
		return gen.ImportJob{}, err
	}
	job, err := s.q.InsertImportJob(ctx, sqlcgen.InsertImportJobParams{
		WorkspaceID: workspaceID, UserID: userID, ParentPageID: parentID, Total: 0, UploadPath: uploadPath,
	})
	if err != nil {
		_ = os.Remove(uploadPath)
		return gen.ImportJob{}, fmt.Errorf("insert import job: %w", err)
	}
	go s.runImport(job.ID, workspaceID, userID, parentID, uploadPath)
	return toImportJob(job), nil
}

// GetImportJob returns a job's status. Only the owner, a workspace admin, or an instance admin may read it.
func (s *Service) GetImportJob(ctx context.Context, userID, jobID uuid.UUID) (gen.ImportJob, error) {
	job, err := s.q.GetImportJob(ctx, jobID)
	if err != nil {
		if db.IsNotFound(err) {
			return gen.ImportJob{}, apperr.NotFound("Import job not found.")
		}
		return gen.ImportJob{}, fmt.Errorf("get import job: %w", err)
	}
	if job.UserID != userID {
		if _, err := perm.RequireWorkspaceAdmin(ctx, s.q, job.WorkspaceID, userID); err != nil {
			return gen.ImportJob{}, apperr.NotFound("Import job not found.")
		}
	}
	return toImportJob(job), nil
}

func (s *Service) saveUpload(jobID uuid.UUID, fh *multipart.FileHeader) (string, error) {
	src, err := fh.Open()
	if err != nil {
		return "", fmt.Errorf("open upload: %w", err)
	}
	defer src.Close()
	dir := filepath.Join(s.dataDir, "tmp")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create tmp dir: %w", err)
	}
	dst := filepath.Join(dir, jobID.String()+".zip")
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return "", fmt.Errorf("create upload file: %w", err)
	}
	if _, err := io.Copy(f, src); err != nil {
		f.Close()
		_ = os.Remove(dst)
		return "", fmt.Errorf("save upload: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(dst)
		return "", fmt.Errorf("close upload: %w", err)
	}
	return dst, nil
}

// runImport processes the zip in the background.
func (s *Service) runImport(jobID, workspaceID, userID uuid.UUID, parentID *uuid.UUID, uploadPath string) {
	defer os.Remove(uploadPath)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	_ = s.q.MarkImportJobRunning(ctx, jobID)

	res, err := s.processZip(ctx, workspaceID, userID, parentID, uploadPath, jobID)
	if err != nil {
		s.log.Error("import failed", "job", jobID, "err", err)
		msg := "The import failed."
		if _, ok := apperr.As(err); ok {
			msg = err.Error()
		}
		_, _ = s.q.FinishImportJob(ctx, sqlcgen.FinishImportJobParams{
			ID: jobID, Status: string(gen.Failed), Total: res.total, Processed: res.processed, Error: &msg,
		})
		return
	}
	payload, _ := json.Marshal(map[string]any{"rootPageIds": res.roots, "warnings": res.warnings})
	_, err = s.q.FinishImportJob(ctx, sqlcgen.FinishImportJobParams{
		ID: jobID, Status: string(gen.Done), Total: res.total, Processed: res.processed, Result: payload,
	})
	if err != nil {
		s.log.Error("finish import job", "job", jobID, "err", err)
	}
}

type importResult struct {
	roots     []uuid.UUID
	warnings  []string
	total     int32
	processed int32
}

// importNode is one entry of the parsed zip tree.
type importNode struct {
	name     string
	isDir    bool
	body     string
	title    string
	children []*importNode
	pageID   uuid.UUID
	path     string
}

func (s *Service) processZip(ctx context.Context, workspaceID, userID uuid.UUID, parentID *uuid.UUID, uploadPath string, jobID uuid.UUID) (importResult, error) {
	zr, err := zip.OpenReader(uploadPath)
	if err != nil {
		return importResult{}, apperr.BadRequest("The uploaded file is not a valid zip.")
	}
	defer zr.Close()
	if len(zr.File) > importZipMaxEntries {
		return importResult{}, apperr.BadRequest("The zip contains too many files.")
	}
	var declared uint64
	for _, f := range zr.File {
		declared += f.UncompressedSize64
	}
	if declared > importMaxTotalBytes {
		return importResult{}, apperr.BadRequest("The zip expands to more data than the importer accepts.")
	}

	root := &importNode{name: "", isDir: true}
	assets := map[string]string{}        // lowercased path and basename -> zip entry name
	assetFiles := map[string]*zip.File{} // zip entry name -> entry; read lazily, one at a time
	var warnings []string
	var mdBytes int64
	dirNodes := map[string]*importNode{"": root}

	var getDir func(string) *importNode
	getDir = func(p string) *importNode {
		if p == "" || p == "." {
			return root
		}
		if n, ok := dirNodes[p]; ok {
			return n
		}
		parent := getDir(path.Dir(p))
		name := path.Base(p)
		n := &importNode{name: name, isDir: true, path: p}
		parent.children = append(parent.children, n)
		dirNodes[p] = n
		return n
	}

	var total int32
	for _, f := range zr.File {
		name := cleanZipPath(f.Name)
		if name == "" || strings.HasPrefix(path.Base(name), ".") || strings.HasPrefix(name, "__MACOSX/") {
			continue
		}
		if f.FileInfo().IsDir() {
			getDir(strings.TrimSuffix(name, "/"))
			continue
		}
		if strings.EqualFold(path.Ext(name), ".md") {
			if f.UncompressedSize64 > importMaxEntryBytes {
				warnings = append(warnings, fmt.Sprintf("Skipped %q: larger than %d MB.", name, importMaxEntryBytes>>20))
				continue
			}
			rc, err := f.Open()
			if err != nil {
				warnings = append(warnings, fmt.Sprintf("Skipped %q: cannot read it.", name))
				continue
			}
			// Declared sizes can lie, so enforce the cap on the bytes actually read.
			data, err := io.ReadAll(io.LimitReader(rc, importMaxEntryBytes+1))
			rc.Close()
			if err != nil || len(data) > importMaxEntryBytes {
				warnings = append(warnings, fmt.Sprintf("Skipped %q: unreadable or larger than %d MB.", name, importMaxEntryBytes>>20))
				continue
			}
			mdBytes += int64(len(data))
			if mdBytes > importMaxMarkdownBytes {
				return importResult{}, apperr.BadRequest("The zip contains too much Markdown.")
			}
			dir := getDir(path.Dir(name))
			base := strings.TrimSuffix(path.Base(name), path.Ext(name))
			if base == dir.name {
				// Folder/Folder.md becomes the folder page body.
				title, body := parseFrontmatter(data)
				dir.body = body
				dir.title = firstNonEmpty(title, dir.name)
				dir.isDir = true
			} else {
				title, body := parseFrontmatter(data)
				n := &importNode{name: base, title: firstNonEmpty(title, base), body: body, path: name}
				dir.children = append(dir.children, n)
			}
			total++
		} else {
			assetFiles[name] = f
			assets[strings.ToLower(name)] = name
			assets[strings.ToLower(path.Base(name))] = name
		}
	}

	// Our own export writes a page's body as a sibling `<Title>.md` and its descendants in a `<Title>/`
	// folder, so the importer must fold such a companion folder back into the page node it belongs to.
	mergeCompanionFolders(root)
	defaultTitles(root)

	builder := &importBuilder{
		svc: s, ctx: ctx, workspaceID: workspaceID, userID: userID, parentID: parentID,
		byTitle: map[string][]*importNode{}, assets: assets, assetFiles: assetFiles,
	}
	// Index every page node by title before resolving links.
	indexTitles(root, builder.byTitle)
	res := importResult{total: total}
	roots, err := builder.createPages(root.children, parentID)
	if err != nil {
		res.warnings = warnings
		return res, err
	}
	if err := builder.fillContent(root.children, &res.processed, &warnings); err != nil {
		res.warnings = warnings
		return res, err
	}
	res.roots = roots
	res.warnings = warnings
	return res, nil
}

// mergeCompanionFolders folds a folder node into a same-named sibling page node. Export emits a page as
// `<Title>.md` next to a `<Title>/` folder holding its descendants; importing that would otherwise create
// two pages (the file page and the folder page). The folder's children move onto the page node, which
// keeps the body/title from the `.md` (or adopts the folder's when only `Folder/Folder.md` carried it).
func mergeCompanionFolders(n *importNode) {
	for _, c := range n.children {
		mergeCompanionFolders(c)
	}
	pages := map[string]*importNode{}
	for _, c := range n.children {
		if !c.isDir {
			pages[strings.ToLower(c.name)] = c
		}
	}
	if len(pages) == 0 {
		return
	}
	out := n.children[:0]
	for _, c := range n.children {
		if c.isDir {
			if page, ok := pages[strings.ToLower(c.name)]; ok && page != c {
				page.children = append(page.children, c.children...)
				if page.body == "" && c.body != "" {
					page.body = c.body
					page.title = firstNonEmpty(page.title, c.title)
				}
				continue
			}
		}
		out = append(out, c)
	}
	n.children = out
}

// defaultTitles gives every node without a title (a pure folder such as Folder/Child.md with no
// Folder/Folder.md) its folder name, so it is addressable by [[links]] and not listed as "Untitled".
func defaultTitles(n *importNode) {
	for _, c := range n.children {
		if strings.TrimSpace(c.title) == "" {
			c.title = c.name
		}
		defaultTitles(c)
	}
}

func indexTitles(n *importNode, into map[string][]*importNode) {
	for _, c := range n.children {
		if c.isDir && c.body == "" && len(c.children) > 0 {
			// pure folder: still a page
		}
		key := strings.ToLower(strings.TrimSpace(c.title))
		if key != "" {
			into[key] = append(into[key], c)
		}
		indexTitles(c, into)
	}
}

type importBuilder struct {
	svc         *Service
	ctx         context.Context
	workspaceID uuid.UUID
	userID      uuid.UUID
	parentID    *uuid.UUID
	byTitle     map[string][]*importNode
	assets      map[string]string
	assetFiles  map[string]*zip.File
}

// createPages inserts the page rows of nodes and their descendants (parents first) so that every node has
// its final id before any body is resolved: links between imported pages then resolve in both directions,
// and link targets exist when the content is stored.
func (b *importBuilder) createPages(nodes []*importNode, parent *uuid.UUID) ([]uuid.UUID, error) {
	if len(nodes) == 0 {
		return nil, nil
	}
	positions, err := fracdex.NKeysBetween("", "", uint(len(nodes)))
	if err != nil {
		return nil, fmt.Errorf("positions: %w", err)
	}
	ids := make([]uuid.UUID, 0, len(nodes))
	for i, n := range nodes {
		id, err := uuid.NewV7()
		if err != nil {
			return nil, fmt.Errorf("new page id: %w", err)
		}
		row, err := b.svc.q.InsertPage(b.ctx, sqlcgen.InsertPageParams{
			ID: id, WorkspaceID: b.workspaceID, ParentID: parent, Title: emptyTitle(firstNonEmpty(n.title, n.name)),
			Position: positions[i], Visibility: "workspace", CreatedBy: b.userID,
		})
		if err != nil {
			return nil, fmt.Errorf("insert page: %w", err)
		}
		n.pageID = row.ID
		ids = append(ids, row.ID)
		childParent := row.ID
		if _, err := b.createPages(n.children, &childParent); err != nil {
			return nil, err
		}
	}
	return ids, nil
}

// fillContent resolves each page's body (links, embeds, assets), stores the searchable content and link
// rows, and asks collab to build the Y.Doc. Every page row already exists (see createPages).
func (b *importBuilder) fillContent(nodes []*importNode, processed *int32, warnings *[]string) error {
	for _, n := range nodes {
		body, err := b.resolveBody(n)
		if err != nil {
			return err
		}
		title := emptyTitle(firstNonEmpty(n.title, n.name))
		// Store searchable/extractable content now; collab overwrites it with the real blocks.
		if err := b.svc.q.UpsertPageContent(b.ctx, sqlcgen.UpsertPageContentParams{
			PageID: n.pageID, Markdown: body, Plaintext: stripMarkdown(body), Blocks: []byte("[]"),
		}); err != nil {
			return fmt.Errorf("store imported content: %w", err)
		}
		if err := b.svc.q.InsertPageLinks(b.ctx, sqlcgen.InsertPageLinksParams{
			SourcePageID: n.pageID, Targets: linkedIDs(body),
		}); err != nil {
			return fmt.Errorf("store imported links: %w", err)
		}
		if err := b.svc.collab.ImportMarkdown(b.ctx, collabclient.ImportRequest{
			PageID: n.pageID, Markdown: body, EditorID: b.userID,
		}); err != nil {
			*warnings = append(*warnings, "page content could not be converted: "+title)
		}
		*processed++
		if err := b.fillContent(n.children, processed, warnings); err != nil {
			return err
		}
	}
	return nil
}

// resolveBody rewrites import-format wikilinks and asset embeds into the stored format.
func (b *importBuilder) resolveBody(n *importNode) (string, error) {
	body := n.body

	// ![[asset]] (Obsidian embed) -> stored image/file link; ![[Note]] -> page link.
	var resErr error
	body = obsidianEmbedRe.ReplaceAllStringFunc(body, func(match string) string {
		inner := obsidianEmbedRe.FindStringSubmatch(match)[1]
		ref, alias, _ := strings.Cut(inner, "|")
		ref = strings.TrimSpace(ref)
		alias = strings.TrimSpace(alias)
		if stored, err := b.storeAsset(ref, n); err != nil {
			resErr = err
			return match
		} else if stored != "" {
			alt := path.Base(ref)
			if alias != "" && !isDigits(alias) { // `|300` is an Obsidian size hint, not alt text
				alt = alias
			}
			return "![" + alt + "](" + stored + ")"
		}
		target, _, _ := strings.Cut(ref, "#")
		if node := b.resolveTitle(strings.TrimSpace(target), n.path); node != nil {
			return "[[hostidian:" + node.pageID.String() + "|" + node.title + "]]"
		}
		return strings.TrimSpace(target)
	})
	if resErr != nil {
		return "", resErr
	}

	// ![alt](asset) -> stored image/file links.
	body = assetEmbedRe.ReplaceAllStringFunc(body, func(match string) string {
		sub := assetEmbedRe.FindStringSubmatch(match)
		alt, ref := sub[1], sub[2]
		stored, err := b.storeAsset(ref, n)
		if err != nil {
			resErr = err
			return match
		}
		if stored == "" {
			return match
		}
		if alt == "" {
			alt = path.Base(ref)
		}
		return "![" + alt + "](" + stored + ")"
	})
	if resErr != nil {
		return "", resErr
	}

	// [[Title]] / [[Title|alias]] / [[Title#heading]] -> [[hostidian:<id>|<title>]]
	body = wikiLinkRe.ReplaceAllStringFunc(body, func(match string) string {
		inner := wikiLinkRe.FindStringSubmatch(match)[1]
		if strings.HasPrefix(inner, "hostidian:") {
			return match // already in stored form (e.g. produced from an ![[Note]] embed)
		}
		target := inner
		if i := strings.IndexByte(target, '|'); i >= 0 {
			target = target[:i]
		}
		if i := strings.IndexByte(target, '#'); i >= 0 {
			target = target[:i]
		}
		target = strings.TrimSpace(target)
		node := b.resolveTitle(target, n.path)
		if node == nil {
			return target // unresolved -> plain text
		}
		return "[[hostidian:" + node.pageID.String() + "|" + node.title + "]]"
	})
	return body, nil
}

func (b *importBuilder) resolveTitle(title string, fromPath string) *importNode {
	candidates := b.byTitle[strings.ToLower(strings.TrimSpace(title))]
	if len(candidates) == 0 {
		return nil
	}
	best := candidates[0]
	bestScore := -1
	for _, c := range candidates {
		score := commonPrefixSegments(path.Dir(c.path), path.Dir(fromPath))
		if score > bestScore {
			best, bestScore = c, score
		}
	}
	return best
}

func (b *importBuilder) storeAsset(ref string, n *importNode) (string, error) {
	ref = strings.TrimPrefix(ref, "./")
	key, ok := b.assets[strings.ToLower(ref)]
	if !ok {
		key, ok = b.assets[strings.ToLower(path.Base(ref))]
	}
	if !ok {
		return "", nil
	}
	zf := b.assetFiles[key]
	if zf == nil || zf.UncompressedSize64 > importMaxEntryBytes {
		return "", nil // too large to import; the reference stays as text
	}
	rc, err := zf.Open()
	if err != nil {
		return "", nil
	}
	data, err := io.ReadAll(io.LimitReader(rc, importMaxEntryBytes+1))
	rc.Close()
	if err != nil || len(data) > importMaxEntryBytes {
		return "", nil
	}
	pid := n.pageID
	att, err := b.svc.files.StoreBytes(b.ctx, b.workspaceID, b.userID, &pid, path.Base(key), data)
	if err != nil {
		return "", fmt.Errorf("store attachment: %w", err)
	}
	return "/api/files/" + att.ID.String(), nil
}

// ================================================================ helpers

func toImportJob(j sqlcgen.ImportJob) gen.ImportJob {
	out := gen.ImportJob{
		Id: j.ID, Status: gen.ImportJobStatus(j.Status), Total: int(j.Total), Processed: int(j.Processed),
		Error: j.Error, CreatedAt: j.CreatedAt, FinishedAt: j.FinishedAt,
	}
	if len(j.Result) > 0 {
		var payload struct {
			RootPageIds []uuid.UUID `json:"rootPageIds"`
			Warnings    []string    `json:"warnings"`
		}
		if err := json.Unmarshal(j.Result, &payload); err == nil {
			ids := payload.RootPageIds
			warnings := payload.Warnings
			out.Result = &struct {
				RootPageIds *[]uuid.UUID `json:"rootPageIds,omitempty"`
				Warnings    *[]string    `json:"warnings,omitempty"`
			}{RootPageIds: &ids, Warnings: &warnings}
		}
	}
	return out
}

func emptyTitle(t string) string {
	if strings.TrimSpace(t) == "" {
		return "Untitled"
	}
	return t
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

func cleanZipPath(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	segs := strings.Split(name, "/")
	out := segs[:0]
	for _, s := range segs {
		if s == "" || s == "." || s == ".." {
			continue
		}
		out = append(out, s)
	}
	if len(out) == 0 {
		return ""
	}
	return strings.Join(out, "/")
}

func commonPrefixSegments(a, b string) int {
	if a == "." {
		a = ""
	}
	if b == "." {
		b = ""
	}
	as := strings.Split(a, "/")
	bs := strings.Split(b, "/")
	n := 0
	for n < len(as) && n < len(bs) && as[n] == bs[n] {
		n++
	}
	return n
}

var (
	wikiLinkRe = regexp.MustCompile(`\[\[([^\[\]]+)\]\]`)
	// obsidianEmbedRe matches Obsidian embeds such as ![[logo.png]] or ![[logo.png|300]].
	obsidianEmbedRe = regexp.MustCompile(`!\[\[([^\[\]]+)\]\]`)
	assetEmbedRe    = regexp.MustCompile(`!\[([^\]]*)\]\(([^)]+)\)`)
	frontmatterRe   = regexp.MustCompile(`(?s)\A---\r?\n(.*?)\r?\n---\r?\n?`)
	titleLineRe     = regexp.MustCompile(`(?m)^title:\s*(.*)$`)
)

// parseFrontmatter extracts a `title` from YAML-ish frontmatter and returns the body without it.
func parseFrontmatter(data []byte) (string, string) {
	text := string(data)
	loc := frontmatterRe.FindStringSubmatchIndex(text)
	if loc == nil {
		return "", text
	}
	head := text[loc[2]:loc[3]]
	body := text[loc[1]:]
	title := ""
	if m := titleLineRe.FindStringSubmatch(head); m != nil {
		title = unquoteYAML(strings.TrimSpace(m[1]))
	}
	return title, body
}

func unquoteYAML(v string) string {
	if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
		v = v[1 : len(v)-1]
	}
	v = strings.ReplaceAll(v, `\"`, `"`)
	v = strings.ReplaceAll(v, `\\`, `\`)
	return v
}

func yamlString(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return `"` + s + `"`
}

func unescapeTitle(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) {
			i++
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func safeName(s string) string {
	s = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	s = strings.Trim(s, ". ")
	if s == "" {
		s = "Untitled"
	}
	if utf8.RuneCountInString(s) > 120 {
		s = string([]rune(s)[:120])
	}
	return s
}

// linkedIDs extracts hostidian link targets from stored markdown.
func linkedIDs(md string) []uuid.UUID {
	seen := map[uuid.UUID]struct{}{}
	var out []uuid.UUID
	for _, m := range storedLinkRe.FindAllStringSubmatch(md, -1) {
		id, err := uuid.Parse(m[1])
		if err != nil {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

var (
	mdImageRe = regexp.MustCompile(`!\[[^\]]*\]\([^)]*\)`)
	mdLinkRe  = regexp.MustCompile(`\[([^\]]*)\]\([^)]*\)`)
	mdMarkRe  = regexp.MustCompile("(?m)[#>*_`~\\-]+")
)

// stripMarkdown is a best-effort plain-text rendering for search.
func stripMarkdown(md string) string {
	md = storedLinkRe.ReplaceAllString(md, "$2")
	md = mdImageRe.ReplaceAllString(md, " ")
	md = mdLinkRe.ReplaceAllString(md, "$1")
	md = mdMarkRe.ReplaceAllString(md, " ")
	return strings.Join(strings.Fields(md), " ")
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
