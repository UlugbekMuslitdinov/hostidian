// Package validate holds the input rules of api/openapi.yaml (the generated code does not enforce them).
package validate

import (
	"net/mail"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"hostidian/backend/internal/apperr"
)

const (
	MinPasswordLen = 10
	MaxPasswordLen = 200
	MaxNameLen     = 100
	MaxSlugLen     = 60
	MaxTitleLen    = 500
)

var (
	slugRE  = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	colorRE = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
)

// Email lower-cases and trims the address and checks its shape. field names the JSON field in errors.
func Email(field, s string) (string, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" || len(s) > 254 {
		return "", apperr.FieldError(field, "Enter a valid email address.")
	}
	addr, err := mail.ParseAddress(s)
	// ParseAddress also accepts "Name <a@b>"; require the bare address only.
	if err != nil || addr.Address != s || strings.ContainsAny(s, " <>") {
		return "", apperr.FieldError(field, "Enter a valid email address.")
	}
	return s, nil
}

// Name trims and checks a display name (1..100 characters, no control characters).
func Name(field, s string) (string, error) {
	s = strings.TrimSpace(s)
	n := utf8.RuneCountInString(s)
	if n < 1 || n > MaxNameLen {
		return "", apperr.FieldError(field, "Must be between 1 and 100 characters.")
	}
	if hasControl(s) {
		return "", apperr.FieldError(field, "Must not contain control characters.")
	}
	return s, nil
}

// Password checks length only (10..200 characters); we deliberately impose no composition rules.
func Password(field, s string) error {
	n := utf8.RuneCountInString(s)
	if n < MinPasswordLen {
		return apperr.FieldError(field, "Must be at least 10 characters.")
	}
	if n > MaxPasswordLen {
		return apperr.FieldError(field, "Must be at most 200 characters.")
	}
	return nil
}

// Slug checks the workspace slug pattern.
func Slug(field, s string) error {
	if len(s) == 0 || len(s) > MaxSlugLen || !slugRE.MatchString(s) {
		return apperr.FieldError(field, "Use lowercase letters, digits and single dashes (max 60 characters).")
	}
	return nil
}

// AvatarColor checks a #rrggbb colour.
func AvatarColor(field, s string) error {
	if !colorRE.MatchString(s) {
		return apperr.FieldError(field, "Must be a #rrggbb colour.")
	}
	return nil
}

// Title checks a page title (may be empty, max 500 characters).
func Title(field, s string) error {
	if utf8.RuneCountInString(s) > MaxTitleLen {
		return apperr.FieldError(field, "Must be at most 500 characters.")
	}
	return nil
}

// ShortString checks an optional short string such as an emoji icon.
func ShortString(field, s string, max int) error {
	if utf8.RuneCountInString(s) > max {
		return apperr.FieldError(field, "Is too long.")
	}
	return nil
}

// Slugify derives a slug from a free-form name ("My Team!" -> "my-team"). It may return "".
func Slugify(name string) string {
	var b strings.Builder
	lastDash := true
	for _, r := range strings.ToLower(name) {
		switch {
		case r < unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r)):
			b.WriteRune(r)
			lastDash = false
		case !lastDash:
			b.WriteByte('-')
			lastDash = true
		}
	}
	s := strings.Trim(b.String(), "-")
	if len(s) > MaxSlugLen {
		s = strings.Trim(s[:MaxSlugLen], "-")
	}
	return s
}

func hasControl(s string) bool {
	for _, r := range s {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}
