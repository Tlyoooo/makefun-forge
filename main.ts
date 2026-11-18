// github-forge: a standalone GitHub-compatible git forge.
//
// One process, no dependencies. It binds an ephemeral port, tells the
// trial environment where it is (POST /register), serves until the
// environment says the trial is over (GET /done), then exits 0.

import http from 'node:http';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (req.method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, () => resolve());
});
const address = server.address();
const port = typeof address === 'object' && address !== null ? address.port : 0;

async function registerWithEnv() {
  const response = await fetch(`${envUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  await response.arrayBuffer().catch(() => undefined);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntilDone() {
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`);
      const body = await response.json().catch(() => null);
      if (body !== null && body.done === true) return;
    } catch {
      // The env is not answering yet; keep polling.
    }
    await sleep(200);
  }
}

if (envUrl !== '') {
  await registerWithEnv();
  await pollUntilDone();
  server.close();
  process.exit(0);
}
