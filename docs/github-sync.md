# GitHub issue sync

Two-way sync between a workspace and the issues of a GitHub repository. Every issue is a page; edits, state
changes and comments flow in both directions. Projects (boards) are not synced yet.

## Set up

1. As a workspace **owner or admin**: *Settings → GitHub → Connect a repository*.
2. Enter `owner/name` (or the repository URL) and a personal access token:
   - fine-grained token: repository access to that repo with **Issues: Read and write** (Metadata: Read is implied);
   - classic token: the `repo` scope (`public_repo` for public repositories).
3. The token is checked against GitHub, stored encrypted, and the existing issues are imported (open and closed;
   pull requests are skipped). The import is idempotent: each issue is keyed by `(connection, issue number)`.
4. *Optional, for instant updates:* in the repository, *Settings → Webhooks → Add webhook* with the payload URL and
   secret shown on the connection, content type `application/json`, and the events **Issues** and
   **Issue comments**. Without a webhook GitHub changes arrive about once a minute. The instance must be reachable
   from the internet for webhooks; polling works everywhere.

A workspace can connect several repositories. Disconnecting keeps all pages and deletes nothing on GitHub.

## What maps to what

| GitHub | Hostidian |
|---|---|
| Issue | A page under the root page **GitHub: owner/repo** |
| Title / description | Page title / page body (Markdown) |
| Open / closed | The page icon (🟢 / 🟣) and the badge in the page's GitHub bar; *Close issue* / *Reopen issue* buttons push to GitHub |
| Comments | One page-level comment thread called **GitHub** (pinned first in the comments panel) |
| `#123` | `[[#123]]` or `[[repo#123]]` in the `[[` page picker finds the page; links to synced pages are sent to GitHub as `#123` |

Creating a page under the root page (with a title) opens a new issue after about 30 seconds of quiet. A custom icon
you pick is never overwritten by the state icons.

Every synced page shows a header with the issue (`owner/repo#123`, a link), its state, *Synced 3 min ago*, and — if
the last attempt failed — the reason, with a *Retry* button for admins.

## How conflicts and loops are handled

The sync keeps a snapshot of what both sides last agreed on (title, state, and a hash of the body in each side's own
form). Every pass compares each side with the snapshot:

- changed on one side only → copied to the other side;
- changed on both sides to the same value → nothing to do;
- changed on both sides to different values → the more recent edit wins (page `updated_at` against GitHub's
  `updated_at`); ties go to GitHub. Different fields never conflict (a title edit here and a description edit there both survive).

Because the snapshot is updated after every transfer, a value we just wrote looks "unchanged" on the next pass, so
nothing ping-pongs — including when the editor re-formats Markdown on the way in (the page side and the GitHub side
are hashed separately). Hidden HTML comments (`<!-- hostidian:page:… -->`, `<!-- hostidian:comment:… -->`) let a re-run
recognise issues and comments it created if the process died before saving the link.

Local edits are pushed once the page has been quiet for 15 seconds (the editor saves every few seconds).

## Comments

Comments live in the page's **GitHub** thread (inline comment threads on blocks stay local).

- Written in Hostidian → posted to the issue with the workspace token, signed `via Hostidian, by <name>`.
- Written on GitHub → added to the thread, stored under the user who connected the repository and prefixed with
  `**@login** commented on GitHub`.
- Edits of GitHub comments are mirrored; deletions on GitHub are mirrored when the webhook is set up (the polling
  feed does not report deletions). Edits and deletions made on the Hostidian side are **not** sent to GitHub.
- Comments longer than 10 000 characters are truncated in Hostidian.

## Attribution

All GitHub writes use the one token, so they appear as the token's owner. GitHub-originated edits appear in
Hostidian as the user who connected the repository (or last replaced the token). That user must remain an owner or
admin of the workspace, otherwise the sync stops with an explanatory error until someone reconnects it.

## Limitations

- Pull requests, labels, assignees, milestones and Projects boards are not synced.
- A page deleted from the Trash for good comes back as a new page the next time its issue changes on GitHub.
  Archived (trashed) pages are skipped and catch up when restored.
- A page title is cut to GitHub's 256 characters.
- Issues transferred or deleted on GitHub show an error on their page; nothing is deleted locally.
- Rate limits: the sync backs off until GitHub's reset time. One poll per connection per minute needs a few API calls.
- The sync runs in the API process and assumes a single API instance (like the event stream).

## Security

- Tokens and webhook secrets are stored with AES-256-GCM; the key is derived from `APP_SECRET`. **Rotating
  `APP_SECRET` makes stored tokens unreadable** — admins must use *Replace token* on each connection afterwards.
- **Who can read the issues:** the synced pages inherit the access of their root page, which by default is every
  non-guest member of the workspace. Connecting a *private* repository therefore shares its issues with all of them;
  restrict the root page (*Share* menu) first if that is not what you want.
- The token is write-only: no API response ever contains it. The webhook secret is shown to owners/admins only.
- Webhook deliveries are authenticated with `X-Hub-Signature-256` (HMAC-SHA256, constant-time compare) before any
  data is read; the payload is used only for routing and everything is re-read through the API.
- The repository name is restricted to GitHub's character set before it reaches an API URL.

## API

Public endpoints are in `api/openapi.yaml` (tag `integrations`): connections are managed by workspace owners/admins;
`GET /workspaces/{id}/github-issues` and `PageDetail.github` are available to anyone who can view the page.
The webhook endpoint `POST /api/integrations/github/webhook/{connectionId}` is deliberately not in the contract: it
has no session and is authenticated by signature only (like `/api/mcp`).
