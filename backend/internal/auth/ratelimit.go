package auth

import (
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// Limiter is an in-memory token-bucket limiter keyed by string: `burst` attempts, refilled evenly
// over `window` (conventions §2: 10 attempts / 15 min per IP + email).
type Limiter struct {
	burst  int
	window time.Duration
	now    func() time.Time

	mu      sync.Mutex
	entries map[string]*limiterEntry
}

type limiterEntry struct {
	lim  *rate.Limiter
	seen time.Time
}

// NewLimiter returns a limiter allowing burst attempts per window. now may be nil (time.Now).
func NewLimiter(burst int, window time.Duration, now func() time.Time) *Limiter {
	if now == nil {
		now = time.Now
	}
	return &Limiter{burst: burst, window: window, now: now, entries: map[string]*limiterEntry{}}
}

// Allow consumes one attempt for key and reports whether it was within the limit.
func (l *Limiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	e, ok := l.entries[key]
	if !ok {
		e = &limiterEntry{lim: rate.NewLimiter(rate.Every(l.window/time.Duration(l.burst)), l.burst)}
		l.entries[key] = e
	}
	e.seen = now
	return e.lim.AllowN(now, 1)
}

// Reset forgets key (called after a successful login).
func (l *Limiter) Reset(key string) {
	l.mu.Lock()
	delete(l.entries, key)
	l.mu.Unlock()
}

// Sweep drops entries that have been idle for longer than the window (their bucket is full again).
func (l *Limiter) Sweep() {
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := l.now().Add(-l.window)
	for k, e := range l.entries {
		if e.seen.Before(cutoff) {
			delete(l.entries, k)
		}
	}
}
