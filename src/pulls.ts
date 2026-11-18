// pulls.ts — pull-request domain logic shared by REST, GraphQL and MCP:
// validation on creation, the changed-files diff against the merge base, the
// mergeability test, and the merge itself (squash, merge and rebase) built on
// the file-level three-way tree merge.

import {
  buildCommit,
  buildTreeFromFlat,
  diffTrees,
  flattenTree,
  isAncestor,
  lineDiffCounts,
  mergeBase,
  mergeFlats,
  parseCommit,
  peelToCommit,
  storePut,
} from './gitobj.ts';

/** An error carrying the HTTP status the REST surface should answer. */
export class PullError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The current tips of a pull request's branches (null when a branch is gone). */
export function prTips(repo, pull) {
  const headOid = repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
  const baseOid = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
  return { headOid, baseOid };
}

/** The merge base commit of a pull request's branches, or null. */
export function prMergeBase(repo, pull) {
  const { headOid, baseOid } = prTips(repo, pull);
  if (headOid === null || baseOid === null) return null;
  const head = peelToCommit(repo.objects, headOid);
  const base = peelToCommit(repo.objects, baseOid);
  if (head === null || base === null) return null;
  return mergeBase(repo.objects, base, head);
}

/** The tree oid of a commit oid (null-safe). */
function treeOf(repo, commitOid) {
  if (commitOid === null) return null;
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/**
 * Validate a would-be pull request the way GitHub does: both branches exist,
 * they differ, and no open pull request already covers the same head/base.
 * Throws PullError (422) on any refusal.
 */
export function validateNewPull(repo, headRef, baseRef) {
  const headOid = repo.refs.get(`refs/heads/${headRef}`);
  const baseOid = repo.refs.get(`refs/heads/${baseRef}`);
  if (headOid === undefined) throw new PullError(422, `Head branch "${headRef}" does not exist`);
  if (baseOid === undefined) throw new PullError(422, `Base branch "${baseRef}" does not exist`);
  if (headRef === baseRef) throw new PullError(422, 'Head and base branches are the same');
  const head = peelToCommit(repo.objects, headOid);
  const base = peelToCommit(repo.objects, baseOid);
  if (head === null || base === null) throw new PullError(422, 'A branch does not point at a commit');
  const baseOfMerge = mergeBase(repo.objects, base, head);
  if (baseOfMerge === head) throw new PullError(422, `No commits between ${baseRef} and ${headRef}`);
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) {
      throw new PullError(422, `A pull request already exists for ${headRef} into ${baseRef}`);
    }
  }
}

/** The changed files of a pull request: merge-base tree vs head tree. */
export function prFiles(repo, pull) {
  const { headOid } = prTips(repo, pull);
  const base = prMergeBase(repo, pull);
  const beforeTree = treeOf(repo, base);
  const afterTree = treeOf(repo, headOid === null ? null : peelToCommit(repo.objects, headOid));
  const changes = diffTrees(repo.objects, beforeTree, afterTree);
  return changes.map((change) => {
    let additions = 0;
    let deletions = 0;
    const oldBlob = change.oldOid === null ? null : repo.objects.get(change.oldOid);
    const newBlob = change.newOid === null ? null : repo.objects.get(change.newOid);
    const oldText = oldBlob !== undefined && oldBlob !== null && oldBlob.type === 'blob' ? oldBlob.data.toString('utf8') : '';
    const newText = newBlob !== undefined && newBlob !== null && newBlob.type === 'blob' ? newBlob.data.toString('utf8') : '';
    const binary = (oldBlob?.data.includes(0) ?? false) || (newBlob?.data.includes(0) ?? false);
    if (!binary && change.mode !== '160000') {
      const counts = lineDiffCounts(oldText, newText);
      additions = counts.additions;
      deletions = counts.deletions;
      if (change.status === 'modified' && additions === 0 && deletions === 0) additions = 1; // a mode-only change still counts
    }
    return {
      filename: change.path,
      status: change.status,
      additions,
      deletions,
      changes: additions + deletions,
      sha: change.newOid ?? change.oldOid,
    };
  });
}

/**
 * The three-way merge at the heart of mergeability and merging: returns
 * { tree } on success or { conflicts } when both sides changed a path
 * differently. `ours` is the base branch tip, `theirs` the head tip.
 */
function threeWayMerge(repo, pull) {
  const { headOid, baseOid } = prTips(repo, pull);
  if (headOid === null || baseOid === null) return { conflicts: ['(branch missing)'] };
  const base = prMergeBase(repo, pull);
  const ancestorFlat = flattenTree(repo.objects, treeOf(repo, base) ?? storePut(repo.objects, 'tree', Buffer.alloc(0)));
  const oursFlat = flattenTree(repo.objects, treeOf(repo, peelToCommit(repo.objects, baseOid)));
  const theirsFlat = flattenTree(repo.objects, treeOf(repo, peelToCommit(repo.objects, headOid)));
  const { merged, conflicts } = mergeFlats(ancestorFlat, oursFlat, theirsFlat);
  if (conflicts.length > 0) return { conflicts };
  return { tree: buildTreeFromFlat(repo.objects, merged) };
}

/** Whether a pull request could merge cleanly right now. */
export function prMergeable(repo, pull) {
  if (pull.state !== 'open') return false;
  const { headOid, baseOid } = prTips(repo, pull);
  if (headOid === null || baseOid === null) return false;
  return threeWayMerge(repo, pull).conflicts === undefined;
}

/**
 * Merge a pull request. method: 'squash' | 'merge' | 'rebase'. On success the
 * base branch moves, the pull request closes as merged, and the merge commit
 * sha is answered. Throws PullError with the status GitHub would use (404 is
 * the caller's job; 405 for anything not mergeable).
 */
export function mergePull(forge, repo, pull, method, options = {}) {
  if (pull.merged) throw new PullError(405, 'Pull Request is not mergeable: it was already merged');
  if (pull.state !== 'open') throw new PullError(405, 'Pull Request is not mergeable: it is closed');
  const { headOid, baseOid } = prTips(repo, pull);
  if (headOid === null || baseOid === null) throw new PullError(405, 'Pull Request is not mergeable: a branch is gone');
  const head = peelToCommit(repo.objects, headOid);
  const base = peelToCommit(repo.objects, baseOid);
  if (head === null || base === null) throw new PullError(405, 'Pull Request is not mergeable');
  if (isAncestor(repo.objects, head, base)) throw new PullError(405, 'Pull Request is not mergeable: nothing to merge');

  const outcome = threeWayMerge(repo, pull);
  if (outcome.conflicts !== undefined) {
    throw new PullError(405, 'Pull Request is not mergeable: conflicts must be resolved first');
  }
  const ident = forge.viewerIdent();
  let mergeSha;
  if (method === 'merge') {
    const message = options.message ?? `Merge pull request #${pull.number} from ${pull.headRef}\n`;
    const data = buildCommit({ tree: outcome.tree, parents: [base, head], author: ident, committer: ident, message });
    mergeSha = storePut(repo.objects, 'commit', data);
  } else if (method === 'rebase') {
    mergeSha = rebaseOnto(repo, pull, base, head, ident);
  } else {
    const title = options.title ?? pull.title;
    const extra = options.message ?? pull.body;
    const message = extra ? `${title}\n\n${extra}\n` : `${title}\n`;
    const data = buildCommit({ tree: outcome.tree, parents: [base], author: ident, committer: ident, message });
    mergeSha = storePut(repo.objects, 'commit', data);
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.nowIso();
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = pull.mergedAt;
  forge.touch(repo);
  return mergeSha;
}

/** Replay the head branch's own commits onto the base tip, oldest first. */
function rebaseOnto(repo, pull, base, head, ident) {
  const baseAncestors = new Set();
  {
    const stack = [base];
    while (stack.length > 0) {
      const oid = stack.pop();
      if (oid === undefined || baseAncestors.has(oid)) continue;
      baseAncestors.add(oid);
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') stack.push(...parseCommit(object.data).parents);
    }
  }
  const chain = [];
  {
    const seen = new Set();
    const stack = [head];
    while (stack.length > 0) {
      const oid = stack.pop();
      if (oid === undefined || seen.has(oid) || baseAncestors.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      chain.push(oid);
      stack.push(...parseCommit(object.data).parents);
    }
  }
  chain.reverse();
  let current = base;
  let currentTree = treeOf(repo, base);
  for (const oid of chain) {
    const commit = parseCommit(repo.objects.get(oid).data);
    const parentTree = commit.parents.length > 0 ? treeOf(repo, commit.parents[0]) : null;
    const ancestorFlat = flattenTree(repo.objects, parentTree ?? storePut(repo.objects, 'tree', Buffer.alloc(0)));
    const oursFlat = flattenTree(repo.objects, currentTree);
    const theirsFlat = flattenTree(repo.objects, commit.tree);
    const { merged, conflicts } = mergeFlats(ancestorFlat, oursFlat, theirsFlat);
    if (conflicts.length > 0) throw new PullError(405, 'Pull Request is not mergeable: conflicts must be resolved first');
    const tree = buildTreeFromFlat(repo.objects, merged);
    const data = buildCommit({ tree, parents: [current], author: commit.author, committer: ident, message: commit.message });
    current = storePut(repo.objects, 'commit', data);
    currentTree = tree;
  }
  return current;
}
