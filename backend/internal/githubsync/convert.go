package githubsync

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

// ThreadBlockID is the reserved comment-thread anchor of a synced page's GitHub discussion. It is not a
// BlockNote block id, so the web client treats it as page-level instead of "detached".
const ThreadBlockID = "github:issue"

// Hidden HTML comments let a re-run recognise what it already created when the process died between the
// GitHub call and the database write.
var (
	pageMarkerRe    = regexp.MustCompile(`(?m)[ \t]*<!-- hostidian:page:([0-9a-f-]{36}) -->[ \t]*\r?\n?`)
	commentMarkerRe = regexp.MustCompile(`<!-- hostidian:comment:([0-9a-f-]{36}) -->`)
	// Same pattern as docs/conventions.md §8: group 1 = page id, group 2 = escaped title.
	pageLinkRe = regexp.MustCompile(`\[\[hostidian:([0-9a-f-]{36})\\?\|((?:\\.|[^\]\\])*)\]\]`)
	unescapeRe = regexp.MustCompile(`\\(.)`)
)

// PageMarker is appended to the body of an issue created from a page.
func PageMarker(pageID uuid.UUID) string { return "<!-- hostidian:page:" + pageID.String() + " -->" }

// CommentMarker is appended to every comment posted from Hostidian.
func CommentMarker(commentID uuid.UUID) string {
	return "<!-- hostidian:comment:" + commentID.String() + " -->"
}

// StripPageMarker removes the page marker from an issue body and reports the page it names.
func StripPageMarker(body string) (clean string, pageID uuid.UUID, ok bool) {
	if m := pageMarkerRe.FindStringSubmatch(body); m != nil {
		if id, err := uuid.Parse(m[1]); err == nil {
			pageID, ok = id, true
		}
	}
	return normalizeBody(pageMarkerRe.ReplaceAllString(body, "")), pageID, ok
}

// ParseCommentMarker returns the Hostidian comment a GitHub comment was posted from.
func ParseCommentMarker(body string) (uuid.UUID, bool) {
	m := commentMarkerRe.FindStringSubmatch(body)
	if m == nil {
		return uuid.Nil, false
	}
	id, err := uuid.Parse(m[1])
	return id, err == nil
}

func normalizeBody(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	s = strings.ReplaceAll(s, "\r", "\n")
	return strings.TrimSpace(s)
}

// normalizeTitle matches what GitHub stores: one line, trimmed.
func normalizeTitle(s string) string {
	return strings.Join(strings.Fields(strings.ReplaceAll(s, " ", " ")), " ")
}

// HashBody fingerprints a Markdown body independent of line endings and surrounding whitespace.
func HashBody(s string) string {
	sum := sha256.Sum256([]byte(normalizeBody(s)))
	return hex.EncodeToString(sum[:])
}

// Converter translates between Hostidian's Markdown dialect (docs/conventions.md §8) and what GitHub renders.
type Converter struct {
	PublicURL     string
	WorkspaceSlug string
	// Issues maps the pages of this connection to their issue number, so links between synced pages become
	// GitHub's own #123 references.
	Issues map[uuid.UUID]int32
}

// ToGitHub rewrites Hostidian-only syntax: page links become #N (synced pages) or ordinary links, and
// attachment paths become absolute URLs.
func (c Converter) ToGitHub(md string) string {
	md = strings.ReplaceAll(md, "\r\n", "\n")
	md = pageLinkRe.ReplaceAllStringFunc(md, func(m string) string {
		sub := pageLinkRe.FindStringSubmatch(m)
		id, err := uuid.Parse(sub[1])
		if err != nil {
			return m
		}
		if n, ok := c.Issues[id]; ok {
			return "#" + strconv.Itoa(int(n))
		}
		title := unescapeRe.ReplaceAllString(sub[2], "$1")
		title = strings.NewReplacer("[", `\[`, "]", `\]`).Replace(title)
		return fmt.Sprintf("[%s](%s)", title, c.pageURL(id))
	})
	md = strings.ReplaceAll(md, "](/api/files/", "]("+c.PublicURL+"/api/files/")
	return normalizeBody(md)
}

// FromGitHub prepares an issue body for the editor. GitHub-flavoured Markdown is what the editor imports, so
// only the sync markers need to go.
func (c Converter) FromGitHub(body string) string {
	clean, _, _ := StripPageMarker(body)
	return clean
}

func (c Converter) pageURL(id uuid.UUID) string {
	return fmt.Sprintf("%s/w/%s/p/%s", c.PublicURL, c.WorkspaceSlug, id)
}

// FormatOutgoingComment is the GitHub text of a comment written in Hostidian: the body, an attribution line
// (every comment is posted with the one workspace token) and the echo marker.
func FormatOutgoingComment(body, author string, commentID uuid.UUID) string {
	return strings.TrimSpace(body) + "\n\n<sub>via Hostidian, by " + sanitizeInline(author) + "</sub>\n" + CommentMarker(commentID)
}

// FormatIncomingComment is the Hostidian text of a comment written on GitHub. The comment is stored under the
// sync user, so the real author is part of the text.
func FormatIncomingComment(login, body string) string {
	return "**@" + sanitizeInline(login) + "** commented on GitHub\n\n" + normalizeBody(body)
}

// sanitizeInline keeps a display name from breaking out of the surrounding markup.
func sanitizeInline(s string) string {
	s = strings.NewReplacer("<", "", ">", "", "\r", " ", "\n", " ").Replace(s)
	s = strings.TrimSpace(s)
	if s == "" {
		return "someone"
	}
	return s
}
