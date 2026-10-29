package githubsync

import "time"

// Action says what to do with one field of a linked page/issue pair.
type Action int

const (
	// Keep: nothing to transfer. Either neither side changed, or both changed to the same value.
	Keep Action = iota
	// Pull: GitHub's value replaces the page's.
	Pull
	// Push: the page's value replaces GitHub's.
	Push
)

func (a Action) String() string { return [...]string{"keep", "pull", "push"}[a] }

// Base is what both sides last agreed on (github_issue_links.base_*).
type Base struct {
	Title          string
	State          string
	LocalBodyHash  string
	RemoteBodyHash string
}

// Side is one side's current value. BodyHash of the page side is taken after ToGitHub, so both hashes describe
// text in the form GitHub stores.
type Side struct {
	Title     string
	BodyHash  string
	UpdatedAt time.Time
}

// Plan is the outcome of Decide.
type Plan struct {
	Title, Body, State Action
}

// Decide classifies every field against the snapshot. A field that changed on one side only moves to the other
// side. A field that changed on both sides to different values goes to whichever side was edited last (page
// updated_at against GitHub updated_at); ties go to GitHub, the side that cannot be edited concurrently.
//
// State is pulled only: closing/reopening from Hostidian pushes straight to GitHub and updates the snapshot in
// the same step, so a page can never hold an unpushed state change.
func Decide(base Base, local, remote Side, remoteState string) Plan {
	remoteWins := !local.UpdatedAt.After(remote.UpdatedAt)
	pick := func(localChanged, remoteChanged, equal bool) Action {
		switch {
		case !localChanged && !remoteChanged, equal:
			return Keep
		case localChanged && !remoteChanged:
			return Push
		case !localChanged && remoteChanged:
			return Pull
		case remoteWins:
			return Pull
		default:
			return Push
		}
	}
	p := Plan{
		Title: pick(local.Title != base.Title, remote.Title != base.Title, local.Title == remote.Title),
		Body: pick(local.BodyHash != base.LocalBodyHash, remote.BodyHash != base.RemoteBodyHash,
			local.BodyHash == remote.BodyHash),
	}
	if remoteState != base.State {
		p.State = Pull
	}
	return p
}
