// Package collabclient calls the collab service's internal API (api/internal.yaml) from the Go API.
package collabclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// DisconnectRequest closes live collaboration sockets. At least one of PageID / UserID is required;
// with both, only that user's connections to that page are closed.
type DisconnectRequest struct {
	PageID uuid.UUID
	UserID uuid.UUID
	Reason string
}

// Disconnecter is what the services depend on (tests substitute a recorder).
type Disconnecter interface {
	// Disconnect fires and forgets: it never blocks the caller and never fails the request. Errors
	// are logged. When collab is not configured it does nothing.
	Disconnect(req DisconnectRequest)
}

// Client talks to POST {COLLAB_INTERNAL_URL}/internal/disconnect.
type Client struct {
	baseURL string
	token   string
	http    *http.Client
	log     *slog.Logger
	wg      sync.WaitGroup
	sem     chan struct{} // bounds in-flight calls when a big subtree is revoked at once
}

// New returns a client. An empty baseURL yields a client whose calls are no-ops.
func New(baseURL, internalToken string, log *slog.Logger) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   internalToken,
		http:    &http.Client{Timeout: 5 * time.Second},
		log:     log,
		sem:     make(chan struct{}, 8),
	}
}

// Enabled reports whether a collab URL is configured.
func (c *Client) Enabled() bool { return c.baseURL != "" }

// Disconnect implements Disconnecter (asynchronous, best effort).
func (c *Client) Disconnect(req DisconnectRequest) {
	if !c.Enabled() {
		return
	}
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		c.sem <- struct{}{}
		defer func() { <-c.sem }()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := c.DisconnectSync(ctx, req); err != nil {
			c.log.Warn("collab disconnect failed", "page", req.PageID, "user", req.UserID, "err", err)
		}
	}()
}

// DisconnectSync performs the call and returns the error.
func (c *Client) DisconnectSync(ctx context.Context, req DisconnectRequest) error {
	if !c.Enabled() {
		return nil
	}
	if req.PageID == uuid.Nil && req.UserID == uuid.Nil {
		return fmt.Errorf("collab disconnect needs a page or a user")
	}
	reason := req.Reason
	if reason == "" {
		reason = "permissions_changed"
	}
	body := map[string]string{"reason": reason}
	if req.PageID != uuid.Nil {
		body["pageId"] = req.PageID.String()
	}
	if req.UserID != uuid.Nil {
		body["userId"] = req.UserID.String()
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/internal/disconnect", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := c.http.Do(httpReq)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("collab responded %d", resp.StatusCode)
	}
	return nil
}

// Wait blocks until in-flight disconnects finished (graceful shutdown and tests).
func (c *Client) Wait() { c.wg.Wait() }

// Noop is a Disconnecter that does nothing.
type Noop struct{}

func (Noop) Disconnect(DisconnectRequest) {}
