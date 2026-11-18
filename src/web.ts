// web.ts — the small HTTP plumbing every surface shares: JSON replies with
// the forge's request-id header, bearer-token auth, and body reading.

/** Write a JSON reply. `extra` headers merge over the defaults. */
export function sendJson(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...extra,
  });
  res.end(text);
}

/** The GitHub-shaped error body: {"message": string}. */
export function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { message }, extra);
}

/**
 * Whether the request carries the trial's bearer token. The token comes from
 * MAKEFUN_SHOP_TOKEN; when the environment provides none, any well-formed
 * Bearer header is accepted (local development only — the trial always sets
 * it, and the unauthenticated checks run there).
 */
export function authorized(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected === undefined || expected === '') return header.startsWith('Bearer ') && header.length > 7;
  return header === `Bearer ${expected}`;
}

/** Read a whole request body (git packs included) into one Buffer. */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Parse a JSON request body: an empty body reads as {}, malformed JSON is a
 * thrown { status: 400 } the router turns into GitHub's 400 shape.
 */
export function parseJsonBody(buffer) {
  if (buffer.length === 0) return {};
  try {
    const value = JSON.parse(buffer.toString('utf8'));
    return value !== null && typeof value === 'object' ? value : {};
  } catch {
    const error = new Error('Malformed JSON in request body');
    error.status = 400;
    throw error;
  }
}

/** The origin a request reached us on, for absolute pagination links. */
export function originOf(req) {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}
