// Domain operations shared by the REST, GraphQL and MCP surfaces: JSON
// shapes, issue/pull creation rules, the pull-request file diff, and the
// squash merge. Keeping them here means the three surfaces can never drift
// apart — a pull request merged over MCP is the same object REST reads back.

import {
  applyTreeChanges,
  commitTree,
  flattenTree,
  getObject,
  makeCommit,
  mergeBase,
  parseCommit,
  treeFromFlat,
} from './store.ts';

export function userJson(user) {
  return { login: user.login, id: user.id, type: 'User', name: user.name, email: user.email };
}

export function repoJson(repo) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.ownerLogin}/${repo.name}`,
    owner: { login: repo.ownerLogin, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://forge.invalid/${repo.ownerLogin}/${repo.name}`,
  };
}

export function labelJson(label) {
  return { id: label.id, name: label.name, color: label.color, description: label.description ?? null };
}

export function issueJson(forge, repo, issue) {
  return {
    id: issue.gid,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels: issue.labels
      .map((name) => repo.labels.get(name))
      .filter(Boolean)
      .map((label) => labelJson(label)),
    user: userJson(forge.viewer),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://forge.invalid/${repo.ownerLogin}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(forge, comment) {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(forge.viewer),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

export function branchTip(repo, branch) {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export function pullJson(forge, repo, pull) {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  return {
    id: pull.gid,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { label: `${repo.ownerLogin}:${pull.headRef}`, ref: pull.headRef, sha: headTip },
    base: { label: `${repo.ownerLogin}:${pull.baseRef}`, ref: pull.baseRef, sha: baseTip },
    user: userJson(forge.viewer),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://forge.invalid/${repo.ownerLogin}/${repo.name}/pull/${pull.number}`,
  };
}

export function createIssue(forge, repo, { title, body = '', labelNames = [] }) {
  if (typeof title !== 'string' || title.length === 0) {
    return { error: { status: 422, message: 'Title is required' } };
  }
  for (const name of labelNames) {
    if (!repo.labels.has(name)) {
      return { error: { status: 422, message: `Label "${name}" does not exist in this repository` } };
    }
  }
  const stamp = forge.nowIso();
  const issue = {
    kind: 'issue',
    gid: forge.nextIssueId,
    number: repo.nextNumber,
    title,
    body: body ?? '',
    state: 'open',
    labels: [...labelNames],
    comments: [],
    createdAt: stamp,
    updatedAt: stamp,
  };
  forge.nextIssueId += 1;
  repo.nextNumber += 1;
  repo.numbers.set(issue.number, issue);
  return { issue };
}

export function createPull(forge, repo, { title, body = '', head, base }) {
  if (typeof head !== 'string' || typeof base !== 'string' || !head || !base) {
    return { error: { status: 422, message: 'head and base branches are required' } };
  }
  const headName = head.includes(':') ? head.slice(head.lastIndexOf(':') + 1) : head;
  const baseName = base.includes(':') ? base.slice(base.lastIndexOf(':') + 1) : base;
  if (!branchTip(repo, headName)) {
    return { error: { status: 422, message: `The head branch "${headName}" does not exist` } };
  }
  if (!branchTip(repo, baseName)) {
    return { error: { status: 422, message: `The base branch "${baseName}" does not exist` } };
  }
  for (const record of repo.numbers.values()) {
    if (
      record.kind === 'pull' &&
      record.state === 'open' &&
      record.headRef === headName &&
      record.baseRef === baseName
    ) {
      return { error: { status: 422, message: 'A pull request already exists for these branches' } };
    }
  }
  const stamp = forge.nowIso();
  const pull = {
    kind: 'pull',
    gid: forge.nextIssueId,
    number: repo.nextNumber,
    title: title ?? '',
    body: body ?? '',
    state: 'open',
    headRef: headName,
    baseRef: baseName,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
  forge.nextIssueId += 1;
  repo.nextNumber += 1;
  repo.numbers.set(pull.number, pull);
  return { pull };
}

// ---------------------------------------------------------------------------
// Pull request diffs and merges
// ---------------------------------------------------------------------------

function flatTreeOfCommit(repo, commitOid) {
  if (!commitOid) return new Map();
  const tree = commitTree(repo, commitOid);
  return flattenTree(repo, tree);
}

function sameEntry(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.oid === b.oid && a.mode === b.mode;
}

function blobText(repo, entry) {
  if (!entry) return null;
  const obj = getObject(repo, entry.oid);
  return obj ? obj.data.toString('utf8') : '';
}

function splitLines(text) {
  if (text === null || text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line counts of a change, via a small LCS diff (files here are small). */
export function lineChangeCounts(oldText, newText) {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length * newLines.length > 4_000_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const rows = oldLines.length;
  const cols = newLines.length;
  const dp = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

/** Files changed between the pull's merge base and its head, GitHub-style. */
export function pullFiles(repo, pull) {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (!headTip || !baseTip) return [];
  const base = mergeBase(repo, headTip, baseTip);
  const fromMap = flatTreeOfCommit(repo, base);
  const toMap = flatTreeOfCommit(repo, headTip);
  const paths = new Set([...fromMap.keys(), ...toMap.keys()]);
  const files = [];
  for (const path of [...paths].sort()) {
    const from = fromMap.get(path);
    const to = toMap.get(path);
    if (sameEntry(from, to)) continue;
    const counts = lineChangeCounts(blobText(repo, from), blobText(repo, to));
    files.push({
      filename: path,
      status: !from ? 'added' : !to ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return files;
}

/**
 * The three-way picture of a pull request: what the head changed relative to
 * the merge base, what the base changed, where they collide, and the flat
 * tree a squash merge would produce.
 */
export function analyzeMerge(repo, pull) {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (!headTip || !baseTip) return { error: 'branch missing' };
  const base = mergeBase(repo, headTip, baseTip);
  const originMap = flatTreeOfCommit(repo, base);
  const headMap = flatTreeOfCommit(repo, headTip);
  const baseMap = flatTreeOfCommit(repo, baseTip);
  const headChanged = new Set();
  const baseChanged = new Set();
  const paths = new Set([...originMap.keys(), ...headMap.keys(), ...baseMap.keys()]);
  for (const path of paths) {
    if (!sameEntry(originMap.get(path), headMap.get(path))) headChanged.add(path);
    if (!sameEntry(originMap.get(path), baseMap.get(path))) baseChanged.add(path);
  }
  const conflicts = [];
  for (const path of headChanged) {
    if (baseChanged.has(path) && !sameEntry(headMap.get(path), baseMap.get(path))) {
      conflicts.push(path);
    }
  }
  const mergedFlat = new Map(baseMap);
  for (const path of headChanged) {
    const entry = headMap.get(path);
    if (entry) mergedFlat.set(path, entry);
    else mergedFlat.delete(path);
  }
  return { headTip, baseTip, conflicts, mergedFlat };
}

export function pullMergeable(repo, pull) {
  const analysis = analyzeMerge(repo, pull);
  if (analysis.error) return 'UNKNOWN';
  return analysis.conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
}

/** Squash-merge a pull request onto its base branch. */
export function squashMerge(forge, repo, pull) {
  if (pull.merged) return { error: { status: 405, message: 'Pull Request already merged' } };
  if (pull.state !== 'open') return { error: { status: 405, message: 'Pull Request is not open' } };
  const analysis = analyzeMerge(repo, pull);
  if (analysis.error) return { error: { status: 405, message: 'Pull Request is not mergeable' } };
  if (analysis.conflicts.length > 0) {
    return {
      error: {
        status: 405,
        message: `Pull Request is not mergeable: conflicting files ${analysis.conflicts.join(', ')}`,
      },
    };
  }
  const tree = treeFromFlat(repo, analysis.mergedFlat);
  const sha = makeCommit(forge, repo, {
    tree,
    parents: [analysis.baseTip],
    message: `${pull.title} (#${pull.number})`,
  });
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.nowIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  return { sha };
}

/** Write files on a branch as one commit (the contents API's engine). */
export function commitFiles(forge, repo, branch, changes, message) {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref) ?? null;
  const baseTree = tip ? commitTree(repo, tip) : null;
  const tree = applyTreeChanges(repo, baseTree, changes);
  const sha = makeCommit(forge, repo, {
    tree,
    parents: tip ? [tip] : [],
    message,
  });
  repo.refs.set(ref, sha);
  return sha;
}

export function commitMessageOf(repo, commitOid) {
  const obj = getObject(repo, commitOid);
  if (!obj || obj.type !== 'commit') return '';
  return parseCommit(obj.data).message.trimEnd();
}
