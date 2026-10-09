package oidc

import (
	"testing"

	"github.com/google/uuid"
)

func TestDecide(t *testing.T) {
	u := &KnownUser{ID: uuid.New()}
	disabled := &KnownUser{ID: uuid.New(), Disabled: true}
	verified := Claims{Issuer: "https://idp", Subject: "sub-1", Email: "Ada@Example.com", EmailVerified: true}
	unverified := Claims{Issuer: "https://idp", Subject: "sub-1", Email: "ada@example.com", EmailVerified: false}
	open := Invite{ID: uuid.New()}
	restricted := Invite{ID: uuid.New(), Email: "ada@example.com"}
	other := Invite{ID: uuid.New(), Email: "someone@example.com"}

	tests := []struct {
		name string
		in   Input
		want Decision
	}{
		// 1. (issuer, subject) match
		{"known identity logs in", Input{Claims: verified, IdentityUser: u}, Decision{Action: Login}},
		{"known identity logs in without verified email", Input{Claims: unverified, IdentityUser: u}, Decision{Action: Login}},
		{"known identity of a disabled user is refused", Input{Claims: verified, IdentityUser: disabled}, Decision{Action: Reject, Reason: ReasonAccountDisabled}},
		{"identity wins over an email match", Input{Claims: verified, IdentityUser: u, EmailUser: disabled}, Decision{Action: Login}},

		// 2. link by email only when verified
		{"verified email links to the existing account", Input{Claims: verified, EmailUser: u}, Decision{Action: LinkAndLogin}},
		{"unverified email never links", Input{Claims: unverified, EmailUser: u}, Decision{Action: Reject, Reason: ReasonEmailUnverified}},
		{"unverified email never links even with open signup", Input{Claims: unverified, EmailUser: u, OpenSignup: true}, Decision{Action: Reject, Reason: ReasonEmailUnverified}},
		{"unverified email never links even with an invite", Input{Claims: unverified, EmailUser: u, Invite: &open}, Decision{Action: Reject, Reason: ReasonEmailUnverified}},
		{"verified email of a disabled account is refused", Input{Claims: verified, EmailUser: disabled}, Decision{Action: Reject, Reason: ReasonAccountDisabled}},

		// 3. creation needs open signup or an invite
		{"closed instance, no invite", Input{Claims: verified}, Decision{Action: Reject, Reason: ReasonSignupDisabled}},
		{"open signup creates the account", Input{Claims: verified, OpenSignup: true}, Decision{Action: Create}},
		{"open signup creates even with an unverified email", Input{Claims: unverified, OpenSignup: true}, Decision{Action: Create}},
		{"valid invite creates the account and is used", Input{Claims: verified, Invite: &open}, Decision{Action: Create, UseInvite: true}},
		{"invite beats open signup", Input{Claims: verified, Invite: &open, OpenSignup: true}, Decision{Action: Create, UseInvite: true}},
		{"email-restricted invite, matching verified email", Input{Claims: verified, Invite: &restricted}, Decision{Action: Create, UseInvite: true}},
		{"email-restricted invite, unverified email", Input{Claims: unverified, Invite: &restricted}, Decision{Action: Reject, Reason: ReasonInviteMismatch}},
		{"email-restricted invite, other email", Input{Claims: verified, Invite: &other}, Decision{Action: Reject, Reason: ReasonInviteMismatch}},
		{"email-restricted invite, other email, open signup", Input{Claims: verified, Invite: &other, OpenSignup: true}, Decision{Action: Reject, Reason: ReasonInviteMismatch}},
		{"no email claim cannot create an account", Input{Claims: Claims{Issuer: "i", Subject: "s"}, OpenSignup: true}, Decision{Action: Reject, Reason: ReasonEmailRequired}},
		{"no email claim but known identity still logs in", Input{Claims: Claims{Issuer: "i", Subject: "s"}, IdentityUser: u}, Decision{Action: Login}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := Decide(tc.in); got != tc.want {
				t.Fatalf("Decide() = %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestSafeNext(t *testing.T) {
	ok := []string{"/", "/w/acme", "/w/acme/p/123?x=1#frag", "/a%2Fb", "/settings/profile"}
	for _, n := range ok {
		if got := SafeNext(n); got != n {
			t.Errorf("SafeNext(%q) = %q, want it unchanged", n, got)
		}
	}
	bad := []string{
		"", "w/acme", "//evil.example", "///evil.example", "http://evil.example", "https://evil.example/x",
		"javascript:alert(1)", `/\evil.example`, `/\/evil.example`, "/\t/evil.example", "/\n/evil.example",
		"/%0d%0a" + string(rune(0x7f)), "\x00/x", "@evil.example", "evil.example/x", " //evil.example",
	}
	for _, n := range bad {
		if got := SafeNext(n); got != "/" {
			t.Errorf("SafeNext(%q) = %q, want /", n, got)
		}
	}
	if got := SafeNext("/" + string(make([]byte, 3000))); got != "/" {
		t.Error("overlong paths must be refused")
	}
}
