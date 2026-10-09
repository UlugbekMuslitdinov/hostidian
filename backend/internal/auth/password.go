package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"runtime"
	"strconv"
	"strings"

	"golang.org/x/crypto/argon2"
)

// HashParams are the argon2id cost parameters.
type HashParams struct {
	MemoryKiB uint32
	Time      uint32
	Threads   uint8
}

// DefaultHashParams are mandated by conventions §2 (64 MiB, t=3, p=2).
var DefaultHashParams = HashParams{MemoryKiB: 64 * 1024, Time: 3, Threads: 2}

const (
	saltLen = 16
	keyLen  = 32
)

// Hasher hashes and verifies passwords with argon2id and PHC-encoded output. A semaphore bounds
// the number of concurrent hashes, because each one needs 64 MiB of memory.
type Hasher struct {
	params HashParams
	sem    chan struct{}
}

// NewHasher builds a Hasher; zero params fall back to DefaultHashParams.
func NewHasher(p HashParams) *Hasher {
	if p == (HashParams{}) {
		p = DefaultHashParams
	}
	n := runtime.GOMAXPROCS(0)
	if n < 2 {
		n = 2
	}
	if n > 8 {
		n = 8
	}
	return &Hasher{params: p, sem: make(chan struct{}, n)}
}

// Hash returns the PHC string `$argon2id$v=19$m=…,t=…,p=…$salt$hash`.
func (h *Hasher) Hash(password string) (string, error) {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("read salt: %w", err)
	}
	key := h.derive(password, salt, h.params)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, h.params.MemoryKiB, h.params.Time, h.params.Threads,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key)), nil
}

// Verify checks password against a PHC string in constant time. Malformed hashes never match.
func (h *Hasher) Verify(password, encoded string) bool {
	params, salt, want, ok := parsePHC(encoded)
	if !ok {
		return false
	}
	got := h.derive(password, salt, params)
	return subtle.ConstantTimeCompare(got, want) == 1
}

func (h *Hasher) derive(password string, salt []byte, p HashParams) []byte {
	h.sem <- struct{}{}
	defer func() { <-h.sem }()
	return argon2.IDKey([]byte(password), salt, p.Time, p.MemoryKiB, p.Threads, keyLen)
}

func parsePHC(encoded string) (p HashParams, salt, key []byte, ok bool) {
	parts := strings.Split(encoded, "$")
	// ["", "argon2id", "v=19", "m=65536,t=3,p=2", salt, hash]
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != fmt.Sprintf("v=%d", argon2.Version) {
		return p, nil, nil, false
	}
	for _, kv := range strings.Split(parts[3], ",") {
		k, v, found := strings.Cut(kv, "=")
		if !found {
			return p, nil, nil, false
		}
		n, err := strconv.ParseUint(v, 10, 32)
		if err != nil {
			return p, nil, nil, false
		}
		switch k {
		case "m":
			p.MemoryKiB = uint32(n)
		case "t":
			p.Time = uint32(n)
		case "p":
			if n > 255 {
				return p, nil, nil, false
			}
			p.Threads = uint8(n)
		}
	}
	// Refuse absurd parameters from a corrupted row instead of allocating gigabytes.
	if p.MemoryKiB == 0 || p.MemoryKiB > 1<<20 || p.Time == 0 || p.Time > 20 || p.Threads == 0 {
		return p, nil, nil, false
	}
	var err error
	if salt, err = base64.RawStdEncoding.DecodeString(parts[4]); err != nil || len(salt) == 0 {
		return p, nil, nil, false
	}
	if key, err = base64.RawStdEncoding.DecodeString(parts[5]); err != nil || len(key) == 0 {
		return p, nil, nil, false
	}
	return p, salt, key, true
}
