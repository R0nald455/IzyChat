// mcp-guard
//
// A minimal reverse proxy for MCP Streamable HTTP servers that recovers
// transparently from the well-known upstream bugs in @playwright/mcp
// (bundled inside playwright-core), where the server evicts a session the
// moment its HTTP transport disconnects and blocks the heartbeat ping
// during long-running tool calls, causing "Session not found" errors:
//   https://github.com/microsoft/playwright-mcp/issues/1140
//   https://github.com/microsoft/playwright-mcp/issues/1293
//
// LibreChat (the client) is never aware any of this happens: this proxy
// keeps the client-facing Mcp-Session-Id stable across backend session
// resets by caching each session's original "initialize" request and
// silently replaying it against the backend when a 404 shows up.
//
// Trade-off: replaying "initialize" gives the client a technically valid
// MCP session again, but any browser state (open tabs, navigated pages)
// held by the old session is gone — a retried tool call may still fail
// for a normal, recoverable reason (e.g. "no page open"). That is a
// world apart from the transport-level crash this proxy replaces.
//
// It also serializes tool calls per session: a single browser tab can only
// do one thing at a time, and dispatching e.g. browser_navigate and
// browser_snapshot concurrently against the same session is a known way
// to hang playwright-mcp forever (navigate invalidates the execution
// context a concurrent snapshot is still reading from). LibreChat may
// fire tool calls from one turn concurrently, so this proxy queues them
// per session and runs them one at a time instead of letting them race.

import http from 'node:http';

const BACKEND_URL = process.env.MCP_BACKEND_URL || 'http://playwright-mcp:8931/mcp';
const PORT = Number(process.env.PORT || 8932);
const SESSION_IDLE_TTL_MS = Number(process.env.SESSION_IDLE_TTL_MS || 2 * 60 * 60 * 1000);
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** @type {Map<string, { backendSessionId: string, initBody: Buffer, initHeaders: http.IncomingHttpHeaders, lastSeen: number }>} */
const sessions = new Map();

/** @type {Map<string, Promise<void>>} per-session queue tail, so tool calls never race each other */
const sessionQueues = new Map();

function enqueueForSession(sessionId, task) {
  if (!sessionId) return task();
  const previous = sessionQueues.get(sessionId) || Promise.resolve();
  const result = previous.then(task, task);
  sessionQueues.set(sessionId, result.then(() => undefined, () => undefined));
  return result;
}

function sweepIdleSessions() {
  const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
  for (const [id, entry] of sessions) {
    if (entry.lastSeen < cutoff) {
      sessions.delete(id);
      sessionQueues.delete(id);
    }
  }
}
setInterval(sweepIdleSessions, SWEEP_INTERVAL_MS).unref();

function isInitializeMessage(parsedBody) {
  if (!parsedBody) return false;
  const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  return messages.some((message) => message && message.method === 'initialize');
}

function buildOutboundHeaders(headers, sessionId) {
  const outbound = { ...headers };
  delete outbound['host'];
  delete outbound['content-length'];
  if (sessionId) {
    outbound['mcp-session-id'] = sessionId;
  } else {
    delete outbound['mcp-session-id'];
  }
  return outbound;
}

async function callBackend(method, body, headers, sessionId) {
  return fetch(BACKEND_URL, {
    method,
    headers: buildOutboundHeaders(headers, sessionId),
    body,
  });
}

function sanitizeResponseHeaders(fetchHeaders, clientSessionId) {
  const headersOut = Object.fromEntries(fetchHeaders);
  delete headersOut['content-length'];
  delete headersOut['content-encoding'];
  delete headersOut['transfer-encoding'];
  if (clientSessionId) headersOut['mcp-session-id'] = clientSessionId;
  return headersOut;
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function handleDelete(req, res) {
  const clientSessionId = req.headers['mcp-session-id'];
  const entry = clientSessionId ? sessions.get(clientSessionId) : undefined;
  const backendRes = await callBackend('DELETE', undefined, req.headers, entry ? entry.backendSessionId : clientSessionId);
  if (clientSessionId) {
    sessions.delete(clientSessionId);
    sessionQueues.delete(clientSessionId);
  }
  res.writeHead(backendRes.status, sanitizeResponseHeaders(backendRes.headers, clientSessionId));
  res.end();
}

async function handleInitialize(rawBody, req, res) {
  const backendRes = await callBackend('POST', rawBody, req.headers, undefined);
  const backendSessionId = backendRes.headers.get('mcp-session-id');
  const bodyText = await backendRes.text();
  if (backendSessionId) {
    sessions.set(backendSessionId, {
      backendSessionId,
      initBody: rawBody,
      initHeaders: req.headers,
      lastSeen: Date.now(),
    });
  }
  res.writeHead(backendRes.status, sanitizeResponseHeaders(backendRes.headers, backendSessionId));
  res.end(bodyText);
}

async function handleProxiedCall(rawBody, req, res) {
  const clientSessionId = req.headers['mcp-session-id'];
  const entry = clientSessionId ? sessions.get(clientSessionId) : undefined;
  const outboundBody = req.method === 'GET' ? undefined : rawBody;

  let backendRes = await callBackend(req.method, outboundBody, req.headers, entry ? entry.backendSessionId : clientSessionId);

  if (backendRes.status === 404 && entry) {
    const reinitRes = await callBackend('POST', entry.initBody, entry.initHeaders, undefined);
    const newBackendSessionId = reinitRes.headers.get('mcp-session-id');
    await reinitRes.text();
    if (newBackendSessionId) {
      console.log(`[mcp-guard] recovered dead session ${clientSessionId} -> ${newBackendSessionId}`);
      entry.backendSessionId = newBackendSessionId;
      entry.lastSeen = Date.now();
      backendRes = await callBackend(req.method, outboundBody, req.headers, newBackendSessionId);
    } else {
      console.warn(`[mcp-guard] failed to recover session ${clientSessionId}: reinitialize returned ${reinitRes.status}`);
    }
  } else if (entry) {
    entry.lastSeen = Date.now();
  }

  res.writeHead(backendRes.status, sanitizeResponseHeaders(backendRes.headers, clientSessionId));
  if (backendRes.body) {
    for await (const chunk of backendRes.body) res.write(chunk);
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
    res.writeHead(405).end();
    return;
  }

  try {
    if (req.method === 'DELETE') {
      await handleDelete(req, res);
      return;
    }

    const rawBody = await readRequestBody(req);
    let parsedBody;
    try {
      parsedBody = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : undefined;
    } catch {
      parsedBody = undefined;
    }

    if (isInitializeMessage(parsedBody)) {
      await handleInitialize(rawBody, req, res);
      return;
    }

    const clientSessionId = req.headers['mcp-session-id'];
    if (req.method === 'GET') {
      // The GET stream is a long-lived SSE channel for server push, not a
      // request/response call — never queue it behind tool calls.
      await handleProxiedCall(rawBody, req, res);
    } else {
      await enqueueForSession(clientSessionId, () => handleProxiedCall(rawBody, req, res));
    }
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'bad_gateway', message: String((err && err.message) || err) }));
  }
});

server.listen(PORT, () => {
  console.log(`mcp-guard listening on :${PORT}, proxying to ${BACKEND_URL}`);
});
