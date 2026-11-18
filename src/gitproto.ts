// gitproto.ts — git smart HTTP at /{owner}/{repo}.git: ref advertisements
// (protocol v0 and v2), ls-refs, upload-pack fetch (v2 with shallow/deepen,
// v0 fallback) and receive-pack pushes with report-status and fast-forward
// enforcement. No git binary: everything runs on gitobj.ts's object model.

import {
  ZERO_OID,
  isAncestor,
  isOid,
  parseCommit,
  parsePack,
  parseTag,
  parseTree,
  peelToCommit,
  resolvePack,
  writePack,
} from './gitobj.ts';
import { sendError } from './web.ts';

const AGENT = 'github-forge/1.0';

// ---------------------------------------------------------------- pkt-lines

/** Encode one pkt-line payload (Buffer or string); null encodes a flush. */
export function pkt(payload) {
  if (payload === null) return Buffer.from('0000', 'latin1');
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const header = (data.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'latin1'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'latin1');
export const PKT_DELIM = Buffer.from('0001', 'latin1');

/**
 * Parse pkt-lines from `buffer`. Answers { items, rest }: items are
 * { kind: 'data', payload } | { kind: 'flush' } | { kind: 'delim' } in order.
 * By default parsing stops at the first flush and `rest` is what follows it
 * (a pack, for receive-pack); with `all: true` every pkt-line in the buffer
 * is read (upload-pack bodies are pkt-lines end to end). Throws on malformed
 * input.
 */
export function parsePktLines(buffer, { all = false } = {}) {
  const items = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    if (cursor + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.toString('latin1', cursor, cursor + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      items.push({ kind: 'flush' });
      cursor += 4;
      if (!all) return { items, rest: buffer.subarray(cursor) };
      continue;
    }
    if (length === 1) {
      items.push({ kind: 'delim' });
      cursor += 4;
      continue;
    }
    if (length === 2) {
      items.push({ kind: 'end' });
      cursor += 4;
      continue;
    }
    if (length < 4 || cursor + length > buffer.length) throw new Error('pkt-line length out of range');
    items.push({ kind: 'data', payload: buffer.subarray(cursor + 4, cursor + length) });
    cursor += length;
  }
  return { items, rest: buffer.subarray(cursor) };
}

/** Split parsed pkt items into the command phase and the argument phase. */
function phases(items) {
  const command = [];
  const args = [];
  let inArgs = false;
  for (const item of items) {
    if (item.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (item.kind !== 'data') continue;
    (inArgs ? args : command).push(item.payload.toString('utf8').replace(/\n$/, ''));
  }
  return { command, args };
}

/** Wrap bytes in side-band-64k band-1 packets (each pkt ≤ 65520 overall). */
function sidebandWrap(data) {
  const parts = [];
  const CHUNK = 65511;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (data.length === 0) parts.push(pkt(Buffer.from([1])));
  return parts;
}

// ---------------------------------------------------------------- refs

/** Sorted [refname, oid] pairs, tags peeled on request of the caller. */
function sortedRefs(repo) {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The commit an annotated tag points at (its peeled target), or null. */
function peeledOf(repo, oid) {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return parseTag(object.data).object;
}

// ---------------------------------------------------------------- advertisement

function v0RefLines(repo, capabilities) {
  const lines = [];
  const refs = sortedRefs(repo);
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (refs.length === 0) {
    lines.push(pkt(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
    return lines;
  }
  let first = true;
  if (headOid !== undefined) {
    lines.push(pkt(`${headOid} HEAD\0${capabilities}\n`));
    first = false;
  }
  for (const [name, oid] of refs) {
    lines.push(pkt(first ? `${oid} ${name}\0${capabilities}\n` : `${oid} ${name}\n`));
    first = false;
    const peeled = peeledOf(repo, oid);
    if (peeled !== null) lines.push(pkt(`${peeled} ${name}^{}\n`));
  }
  return lines;
}

export function advertise(req, res, repo, service) {
  const protocolHeader = req.headers['git-protocol'] ?? '';
  const wantsV2 = service === 'git-upload-pack' && /(?:^|[:,])\s*version=2/.test(protocolHeader);
  res.setHeader('x-github-request-id', 'git-advertisement');
  if (wantsV2) {
    const body = Buffer.concat([
      pkt('version 2\n'),
      pkt(`agent=${AGENT}\n`),
      pkt('ls-refs=unborn\n'),
      pkt('fetch=shallow\n'),
      pkt('object-format=sha1\n'),
      PKT_FLUSH,
    ]);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-length': body.length });
    res.end(body);
    return;
  }
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const capabilities = service === 'git-upload-pack'
    ? `side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:${headRef}`
    : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:${headRef}`;
  const body = Buffer.concat([
    pkt(`# service=${service}\n`),
    PKT_FLUSH,
    ...v0RefLines(repo, capabilities),
    PKT_FLUSH,
  ]);
  res.writeHead(200, { 'content-type': `application/x-${service}-advertisement`, 'content-length': body.length });
  res.end(body);
}

// ---------------------------------------------------------------- ls-refs

function lsRefs(repo, args) {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name) => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------- fetch computation

/**
 * The object set a fetch delivers, with shallow bookkeeping.
 *
 * wants/haves are commit-ish oids; clientShallow is the set of commits the
 * client holds as shallow boundaries. The depth limit counts commit edges
 * from the wants; deepen extends it past the client's boundary.
 */
export function computeFetch(store, { wants, haves, clientShallow, depth, deepen }) {
  // What the client already holds: the closure of its haves, not descending
  // below its shallow boundary commits.
  const haveSet = new Set();
  {
    const stack = [...haves];
    while (stack.length > 0) {
      const oid = stack.pop();
      if (oid === undefined || haveSet.has(oid)) continue;
      const object = store.get(oid);
      if (object === undefined) continue;
      haveSet.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        if (!clientShallow.has(oid)) stack.push(...commit.parents);
      } else if (object.type === 'tag') {
        const target = parseTag(object.data).object;
        if (target !== null) stack.push(target);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) if (entry.mode !== '160000') stack.push(entry.oid);
      }
    }
  }

  // Distances (in commit edges) from the wants.
  const distance = new Map();
  {
    const queue = [];
    for (const want of wants) {
      const commit = peelToCommit(store, want);
      if (commit !== null && !distance.has(commit)) {
        distance.set(commit, 0);
        queue.push(commit);
      }
    }
    while (queue.length > 0) {
      const current = queue.shift();
      const object = store.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!distance.has(parent)) {
          distance.set(parent, distance.get(current) + 1);
          queue.push(parent);
        }
      }
    }
  }

  let limit = null;
  if (depth !== null && depth !== undefined) limit = depth;
  else if (deepen !== null && deepen !== undefined) {
    let boundaryDistance = 0;
    for (const oid of clientShallow) {
      if (distance.has(oid)) boundaryDistance = Math.max(boundaryDistance, distance.get(oid));
    }
    limit = deepen + boundaryDistance;
  }

  // The wanted closure, depth-limited on commits.
  const wantSet = new Set();
  {
    const stack = [...wants];
    while (stack.length > 0) {
      const oid = stack.pop();
      if (oid === undefined || wantSet.has(oid)) continue;
      const object = store.get(oid);
      if (object === undefined) continue;
      if (object.type === 'commit') {
        const dist = distance.get(oid);
        if (limit !== null && (dist === undefined || dist >= limit)) continue;
        wantSet.add(oid);
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        stack.push(...commit.parents);
      } else {
        wantSet.add(oid);
        if (object.type === 'tag') {
          const target = parseTag(object.data).object;
          if (target !== null) stack.push(target);
        } else if (object.type === 'tree') {
          for (const entry of parseTree(object.data)) if (entry.mode !== '160000') stack.push(entry.oid);
        }
      }
    }
  }

  const objects = new Set();
  for (const oid of wantSet) if (!haveSet.has(oid)) objects.add(oid);

  // The new shallow boundary: delivered commits whose parents were cut by
  // the depth limit (a parent the client already holds does not count).
  const shallow = new Set();
  const unshallow = new Set();
  if (limit !== null) {
    for (const oid of wantSet) {
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      const cut = commit.parents.some((parent) => store.has(parent) && !wantSet.has(parent) && !haveSet.has(parent));
      if (cut) shallow.add(oid);
    }
    for (const oid of clientShallow) {
      if (wantSet.has(oid) && !shallow.has(oid)) unshallow.add(oid);
    }
  }
  const common = haves.filter((oid) => store.has(oid));
  return { objects, shallow, unshallow, common };
}

/** A complete pack carrying `objects` (a Set of oids) from the store. */
function packOf(store, objects) {
  const rank = { commit: 0, tag: 1, tree: 2, blob: 3 };
  const list = [...objects]
    .map((oid) => ({ oid, ...store.get(oid) }))
    .sort((a, b) => (rank[a.type] - rank[b.type]) || (a.oid < b.oid ? -1 : 1));
  return writePack(list.map(({ type, data }) => ({ type, data })));
}

// ---------------------------------------------------------------- upload-pack

function fetchArguments(args) {
  const parsed = {
    wants: [],
    haves: [],
    clientShallow: new Set(),
    depth: null,
    deepen: null,
    done: false,
  };
  for (const arg of args) {
    if (arg.startsWith('want ')) parsed.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) parsed.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) parsed.clientShallow.add(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) parsed.deepen = Number(arg.slice(7).trim());
    else if (arg === 'done') parsed.done = true;
  }
  return parsed;
}

function uploadPackV2(res, repo, args) {
  const request = fetchArguments(args);
  const result = computeFetch(repo.objects, request);
  const parts = [];
  if (!request.done) {
    parts.push(pkt('acknowledgments\n'));
    if (result.common.length === 0) parts.push(pkt('NAK\n'));
    else for (const oid of result.common) parts.push(pkt(`ACK ${oid}\n`));
    parts.push(PKT_FLUSH);
    return sendUploadResult(res, parts);
  }
  if (request.haves.length > 0) {
    parts.push(pkt('acknowledgments\n'));
    if (result.common.length === 0) parts.push(pkt('NAK\n'));
    else for (const oid of result.common) parts.push(pkt(`ACK ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  if (request.depth !== null || request.deepen !== null || request.clientShallow.size > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of [...result.shallow].sort()) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of [...result.unshallow].sort()) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pkt('packfile\n'));
  parts.push(...sidebandWrap(packOf(repo.objects, result.objects)));
  parts.push(PKT_FLUSH);
  return sendUploadResult(res, parts);
}

function uploadPackV0(res, repo, items) {
  // v0: wants (the first may carry capabilities), flush, haves, done, flush.
  const wants = [];
  const haves = [];
  const clientShallow = new Set();
  let depth = null;
  let deepen = null;
  let section = 0;
  for (const item of items) {
    if (item.kind === 'flush') {
      section += 1;
      continue;
    }
    if (item.kind !== 'data') continue;
    let line = item.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) clientShallow.add(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('deepen ')) deepen = Number(line.slice(7).trim());
    }
  }
  const result = computeFetch(repo.objects, { wants, haves, clientShallow, depth, deepen });
  const parts = [];
  for (const oid of [...result.shallow].sort()) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of [...result.unshallow].sort()) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(pkt('NAK\n'));
  parts.push(...sidebandWrap(packOf(repo.objects, result.objects)));
  parts.push(PKT_FLUSH);
  return sendUploadResult(res, parts);
}

function sendUploadResult(res, parts) {
  const body = Buffer.concat(parts);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': body.length });
  res.end(body);
}

async function uploadPack(req, res, repo, body) {
  let parsed;
  try {
    parsed = parsePktLines(body, { all: true });
  } catch {
    sendError(res, 400, 'Malformed pkt-line stream');
    return;
  }
  const { command, args } = phases(parsed.items);
  const commandLine = command.find((line) => line.startsWith('command='));
  if (commandLine === 'command=ls-refs') {
    const lines = lsRefs(repo, args);
    const parts = lines.map((line) => pkt(`${line}\n`));
    parts.push(PKT_FLUSH);
    return sendUploadResult(res, parts);
  }
  if (commandLine === 'command=fetch') {
    return uploadPackV2(res, repo, args);
  }
  // No command line: a protocol v0 fetch request.
  return uploadPackV0(res, repo, parsed.items);
}

// ---------------------------------------------------------------- receive-pack

async function receivePack(req, res, repo, body) {
  let parsed;
  try {
    parsed = parsePktLines(body);
  } catch {
    sendError(res, 400, 'Malformed pkt-line stream');
    return;
  }
  const commands = [];
  let capabilities = '';
  for (const item of parsed.items) {
    if (item.kind !== 'data') continue;
    let line = item.payload.toString('utf8').replace(/\n$/, '');
    if (commands.length === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const fields = line.split(' ');
    if (fields.length !== 3 || !isOid(fields[0]) || !isOid(fields[1])) continue;
    commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields[2] });
  }
  const packBytes = parsed.rest;
  const report = [];
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const pack = parsePack(packBytes, 0);
      resolvePack(pack, repo.objects);
    } catch (error) {
      unpackOk = false;
      report.push(`unpack ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (unpackOk) report.push('unpack ok');

  if (unpackOk) {
    for (const command of commands) {
      report.push(applyCommand(repo, command));
    }
  } else {
    for (const command of commands) report.push(`ng ${command.ref} unpack failed`);
  }

  const stream = Buffer.concat([...report.map((line) => pkt(`${line}\n`)), PKT_FLUSH]);
  const useSideband = capabilities.split(' ').includes('side-band-64k');
  const payload = useSideband ? Buffer.concat([...sidebandWrap(stream), PKT_FLUSH]) : stream;
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': payload.length });
  res.end(payload);
}

/** Validate and apply one ref update; answers its report-status line. */
function applyCommand(repo, { oldOid, newOid, ref }) {
  const fail = (reason) => `ng ${ref} ${reason}`;
  if (!ref.startsWith('refs/') || ref.includes('..') || ref.includes(' ')) return fail('invalid refname');
  const current = repo.refs.get(ref) ?? ZERO_OID;

  if (newOid === ZERO_OID) {
    // A deletion.
    if (current === ZERO_OID) return fail('reference not found');
    if (oldOid !== current) return fail('stale ref');
    if (ref === `refs/heads/${repo.defaultBranch}`) return fail('deletion of the current branch prohibited');
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  const object = repo.objects.get(newOid);
  if (object === undefined) return fail('reference not found');
  if (ref.startsWith('refs/heads/') && object.type !== 'commit') {
    // A tag object may name a branch only through its commit.
    if (object.type !== 'tag' || peelToCommit(repo.objects, newOid) === null) return fail('invalid object');
  }
  if (oldOid === ZERO_OID) {
    if (current !== ZERO_OID) return fail('reference already exists');
    repo.refs.set(ref, newOid);
    return `ok ${ref}`;
  }
  if (oldOid !== current) return fail('stale ref');
  if (oldOid === newOid) return `ok ${ref}`;
  const newCommit = peelToCommit(repo.objects, newOid);
  const oldCommit = peelToCommit(repo.objects, oldOid);
  if (newCommit === null || oldCommit === null) return fail('invalid object');
  if (!isAncestor(repo.objects, oldCommit, newCommit)) return fail('non-fast-forward');
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}

// ---------------------------------------------------------------- the router

/**
 * Handle one git smart-HTTP request. `segments` is the path after
 * /{owner}/{repo}.git, split and decoded: ['info', 'refs'] for the
 * advertisement, ['git-upload-pack'] / ['git-receive-pack'] for the POSTs.
 */
export async function handleGit(forge, req, res, owner, repoName, segments, body) {
  const repo = forge.getRepo(owner, repoName);
  if (segments.length === 2 && segments[0] === 'info' && segments[1] === 'refs') {
    const service = new URL(req.url, 'http://localhost').searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendError(res, 400, 'Unknown service');
      return true;
    }
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    advertise(req, res, repo, service);
    return true;
  }
  if (segments.length === 1 && segments[0] === 'git-upload-pack' && req.method === 'POST') {
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    await uploadPack(req, res, repo, body);
    return true;
  }
  if (segments.length === 1 && segments[0] === 'git-receive-pack' && req.method === 'POST') {
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    await receivePack(req, res, repo, body);
    return true;
  }
  return false;
}
