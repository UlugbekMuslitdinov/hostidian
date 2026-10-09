package shares

import "strings"

// unavailableLink replaces a page link whose target is outside the shared subtree: the stored node carries
// the target's title, which must not leak through a public page.
func unavailableLink() map[string]any {
	return map[string]any{"type": "text", "text": "unavailable page", "styles": map[string]any{}}
}

// sanitizePageLinks walks BlockNote JSON and replaces every `pageLink` inline node whose pageId is not in
// allowed (lower-case uuid strings) with plain text. It mutates maps and slices in place and returns the
// (possibly replaced) value.
func sanitizePageLinks(v any, allowed map[string]bool) any {
	switch t := v.(type) {
	case []any:
		for i := range t {
			t[i] = sanitizePageLinks(t[i], allowed)
		}
		return t
	case map[string]any:
		if typ, _ := t["type"].(string); typ == "pageLink" {
			props, _ := t["props"].(map[string]any)
			id, _ := props["pageId"].(string)
			if !allowed[strings.ToLower(id)] {
				return unavailableLink()
			}
			return t
		}
		for k, val := range t {
			t[k] = sanitizePageLinks(val, allowed)
		}
		return t
	}
	return v
}
