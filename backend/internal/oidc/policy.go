// Package oidc implements the optional OpenID Connect login (conventions §2): the protocol side
// (Provider: discovery, PKCE, state/nonce cookie, token verification) and the account-linking
// policy (Decide), which is a pure function so it can be unit-tested without an identity provider.
package oidc

import (
	"strings"

	"github.com/google/uuid"
)

// Claims are the identity attributes taken from a verified ID token.
type Claims struct {
	Issuer        string
	Subject       string
	Email         string // as sent by the provider, may be empty
	EmailVerified bool
	Name          string
}

// KnownUser is the part of an existing account the policy needs.
type KnownUser struct {
	ID       uuid.UUID
	Disabled bool
}

// Invite is a valid (unused, unexpired) invite presented to /auth/oidc/login?invite=….
type Invite struct {
	ID    uuid.UUID
	Email string // lower-cased; empty = not restricted
}

// Input is everything Decide looks at.
type Input struct {
	Claims Claims
	// IdentityUser is the account already linked to (issuer, subject), if any.
	IdentityUser *KnownUser
	// EmailUser is the account whose email equals Claims.Email, if any.
	EmailUser *KnownUser
	// OpenSignup mirrors instance_settings.allow_open_signup.
	OpenSignup bool
	// Invite is the invite from the login request, nil when none was given or it is not valid.
	Invite *Invite
}

// Action is what the caller must do next.
type Action int

const (
	// Reject: do not log in; Reason says why (it becomes /login?error=<reason>).
	Reject Action = iota
	// Login: log in IdentityUser.
	Login
	// LinkAndLogin: attach the identity to EmailUser, then log in.
	LinkAndLogin
	// Create: create a new user (and consume the invite when UseInvite).
	Create
)

// Reasons surfaced to the login page as ?error=<reason>.
const (
	ReasonAccountDisabled = "account_disabled"
	ReasonEmailUnverified = "email_unverified"
	ReasonEmailRequired   = "email_required"
	ReasonSignupDisabled  = "signup_disabled"
	ReasonInviteMismatch  = "invite_email_mismatch"
)

// Decision is the outcome of Decide.
type Decision struct {
	Action    Action
	Reason    string
	UseInvite bool
}

// Decide applies the policy of conventions §2:
//
//  1. match existing users by (issuer, subject);
//  2. otherwise link to an existing user with the same email only if email_verified is true;
//  3. otherwise create a user only if open signup is on or a valid invite token was passed.
//
// Disabled accounts are never logged in.
func Decide(in Input) Decision {
	if u := in.IdentityUser; u != nil {
		if u.Disabled {
			return Decision{Action: Reject, Reason: ReasonAccountDisabled}
		}
		return Decision{Action: Login}
	}

	email := strings.ToLower(strings.TrimSpace(in.Claims.Email))
	if u := in.EmailUser; u != nil {
		// An unverified email must never grant access to somebody else's account, and we cannot
		// create a second account with the same email either.
		if !in.Claims.EmailVerified {
			return Decision{Action: Reject, Reason: ReasonEmailUnverified}
		}
		if u.Disabled {
			return Decision{Action: Reject, Reason: ReasonAccountDisabled}
		}
		return Decision{Action: LinkAndLogin}
	}

	if email == "" {
		return Decision{Action: Reject, Reason: ReasonEmailRequired}
	}
	if inv := in.Invite; inv != nil {
		if inv.Email != "" && (!in.Claims.EmailVerified || !strings.EqualFold(inv.Email, email)) {
			return Decision{Action: Reject, Reason: ReasonInviteMismatch}
		}
		return Decision{Action: Create, UseInvite: true}
	}
	if in.OpenSignup {
		return Decision{Action: Create}
	}
	return Decision{Action: Reject, Reason: ReasonSignupDisabled}
}
