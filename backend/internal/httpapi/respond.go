package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"hostidian/backend/internal/apperr"
)

// maxJSONBody caps JSON request bodies (uploads use their own limits).
const maxJSONBody = 1 << 20

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string            `json:"code"`
	Message string            `json:"message"`
	Details map[string]string `json:"details,omitempty"`
}

// writeJSON writes v as the JSON response body.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	// Encoding errors can only mean the client went away; headers are already sent.
	_ = json.NewEncoder(w).Encode(v)
}

func noContent(w http.ResponseWriter) { w.WriteHeader(http.StatusNoContent) }

// writeAppError sends the error envelope of conventions §1.
func writeAppError(w http.ResponseWriter, e *apperr.Error) {
	if e.Status == http.StatusTooManyRequests {
		w.Header().Set("Retry-After", "90") // the limiter refills one attempt every 90 seconds
	}
	writeJSON(w, e.Status, errorBody{Error: errorDetail{Code: e.Code, Message: e.Message, Details: e.Details}})
}

// writeError turns any error into the envelope; unexpected errors become a logged 500 that never
// leaks internals.
func (s *Server) writeError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, context.Canceled) && r.Context().Err() != nil {
		return // the client went away
	}
	e, ok := apperr.As(err)
	if !ok {
		e = apperr.Internal(err)
	}
	if e.Status >= 500 {
		s.Log.Error("request failed", "request_id", requestIDFrom(r.Context()), "method", r.Method, "path", routePattern(r), "err", err)
	}
	writeAppError(w, e)
}

// errEmptyBody is returned by decodeJSON for a request without any body.
var errEmptyBody = apperr.BadRequest("A JSON body is required.")

// decodeJSON reads the request body into T. Unknown fields are ignored; trailing data is rejected.
func decodeJSON[T any](w http.ResponseWriter, r *http.Request) (T, error) {
	var v T
	body := http.MaxBytesReader(w, r.Body, maxJSONBody)
	dec := json.NewDecoder(body)
	if err := dec.Decode(&v); err != nil {
		var tooLarge *http.MaxBytesError
		switch {
		case errors.As(err, &tooLarge):
			return v, apperr.PayloadTooLarge("The request body is too large.")
		case errors.Is(err, io.EOF):
			return v, errEmptyBody
		default:
			return v, apperr.BadRequest("The request body is not valid JSON for this endpoint.")
		}
	}
	if dec.More() {
		return v, apperr.BadRequest("The request body must contain a single JSON value.")
	}
	return v, nil
}

// optional distinguishes an absent JSON field from an explicit null (for PATCH-style bodies).
type optional[T any] struct {
	Set   bool
	Value *T // nil when the field was null
}

func (o *optional[T]) UnmarshalJSON(b []byte) error {
	o.Set = true
	if string(b) == "null" {
		o.Value = nil
		return nil
	}
	var v T
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	o.Value = &v
	return nil
}

// fieldRequired is the 422 for a missing required body field.
func fieldRequired(field string) error {
	return apperr.FieldError(field, "This field is required.")
}
