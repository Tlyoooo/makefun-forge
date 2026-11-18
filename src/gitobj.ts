// gitobj.ts — the git object model, implemented from scratch on node:crypto and
// node:zlib: sha1 addressing, trees, commits, tags, pack reading (with ofs/ref
// delta resolution) and pack writing (plain, undeltified objects).
//
// Objects are kept as { type, data } records in a Map keyed by hex oid, where
// `data` is the raw object payload (no header). Everything here is pure and
// deterministic: no clocks, no randomness.

import { createHash } from 'node:crypto';
import { createInflate, deflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const OBJECT_TYPES = ['commit', 'tree', 'blob', 'tag'];
const TYPE_CODES = { commit: 1, tree: 2, blob: 3, tag: 4, 'ofs-delta': 6, 'ref-delta': 7 };
const CODE_TYPES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data) {
  return createHash('sha1').update(data).digest('hex');
}

/** The oid of an object: sha1 over "<type> <size>\0" + payload. */
export function hashObject(type, data) {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Store an object and answer its oid (idempotent). */
export function storePut(store, type, data) {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

export function isOid(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- trees

/**
 * Parse a tree payload into entries { mode, name, oid }. `mode` is the git
 * spelling without leading zeros ("100644", "40000", "100755", "120000",
 * "160000").
 */
export function parseTree(data) {
  const entries = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: by name, with directories compared as if suffixed "/". */
function treeSortKey(entry) {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function compareTreeEntries(a, b) {
  const ka = treeSortKey(a);
  const kb = treeSortKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** Serialize entries into a tree payload, sorted the way git sorts them. */
export function buildTree(entries) {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree into a Map of path -> { mode, oid } for files and submodules. */
export function flattenTree(store, treeOid, prefix = '', out = new Map()) {
  const tree = store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Build (and store) nested trees from a flat path -> { mode, oid } map. */
export function buildTreeFromFlat(store, flat) {
  // Group paths by their first segment, recursively.
  const root = new Map(); // name -> { file?: {mode, oid}, dir?: Map }
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let level = root;
    for (let i = 0; i < segments.length; i += 1) {
      const name = segments[i];
      if (i === segments.length - 1) {
        level.set(name, { file: entry });
      } else {
        let next = level.get(name);
        if (next === undefined || next.dir === undefined) {
          next = { dir: new Map() };
          level.set(name, next);
        }
        level = next.dir;
      }
    }
  }
  const emit = (level) => {
    const entries = [];
    for (const [name, node] of level) {
      if (node.file !== undefined) entries.push({ mode: node.file.mode, name, oid: node.file.oid });
      else entries.push({ mode: '40000', name, oid: emit(node.dir) });
    }
    return storePut(store, 'tree', buildTree(entries));
  };
  return emit(root);
}

/**
 * A tree like `treeOid` (or empty when null) with `segments` set to `leaf`
 * ({ mode, oid }) or removed (leaf === null). Intermediates are rebuilt and
 * stored. Answers the new tree oid.
 */
export function treeWithPath(store, treeOid, segments, leaf) {
  const entries = treeOid === null ? [] : parseTree(store.get(treeOid)?.data ?? Buffer.alloc(0));
  const head = segments[0];
  const rest = segments.slice(1);
  const kept = entries.filter((entry) => entry.name !== head);
  if (rest.length === 0) {
    if (leaf !== null) kept.push({ mode: leaf.mode, name: head, oid: leaf.oid });
  } else {
    const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
    const childOid = treeWithPath(store, existing === undefined ? null : existing.oid, rest, leaf);
    // Drop directories that became empty.
    const child = store.get(childOid);
    if (child !== undefined && child.data.length > 0) kept.push({ mode: '40000', name: head, oid: childOid });
  }
  return storePut(store, 'tree', buildTree(kept));
}

/** The entry at `segments` under a tree, or null. */
export function treeEntryAt(store, treeOid, segments) {
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const tree = store.get(current);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) return entry;
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

// ---------------------------------------------------------------- commits and tags

/** Parse an "Name <email> ts tz" ident line. */
export function parseIdent(line) {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', timestamp: 0, timezone: '+0000' };
  return { name: match[1], email: match[2], timestamp: Number(match[3]), timezone: match[4] };
}

export function formatIdent(ident) {
  return `${ident.name} <${ident.email}> ${ident.timestamp} ${ident.timezone}`;
}

/** Parse a commit payload. Header continuations (gpgsig) are skipped over. */
export function parseCommit(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const commit = { tree: null, parents: [], author: null, committer: null, message };
  let lastKey = null;
  for (const line of header.split('\n')) {
    if (line.startsWith(' ')) continue; // a continuation of the previous header
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    lastKey = key;
    if (key === 'tree') commit.tree = value;
    else if (key === 'parent') commit.parents.push(value);
    else if (key === 'author') commit.author = parseIdent(value);
    else if (key === 'committer') commit.committer = parseIdent(value);
  }
  void lastKey;
  return commit;
}

/** Serialize a commit from parts; the message is used verbatim. */
export function buildCommit({ tree, parents, author, committer, message }) {
  let text = `tree ${tree}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${formatIdent(author)}\n`;
  text += `committer ${formatIdent(committer)}\n`;
  text += `\n${message}`;
  return Buffer.from(text, 'utf8');
}

/** Parse an annotated tag payload. */
export function parseTag(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const tag = { object: null, type: null, tag: null, tagger: null, message: split === -1 ? '' : text.slice(split + 2) };
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space === -1) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') tag.object = value;
    else if (key === 'type') tag.type = value;
    else if (key === 'tag') tag.tag = value;
    else if (key === 'tagger') tag.tagger = parseIdent(value);
  }
  return tag;
}

/** Peel an object to the commit it ultimately points at, or null. */
export function peelToCommit(store, oid) {
  let current = oid;
  for (let depth = 0; depth < 32; depth += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      if (current === null) return null;
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- reachability

/** Every oid reachable from `tips` (commits, tags, trees, blobs). */
export function collectReachable(store, tips, stopAt = null) {
  const seen = new Set();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop();
    if (oid === undefined || seen.has(oid)) continue;
    if (stopAt !== null && stopAt.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (commit.tree !== null) stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (target !== null) stack.push(target);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Whether `ancestor` is reachable from `descendant` by walking commit parents. */
export function isAncestor(store, ancestor, descendant) {
  if (ancestor === descendant) return true;
  const seen = new Set();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop();
    if (oid === undefined || seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** All commit ancestors of `oid`, with their shortest distance from it. */
function ancestorDistances(store, oid) {
  const distances = new Map();
  const queue = [oid];
  distances.set(oid, 0);
  while (queue.length > 0) {
    const current = queue.shift();
    const object = store.get(current);
    if (object === undefined || object.type !== 'commit') continue;
    const distance = distances.get(current) + 1;
    for (const parent of parseCommit(object.data).parents) {
      if (!distances.has(parent)) {
        distances.set(parent, distance);
        queue.push(parent);
      }
    }
  }
  return distances;
}

/** The best common ancestor of two commits, or null. */
export function mergeBase(store, a, b) {
  if (a === b) return a;
  const fromA = ancestorDistances(store, a);
  const fromB = ancestorDistances(store, b);
  let best = null;
  let bestScore = Infinity;
  for (const [oid, distance] of fromA) {
    const other = fromB.get(oid);
    if (other === undefined) continue;
    const score = distance + other;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}

// ---------------------------------------------------------------- packs

/** Inflate one zlib stream starting at `offset`; answers data + bytes consumed. */
export function inflateAt(buffer, offset) {
  return new Promise((resolve, reject) => {
    const stream = createInflate();
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve({ data: Buffer.concat(chunks), consumed: stream.bytesRead }));
    stream.end(buffer.subarray(offset));
  });
}

/** Apply a git delta payload to a base buffer. */
export function applyDelta(base, delta) {
  let offset = 0;
  const readVarint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: ${sourceSize} != ${base.length}`);
  const targetSize = readVarint();
  const parts = [];
  let produced = 0;
  while (offset < delta.length) {
    const opcode = delta[offset];
    offset += 1;
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (opcode & (1 << bit)) {
          copyOffset |= delta[offset] << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (opcode & (0x10 << bit)) {
          copySize |= delta[offset] << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (opcode !== 0) {
      parts.push(delta.subarray(offset, offset + opcode));
      produced += opcode;
      offset += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== targetSize || out.length !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

/**
 * Parse a pack starting at `offset` in `buffer`, verifying its trailer.
 * Answers { entries, end } where each entry is one of:
 *   { kind: 'plain', type, data, headerOffset }
 *   { kind: 'ofs', data, headerOffset, baseHeaderOffset }  (offsets are
 *                                                          pack-relative)
 *   { kind: 'ref', data, headerOffset, baseOid }
 * and `end` is the offset just past the trailer. Delta payloads are NOT
 * applied here; resolvePack does that.
 */
export async function parsePack(buffer, offset) {
  if (buffer.length - offset < 12 + 20) throw new Error('pack is too short');
  if (buffer.toString('latin1', offset, offset + 4) !== 'PACK') throw new Error('pack signature missing');
  const version = buffer.readUInt32BE(offset + 4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buffer.readUInt32BE(offset + 8);
  let cursor = offset + 12;
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const headerOffset = cursor - offset;
    let byte = buffer[cursor];
    cursor += 1;
    const code = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = buffer[cursor];
      cursor += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (code === TYPE_CODES['ofs-delta']) {
      byte = buffer[cursor];
      cursor += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = buffer[cursor];
        cursor += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      const { data, consumed } = await inflateAt(buffer, cursor);
      entries.push({ kind: 'ofs', data, headerOffset, baseHeaderOffset: headerOffset - back });
      cursor += consumed;
    } else if (code === TYPE_CODES['ref-delta']) {
      const baseOid = buffer.toString('hex', cursor, cursor + 20);
      cursor += 20;
      const { data, consumed } = await inflateAt(buffer, cursor);
      entries.push({ kind: 'ref', data, headerOffset, baseOid });
      cursor += consumed;
    } else {
      const type = CODE_TYPES[code];
      if (type === undefined) throw new Error(`unknown pack object type code ${code}`);
      const { data, consumed } = await inflateAt(buffer, cursor);
      if (data.length !== size) throw new Error(`pack object size mismatch: ${data.length} != ${size}`);
      entries.push({ kind: 'plain', type, data, headerOffset });
      cursor += consumed;
    }
  }
  // The trailer is the sha1 of everything before it.
  const trailer = buffer.subarray(cursor, cursor + 20);
  const digest = createHash('sha1').update(buffer.subarray(offset, cursor)).digest();
  if (!trailer.equals(digest)) throw new Error('pack checksum mismatch');
  return { entries, end: cursor + 20 };
}

/**
 * Resolve a parsed pack's entries into objects, applying deltas (bases come
 * from the pack itself or, for thin packs, from `store`), and store every
 * object into `store`. Answers [{ oid, type, data }] and the delta count.
 */
export function resolvePack(pack, store) {
  const { entries } = pack;
  const byOffset = new Map();
  for (let index = 0; index < entries.length; index += 1) byOffset.set(entries[index].headerOffset, index);
  const byOid = new Map(); // oid -> index, for ref-delta bases inside the pack
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.kind === 'plain') byOid.set(hashObject(entry.type, entry.data), index);
  }
  const resolved = new Array(entries.length).fill(null);
  let deltaCount = 0;

  const resolveIndex = (index) => {
    if (resolved[index] !== null) return resolved[index];
    const entry = entries[index];
    let object;
    if (entry.kind === 'plain') {
      object = { type: entry.type, data: entry.data };
    } else {
      deltaCount += 1;
      let base;
      if (entry.kind === 'ofs') {
        const baseIndex = byOffset.get(entry.baseHeaderOffset);
        if (baseIndex === undefined) throw new Error('ofs-delta base is not in the pack');
        base = resolveIndex(baseIndex);
      } else if (byOid.has(entry.baseOid)) {
        base = resolveIndex(byOid.get(entry.baseOid));
      } else {
        const stored = store.get(entry.baseOid);
        if (stored === undefined) throw new Error(`ref-delta base ${entry.baseOid} is missing`);
        base = stored;
      }
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    }
    resolved[index] = object;
    byOid.set(hashObject(object.type, object.data), index);
    return object;
  };

  const objects = [];
  for (let index = 0; index < entries.length; index += 1) {
    const object = resolveIndex(index);
    const oid = storePut(store, object.type, object.data);
    objects.push({ oid, type: object.type, data: object.data });
  }
  return { objects, deltaCount };
}

/** One pack entry header: type code + size as the variable-length encoding. */
function packEntryHeader(code, size) {
  const bytes = [];
  let first = (code << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Write a complete pack of plain (undeltified) objects. */
export function writePack(objects) {
  const parts = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packEntryHeader(TYPE_CODES[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- diffs and merges

/** Compare two trees: the file-level changes from `baseTree` to `headTree`. */
export function diffTrees(store, baseTree, headTree) {
  const before = baseTree === null ? new Map() : flattenTree(store, baseTree);
  const after = headTree === null ? new Map() : flattenTree(store, headTree);
  const changes = [];
  for (const [path, entry] of after) {
    const old = before.get(path);
    if (old === undefined) changes.push({ path, status: 'added', oldOid: null, newOid: entry.oid, mode: entry.mode });
    else if (old.oid !== entry.oid || old.mode !== entry.mode) {
      changes.push({ path, status: 'modified', oldOid: old.oid, newOid: entry.oid, mode: entry.mode });
    }
  }
  for (const [path, entry] of before) {
    if (!after.has(path)) changes.push({ path, status: 'removed', oldOid: entry.oid, newOid: null, mode: entry.mode });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

/**
 * A three-way merge of flattened trees. For every path: unchanged on one side
 * takes the other side's version; changed identically on both sides takes it;
 * changed differently is a conflict. Answers the merged flat map and the
 * conflicting paths.
 */
export function mergeFlats(base, ours, theirs) {
  const merged = new Map();
  const conflicts = [];
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const same = (x, y) => x === undefined && y === undefined ? true : x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode;
    if (same(o, t)) {
      if (o !== undefined) merged.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) merged.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) merged.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  return { merged, conflicts };
}

/**
 * Count added/deleted lines between two texts with an LCS dynamic program.
 * Very large inputs fall back to a multiset comparison so a pathological file
 * cannot stall the server.
 */
export function lineDiffCounts(oldText, newText) {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // A trailing newline produces a final empty element; git counts lines, and
  // both sides share the convention, so comparisons stay consistent.
  if (oldLines.length * newLines.length > 4_000_000) {
    const counts = new Map();
    for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1);
    let deletions = 0;
    let additions = 0;
    for (const line of newLines) {
      const left = counts.get(line) ?? 0;
      if (left > 0) counts.set(line, left - 1);
      else additions += 1;
    }
    for (const left of counts.values()) deletions += left;
    return { additions, deletions };
  }
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const dp = new Uint32Array(rows * cols);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      dp[i * cols + j] = oldLines[i] === newLines[j]
        ? dp[(i + 1) * cols + j + 1] + 1
        : Math.max(dp[(i + 1) * cols + j], dp[i * cols + j + 1]);
    }
  }
  const common = dp[0];
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}
