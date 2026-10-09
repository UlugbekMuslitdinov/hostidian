package oidc

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"hostidian/backend/internal/config"
)

func testProvider() *Provider {
	return New(config.OIDC{IssuerURL: "https://idp.example", ClientID: "id", ClientSecret: "secret", Name: "SSO"}, "app-secret", true, nil)
}

func TestStateCookieSealing(t *testing.T) {
	p := testProvider()
	now := time.Unix(1_800_000_000, 0)
	p.now = func() time.Time { return now }

	in := statePayload{State: "st", Nonce: "no", Verifier: "ve", Invite: "inv", Next: "/w/x", Expires: now.Add(stateTTL).Unix()}
	sealed, err := p.seal(in)
	if err != nil {
		t.Fatal(err)
	}
	out, err := p.open(sealed)
	if err != nil || out != in {
		t.Fatalf("round trip: %+v %v", out, err)
	}

	// tampering with the payload or the signature is detected
	body, sig, _ := strings.Cut(sealed, ".")
	for name, bad := range map[string]string{
		"payload":   body[:len(body)-2] + "AA." + sig,
		"signature": body + "." + sig[:len(sig)-2] + "AA",
		"no dot":    body + sig,
		"empty":     "",
		"garbage":   "!!!.???",
	} {
		if _, err := p.open(bad); err == nil {
			t.Errorf("%s: tampered cookie accepted", name)
		}
	}

	// a different APP_SECRET cannot forge or read cookies
	other := New(p.cfg, "another-secret", true, nil)
	other.now = p.now
	if _, err := other.open(sealed); err == nil {
		t.Fatal("cookie verified with another secret")
	}

	// expiry
	now = now.Add(stateTTL + time.Second)
	if _, err := p.open(sealed); err == nil {
		t.Fatal("expired state accepted")
	}
}

func TestCookieAttributes(t *testing.T) {
	c := testProvider().cookie("v", 600)
	if !c.HttpOnly || !c.Secure || c.Path != "/api/auth/oidc" || c.MaxAge != 600 || c.SameSite != http.SameSiteLaxMode {
		t.Fatalf("cookie = %+v", c)
	}
	if clr := testProvider().ClearCookie(); clr.MaxAge >= 0 {
		t.Fatal("ClearCookie must expire the cookie")
	}
}
