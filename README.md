# Workflowy MCP

A remote, self-hosted MCP server for Workflowy. Deploy it to Vercel, store your Workflowy credentials server-side, and connect from MCP clients that support Streamable HTTP.

This is the hosted companion to [workflowy-local-mcp](https://github.com/rodolfo-terriquez/workflowy-local-mcp). Use the local app when you want everything to stay on your machine. Use this project when you want a remote MCP endpoint that works from places where a local MCP process is not available.

## Current State

This repo uses Workflowy's LLM Doc API for reading and editing outlines, plus a Neon-backed cache for search. It is designed for personal self-hosting rather than shared public access.

The deployed root page is an owner-only web console. After unlocking it with `ADMIN_SECRET`, you can:

- Check whether the hosted MCP connection is working
- Copy Streamable HTTP client configuration
- Customize the server instructions and tool descriptions returned to AI clients
- Manage Workflowy bookmarks stored in Neon
- Sync and search the hosted Workflowy cache
- View server and browser activity logs in one diagnostics view

Backups and desktop app controls are intentionally not included in this hosted version.

## MCP Tools

| Tool | Description |
| --- | --- |
| `list_bookmarks` | List saved Workflowy locations and load `ai_instructions` when configured |
| `save_bookmark` | Save a node ID, special target, or Workflowy link with context notes |
| `delete_bookmark` | Delete a saved bookmark by name |
| `read_doc` | Read a Workflowy node and its children through Workflowy's LLM Doc API |
| `edit_doc` | Batch insert, update, delete, or move nodes through Workflowy's LLM Doc API |
| `search_nodes` | Search the Neon-backed Workflowy cache, with safe auto-sync when empty or stale |
| `sync_nodes` | Refresh the Neon-backed cache from Workflowy's full export |
| `cache_status` | Show cache freshness and node count without running a search |
| `get_targets` | Fetch special Workflowy targets such as inbox and home/root |

The server also exposes a `server_instructions` MCP prompt. It combines the default Workflowy tool guidance, hosted deployment notes, web-console customizations, and the optional `ai_instructions` bookmark.

## How Auth Works

There are two separate secrets:

| Secret | Where it goes | What it protects |
| --- | --- | --- |
| `ADMIN_SECRET` | Vercel environment only; typed into the web console login | The owner-only web interface |
| `MCP_ACCESS_SECRET` | Vercel environment and your MCP client header | The `/api/mcp` endpoint |

Your Workflowy key is different:

| Value | Where it goes | Notes |
| --- | --- | --- |
| `WORKFLOWY_API_KEY` | Vercel environment only | The MCP client does not need this key |
| `DATABASE_URL` | Vercel environment only | Neon Postgres connection string |

Recommended MCP auth header:

```text
Authorization: Bearer YOUR_MCP_ACCESS_SECRET
```

The server verifies that bearer token against `MCP_ACCESS_SECRET`, then uses `WORKFLOWY_API_KEY` from the deployment environment. That means users do not need to paste their Workflowy API key into both the MCP client and the web console.

The web console login sets a signed, HTTP-only cookie that lasts 12 hours. The Workflowy API key is not stored in Neon or browser local storage. Bookmarks, cache rows, custom MCP settings, and server logs are stored in Neon under a SHA-256 hash of the Workflowy API key.

Legacy per-request key mode still works as `Authorization: Bearer MCP_ACCESS_SECRET:WORKFLOWY_API_KEY`, but new deployments should use the server-side `WORKFLOWY_API_KEY` flow above.

## Prerequisites

- A GitHub account
- A Vercel account
- A Neon Postgres database
- A Workflowy API key
- An MCP client that supports Streamable HTTP

## Get A Workflowy API Key

Create or copy your Workflowy API key from:

```text
https://beta.workflowy.com/api-reference/
```

Keep this key private. It belongs in your Vercel environment variables, not in your MCP client configuration.

## Deploy To Vercel

1. Fork this repository to your GitHub account.

2. Create a Neon database and copy its connection string.

3. Generate two strong secrets:

```sh
openssl rand -hex 32
openssl rand -hex 32
```

Use one value for `ADMIN_SECRET` and the other for `MCP_ACCESS_SECRET`.

4. Import the forked repository into Vercel.

5. Add these Vercel environment variables:

```text
DATABASE_URL=postgres://...
ADMIN_SECRET=your-admin-secret
MCP_ACCESS_SECRET=your-mcp-access-secret
WORKFLOWY_API_KEY=your-workflowy-api-key
```

Optional browser origin restriction:

```text
ALLOWED_ORIGINS=https://claude.ai
```

If `ALLOWED_ORIGINS` is unset, non-browser requests and browser requests are allowed. If it is set, browser-originated requests must match one of the comma-separated origins.

6. Deploy the project.

7. Open your deployed app:

```text
https://YOUR-VERCEL-APP.vercel.app/
```

8. Unlock the web console with `ADMIN_SECRET`.

9. Confirm the dashboard shows `Connected`. If it shows `Configuration issues`, check the Vercel environment variables and redeploy.

Your MCP endpoint is:

```text
https://YOUR-VERCEL-APP.vercel.app/api/mcp
```

Vercel automatically creates the Neon tables on first use.

## Connect An MCP Client

Use Streamable HTTP, not stdio.

Endpoint:

```text
https://YOUR-VERCEL-APP.vercel.app/api/mcp
```

Header:

```text
Authorization: Bearer YOUR_MCP_ACCESS_SECRET
```

Generic client shape:

```json
{
  "type": "streamable-http",
  "url": "https://YOUR-VERCEL-APP.vercel.app/api/mcp",
  "headers": {
    "Authorization": "Bearer YOUR_MCP_ACCESS_SECRET"
  }
}
```

Claude-style configuration:

```json
{
  "mcpServers": {
    "workflowy": {
      "type": "streamable-http",
      "url": "https://YOUR-VERCEL-APP.vercel.app/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_ACCESS_SECRET"
      }
    }
  }
}
```

The web console's Setup page can copy these templates for you. Replace the placeholder `MCP_ACCESS_SECRET` with the actual secret you saved in Vercel.

## Run With Docker

Vercel is the easiest hosted path, but the app can also run in a Docker container. You still need a reachable Postgres database, such as Neon, and the same environment variables.

Create a `Dockerfile`:

```dockerfile
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "run", "start"]
```

Build the image:

```sh
docker build -t workflowy-mcp .
```

Run it locally:

```sh
docker run --rm -p 3000:3000 \
  -e DATABASE_URL="postgres://..." \
  -e ADMIN_SECRET="your-admin-secret" \
  -e MCP_ACCESS_SECRET="your-mcp-access-secret" \
  -e WORKFLOWY_API_KEY="your-workflowy-api-key" \
  workflowy-mcp
```

Open the web console:

```text
http://localhost:3000/
```

Local Docker MCP endpoint:

```text
http://localhost:3000/api/mcp
```

For a remote Docker deployment, put the container behind HTTPS with a reverse proxy or hosting platform such as Caddy, nginx, Fly.io, Render, Railway, a VPS, or a cloud load balancer. MCP clients connecting over the internet should use an `https://` endpoint.

## First Setup In The Web Console

Recommended order:

1. Open the dashboard and confirm it says `Connected`.
2. Go to Setup and copy the client configuration into your MCP client.
3. Go to Bookmarks and save important Workflowy locations.
4. If you keep AI instructions in Workflowy, save that node as `ai_instructions`.
5. Go to Cache and run the first sync if you want search results immediately.
6. Go to Tools if you want to customize the server instructions or individual tool descriptions.
7. Use Diagnostics to inspect recent MCP tool calls and browser-side console activity.

## Recommended `ai_instructions` Bookmark

If you keep AI instructions in Workflowy, save that node as a bookmark named `ai_instructions`.

Example bookmark:

```json
{
  "name": "ai_instructions",
  "node_id": "YOUR_NODE_ID",
  "context": "Custom instructions to read at the start of every MCP session."
}
```

After that, `list_bookmarks` and the `server_instructions` prompt will include the readable instructions from that Workflowy node.

## Local Development

Install dependencies:

```sh
npm install
```

Create `.env.local`:

```text
DATABASE_URL=postgres://...
ADMIN_SECRET=dev-admin-secret
MCP_ACCESS_SECRET=dev-mcp-secret
WORKFLOWY_API_KEY=your-workflowy-api-key
```

Run Next.js:

```sh
npm run dev
```

Local app:

```text
http://localhost:3000/
```

Local MCP endpoint:

```text
http://localhost:3000/api/mcp
```

For local client testing, use:

```text
Authorization: Bearer dev-mcp-secret
```

## Operational Notes

- Vercel Fluid compute is recommended for long-lived MCP requests.
- The Workflowy `nodes-export` endpoint is rate limited to 1 request per minute.
- `sync_nodes` replaces the hosted cache for the configured Workflowy API key.
- `search_nodes` will attempt a safe auto-sync when the cache is empty or stale and the export rate limit allows it.
- Successful `edit_doc` calls trigger targeted cache refreshes for affected nodes and parent lists, then mark the full cache stale for later reconciliation.
- Server logs redact obvious secret, token, API key, password, and credential fields before storing metadata.
- This is a personal deployment model. For shared or multi-user hosting, add a stronger account/auth layer first.


## Fork maintenance and validation

This fork updates Next.js and the MCP transport dependencies and supports literal
Japanese substring searches in node titles and notes, alongside PostgreSQL
full-text ranking. Substring matching may scan the account's cache on large outlines.

Use Node.js 22.18 or newer. Install from the committed lockfile with `npm ci`.
The `mcp-handler` 1.1.0 release pins SDK 1.26.0; this fork overrides that pin with
the patched SDK selected in `package.json`. Keep the transport smoke tests when
updating either package. PostCSS is overridden to a patched 8.5 release as well.
Tool-description registrations are scoped to each MCP server instance.

Validation:

```sh
npm test
npm run build
npm run test:transport
npm audit
```

Search tests execute the production SQL against PGlite (PostgreSQL in WASM),
including Japanese text, account isolation, completed items and literal special
characters. Transport tests exercise the built Next.js route with SDK clients
in memory, including concurrent clients, bearer authentication and signed admin
cookies. They use dummy credentials and make no Workflowy or Neon requests.
A deployed HTTPS connection and real Workflowy/Neon reads and writes still need
separate validation.

### Data and access boundaries

This remains a personal, single-owner server. `search_nodes` can automatically
export all accessible Workflowy nodes into your Neon database. Node titles and
notes are stored as readable database fields; the hashed API key is an account
identifier, not encryption of note contents. Changing an API key does not delete
cache rows belonging to the previous key. Manage old data in your own database.

The MCP secret grants all exposed tools, including node deletion and moves.
This fork does not add subtree restrictions, a read-only mode, login throttling,
or backups. Keep the admin and MCP secrets distinct and random. Set
`ALLOWED_ORIGINS` for browser clients, and configure hosting-level rate limits.

### Neon project setup

`neon.ts` declares a Postgres-only setup with Auth disabled. The project and
branch link is stored in the git-ignored `.neon`; credentials belong in
`.env.local` (also ignored). Existing handlers already read `DATABASE_URL`
with the Neon HTTP driver, so no additional backend service is required.

After linking and deploying the Neon configuration, run `npm run test:db`
with Node.js 22.18 or newer. It runs the production search SQL against the
configured database using synthetic rows in a transaction-local temporary
table. The test checks Japanese title/note search and account isolation;
the temporary table is dropped at transaction completion. It does not call
Workflowy or populate the persistent cache. Full application verification
still requires the admin/MCP secrets, the Workflowy API key and a running
HTTP server.
