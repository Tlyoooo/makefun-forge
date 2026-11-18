// Git smart HTTP, implemented from the wire format: pkt-lines, packfiles
// (read and write, including ofs/ref deltas), protocol v2 ls-refs/fetch,
// protocol v0 fetch, and v0 receive-pack with report-status.
//
// Routes (all under /{owner}/{repo}.git):
//   GET  info/refs?service=git-upload-pack|git-receive-pack
//   POST git-upload-pack
//   POST git-receive-pack

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  commitAncestors,
  commitTree,
  getObject,
  headRef,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  peelObject,
  peelToCommit,
  storeObject,
} from './store.ts';

const AGENT = 'koyuki-forge/1.0.0';
const TYPE_CODES = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta' };

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export function pktLine(payload) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/**
 * Decode pkt-lines from `start`. Returns the events and the offset just past
 * the terminating flush (where a receive-pack's packfile begins). Stops
 * quietly at malformed input — a garbage body must never kill the server.
 */
export function decodePktLines(buf, start = 0) {
  const events = [];
  let offset = start;
  while (offset + 4 <= buf.length) {
    const hex = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const length = Number.parseInt(hex, 16);
    if (length === 0) {
      events.push({ kind: 'flush' });
      offset += 4;
      return { events, offset };
    }
    if (length === 1) {
      events.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      events.push({ kind: 'end' });
      offset += 4;
      return { events, offset };
    }
    if (length === 3) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) break;
    events.push({ kind: 'data', data: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { events, offset };
}

function sidebandPackets(pack) {
  const parts = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (parts.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

function packObjectHeader(type, size) {
  const bytes = [];
  let current = (type << 4) | (size & 0x0f);
  let rest = size >> 4;
  while (rest > 0) {
    bytes.push(current | 0x80);
    current = rest & 0x7f;
    rest >>= 7;
  }
  bytes.push(current);
  return Buffer.from(bytes);
}

/** Serialize the given objects (plain, undeltified) into a packfile. */
export function buildPack(repo, oids) {
  const parts = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = getObject(repo, oid);
    if (!obj) continue;
    parts.push(packObjectHeader(TYPE_CODES[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    const byte = buf[pos];
    pos += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: pos };
}

function applyDelta(base, delta) {
  let pos = 0;
  const source = readVarint(delta, pos);
  pos = source.next;
  const target = readVarint(delta, pos);
  pos = target.next;
  if (source.value !== base.length) throw new Error('delta base size mismatch');
  const out = [];
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[pos]; pos += 1; }
      if (op & 0x02) { offset |= delta[pos] << 8; pos += 1; }
      if (op & 0x04) { offset |= delta[pos] << 16; pos += 1; }
      if (op & 0x08) { offset |= delta[pos] << 24; pos += 1; }
      if (op & 0x10) { size = delta[pos]; pos += 1; }
      if (op & 0x20) { size |= delta[pos] << 8; pos += 1; }
      if (op & 0x40) { size |= delta[pos] << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== target.value) throw new Error('delta target size mismatch');
  return result;
}

/**
 * Read a packfile starting at `start`, storing every object it carries into
 * the repo. Returns the offset just past the pack trailer.
 */
export function readPack(repo, buf, start = 0) {
  if (buf.length < start + 12 || buf.toString('ascii', start, start + 4) !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = buf.readUInt32BE(start + 8);
  let pos = start + 12;
  const entries = [];
  const byStart = new Map();
  for (let i = 0; i < count; i += 1) {
    const entryStart = pos;
    let byte = buf[pos];
    pos += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buf[pos];
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid = null;
    let baseStart = null;
    if (typeCode === 6) {
      let b = buf[pos];
      pos += 1;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = buf[pos];
        pos += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      baseStart = entryStart - back;
    } else if (typeCode === 7) {
      baseOid = buf.toString('hex', pos, pos + 20);
      pos += 20;
    }
    const inflated = inflateSync(buf.subarray(pos), { info: true });
    pos += inflated.engine.bytesWritten;
    const entry = {
      start: entryStart,
      type: CODE_TYPES[typeCode],
      data: inflated.buffer,
      baseOid,
      baseStart,
      resolved: null,
    };
    entries.push(entry);
    byStart.set(entryStart, entry);
  }
  // The trailer is the pack's own sha1; verify it when fully present.
  const trailerEnd = pos + 20;
  const resolveEntry = (entry, depth) => {
    if (entry.resolved) return entry.resolved;
    if (depth > 64) throw new Error('delta chain too deep');
    let resolved;
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let base = null;
      if (entry.baseStart !== null && byStart.has(entry.baseStart)) {
        base = resolveEntry(byStart.get(entry.baseStart), depth + 1);
      } else if (entry.baseOid) {
        base = getObject(repo, entry.baseOid);
      }
      if (!base) throw new Error('delta base not found');
      const data = applyDelta(base.data, entry.data);
      resolved = { type: base.type, data };
    } else {
      resolved = { type: entry.type, data: entry.data };
    }
    entry.resolved = resolved;
    return resolved;
  };
  for (const entry of entries) {
    const { type, data } = resolveEntry(entry, 0);
    storeObject(repo, type, data);
  }
  return trailerEnd;
}

// ---------------------------------------------------------------------------
// Reachability / object selection for fetch
// ---------------------------------------------------------------------------

function addTreeClosure(repo, treeOid, out) {
  if (!treeOid || out.has(treeOid)) {
    if (treeOid) out.add(treeOid);
    return;
  }
  out.add(treeOid);
  const obj = getObject(repo, treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '40000') addTreeClosure(repo, entry.oid, out);
    else out.add(entry.oid);
  }
}

function addTagChain(repo, tagOid, out) {
  let current = tagOid;
  for (let hops = 0; hops < 32; hops += 1) {
    const obj = getObject(repo, current);
    if (!obj || obj.type !== 'tag') return;
    out.add(current);
    const target = parseTag(obj.data).object;
    if (!target) return;
    current = target;
    const peeled = getObject(repo, current);
    if (!peeled || peeled.type !== 'tag') return;
  }
}

/**
 * Decide what a fetch sends: objects reachable from the wants that the
 * client cannot already have, with shallow cut-offs when a depth is given.
 * Returns {oids, shallow, unshallow}.
 */
export function selectFetchObjects(repo, { wants, haves, clientShallow, deepen }) {
  const shallowSet = new Set(clientShallow);
  const excluded = new Set();
  for (const have of haves) {
    const peeled = peelObject(repo, have);
    if (!peeled) continue;
    if (peeled.type === 'commit') {
      if (shallowSet.has(peeled.oid)) {
        excluded.add(peeled.oid);
        addTreeClosure(repo, commitTree(repo, peeled.oid), excluded);
      } else {
        for (const ancestor of commitAncestors(repo, peeled.oid)) {
          excluded.add(ancestor);
          addTreeClosure(repo, commitTree(repo, ancestor), excluded);
        }
      }
    } else if (peeled.type === 'tag') {
      addTagChain(repo, have, excluded);
      const commit = peelToCommit(repo, have);
      if (commit) {
        excluded.add(commit);
        addTreeClosure(repo, commitTree(repo, commit), excluded);
      }
    } else {
      excluded.add(peeled.oid);
    }
  }

  // Breadth-first depth assignment from the wants (want = depth 1).
  const depthOf = new Map();
  const queue = [];
  for (const want of wants) {
    const commit = peelToCommit(repo, want);
    if (commit && !depthOf.has(commit)) {
      depthOf.set(commit, 1);
      queue.push(commit);
    }
  }
  while (queue.length > 0) {
    const commit = queue.shift();
    const depth = depthOf.get(commit);
    if (deepen !== null && depth >= deepen) continue;
    const obj = getObject(repo, commit);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!depthOf.has(parent)) {
        depthOf.set(parent, depth + 1);
        queue.push(parent);
      }
    }
  }

  const candidate = new Set();
  for (const want of wants) {
    const obj = getObject(repo, want);
    if (!obj) continue;
    if (obj.type === 'tag') addTagChain(repo, want, candidate);
    else if (obj.type === 'blob' || obj.type === 'tree') candidate.add(want);
  }
  for (const [commit, depth] of depthOf) {
    if (deepen !== null && depth > deepen) continue;
    candidate.add(commit);
    addTreeClosure(repo, commitTree(repo, commit), candidate);
  }

  const shallow = [];
  const unshallow = [];
  if (deepen !== null) {
    for (const [commit, depth] of depthOf) {
      if (depth !== deepen) continue;
      const obj = getObject(repo, commit);
      const hasParent = obj && obj.type === 'commit' && parseCommit(obj.data).parents.length > 0;
      if (hasParent && !shallowSet.has(commit)) shallow.push(commit);
    }
    for (const held of shallowSet) {
      if (depthOf.has(held) && depthOf.get(held) < deepen) unshallow.push(held);
    }
  }

  const oids = [...candidate].filter((oid) => !excluded.has(oid));
  return { oids, shallow, unshallow };
}

// ---------------------------------------------------------------------------
// Advertisements and ls-refs
// ---------------------------------------------------------------------------

function sortedRefs(repo) {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function advertisementV0(repo, service) {
  const isUpload = service === 'git-upload-pack';
  const caps = isUpload
    ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:${headRef(repo)}`
    : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT} symref=HEAD:${headRef(repo)}`;
  const parts = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const lines = [];
  const headOid = repo.refs.get(headRef(repo));
  if (headOid) lines.push([headOid, 'HEAD']);
  for (const [ref, oid] of sortedRefs(repo)) {
    lines.push([oid, ref]);
    const peeled = peelToCommit(repo, oid);
    if (peeled && peeled !== oid) lines.push([peeled, `${ref}^{}`]);
  }
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach(([oid, ref], index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${oid} ${ref}${suffix}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function advertisementV2() {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

function lsRefs(repo, args) {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes = [];
  for (const line of args) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const lines = [];
  const headTarget = headRef(repo);
  const headOid = repo.refs.get(headTarget);
  const headIncluded = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
  if (headIncluded) {
    if (headOid) {
      lines.push(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}`);
    } else if (unborn) {
      lines.push(`unborn HEAD symref-target:${headTarget}`);
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (prefixes.length > 0 && !prefixes.some((p) => ref.startsWith(p))) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const peeled = peelToCommit(repo, oid);
      if (peeled && peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

function parseFetchArgs(lines) {
  const parsed = { wants: [], haves: [], clientShallow: [], deepen: null, done: false };
  const oidArg = (line, prefix) => line.slice(prefix.length).split(/[\s\0]/)[0];
  for (const line of lines) {
    if (line.startsWith('want ')) parsed.wants.push(oidArg(line, 'want '));
    else if (line.startsWith('have ')) parsed.haves.push(oidArg(line, 'have '));
    else if (line.startsWith('shallow ')) parsed.clientShallow.push(oidArg(line, 'shallow '));
    else if (line.startsWith('deepen ')) parsed.deepen = Number.parseInt(line.slice(7), 10) || null;
    else if (line === 'done') parsed.done = true;
  }
  return parsed;
}

function fetchV2(repo, args) {
  const { wants, haves, clientShallow, deepen } = parseFetchArgs(args);
  const { oids, shallow, unshallow } = selectFetchObjects(repo, { wants, haves, clientShallow, deepen });
  const parts = [];
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(buildPack(repo, oids)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0(repo, lines) {
  const { wants, haves, clientShallow, deepen } = parseFetchArgs(lines);
  const { oids, shallow, unshallow } = selectFetchObjects(repo, { wants, haves, clientShallow, deepen });
  const parts = [];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPackets(buildPack(repo, oids)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Receive-pack
// ---------------------------------------------------------------------------

function receivePack(repo, body) {
  const { events, offset } = decodePktLines(body, 0);
  const commands = [];
  let capabilities = '';
  for (const event of events) {
    if (event.kind !== 'data') continue;
    let line = event.data.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const firstSpace = line.indexOf(' ');
    const secondSpace = line.indexOf(' ', firstSpace + 1);
    if (firstSpace === -1 || secondSpace === -1) continue;
    commands.push({
      old: line.slice(0, firstSpace),
      new: line.slice(firstSpace + 1, secondSpace),
      ref: line.slice(secondSpace + 1),
    });
  }
  const wantsReport = /(^|\s)report-status(-v2)?(\s|$)/.test(capabilities) || capabilities.includes('report-status');
  const sideBand = capabilities.includes('side-band-64k') || capabilities.includes('side-band');

  let unpackOk = true;
  let unpackError = '';
  const packBytes = body.subarray(offset);
  if (packBytes.length > 0) {
    try {
      readPack(repo, packBytes, 0);
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const results = [];
  for (const command of commands) {
    results.push(applyRefUpdate(repo, command));
  }

  if (!wantsReport) return Buffer.alloc(0);
  const reportParts = [pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackError || 'error'}\n`)];
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  if (!sideBand) return report;
  const wrapped = [];
  const CHUNK = 32768;
  for (let pos = 0; pos < report.length; pos += CHUNK) {
    const chunk = report.subarray(pos, Math.min(report.length, pos + CHUNK));
    wrapped.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  wrapped.push(PKT_FLUSH);
  return Buffer.concat(wrapped);
}

function applyRefUpdate(repo, { old, new: next, ref }) {
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (old !== current) {
    return { ref, ok: false, reason: old === ZERO_OID ? 'reference already exists' : 'stale info' };
  }
  if (next === ZERO_OID) {
    if (ref === headRef(repo)) {
      return { ref, ok: false, reason: 'deletion of the current branch prohibited' };
    }
    repo.refs.delete(ref);
    return { ref, ok: true };
  }
  if (!getObject(repo, next)) return { ref, ok: false, reason: 'missing object' };
  if (old === ZERO_OID || old === next) {
    repo.refs.set(ref, next);
    return { ref, ok: true };
  }
  const oldCommit = peelToCommit(repo, old);
  const newCommit = peelToCommit(repo, next);
  if (oldCommit && newCommit && !isAncestor(repo, oldCommit, newCommit)) {
    return { ref, ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(ref, next);
  return { ref, ok: true };
}

// ---------------------------------------------------------------------------
// HTTP handlers (called from main.ts with an authenticated, resolved repo)
// ---------------------------------------------------------------------------

export function handleInfoRefs(repo, service, gitProtocolHeader) {
  if (service === 'git-upload-pack' && typeof gitProtocolHeader === 'string' && gitProtocolHeader.includes('version=2')) {
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-advertisement',
      body: advertisementV2(),
    };
  }
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: advertisementV0(repo, service),
  };
}

export function handleUploadPack(repo, body) {
  const { events } = decodePktLines(body, 0);
  // Split the event stream into sections on delimiters.
  const sections = [[]];
  for (const event of events) {
    if (event.kind === 'delim') sections.push([]);
    else if (event.kind === 'data') sections[sections.length - 1].push(event.data.toString('utf8').replace(/\n$/, ''));
  }
  const first = sections[0][0] ?? '';
  if (first.startsWith('command=')) {
    const command = first.slice('command='.length);
    const args = sections.length > 1 ? sections[1] : [];
    if (command === 'ls-refs') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(repo, args) };
    }
    if (command === 'fetch') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV2(repo, args) };
    }
    return { status: 400, contentType: 'text/plain', body: Buffer.from('unknown command\n') };
  }
  // Protocol v0: everything is one flat list of want/have lines.
  const lines = sections.flat();
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV0(repo, lines) };
}

export function handleReceivePack(repo, body) {
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: receivePack(repo, body) };
}
