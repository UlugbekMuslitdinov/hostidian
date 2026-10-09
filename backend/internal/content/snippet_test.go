package content

import "testing"

func TestMarkSnippetEscapesTextAndMarksMatches(t *testing.T) {
	in := "a <script>alert(1)</script> & roadmap"
	want := "a &lt;script&gt;alert(1)&lt;/script&gt; &amp; <mark>road</mark>map"
	if got := MarkSnippet(in); got != want {
		t.Fatalf("MarkSnippet() = %q, want %q", got, want)
	}
}
