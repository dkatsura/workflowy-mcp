# Contributing

Use Node.js 22.18 or newer and the committed lockfile:

```sh
npm ci
npm test
npm run build
npm run test:transport
npm run test:oauth-http
```

These tests use synthetic credentials and isolated PGlite databases. They do not
prove a deployment can access real Workflowy or Neon accounts. `npm run test:db`
is a separate opt-in check against your configured database; read its script
before running it. Never use production credentials in pull request CI.

Keep fixtures and commit messages generic. Do not include personal project
names, actual node text, account identifiers, production URLs, or credentials.
Preserve upstream license notices. Use `.env.example` for variable names and
blank values; keep real settings local.

Before sharing changes, review `git diff` and staged filenames. With Gitleaks
installed, scan the working tree (including untracked files):

```sh
gitleaks dir . --redact --no-banner
```

A clean scan does not prove that no secrets exist. Also inspect history, binary
assets and any files excluded from the scanner when preparing a release. Avoid
broad allowlists that suppress credentials alongside dummy test values.
