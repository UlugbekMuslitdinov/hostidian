package auth

import (
	"strings"
	"testing"
	"time"
)

func TestHasherDefaultParameters(t *testing.T) {
	h := NewHasher(HashParams{})
	enc, err := h.Hash("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	// conventions §2: argon2id, 64 MiB, t=3, p=2, PHC string
	if !strings.HasPrefix(enc, "$argon2id$v=19$m=65536,t=3,p=2$") {
		t.Fatalf("PHC string %q does not carry the mandated parameters", enc)
	}
	enc2, _ := h.Hash("correct horse battery")
	if enc == enc2 {
		t.Fatal("salts must differ")
	}
	if !h.Verify("correct horse battery", enc) || h.Verify("correct horse batterY", enc) {
		t.Fatal("verify is wrong")
	}
}

func TestHasherVerifyUsesStoredParameters(t *testing.T) {
	weak := NewHasher(HashParams{MemoryKiB: 64, Time: 1, Threads: 1})
	enc, _ := weak.Hash("pw")
	// a hasher configured differently still verifies old hashes (parameters come from the PHC string)
	if !NewHasher(HashParams{}).Verify("pw", enc) {
		t.Fatal("hash with other parameters did not verify")
	}
}

func TestHasherRejectsMalformedHashes(t *testing.T) {
	h := NewHasher(HashParams{MemoryKiB: 64, Time: 1, Threads: 1})
	for _, bad := range []string{
		"", "plain", "$argon2id$", "$argon2i$v=19$m=64,t=1,p=1$AAAA$AAAA", "$argon2id$v=18$m=64,t=1,p=1$AAAA$AAAA",
		"$argon2id$v=19$m=64,t=1$AAAA$AAAA", "$argon2id$v=19$m=x,t=1,p=1$AAAA$AAAA", "$argon2id$v=19$m=64,t=1,p=1$!!$AAAA",
		"$argon2id$v=19$m=4294967295,t=1,p=1$AAAA$AAAA", // would allocate gigabytes
		"$argon2id$v=19$m=64,t=0,p=1$AAAA$AAAA",
	} {
		if h.Verify("x", bad) {
			t.Errorf("malformed hash %q verified", bad)
		}
	}
}

func TestLimiter(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	l := NewLimiter(10, 15*time.Minute, func() time.Time { return now })

	for i := 0; i < 10; i++ {
		if !l.Allow("a") {
			t.Fatalf("attempt %d should be allowed", i+1)
		}
	}
	if l.Allow("a") {
		t.Fatal("11th attempt must be refused")
	}
	if !l.Allow("b") {
		t.Fatal("keys are independent")
	}
	// refills evenly: 10 per 15 minutes = one per 90 s
	now = now.Add(89 * time.Second)
	if l.Allow("a") {
		t.Fatal("not refilled yet")
	}
	now = now.Add(2 * time.Second)
	if !l.Allow("a") {
		t.Fatal("one attempt should have refilled")
	}
	if l.Allow("a") {
		t.Fatal("only one")
	}
	now = now.Add(15 * time.Minute)
	for i := 0; i < 10; i++ {
		if !l.Allow("a") {
			t.Fatalf("after a full window attempt %d should be allowed", i+1)
		}
	}

	l.Reset("a")
	if !l.Allow("a") {
		t.Fatal("reset must forget the key")
	}
	// idle keys are swept
	now = now.Add(time.Hour)
	l.Sweep()
	l.mu.Lock()
	n := len(l.entries)
	l.mu.Unlock()
	if n != 0 {
		t.Fatalf("%d entries left after sweep", n)
	}
}
