package shares

import (
	"encoding/json"
	"testing"
)

func TestSanitizePageLinksHidesTitlesOutsideTheShare(t *testing.T) {
	const inside = "11111111-1111-1111-1111-111111111111"
	const outside = "22222222-2222-2222-2222-222222222222"
	raw := `[{"type":"paragraph","content":[
	  {"type":"text","text":"see ","styles":{}},
	  {"type":"pageLink","props":{"pageId":"` + inside + `","title":"Public sibling"}},
	  {"type":"pageLink","props":{"pageId":"` + outside + `","title":"Secret roadmap"}}],
	 "children":[{"type":"table","content":{"type":"tableContent","rows":[{"cells":[[
	  {"type":"pageLink","props":{"pageId":"` + outside + `","title":"Secret roadmap"}}]]}]}}]}]`
	var blocks []any
	if err := json.Unmarshal([]byte(raw), &blocks); err != nil {
		t.Fatal(err)
	}
	got := sanitizePageLinks(blocks, map[string]bool{inside: true})
	out, _ := json.Marshal(got)
	s := string(out)
	if contains(s, "Secret roadmap") || contains(s, outside) {
		t.Fatalf("outside link leaked: %s", s)
	}
	if !contains(s, "Public sibling") || !contains(s, inside) {
		t.Fatalf("inside link was removed: %s", s)
	}
	if !contains(s, "unavailable page") {
		t.Fatalf("no placeholder text: %s", s)
	}
}

func contains(s, sub string) bool { return len(sub) > 0 && indexOf(s, sub) >= 0 }

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
