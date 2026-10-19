# Security and data handling

This is a single-owner, self-hosted application. The OAuth implementation has
regression tests, but has not received an independent security audit. Do not
operate it as a shared service without a separate security review.

## Credentials

Keep real values in hosting environment settings or a local `.env.local`.
`.env.example` deliberately contains no usable values. Never commit environment
files, database URLs, deployment exports, screenshots of credentials, or logs
containing authorization headers. Git ignore rules do not protect a file already
tracked by Git. Do not put server secrets in `NEXT_PUBLIC_` variables.

Workflowy credentials remain on the server. Database cache partitions use a hash
of the API key; this does not encrypt node contents. OAuth token and code hashes
are persisted rather than raw tokens. Client registration identifiers are public
signed metadata, not secret credentials.

## Data and permissions

- Sync can copy all accessible Workflowy nodes, titles, notes and hierarchy into
  Postgres. Search may trigger sync automatically. This is not a subtree boundary.
- Postgres also stores bookmarks, custom instructions/settings, synchronization
  metadata, diagnostic logs, and OAuth grants/token metadata.
- Search logging records query length rather than the query text. Error messages
  and other diagnostic data still need review before sharing. Redaction is not a
  guarantee that arbitrary content is safe to publish.
- OAuth and static bearer access permit every exposed tool, including edits,
  moves and deletion. There is no read-only permission mode or automatic backup.
- Logging out of the web console does not revoke OAuth grants. Use
  `/oauth/connections` to revoke an approved connection.
- Rotating the admin secret or Workflowy API key invalidates existing OAuth
  grants. Admin-secret rotation also requires new client registration. Rotating
  an API key does not delete the cache and logs stored for its old key.
- OAuth approval limits failed secret attempts. The separate admin login does
  not currently throttle attempts; configure protection at the hosting layer.
- `ALLOWED_ORIGINS` is an origin check, not an authentication replacement.

## Suspected exposure or vulnerability

Do not post live secrets, private outlines, database dumps, or exploitable details
in public issues. Use GitHub private vulnerability reporting if the repository
has it enabled. If no private channel is offered, ask the maintainer to establish
one without disclosing sensitive details publicly.

For an exposed credential, revoke or rotate it at its issuing service, then
review access and stored data. Deleting a file or rewriting a branch does not
remove copies, forks, or necessarily make old commit URLs inaccessible.
