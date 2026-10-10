package collabclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"
)

// ApplyMode says how Markdown is merged into the live document.
type ApplyMode string

const (
	ApplyReplace ApplyMode = "replace"
	ApplyAppend  ApplyMode = "append"
	ApplyPrepend ApplyMode = "prepend"
)

// Valid reports whether m is one of the three modes.
func (m ApplyMode) Valid() bool { return m == ApplyReplace || m == ApplyAppend || m == ApplyPrepend }

// ApplyRequest edits a page's document through the live Y.Doc (api/internal.yaml, `applyMarkdown`).
type ApplyRequest struct {
	PageID   uuid.UUID
	Markdown string
	Mode     ApplyMode
	// EditorID is the user the edit is attributed to (pages.last_edited_by).
	EditorID uuid.UUID
}

// Applier is what the MCP tools depend on (tests substitute a fake).
type Applier interface {
	// ApplyMarkdown merges the Markdown into the page's live document and returns the page's resulting
	// Markdown. It returns once the change is stored and its extracted content reached the API.
	ApplyMarkdown(ctx context.Context, req ApplyRequest) (string, error)
}

var (
	// ErrNotConfigured: COLLAB_INTERNAL_URL is not set, so the live document cannot be edited.
	ErrNotConfigured = errors.New("collab service is not configured")
	// ErrPageNotFound: collab does not know the page (deleted, or never existed).
	ErrPageNotFound = errors.New("collab: page not found")
	// ErrInvalidMarkdown: collab rejected the input (422).
	ErrInvalidMarkdown = errors.New("collab: invalid markdown")
)

// applyTimeout covers loading the document, the store and the content push (which collab retries briefly).
const applyTimeout = 60 * time.Second

// ApplyMarkdown calls POST {COLLAB_INTERNAL_URL}/internal/apply-markdown.
func (c *Client) ApplyMarkdown(ctx context.Context, req ApplyRequest) (string, error) {
	if !c.Enabled() {
		return "", ErrNotConfigured
	}
	if !req.Mode.Valid() {
		return "", fmt.Errorf("collab apply: unknown mode %q", req.Mode)
	}
	payload, err := json.Marshal(map[string]string{
		"pageId": req.PageID.String(), "markdown": req.Markdown, "mode": string(req.Mode), "editorId": req.EditorID.String(),
	})
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(ctx, applyTimeout)
	defer cancel()
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/internal/apply-markdown", bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+c.token)
	// Same transport (connection pool) as the other calls, but the 5 s client timeout is too short here.
	long := &http.Client{Transport: c.http.Transport}
	resp, err := long.Do(httpReq)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return "", err
	}
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return "", ErrPageNotFound
	case resp.StatusCode == http.StatusUnprocessableEntity:
		return "", fmt.Errorf("%w: %s", ErrInvalidMarkdown, envelopeMessage(body))
	case resp.StatusCode/100 != 2:
		return "", fmt.Errorf("collab responded %d: %s", resp.StatusCode, envelopeMessage(body))
	}
	var out struct {
		Markdown string `json:"markdown"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", fmt.Errorf("decode collab response: %w", err)
	}
	return out.Markdown, nil
}

func envelopeMessage(body []byte) string {
	var env struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &env) == nil && env.Error.Message != "" {
		return env.Error.Message
	}
	if len(body) > 200 {
		body = body[:200]
	}
	return string(body)
}

// ApplyMarkdown implements Applier as "unavailable" (collab not configured): unlike the best-effort
// disconnects, an edit that silently went nowhere would be a lie.
func (Noop) ApplyMarkdown(context.Context, ApplyRequest) (string, error) {
	return "", ErrNotConfigured
}
