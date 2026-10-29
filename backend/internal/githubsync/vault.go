// Package githubsync keeps a workspace and one GitHub repository's issues in sync, in both directions.
//
// Each issue is a page under a per-connection root page. A snapshot of the last agreed title, body and
// state (github_issue_links.base_*) turns every later difference into "changed here", "changed there" or
// "changed on both sides", which is what makes the sync loop-free: a value we just wrote equals the snapshot
// on the next pass and is ignored. See docs/github-sync.md.
package githubsync

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
)

// Vault encrypts the secrets stored per connection (access token, webhook secret) with AES-256-GCM.
// The key is derived from APP_SECRET, so rotating APP_SECRET invalidates stored tokens: admins have to
// re-enter them.
type Vault struct {
	aead cipher.AEAD
}

// NewVault derives the key from appSecret.
func NewVault(appSecret string) (*Vault, error) {
	if appSecret == "" {
		return nil, errors.New("githubsync: APP_SECRET is required to store GitHub tokens")
	}
	key := sha256.Sum256([]byte("hostidian/github-sync/v1\x00" + appSecret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, fmt.Errorf("githubsync: cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("githubsync: gcm: %w", err)
	}
	return &Vault{aead: aead}, nil
}

// Seal returns nonce || ciphertext.
func (v *Vault) Seal(plain []byte) ([]byte, error) {
	nonce := make([]byte, v.aead.NonceSize(), v.aead.NonceSize()+len(plain)+v.aead.Overhead())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("githubsync: nonce: %w", err)
	}
	return v.aead.Seal(nonce, nonce, plain, nil), nil
}

// Open reverses Seal. It fails when the blob was tampered with or sealed under another APP_SECRET.
func (v *Vault) Open(blob []byte) ([]byte, error) {
	n := v.aead.NonceSize()
	if len(blob) < n+v.aead.Overhead() {
		return nil, errors.New("githubsync: stored secret is malformed")
	}
	plain, err := v.aead.Open(nil, blob[:n], blob[n:], nil)
	if err != nil {
		return nil, errors.New("githubsync: cannot decrypt stored secret (was APP_SECRET changed?)")
	}
	return plain, nil
}
