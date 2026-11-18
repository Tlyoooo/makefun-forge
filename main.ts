// github-forge — a GitHub-compatible git forge in one Node process.
//
// Boot contract (make.fun agent/v1): bind an ephemeral port, POST
// {"port": N} to $MAKEFUN_ENV_URL/register, poll $MAKEFUN_ENV_URL/done until
// it answers {"done": true}, then exit 0. GET /healthz answers 200
// {"ok": true} with no auth. Everything else requires the trial's bearer
// token (MAKEFUN_SHOP_TOKEN): REST v3 under /api/v3, GraphQL at
// /api/graphql, MCP at /mcp, and git smart HTTP at /{owner}/{repo}.git —
// all served from one in-memory store (src/store.ts).

import { createServer } from 'node:http';
import { Forge } from './src/store.ts';
import { handleRest } from './src/rest.ts';
import { handleGit } from './src/gitproto.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { authorized, parseJsonBody, readBody, sendError, sendJson } from './src/web.ts';

const forge = new Forge();

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function route(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  res.setHeader('x-github-request-id', forge.nextRequestId());

  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const body = await readBody(req);

  if (!authorized(req)) {
    sendError(res, 401, 'Unauthorized');
    return;
  }

  try {
    if (path === '/api/graphql') {
      if (req.method !== 'POST') {
        sendError(res, 404, 'Not Found');
        return;
      }
      handleGraphql(forge, res, body);
      return;
    }

    if (path === '/mcp') {
      if (req.method !== 'POST') {
        sendError(res, 404, 'Not Found');
        return;
      }
      handleMcp(forge, res, body);
      return;
    }

    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      const segments = path
        .slice('/api/v3'.length)
        .split('/')
        .filter((segment) => segment !== '')
        .map(decodeSegment);
      let jsonBody = {};
      if (body.length > 0 && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '')) {
        jsonBody = parseJsonBody(body);
      }
      const handled = handleRest(forge, req, res, url, segments, jsonBody);
      if (!handled) sendError(res, 404, 'Not Found');
      return;
    }

    const gitMatch = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(path);
    if (gitMatch !== null) {
      const owner = decodeSegment(gitMatch[1]);
      const repoName = decodeSegment(gitMatch[2]);
      const tail = (gitMatch[3] ?? '')
        .split('/')
        .filter((segment) => segment !== '')
        .map(decodeSegment);
      const handled = await handleGit(forge, req, res, owner, repoName, tail, body);
      if (!handled) sendError(res, 404, 'Not Found');
      return;
    }

    sendError(res, 404, 'Not Found');
  } catch (error) {
    if (error !== null && typeof error === 'object' && typeof error.status === 'number') {
      sendError(res, error.status, error.message ?? 'Error');
      return;
    }
    console.error('forge: request failed', error);
    if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
    else res.end();
  }
}

const server = createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error('forge: request failed', error);
    if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
    else res.end();
  });
});
server.keepAliveTimeout = 75_000;
server.headersTimeout = 80_000;

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, resolve);
});
const address = server.address();
const port = typeof address === 'object' && address !== null ? address.port : 0;
console.error(`github-forge listening on port ${port}`);

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  const base = envUrl.replace(/\/+$/, '');
  await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  }).catch(() => undefined);
  for (;;) {
    try {
      const answer = await fetch(`${base}/done`);
      const payload = await answer.json().catch(() => null);
      if (payload !== null && payload.done === true) break;
    } catch {
      // The env is not answering yet; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  server.close();
  process.exit(0);
}
