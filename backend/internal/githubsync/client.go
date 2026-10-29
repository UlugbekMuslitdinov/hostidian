package githubsync

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	defaultAPIBase = "https://api.github.com"
	maxResponse    = 16 << 20
	pageSize       = 100
)

var (
	nameRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`)
	// https://github.com/owner/repo(.git)(/…) or owner/repo
	repoRe = regexp.MustCompile(`^(?:https?://github\.com/)?([A-Za-z0-9_.-]{1,100})/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?/?$`)
)

// ParseRepository accepts "owner/repo" or a github.com URL. Both parts end up in URL paths, so anything outside
// GitHub's own character set (including "." and "..") is rejected.
func ParseRepository(s string) (owner, repo string, ok bool) {
	m := repoRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil || !nameRe.MatchString(m[1]) || !nameRe.MatchString(m[2]) || isDots(m[1]) || isDots(m[2]) {
		return "", "", false
	}
	return m[1], m[2], true
}

func isDots(s string) bool { return s == "." || s == ".." }

// APIError is a non-2xx answer from GitHub.
type APIError struct {
	Status  int
	Message string
	// RetryAt is set when GitHub asked us to back off (rate limit, abuse detection).
	RetryAt time.Time
}

func (e *APIError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("GitHub responded %d", e.Status)
	}
	return fmt.Sprintf("GitHub responded %d: %s", e.Status, e.Message)
}

// IsAuth reports a rejected or insufficiently privileged token.
func (e *APIError) IsAuth() bool {
	return (e.Status == http.StatusUnauthorized || e.Status == http.StatusForbidden) && e.RetryAt.IsZero()
}

// Issue is the part of GitHub's issue object the sync uses.
type Issue struct {
	Number      int32     `json:"number"`
	Title       string    `json:"title"`
	Body        *string   `json:"body"`
	State       string    `json:"state"`
	HTMLURL     string    `json:"html_url"`
	UpdatedAt   time.Time `json:"updated_at"`
	PullRequest *struct{} `json:"pull_request"`
}

// BodyText is the body, "" when GitHub returned null.
func (i Issue) BodyText() string {
	if i.Body == nil {
		return ""
	}
	return *i.Body
}

// Comment is an issue comment.
type Comment struct {
	ID        int64     `json:"id"`
	Body      string    `json:"body"`
	UpdatedAt time.Time `json:"updated_at"`
	IssueURL  string    `json:"issue_url"`
	User      struct {
		Login string `json:"login"`
	} `json:"user"`
}

// IssueNumber extracts N from ".../issues/N".
func (c Comment) IssueNumber() (int32, bool) {
	i := strings.LastIndex(c.IssueURL, "/")
	if i < 0 {
		return 0, false
	}
	n, err := strconv.ParseInt(c.IssueURL[i+1:], 10, 32)
	return int32(n), err == nil && n > 0
}

// Repo is what Connect needs to know about a repository.
type Repo struct {
	FullName  string `json:"full_name"`
	HasIssues bool   `json:"has_issues"`
	Archived  bool   `json:"archived"`
}

// IssuePatch lists the fields to change; nil fields are left alone.
type IssuePatch struct {
	Title *string `json:"title,omitempty"`
	Body  *string `json:"body,omitempty"`
	State *string `json:"state,omitempty"`
}

// Client is a minimal GitHub REST client for one token.
type Client struct {
	token string
	base  string
	http  *http.Client
}

// NewClient returns a client for api.github.com.
func NewClient(token string) *Client {
	return &Client{token: token, base: defaultAPIBase, http: &http.Client{Timeout: 30 * time.Second}}
}

// WithBase points the client at another API root (tests, GitHub Enterprise).
func (c *Client) WithBase(base string) *Client {
	c.base = strings.TrimRight(base, "/")
	return c
}

func (c *Client) do(ctx context.Context, method, path string, query url.Values, in, out any) (http.Header, error) {
	u := c.base + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "hostidian-github-sync")
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode/100 != 2 {
		return resp.Header, apiError(resp, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			return nil, fmt.Errorf("decode GitHub response: %w", err)
		}
	}
	return resp.Header, nil
}

func apiError(resp *http.Response, raw []byte) *APIError {
	e := &APIError{Status: resp.StatusCode}
	var payload struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &payload) == nil {
		e.Message = payload.Message
	}
	if len(e.Message) > 300 {
		e.Message = e.Message[:300]
	}
	limited := resp.StatusCode == http.StatusTooManyRequests ||
		(resp.StatusCode == http.StatusForbidden && (resp.Header.Get("X-RateLimit-Remaining") == "0" || resp.Header.Get("Retry-After") != ""))
	if limited {
		e.RetryAt = time.Now().Add(time.Minute)
		if s := resp.Header.Get("Retry-After"); s != "" {
			if n, err := strconv.Atoi(s); err == nil {
				e.RetryAt = time.Now().Add(time.Duration(n) * time.Second)
			}
		} else if s := resp.Header.Get("X-RateLimit-Reset"); s != "" {
			if n, err := strconv.ParseInt(s, 10, 64); err == nil {
				e.RetryAt = time.Unix(n, 0).Add(time.Second)
			}
		}
	}
	return e
}

func repoPath(owner, repo string) string {
	return "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(repo)
}

// GetRepo checks that the token can see the repository.
func (c *Client) GetRepo(ctx context.Context, owner, repo string) (Repo, error) {
	var r Repo
	_, err := c.do(ctx, http.MethodGet, repoPath(owner, repo), nil, nil, &r)
	return r, err
}

func listQuery(since *time.Time, page int, sort string) url.Values {
	q := url.Values{"per_page": {strconv.Itoa(pageSize)}, "page": {strconv.Itoa(page)}, "sort": {sort}, "direction": {"asc"}}
	if since != nil {
		q.Set("since", since.UTC().Format(time.RFC3339))
	}
	return q
}

func hasNext(h http.Header) bool {
	for _, link := range h.Values("Link") {
		if strings.Contains(link, `rel="next"`) {
			return true
		}
	}
	return false
}

// ListIssues returns one page of issues (open and closed, pull requests included) updated since the cursor,
// oldest update first.
func (c *Client) ListIssues(ctx context.Context, owner, repo string, since *time.Time, page int) ([]Issue, bool, error) {
	q := listQuery(since, page, "updated")
	q.Set("state", "all")
	var out []Issue
	h, err := c.do(ctx, http.MethodGet, repoPath(owner, repo)+"/issues", q, nil, &out)
	return out, err == nil && hasNext(h), err
}

// GetIssue fetches one issue.
func (c *Client) GetIssue(ctx context.Context, owner, repo string, number int32) (Issue, error) {
	var i Issue
	_, err := c.do(ctx, http.MethodGet, fmt.Sprintf("%s/issues/%d", repoPath(owner, repo), number), nil, nil, &i)
	return i, err
}

// CreateIssue opens an issue.
func (c *Client) CreateIssue(ctx context.Context, owner, repo, title, body string) (Issue, error) {
	var i Issue
	_, err := c.do(ctx, http.MethodPost, repoPath(owner, repo)+"/issues", nil, map[string]string{"title": title, "body": body}, &i)
	return i, err
}

// PatchIssue updates the listed fields.
func (c *Client) PatchIssue(ctx context.Context, owner, repo string, number int32, p IssuePatch) (Issue, error) {
	var i Issue
	_, err := c.do(ctx, http.MethodPatch, fmt.Sprintf("%s/issues/%d", repoPath(owner, repo), number), nil, p, &i)
	return i, err
}

// ListComments returns one page of the repository's issue comments updated since the cursor.
func (c *Client) ListComments(ctx context.Context, owner, repo string, since *time.Time, page int) ([]Comment, bool, error) {
	var out []Comment
	h, err := c.do(ctx, http.MethodGet, repoPath(owner, repo)+"/issues/comments", listQuery(since, page, "updated"), nil, &out)
	return out, err == nil && hasNext(h), err
}

// CreateComment posts a comment on an issue.
func (c *Client) CreateComment(ctx context.Context, owner, repo string, number int32, body string) (Comment, error) {
	var out Comment
	_, err := c.do(ctx, http.MethodPost, fmt.Sprintf("%s/issues/%d/comments", repoPath(owner, repo), number), nil,
		map[string]string{"body": body}, &out)
	return out, err
}
