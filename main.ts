// koyuki-forge: a GitHub-compatible git forge in one Node process.
//
// Boot contract (the trial harness): bind an ephemeral port (never 8080),
// POST {"port": N} to $MAKEFUN_ENV_URL/register, serve until the harness
// answers {"done": true} on $MAKEFUN_ENV_URL/done, then exit 0.
//
// Surfaces:
//   /{owner}/{repo}.git/...   git smart HTTP (upload-pack v2/v0, receive-pack)
//   /api/v3/...               REST v3
//   /api/graphql              GraphQL
//   /mcp                      MCP (JSON-RPC over streamable HTTP)
//   /healthz                  the harness's boot probe (no auth)
//
// Every API surface authenticates with `Authorization: Bearer
// $MAKEFUN_SHOP_TOKEN`; a missing or wrong token is a 401. A repository
// belongs to the login the token names; any other owner is a 404.

import { createServer } from 'node:http';
import { Forge } from './src/store.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './src/gitproto.ts';

const forge = new Forge();
const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let requestCounter = 0;

function isAuthorized(req) {
  if (!expectedToken) return true;
  return req.headers.authorization === `Bearer ${expectedToken}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, body, extraHeaders = {}) {
  requestCounter += 1;
  const headers = {
    'content-type': 'application/json',
    'x-github-request-id': `req-${requestCounter}`,
    ...extraHeaders,
  };
  if (body === undefined || body === null) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  headers['content-length'] = payload.length;
  res.writeHead(status, headers);
  res.end(payload);
}

function sendRaw(res, status, contentType, body) {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

async function route(req, res) {
  const url = new URL(req.url ?? '/', 'http://forge.invalid');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/healthz') {
    sendRaw(res, 200, 'application/json', Buffer.from('{"ok":true}', 'utf8'));
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
  if (gitMatch) {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const owner = decodeURIComponent(gitMatch[1]);
    const repoName = decodeURIComponent(gitMatch[2]);
    const repo = forge.getRepo(owner, repoName);
    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const endpoint = gitMatch[3];
    if (endpoint === 'info/refs') {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'service parameter required' });
        return;
      }
      const result = handleInfoRefs(repo, service, req.headers['git-protocol']);
      sendRaw(res, result.status, result.contentType, result.body);
      return;
    }
    const body = await readBody(req);
    const result = endpoint === 'git-upload-pack'
      ? handleUploadPack(repo, body)
      : handleReceivePack(repo, body);
    sendRaw(res, result.status, result.contentType, result.body);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const raw = await readBody(req);
    let body = {};
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
    }
    const result = handleRest(forge, {
      method,
      path,
      query: url.searchParams,
      body,
      host: req.headers.host ?? 'forge.invalid',
    });
    if (result.status === 204) {
      sendJson(res, 204, undefined, result.headers ?? {});
      return;
    }
    sendJson(res, result.status, result.body, result.headers ?? {});
    return;
  }

  if (path === '/api/graphql') {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { errors: [{ message: 'Unauthorized' }] });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 400, { errors: [{ message: 'GraphQL only accepts POST' }] });
      return;
    }
    const raw = await readBody(req);
    const result = handleGraphQL(forge, raw.toString('utf8'));
    sendJson(res, result.status, result.body);
    return;
  }

  if (path === '/mcp') {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
      return;
    }
    if (method === 'DELETE') {
      sendJson(res, 200, {});
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed' } });
      return;
    }
    const raw = await readBody(req);
    const result = handleMcp(forge, raw.toString('utf8'));
    if (result.body === null || result.body === undefined) {
      res.writeHead(result.status);
      res.end();
      return;
    }
    sendJson(res, result.status, result.body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

const server = createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error('request failed:', err);
    if (!res.headersSent) {
      try {
        sendJson(res, 500, { message: 'Internal server error' });
      } catch {
        // The socket is gone; nothing more to do.
      }
    } else {
      res.destroy();
    }
  });
});
server.on('error', (err) => {
  console.error('server error:', err);
});

async function registerAndPoll(port) {
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/$/, '');
  if (!envUrl) {
    console.log(`koyuki-forge listening on 127.0.0.1:${port} (no env URL; serving standalone)`);
    return;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok || response.status === 409) break;
    } catch {
      // The harness may need a moment; keep trying inside the boot budget.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.log(`koyuki-forge registered port ${port}`);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    try {
      const response = await fetch(`${envUrl}/done`);
      if (!response.ok) continue;
      const state = await response.json();
      if (state && state.done === true) break;
    } catch {
      // Transient harness hiccup; keep polling.
    }
  }
  console.log('koyuki-forge: harness reports done; exiting');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  registerAndPoll(port).catch((err) => {
    console.error('lifecycle failed:', err);
  });
});
