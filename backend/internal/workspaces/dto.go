package workspaces

import (
	openapi_types "github.com/oapi-codegen/runtime/types"

	"hostidian/backend/internal/db/sqlcgen"
	"hostidian/backend/internal/httpapi/gen"
)

// ToGen converts a workspace row to its API shape.
func ToGen(w sqlcgen.Workspace) gen.Workspace {
	return gen.Workspace{Id: w.ID, Name: w.Name, Slug: w.Slug, Icon: w.Icon, CreatedAt: w.CreatedAt}
}

// MembershipToGen converts a workspace + the caller's role to the API shape.
func MembershipToGen(w sqlcgen.Workspace, role string) gen.WorkspaceMembership {
	return gen.WorkspaceMembership{Workspace: ToGen(w), Role: gen.WorkspaceRole(role)}
}

func inviteToGen(inv sqlcgen.Invite, publicURL string) gen.Invite {
	return gen.Invite{
		Id:        inv.ID,
		Token:     inv.Token,
		Url:       publicURL + "/invite/" + inv.Token,
		Role:      gen.InviteRole(inv.Role),
		Email:     inv.Email,
		ExpiresAt: inv.ExpiresAt,
		CreatedAt: inv.CreatedAt,
	}
}

func emailOf(s string) openapi_types.Email { return openapi_types.Email(s) }
