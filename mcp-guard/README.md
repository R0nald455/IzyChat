# mcp-guard

Reverse proxy that sits between LibreChat and an MCP Streamable HTTP server
(here: `playwright-mcp`) and recovers transparently from server-side session
eviction, working around these upstream bugs:

- https://github.com/microsoft/playwright-mcp/issues/1140 — session is
  deleted the instant the HTTP transport disconnects, even for a normal,
  transient reconnect.
- https://github.com/microsoft/playwright-mcp/issues/1293 — a hardcoded
  5-second ping timeout breaks the session during any tool call that runs
  longer than that.

## How it works

1. On the client's `initialize` call, mcp-guard forwards it to the backend,
   records the backend's `Mcp-Session-Id`, and caches the raw `initialize`
   request body/headers for that session.
2. On every later call, if the backend responds `404` (session not found),
   mcp-guard replays the cached `initialize` request to mint a fresh backend
   session, then retries the original call against it — all invisible to
   the client, which keeps seeing its original `Mcp-Session-Id`.

Browser state (open tabs/pages) from before the eviction is still lost — a
retried tool call can still fail for a normal MCP reason (e.g. "no page
open") — but that is a recoverable tool-level error instead of the
transport-level crash LibreChat was hitting.

## Config

- `MCP_BACKEND_URL` (default `http://playwright-mcp:8931/mcp`)
- `PORT` (default `8932`)
- `SESSION_IDLE_TTL_MS` (default 2h) — idle client sessions are forgotten
  after this long, to bound memory use.

`GET /healthz` returns `200 ok` for use as a Docker healthcheck.
