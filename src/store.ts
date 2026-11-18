// store.ts — the forge's whole state, in memory, shared by the REST, git,
// GraphQL and MCP surfaces: users, repositories (with their own git object
// store and refs), labels, issues, comments and pull requests.
//
// Time is a logical clock: the base instant comes from MAKEFUN_TRIAL_NOW when
// the trial provides one (else the scenario epoch), and every timestamp the
// forge issues advances it by one second. Nothing observable ever reads the
// wall clock or a random source, so a run and its replay agree byte for byte
// on every check outcome.

import { buildCommit, buildTree, parseCommit, storePut } from './gitobj.ts';

/** The scenario's fixed epoch (2025-01-01T00:00:00Z), the clock's fallback. */
const FALLBACK_EPOCH_MS = 1735689600000;

/** The identities the suite's scenario fixes (wire.ts's seeded cast). */
export const VIEWER = { login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User' };
export const TEAMMATE = { login: 'quinnkeller', id: 1001, name: 'quinn keller', email: 'quinnkeller@example.invalid', type: 'User' };
export const STRANGER = { login: 'olgabauer', id: 1002, name: 'olga bauer', email: 'olgabauer@example.invalid', type: 'User' };
export const ORG = { login: 'faint-meadow-org', id: 2000, name: 'faint meadow org', email: 'faint-meadow-org@example.invalid', type: 'Organization' };
const KNOWN_USERS = [VIEWER, TEAMMATE, STRANGER, ORG];

/** Parse MAKEFUN_TRIAL_NOW (epoch ms, epoch s, or an ISO string) to ms. */
function trialNowMs() {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw === undefined || raw === '') return FALLBACK_EPOCH_MS;
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    return value > 1e13 ? value : value * (value > 1e11 ? 1 : 1000);
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? FALLBACK_EPOCH_MS : parsed;
}

export class Forge {
  constructor() {
    this.users = new Map(KNOWN_USERS.map((user) => [user.login, user]));
    this.repos = new Map(); // "owner/name" (lowercased) -> repo
    this.clockMs = trialNowMs();
    this.nextRepoId = 1;
    this.nextRecordId = 1; // global database ids for issues, PRs and comments
    this.requestCounter = 0;
  }

  /** The next logical instant, as an ISO string (each call advances 1 s). */
  nowIso() {
    this.clockMs += 1000;
    return new Date(this.clockMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** The next logical instant, as epoch seconds (for git idents). */
  nowSec() {
    return Math.floor(this.clockMs / 1000) + 1;
  }

  /** A deterministic, non-empty request id. */
  nextRequestId() {
    this.requestCounter += 1;
    return `forge-${this.requestCounter.toString(16).padStart(8, '0')}`;
  }

  user(login) {
    return this.users.get(login) ?? null;
  }

  /** The commit identity REST-side writes use: the viewer's. */
  viewerIdent() {
    const timestamp = this.nowSec();
    this.clockMs += 1000;
    return { name: VIEWER.name, email: VIEWER.email, timestamp, timezone: '+0000' };
  }

  repoKey(owner, name) {
    return `${owner}/${name}`.toLowerCase();
  }

  getRepo(owner, name) {
    return this.repos.get(this.repoKey(owner, name)) ?? null;
  }

  createRepo(owner, { name, description = '', private: isPrivate = false }) {
    const repo = {
      id: this.nextRepoId,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(), // full refname -> oid
      labels: new Map(), // name -> { name, color, description }
      issues: new Map(), // number -> issue
      pulls: new Map(), // number -> pull request
      nextNumber: 1,
      createdAt: this.nowIso(),
      updatedAt: null,
    };
    repo.updatedAt = repo.createdAt;
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner, name) {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** Repos owned by a login, in creation order. */
  reposOf(owner) {
    return [...this.repos.values()].filter((repo) => repo.owner === owner);
  }

  /** The ref HEAD points at. */
  headRef(repo) {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /** The oid a branch name or full ref resolves to, or null. */
  refOid(repo, ref) {
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const branch = `refs/heads/${ref}`;
    if (repo.refs.has(branch)) return repo.refs.get(branch);
    const tag = `refs/tags/${ref}`;
    if (repo.refs.has(tag)) return repo.refs.get(tag);
    return null;
  }

  touch(repo) {
    repo.updatedAt = this.nowIso();
  }

  /**
   * Record a commit built from `tree` on `branch` (whose current tip becomes
   * the parent, if any) with `message`, authored by the viewer. Answers the
   * commit oid and moves the branch. `parentOid` overrides the parent (a
   * write that seeds a fresh branch from another branch's tip).
   */
  commitOnBranch(repo, branch, tree, message, parentOid = undefined) {
    const ref = `refs/heads/${branch}`;
    const parent = parentOid === undefined ? repo.refs.get(ref) : parentOid;
    const ident = this.viewerIdent();
    const data = buildCommit({
      tree,
      parents: parent === undefined ? [] : [parent],
      author: ident,
      committer: ident,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    const oid = storePut(repo.objects, 'commit', data);
    repo.refs.set(ref, oid);
    this.touch(repo);
    return oid;
  }

  /** Create an issue record (shared by REST, GraphQL and MCP creation). */
  createIssue(repo, { title, body = '', labels = [] }) {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue = {
      id: this.nextRecordId,
      number,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      user: VIEWER.login,
      comments: [],
      createdAt: this.nowIso(),
      updatedAt: null,
    };
    issue.updatedAt = issue.createdAt;
    this.nextRecordId += 1;
    repo.issues.set(number, issue);
    this.touch(repo);
    return issue;
  }

  /** Add a comment to an issue; answers the comment record. */
  addComment(repo, issue, body) {
    const comment = {
      id: this.nextRecordId,
      body: body ?? '',
      user: VIEWER.login,
      createdAt: this.nowIso(),
      updatedAt: null,
    };
    comment.updatedAt = comment.createdAt;
    this.nextRecordId += 1;
    issue.comments.push(comment);
    issue.updatedAt = comment.createdAt;
    return comment;
  }

  /** Create a pull request record over existing branches. */
  createPull(repo, { title, body = '', headRef, baseRef }) {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull = {
      id: this.nextRecordId,
      number,
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      user: VIEWER.login,
      createdAt: this.nowIso(),
      updatedAt: null,
    };
    pull.updatedAt = pull.createdAt;
    this.nextRecordId += 1;
    repo.pulls.set(number, pull);
    this.touch(repo);
    return pull;
  }
}

// ---------------------------------------------------------------- global ids

/**
 * Relay-style global ids: base64 of "<kind><numeric id>", opaque, stable, and
 * never the bare number. Kinds: R repo, I issue, P pull request, C comment,
 * U user.
 */
export function globalId(kind, numericId) {
  return Buffer.from(`${kind}${numericId}`, 'utf8').toString('base64');
}

/** Decode a global id into { kind, numericId }, or null when malformed. */
export function parseGlobalId(value) {
  if (typeof value !== 'string' || value === '') return null;
  let text;
  try {
    text = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^([RIPCU])(\d+)$/.exec(text);
  if (match === null) return null;
  return { kind: match[1], numericId: Number(match[2]) };
}

/** The commit a ref points at, parsed, or null. */
export function tipCommit(repo, ref) {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return null;
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  return { oid, commit: parseCommit(object.data) };
}
