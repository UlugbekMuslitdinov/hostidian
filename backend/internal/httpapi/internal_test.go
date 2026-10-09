package httpapi_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"hostidian/backend/internal/httpapi"
)

func init() {
	// what wave 2 does for PUT /internal/pages/{pageId}/content
	httpapi.RegisterInternalRoutes(func(s *httpapi.Server, r chi.Router) {
		r.Put("/echo/{id}", func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.WriteString(w, "echo:"+chi.URLParam(r, "id"))
		})
	})
}

func TestInternalRouter(t *testing.T) {
	e := newEnv(t)
	ts := httptest.NewServer(e.server.InternalHandler())
	defer ts.Close()

	do := func(method, path, token string) (int, string) {
		req, _ := http.NewRequest(method, ts.URL+path, strings.NewReader(""))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}

	// health needs no token
	for _, p := range []string{"/healthz", "/internal/health"} {
		if code, body := do("GET", p, ""); code != 200 || !strings.Contains(body, "ok") {
			t.Fatalf("GET %s = %d %s", p, code, body)
		}
	}
	// everything else is behind the bearer token, compared in constant time
	if code, body := do("PUT", "/internal/echo/42", ""); code != 401 || !strings.Contains(body, `"unauthorized"`) {
		t.Fatalf("no token = %d %s", code, body)
	}
	if code, _ := do("PUT", "/internal/echo/42", "wrong"); code != 401 {
		t.Fatalf("wrong token = %d", code)
	}
	if code, _ := do("PUT", "/internal/echo/42", e.cfg.InternalToken[:5]); code != 401 {
		t.Fatalf("token prefix = %d", code)
	}
	if code, body := do("PUT", "/internal/echo/42", e.cfg.InternalToken); code != 200 || body != "echo:42" {
		t.Fatalf("registered route = %d %q", code, body)
	}
	// unknown internal paths are 404 envelopes (after auth), unknown everything else too
	if code, body := do("GET", "/internal/nope", e.cfg.InternalToken); code != 404 || !strings.Contains(body, `"not_found"`) {
		t.Fatalf("unknown = %d %s", code, body)
	}
	if code, _ := do("GET", "/api/instance/info", ""); code != 404 {
		t.Fatalf("the public API must not be served on the internal listener, got %d", code)
	}
}

func TestPublicListenerDoesNotServeInternal(t *testing.T) {
	e := newEnv(t)
	res, err := http.Get(e.ts.URL + "/internal/health")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 404 {
		t.Fatalf("public listener answered /internal/health with %d", res.StatusCode)
	}
	res, err = http.Get(e.ts.URL + "/healthz")
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("/healthz: %v %v", res, err)
	}
	res.Body.Close()
}
