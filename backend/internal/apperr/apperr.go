// Package apperr defines the error type shared by the domain services and the HTTP layer.
// An *Error maps 1:1 onto the error envelope of docs/conventions.md §1.
package apperr

import (
	"errors"
	"net/http"
)

// Codes of the error envelope (conventions §1).
const (
	CodeBadRequest      = "bad_request"
	CodeUnauthorized    = "unauthorized"
	CodeForbidden       = "forbidden"
	CodeNotFound        = "not_found"
	CodeConflict        = "conflict"
	CodePayloadTooLarge = "payload_too_large"
	CodeValidation      = "validation_failed"
	CodeRateLimited     = "rate_limited"
	CodeInternal        = "internal"
)

// Error is a client-facing failure. Message and Details are sent to the client verbatim, so they
// must never contain internals; Cause (if any) is only logged.
type Error struct {
	Status  int
	Code    string
	Message string
	Details map[string]string
	Cause   error
}

func (e *Error) Error() string {
	if e.Cause != nil {
		return e.Code + ": " + e.Message + ": " + e.Cause.Error()
	}
	return e.Code + ": " + e.Message
}

func (e *Error) Unwrap() error { return e.Cause }

func New(status int, code, message string) *Error {
	return &Error{Status: status, Code: code, Message: message}
}

func BadRequest(message string) *Error { return New(http.StatusBadRequest, CodeBadRequest, message) }
func Unauthorized(message string) *Error {
	return New(http.StatusUnauthorized, CodeUnauthorized, message)
}
func Forbidden(message string) *Error { return New(http.StatusForbidden, CodeForbidden, message) }
func NotFound(message string) *Error  { return New(http.StatusNotFound, CodeNotFound, message) }
func Conflict(message string) *Error  { return New(http.StatusConflict, CodeConflict, message) }
func RateLimited(message string) *Error {
	return New(http.StatusTooManyRequests, CodeRateLimited, message)
}

func PayloadTooLarge(message string) *Error {
	return New(http.StatusRequestEntityTooLarge, CodePayloadTooLarge, message)
}

// Validation builds a 422. details maps field name -> message and may be nil.
func Validation(message string, details map[string]string) *Error {
	e := New(http.StatusUnprocessableEntity, CodeValidation, message)
	e.Details = details
	return e
}

// FieldError is shorthand for a validation failure on a single field.
func FieldError(field, message string) *Error {
	return Validation(message, map[string]string{field: message})
}

// Internal wraps an unexpected failure. The cause is kept for logging but never sent to clients.
func Internal(cause error) *Error {
	return &Error{Status: http.StatusInternalServerError, Code: CodeInternal, Message: "Something went wrong.", Cause: cause}
}

// As reports whether err is (or wraps) an *Error.
func As(err error) (*Error, bool) {
	var e *Error
	if errors.As(err, &e) {
		return e, true
	}
	return nil, false
}

// Wrap passes *Error values through untouched and turns anything else into a 500.
func Wrap(err error) *Error {
	if err == nil {
		return nil
	}
	if e, ok := As(err); ok {
		return e
	}
	return Internal(err)
}
