// The forge's data model and git object store.
//
// Everything lives in memory: a trial boots a fresh process, builds a few
// dozen repositories at most, and grades what the surfaces answer — nothing
// needs to survive the process. Each repository owns an isolated object
// store (oid -> {type, data}) and ref table, exactly like separate on-disk
// repositories would behave.

import { createHash } from 'node:crypto';
import { VIEWER } from './scenario.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
/** 2025-01-01T00:00:00Z; forge-made timestamps count up from here. */
const CLOCK_EPOCH = 1735689600;

export function sha1Hex(data) {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of a payload: sha1 of "<type> <size>\0" + payload. */
export function objectId(type, data) {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

export class Forge {
  constructor() {
    this.viewer = VIEWER;
    /** full name "owner/name" -> Repo */
    this.repos = new Map();
    this.nextRepoId = 1;
    this.nextIssueId = 1;
    this.nextCommentId = 1;
    this.nextLabelId = 1;
    this.clockTicks = 0;
  }

  /** A deterministic clock: every stamp is unique and reproducible. */
  nowSeconds() {
    this.clockTicks += 1;
    return CLOCK_EPOCH + this.clockTicks;
  }

  nowIso() {
    return new Date(this.nowSeconds() * 1000).toISOString();
  }

  createRepo({ name, description = '', isPrivate = false, defaultBranch = 'main' }) {
    const stamp = this.nowIso();
    const repo = {
      id: this.nextRepoId,
      name,
      ownerLogin: this.viewer.login,
      private: Boolean(isPrivate),
      description: description ?? '',
      defaultBranch: defaultBranch || 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      numbers: new Map(),
      nextNumber: 1,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.nextRepoId += 1;
    this.repos.set(`${repo.ownerLogin}/${name}`, repo);
    return repo;
  }

  getRepo(owner, name) {
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  deleteRepo(owner, name) {
    return this.repos.delete(`${owner}/${name}`);
  }

  listRepos() {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }
}

// ---------------------------------------------------------------------------
// Git objects
// ---------------------------------------------------------------------------

export function storeObject(repo, type, data) {
  const oid = objectId(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo, oid) {
  return repo.objects.get(oid) ?? null;
}

export function parseCommit(data) {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const commit = { tree: null, parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) commit.author = line.slice(7);
    else if (line.startsWith('committer ')) commit.committer = line.slice(10);
  }
  return commit;
}

export function formatIdent(name, email, seconds) {
  return `${name} <${email}> ${seconds} +0000`;
}

export function buildCommitData({ tree, parents, name, email, seconds, message }) {
  const ident = formatIdent(name, email, seconds);
  let head = `tree ${tree}\n`;
  for (const parent of parents) head += `parent ${parent}\n`;
  head += `author ${ident}\ncommitter ${ident}\n\n`;
  return Buffer.from(head + (message ?? ''), 'utf8');
}

export function makeCommit(forge, repo, { tree, parents, message }) {
  const data = buildCommitData({
    tree,
    parents,
    name: forge.viewer.name,
    email: forge.viewer.email,
    seconds: forge.nowSeconds(),
    message,
  });
  return storeObject(repo, 'commit', data);
}

export function parseTag(data) {
  const text = data.toString('utf8');
  const tag = { object: null, type: null, name: null };
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) tag.object = line.slice(7).trim();
    else if (line.startsWith('type ')) tag.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag.name = line.slice(4).trim();
    else if (line === '') break;
  }
  return tag;
}

/** Follow tag objects until a non-tag object; returns {oid, type} or null. */
export function peelObject(repo, oid) {
  let current = oid;
  for (let hops = 0; hops < 32; hops += 1) {
    const obj = getObject(repo, current);
    if (!obj) return null;
    if (obj.type !== 'tag') return { oid: current, type: obj.type };
    const tag = parseTag(obj.data);
    if (!tag.object) return null;
    current = tag.object;
  }
  return null;
}

/** The commit an object names (through any tag chain), or null. */
export function peelToCommit(repo, oid) {
  const peeled = peelObject(repo, oid);
  if (!peeled || peeled.type !== 'commit') return null;
  return peeled.oid;
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

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

function treeSortKey(entry) {
  // Git compares tree entries by name, directories as if suffixed with '/'.
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function serializeTree(entries) {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree into a Map of "path" -> {mode, oid}, recursively. */
export function flattenTree(repo, treeOid, prefix = '', out = new Map()) {
  if (!treeOid) return out;
  const obj = getObject(repo, treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Rebuild (and store) nested trees from a flattened path map. */
export function treeFromFlat(repo, flat) {
  const root = new Map();
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (!node.has(parts[i])) node.set(parts[i], new Map());
      node = node.get(parts[i]);
    }
    node.set(parts[parts.length - 1], entry);
  }
  const emit = (node) => {
    const entries = [];
    for (const [name, value] of node) {
      if (value instanceof Map) entries.push({ mode: '40000', name, oid: emit(value) });
      else entries.push({ mode: value.mode, name, oid: value.oid });
    }
    return storeObject(repo, 'tree', serializeTree(entries));
  };
  return emit(root);
}

/**
 * Apply file changes ({path -> Buffer to write, or null to delete}) on top of
 * a base tree and return the new tree oid. New files get mode 100644;
 * existing files keep their mode.
 */
export function applyTreeChanges(repo, baseTreeOid, changes) {
  const flat = flattenTree(repo, baseTreeOid);
  for (const [path, content] of changes) {
    if (content === null) {
      flat.delete(path);
    } else {
      const previous = flat.get(path);
      const oid = storeObject(repo, 'blob', content);
      flat.set(path, { mode: previous ? previous.mode : '100644', oid });
    }
  }
  return treeFromFlat(repo, flat);
}

/** Look up one path in a tree; returns {kind:'file'|'dir', ...} or null. */
export function lookupPath(repo, treeOid, path) {
  if (!treeOid) return null;
  const parts = path.split('/').filter((part) => part.length > 0);
  let current = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = getObject(repo, current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) {
      if (entry.mode === '40000') return { kind: 'dir', oid: entry.oid };
      return { kind: 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  // The path was the root itself.
  return { kind: 'dir', oid: treeOid };
}

/** The tree oid a commit names, or null. */
export function commitTree(repo, commitOid) {
  const obj = getObject(repo, commitOid);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

// ---------------------------------------------------------------------------
// Refs and history
// ---------------------------------------------------------------------------

export function headRef(repo) {
  return `refs/heads/${repo.defaultBranch}`;
}

/**
 * Resolve a revision-ish name to an oid: HEAD, a full ref, a branch or tag
 * shorthand, or a raw object id. Returns null when nothing matches.
 */
export function resolveRevision(repo, name) {
  if (!name) return null;
  if (name === 'HEAD') return repo.refs.get(headRef(repo)) ?? null;
  if (name.startsWith('refs/')) return repo.refs.get(name) ?? null;
  const asBranch = repo.refs.get(`refs/heads/${name}`);
  if (asBranch) return asBranch;
  const asTag = repo.refs.get(`refs/tags/${name}`);
  if (asTag) return asTag;
  if (/^[0-9a-f]{40}$/.test(name) && repo.objects.has(name)) return name;
  return null;
}

/** All commit oids reachable from a commit (itself included). */
export function commitAncestors(repo, tip) {
  const seen = new Set();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift();
    if (!oid || seen.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return seen;
}

export function isAncestor(repo, ancestor, descendant) {
  if (ancestor === descendant) return true;
  return commitAncestors(repo, descendant).has(ancestor);
}

/** A common ancestor of two commits (breadth-first from b), or null. */
export function mergeBase(repo, a, b) {
  const ancestorsOfA = commitAncestors(repo, a);
  const seen = new Set();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift();
    if (!oid || seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const obj = getObject(repo, oid);
    if (obj && obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
  }
  return null;
}

/** Commits reachable from a tip, newest first (breadth-first by parents). */
export function listCommits(repo, tip, limit = 1000) {
  const out = [];
  const seen = new Set();
  const queue = [tip];
  while (queue.length > 0 && out.length < limit) {
    const oid = queue.shift();
    if (!oid || seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return out;
}
