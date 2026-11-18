// rest.ts — the REST v3 surface under /api/v3: the root and meta documents,
// users, repositories (CRUD + Link pagination), branches, the git data API,
// commits, contents with GitHub's sha rules, labels, issues + comments, and
// pull requests. Every reply is JSON with a non-empty X-GitHub-Request-Id;
// another owner's repository is a 404, never a 403.

import {
  buildCommit,
  buildTree,
  buildTreeFromFlat,
  flattenTree,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  storePut,
  treeEntryAt,
  treeWithPath,
  ZERO_OID,
} from './gitobj.ts';
import { VIEWER, globalId } from './store.ts';
import { PullError, mergePull, prFiles, prMergeable, validateNewPull } from './pulls.ts';
import { originOf, sendError, sendJson } from './web.ts';

// ---------------------------------------------------------------- views

export function userView(user) {
  return {
    login: user.login,
    id: user.id,
    node_id: globalId('U', user.id),
    avatar_url: '',
    gravatar_id: '',
    url: '',
    html_url: '',
    type: user.type,
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

export function repoView(forge, repo) {
  const owner = forge.user(repo.owner) ?? { login: repo.owner, id: 0, name: repo.owner, email: '', type: 'User' };
  const openCount = [...repo.issues.values()].filter((issue) => issue.state === 'open').length
    + [...repo.pulls.values()].filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('R', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userView(owner),
    private: repo.private,
    html_url: '',
    description: repo.description,
    fork: false,
    url: '',
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    topics: [],
    has_issues: true,
    has_projects: false,
    has_downloads: false,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    open_issues_count: openCount,
    default_branch: repo.defaultBranch,
    visibility: repo.private ? 'private' : 'public',
  };
}

function labelView(label) {
  return {
    id: label.id,
    node_id: '',
    url: '',
    name: label.name,
    color: label.color,
    default: false,
    description: label.description ?? '',
  };
}

function issueLabelsView(repo, issue) {
  return issue.labels
    .map((name) => repo.labels.get(name))
    .filter((label) => label !== undefined)
    .map((label) => labelView(label));
}

export function issueView(forge, repo, issue) {
  return {
    id: issue.id,
    node_id: globalId('I', issue.id),
    url: '',
    repository_url: '',
    html_url: '',
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userView(forge.user(issue.user) ?? VIEWER),
    labels: issueLabelsView(repo, issue),
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
  };
}

/** A pull request seen through the issues API, as GitHub shapes it. */
export function pullAsIssueView(forge, repo, pull) {
  return {
    id: pull.id,
    node_id: globalId('P', pull.id),
    url: '',
    repository_url: '',
    html_url: '',
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userView(forge.user(pull.user) ?? VIEWER),
    labels: [],
    assignee: null,
    assignees: [],
    comments: 0,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    pull_request: { url: '', html_url: '', diff_url: '', patch_url: '' },
  };
}

export function commentView(forge, comment) {
  return {
    id: comment.id,
    node_id: globalId('C', comment.id),
    url: '',
    html_url: '',
    body: comment.body,
    user: userView(forge.user(comment.user) ?? VIEWER),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

function branchSideView(forge, repo, refName) {
  const oid = repo.refs.get(`refs/heads/${refName}`) ?? null;
  return {
    label: `${repo.owner}:${refName}`,
    ref: refName,
    sha: oid,
    user: userView(forge.user(repo.owner) ?? VIEWER),
    repo: repoView(forge, repo),
  };
}

export function pullView(forge, repo, pull) {
  return {
    id: pull.id,
    node_id: globalId('P', pull.id),
    url: '',
    html_url: '',
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userView(forge.user(pull.user) ?? VIEWER),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: pull.state === 'open' ? prMergeable(repo, pull) : null,
    head: branchSideView(forge, repo, pull.headRef),
    base: branchSideView(forge, repo, pull.baseRef),
    _links: {},
  };
}

function identView(ident) {
  return {
    name: ident.name,
    email: ident.email,
    date: new Date(ident.timestamp * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

export function commitView(repo, oid) {
  const object = repo.objects.get(oid);
  const commit = parseCommit(object.data);
  return {
    sha: oid,
    node_id: oid,
    url: '',
    html_url: '',
    author: commit.author === null ? null : identView(commit.author),
    committer: commit.committer === null ? null : identView(commit.committer),
    message: commit.message.replace(/\n$/, ''),
    tree: { sha: commit.tree, url: '' },
    parents: commit.parents.map((parent) => ({ sha: parent, url: '', html_url: '' })),
    commit: {
      author: commit.author === null ? null : identView(commit.author),
      committer: commit.committer === null ? null : identView(commit.committer),
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree, url: '' },
      comment_count: 0,
    },
  };
}

/** The compact commit shape the contents routes answer with. */
function contentsCommitView(repo, oid) {
  const view = commitView(repo, oid);
  return {
    sha: view.sha,
    author: view.author,
    committer: view.committer,
    message: view.message,
    tree: view.tree,
    parents: view.parents,
    url: '',
    html_url: '',
  };
}

// ---------------------------------------------------------------- helpers

/** Pagination: slice `items` by ?page / ?per_page and set the Link header. */
function paginate(req, res, url, items) {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const links = [];
  const linkUrl = (target) => {
    const next = new URL(url.pathname + url.search, originOf(req));
    next.searchParams.set('page', String(target));
    next.searchParams.set('per_page', String(perPage));
    return next.toString();
  };
  if (page < lastPage) {
    links.push(`<${linkUrl(page + 1)}>; rel="next"`);
    links.push(`<${linkUrl(lastPage)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${linkUrl(1)}>; rel="first"`);
    links.push(`<${linkUrl(page - 1)}>; rel="prev"`);
  }
  if (links.length > 0) res.setHeader('link', links.join(', '));
  return slice;
}

function rateHeaders(forge) {
  return {
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4999',
    'x-ratelimit-reset': String(forge.nowSec() + 3600),
    'x-github-request-id': forge.nextRequestId(),
  };
}

/** Resolve a repo for a route, answering 404 (and returning null) when absent. */
function needRepo(forge, res, owner, name) {
  const repo = forge.getRepo(owner, name);
  if (repo === null) {
    sendError(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

/** Walk from a ref name or oid to a commit oid (null when unborn/unknown). */
function resolveCommit(repo, ref) {
  if (ref === undefined || ref === null || ref === '') {
    const oid = repo.refs.get(forge_head(repo));
    return oid === undefined ? null : peelToCommit(repo.objects, oid);
  }
  const viaRef = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  if (viaRef !== undefined) return peelToCommit(repo.objects, viaRef);
  if (isOid(ref) && repo.objects.has(ref)) return peelToCommit(repo.objects, ref);
  // A unique oid prefix.
  if (/^[0-9a-f]{4,39}$/.test(ref)) {
    const matches = [...repo.objects.keys()].filter((oid) => oid.startsWith(ref));
    if (matches.length === 1) return peelToCommit(repo.objects, matches[0]);
  }
  return null;
}

function forge_head(repo) {
  return `refs/heads/${repo.defaultBranch}`;
}

function treeOfCommit(repo, commitOid) {
  if (commitOid === null) return null;
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

// ---------------------------------------------------------------- the router

/**
 * Handle one /api/v3 request. `segments` is the path after /api/v3, split and
 * decoded. Returns true when the route was claimed (even with an error).
 */
export function handleRest(forge, req, res, url, segments, body) {
  const headers = rateHeaders(forge);
  const json = (status, value) => sendJson(res, status, value, headers);
  const fail = (status, message) => sendError(res, status, message, headers);
  const method = req.method;

  // Root and meta.
  if (segments.length === 0 || (segments.length === 1 && segments[0] === '')) {
    if (method !== 'GET') return false;
    sendJson(res, 200, {
      current_user_url: '',
      current_user_repositories_url: '',
      repository_url: '',
      issue_search_url: '',
      emojis_url: '',
      rate_limit_url: '',
    }, { ...headers, 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return false;
    json(200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      installed_version: '1.0.0',
      plan: 'github-forge',
    });
    return true;
  }

  // The token's user.
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return false;
    json(200, userView(VIEWER));
    return true;
  }
  if (segments[0] === 'users' && segments.length === 2) {
    if (method !== 'GET') return false;
    const user = forge.user(segments[1]);
    if (user === null) {
      fail(404, 'Not Found');
      return true;
    }
    json(200, userView(user));
    return true;
  }

  // Repository creation and the viewer's list.
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const repos = forge.reposOf(VIEWER.login).map((repo) => repoView(forge, repo));
      json(200, paginate(req, res, url, repos));
      return true;
    }
    if (method === 'POST') {
      const name = body.name;
      if (typeof name !== 'string' || name === '' || /[^A-Za-z0-9._-]/.test(name) || name === '.' || name === '..') {
        fail(422, 'Repository creation failed: the name is invalid');
        return true;
      }
      if (forge.getRepo(VIEWER.login, name) !== null) {
        fail(422, `Repository creation failed: a repository named "${name}" already exists on this account`);
        return true;
      }
      const repo = forge.createRepo(VIEWER.login, {
        name,
        description: typeof body.description === 'string' ? body.description : '',
        private: body.private === true,
      });
      if (body.auto_init === true) {
        const blob = storePut(repo.objects, 'blob', Buffer.from(`# ${name}\n`, 'utf8'));
        const tree = storePut(repo.objects, 'tree', buildTree([{ mode: '100644', name: 'README.md', oid: blob }]));
        forge.commitOnBranch(repo, repo.defaultBranch, tree, 'Initial commit');
      }
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      json(201, repoView(forge, repo));
      return true;
    }
    return false;
  }

  if (segments[0] !== 'repos' || segments.length < 3) return false;
  const owner = segments[1];
  const repoName = segments[2];
  const rest = segments.slice(3);
  const repo = needRepo(forge, res, owner, repoName);
  if (repo === null) return true;

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') {
      json(200, repoView(forge, repo));
      return true;
    }
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== ''
        && repo.refs.has(`refs/heads/${body.default_branch}`)) repo.defaultBranch = body.default_branch;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        forge.repos.delete(forge.repoKey(repo.owner, repo.name));
        repo.name = body.name;
        forge.repos.set(forge.repoKey(repo.owner, repo.name), repo);
      }
      forge.touch(repo);
      json(200, repoView(forge, repo));
      return true;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, repoName);
      res.writeHead(204, headers);
      res.end();
      return true;
    }
    return false;
  }

  if (rest[0] === 'branches') return branchesRoute(forge, req, res, url, repo, rest.slice(1), method, headers);
  if (rest[0] === 'commits') return commitsRoute(forge, req, res, url, repo, rest.slice(1), method, headers);
  if (rest[0] === 'git') return gitDataRoute(forge, req, res, url, repo, rest.slice(1), method, body, headers);
  if (rest[0] === 'contents') return contentsRoute(forge, req, res, url, repo, rest.slice(1), method, body, headers);
  if (rest[0] === 'labels') return labelsRoute(forge, req, res, url, repo, rest.slice(1), method, body, headers);
  if (rest[0] === 'issues') return issuesRoute(forge, req, res, url, repo, rest.slice(1), method, body, headers);
  if (rest[0] === 'pulls') return pullsRoute(forge, req, res, url, repo, rest.slice(1), method, body, headers);
  return false;
}

// ---------------------------------------------------------------- branches

function branchView(repo, name) {
  const oid = repo.refs.get(`refs/heads/${name}`);
  return {
    name,
    commit: { sha: oid, url: '' },
    protected: false,
  };
}

function branchesRoute(forge, req, res, url, repo, rest, method, headers) {
  const json = (status, value) => sendJson(res, status, value, headers);
  const fail = (status, message) => sendError(res, status, message, headers);
  if (method !== 'GET') return false;
  if (rest.length === 0) {
    const names = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort();
    json(200, paginate(req, res, url, names.map((name) => branchView(repo, name))));
    return true;
  }
  const name = rest.join('/');
  if (!repo.refs.has(`refs/heads/${name}`)) {
    fail(404, 'Branch not found');
    return true;
  }
  json(200, branchView(repo, name));
  return true;
}

// ---------------------------------------------------------------- commits

function commitsRoute(forge, req, res, url, repo, rest, method, headers) {
  const json = (status, value) => sendJson(res, status, value, headers);
  const fail = (status, message) => sendError(res, status, message, headers);
  if (method !== 'GET') return false;
  if (rest.length === 1 && rest[0] !== '') {
    const oid = resolveCommit(repo, rest[0]);
    if (oid === null) {
      fail(404, 'Not Found');
      return true;
    }
    json(200, commitView(repo, oid));
    return true;
  }
  if (rest.length !== 0) return false;
  const start = resolveCommit(repo, url.searchParams.get('sha') ?? undefined);
  if (start === null) {
    fail(409, 'Git Repository is empty.');
    return true;
  }
  // A rev-list walk: newest first, parents after their children.
  const ordered = [];
  const seen = new Set();
  const heap = [start];
  const timeOf = (oid) => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return 0;
    return parseCommit(object.data).committer?.timestamp ?? 0;
  };
  while (heap.length > 0) {
    let best = 0;
    for (let i = 1; i < heap.length; i += 1) if (timeOf(heap[i]) > timeOf(heap[best])) best = i;
    const oid = heap.splice(best, 1)[0];
    if (oid === undefined || seen.has(oid)) continue;
    seen.add(oid);
    ordered.push(oid);
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'commit') heap.push(...parseCommit(object.data).parents);
  }
  json(200, paginate(req, res, url, ordered.map((oid) => commitView(repo, oid))));
  return true;
}

// ---------------------------------------------------------------- git data

function refView(repo, ref) {
  const oid = repo.refs.get(ref);
  const object = oid === undefined ? undefined : repo.objects.get(oid);
  return {
    ref,
    node_id: '',
    url: '',
    object: { type: object?.type ?? 'commit', sha: oid ?? ZERO_OID, url: '' },
  };
}

/** Normalize a ref path tail ("heads/x" or "refs/heads/x") to a full ref. */
function fullRef(tail) {
  const joined = tail.join('/');
  return joined.startsWith('refs/') ? joined : `refs/${joined}`;
}

function gitDataRoute(forge, req, res, url, repo, rest, method, body, headers) {
  const json = (status, value) => sendJson(res, status, value, headers);
  const fail = (status, message) => sendError(res, status, message, headers);

  if (rest[0] === 'refs') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const refs = [...repo.refs.keys()].sort().map((ref) => refView(repo, ref));
        json(200, paginate(req, res, url, refs));
        return true;
      }
      if (method === 'POST') {
        const ref = body.ref;
        const sha = body.sha;
        if (typeof ref !== 'string' || !ref.startsWith('refs/') || typeof sha !== 'string' || !repo.objects.has(sha)) {
          fail(422, 'Validation Failed: ref or object is invalid');
          return true;
        }
        if (repo.refs.has(ref)) {
          fail(422, 'Reference already exists');
          return true;
        }
        repo.refs.set(ref, sha);
        forge.touch(repo);
        json(201, refView(repo, ref));
        return true;
      }
      return false;
    }
    const ref = fullRef(rest.slice(1));
    if (method === 'GET') {
      if (!repo.refs.has(ref)) {
        fail(404, 'Reference not found');
        return true;
      }
      json(200, refView(repo, ref));
      return true;
    }
    if (method === 'DELETE') {
      if (!repo.refs.has(ref)) {
        fail(404, 'Reference not found');
        return true;
      }
      repo.refs.delete(ref);
      forge.touch(repo);
      res.writeHead(204, headers);
      res.end();
      return true;
    }
    return false;
  }
  // The singular spelling GitHub also serves.
  if (rest[0] === 'ref' && rest.length >= 2) {
    const ref = fullRef(rest.slice(1));
    if (method === 'GET') {
      if (!repo.refs.has(ref)) {
        fail(404, 'Reference not found');
        return true;
      }
      json(200, refView(repo, ref));
      return true;
    }
    return false;
  }

  if (rest[0] === 'blobs') {
    if (rest.length === 1 && method === 'POST') {
      const encoding = body.encoding ?? 'utf-8';
      const data = encoding === 'base64'
        ? Buffer.from(String(body.content ?? '').replace(/\s+/g, ''), 'base64')
        : Buffer.from(String(body.content ?? ''), 'utf8');
      const sha = storePut(repo.objects, 'blob', data);
      json(201, { sha, url: '' });
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      const object = repo.objects.get(rest[1]);
      if (object === undefined || object.type !== 'blob') {
        fail(404, 'Not Found');
        return true;
      }
      json(200, { sha: rest[1], node_id: '', size: object.data.length, url: '', content: object.data.toString('base64'), encoding: 'base64' });
      return true;
    }
    return false;
  }

  if (rest[0] === 'trees') {
    if (rest.length === 1 && method === 'POST') {
      const flat = new Map();
      if (typeof body.base_tree === 'string') {
        const baseCommit = resolveCommit(repo, body.base_tree);
        const baseTree = baseCommit !== null ? treeOfCommit(repo, baseCommit) : (repo.objects.has(body.base_tree) ? body.base_tree : null);
        if (baseTree !== null) for (const [path, entry] of flattenTree(repo.objects, baseTree)) flat.set(path, entry);
      }
      for (const entry of Array.isArray(body.tree) ? body.tree : []) {
        if (typeof entry.path !== 'string') continue;
        if (entry.sha === null) {
          flat.delete(entry.path);
          continue;
        }
        let sha = entry.sha;
        if (sha === undefined && entry.content !== undefined) {
          sha = storePut(repo.objects, 'blob', Buffer.from(String(entry.content), 'utf8'));
        }
        if (typeof sha !== 'string' || !repo.objects.has(sha)) {
          fail(422, `Validation Failed: the object ${String(sha)} does not exist`);
          return true;
        }
        flat.set(entry.path, { mode: entry.mode ?? '100644', oid: sha });
      }
      const tree = buildTreeFromFlat(repo.objects, flat);
      json(201, { sha: tree, url: '', tree: [], truncated: false });
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      const commit = resolveCommit(repo, rest[1]);
      const treeOid = commit !== null ? treeOfCommit(repo, commit) : (repo.objects.has(rest[1]) && repo.objects.get(rest[1]).type === 'tree' ? rest[1] : null);
      if (treeOid === null) {
        fail(404, 'Not Found');
        return true;
      }
      const recursive = url.searchParams.get('recursive') === '1';
      const entries = [];
      if (recursive) {
        const walk = (oid, prefix) => {
          for (const entry of parseTree(repo.objects.get(oid).data)) {
            const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
            entries.push({ path, mode: entry.mode, type: entry.mode === '40000' ? 'tree' : entry.mode === '160000' ? 'commit' : 'blob', sha: entry.oid, url: '' });
            if (entry.mode === '40000') walk(entry.oid, path);
          }
        };
        walk(treeOid, '');
      } else {
        for (const entry of parseTree(repo.objects.get(treeOid).data)) {
          entries.push({ path: entry.name, mode: entry.mode, type: entry.mode === '40000' ? 'tree' : entry.mode === '160000' ? 'commit' : 'blob', sha: entry.oid, url: '' });
        }
      }
      json(200, { sha: treeOid, url: '', tree: entries, truncated: false });
      return true;
    }
    return false;
  }

  if (rest[0] === 'commits') {
    if (rest.length === 1 && method === 'POST') {
      const tree = body.tree;
      if (typeof tree !== 'string' || !repo.objects.has(tree)) {
        fail(422, 'Validation Failed: the tree does not exist');
        return true;
      }
      const ident = forge.viewerIdent();
      const author = body.author !== undefined ? identFromBody(body.author, ident) : ident;
      const committer = body.committer !== undefined ? identFromBody(body.committer, ident) : ident;
      const parents = Array.isArray(body.parents) ? body.parents.filter((parent) => repo.objects.has(parent)) : [];
      const data = buildCommit({ tree, parents, author, committer, message: String(body.message ?? '') });
      const sha = storePut(repo.objects, 'commit', data);
      json(201, commitView(repo, sha));
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      if (!repo.objects.has(rest[1]) || repo.objects.get(rest[1]).type !== 'commit') {
        fail(404, 'Not Found');
        return true;
      }
      json(200, commitView(repo, rest[1]));
      return true;
    }
    return false;
  }

  if (rest[0] === 'tags' && rest.length === 2 && method === 'GET') {
    const object = repo.objects.get(rest[1]);
    if (object === undefined || object.type !== 'tag') {
      fail(404, 'Not Found');
      return true;
    }
    const tag = parseTag(object.data);
    json(200, { node_id: '', tag: tag.tag, sha: rest[1], url: '', message: tag.message, object: { sha: tag.object, type: tag.type, url: '' }, tagger: tag.tagger === null ? null : identView(tag.tagger) });
    return true;
  }
  return false;
}

function identFromBody(value, fallback) {
  if (value === null || typeof value !== 'object') return fallback;
  const timestamp = typeof value.date === 'string' ? Math.floor(Date.parse(value.date) / 1000) : fallback.timestamp;
  return {
    name: typeof value.name === 'string' ? value.name : fallback.name,
    email: typeof value.email === 'string' ? value.email : fallback.email,
    timestamp: Number.isNaN(timestamp) ? fallback.timestamp : timestamp,
    timezone: '+0000',
  };
}

// ---------------------------------------------------------------- contents

function contentsRoute(forge, req, res, url, repo, segments, method, body, headers) {
  const json = (status, value) => sendJson(res, status, value, headers);
  const fail = (status, message) => sendError(res, status, message, headers);
  const path = segments.join('/');

  const branchOf = (fallback) => {
    const named = typeof body?.branch === 'string' && body.branch !== '' ? body.branch : fallback;
    return named;
  };

  if (method === 'GET') {
    const ref = url.searchParams.get('ref') ?? undefined;
    const commit = resolveCommit(repo, ref);
    if (commit === null) {
      fail(404, 'Not Found');
      return true;
    }
    const tree = treeOfCommit(repo, commit);
    if (path === '') {
      json(200, dirListing(repo, tree, ''));
      return true;
    }
    const entry = treeEntryAt(repo.objects, tree, path.split('/'));
    if (entry === null) {
      fail(404, 'Not Found');
      return true;
    }
    if (entry.mode === '40000') {
      json(200, dirListing(repo, entry.oid, path));
      return true;
    }
    const object = repo.objects.get(entry.oid);
    if (object === undefined || object.type !== 'blob') {
      fail(404, 'Not Found');
      return true;
    }
    json(200, {
      name: path.split('/').pop(),
      path,
      sha: entry.oid,
      size: object.data.length,
      url: '',
      html_url: '',
      git_url: '',
      download_url: '',
      type: entry.mode === '120000' ? 'symlink' : 'file',
      content: object.data.toString('base64'),
      encoding: 'base64',
      _links: {},
    });
    return true;
  }

  if (method === 'PUT') {
    if (path === '') {
      fail(422, 'Validation Failed: a file path is required');
      return true;
    }
    if (typeof body.message !== 'string' || body.message === '' || typeof body.content !== 'string') {
      fail(422, 'Validation Failed: message and content are required');
      return true;
    }
    const branch = branchOf(repo.defaultBranch);
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref);
    if (tip === undefined && branch !== repo.defaultBranch) {
      // A write to a fresh branch starts from the default branch's tip.
      tip = repo.refs.get(forge_head(repo));
    }
    const tipTree = tip === undefined ? null : treeOfCommit(repo, peelToCommit(repo.objects, tip));
    const existing = tipTree === null ? null : treeEntryAt(repo.objects, tipTree, path.split('/'));
    const data = Buffer.from(body.content.replace(/\s+/g, ''), 'base64');
    const blobOid = hashObject('blob', data);
    if (existing !== null && existing.mode !== '40000') {
      if (body.sha === undefined) {
        fail(422, 'Validation Failed: "sha" wasn\'t supplied');
        return true;
      }
      if (body.sha !== existing.oid) {
        fail(409, `${path} does not match ${String(body.sha)}`);
        return true;
      }
    }
    storePut(repo.objects, 'blob', data);
    const newTree = treeWithPath(repo.objects, tipTree, path.split('/'), { mode: '100644', oid: blobOid });
    const commitOid = forge.commitOnBranch(repo, branch, newTree, body.message, tip);
    const created = existing === null;
    json(created ? 201 : 200, {
      content: {
        name: path.split('/').pop(),
        path,
        sha: blobOid,
        size: data.length,
        url: '',
        html_url: '',
        git_url: '',
        download_url: '',
        type: 'file',
        _links: {},
      },
      commit: contentsCommitView(repo, commitOid),
    });
    return true;
  }

  if (method === 'DELETE') {
    if (typeof body.message !== 'string' || typeof body.sha !== 'string') {
      fail(422, 'Validation Failed: message and sha are required');
      return true;
    }
    const branch = branchOf(repo.defaultBranch);
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) {
      fail(404, 'Not Found');
      return true;
    }
    const tipTree = treeOfCommit(repo, peelToCommit(repo.objects, tip));
    const existing = tipTree === null ? null : treeEntryAt(repo.objects, tipTree, path.split('/'));
    if (existing === null || existing.mode === '40000') {
      fail(404, 'Not Found');
      return true;
    }
    if (body.sha !== existing.oid) {
      fail(409, `${path} does not match ${body.sha}`);
      return true;
    }
    const newTree = treeWithPath(repo.objects, tipTree, path.split('/'), null);
    const commitOid = forge.commitOnBranch(repo, branch, newTree, body.message);
    json(200, { content: null, commit: contentsCommitView(repo, commitOid) });
    return true;
  }
  return false;
}

function dirListing(repo, treeOid, prefix) {
  const tree = repo.objects.get(treeOid);
  if (tree === undefined) return [];
  return parseTree(tree.data).map((entry) => {
    const object = repo.objects.get(entry.oid);
    return {
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
      size: entry.mode === '40000' || object === undefined ? 0 : object.data.length,
      url: '',
      html_url: '',
      git_url: '',
      download_url: null,
      type: entry.mode === '40000' ? 'dir' : entry.mode === '160000' ? 'submodule' : 'file',
      _links: {},
    };
  });
}

// ---------------------------------------------------------------- labels

function labelsRoute(forge, req, res, url, repo, rest, method, body, headers) {
  const json = (status, value) => sendJson(res, status, value, headers);
  const fail = (status, message) => sendError(res, status, message, headers);
  if (rest.length === 0) {
    if (method === 'GET') {
      const labels = [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map(labelView);
      json(200, paginate(req, res, url, labels));
      return true;
    }
    if (method === 'POST') {
      const name = body.name;
      if (typeof name !== 'string' || name === '') {
        fail(422, 'Validation Failed: a label name is required');
        return true;
      }
      if (repo.labels.has(name)) {
        fail(422, 'Validation Failed: a label with that name already exists');
        return true;
      }
      const label = {
        id: forge.nextRecordId,
        name,
        color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
        description: typeof body.description === 'string' ? body.description : '',
      };
      forge.nextRecordId += 1;
      repo.labels.set(name, label);
      json(201, labelView(label));
      return true;
    }
    return false;
  }
  if (rest.length === 1) {
    const label = repo.labels.get(rest[0]);
    if (method === 'GET') {
      if (label === undefined) {
        fail(404, 'Not Found');
        return true;
      }
      json(200, labelView(label));
      return true;
    }
    if (method === 'DELETE') {
      if (label === undefined) {
        fail(404, 'Not Found');
        return true;
      }
      repo.labels.delete(rest[0]);
      res.writeHead(204, headers);
      res.end();
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- issues

/** Every issue-shaped record: issues plus pull requests (GitHub lists both). */
function issueRecords(repo) {
  const records = [];
  for (const issue of repo.issues.values()) records.push({ kind: 'issue', record: issue });
  for (const pull of repo.pulls.values()) records.push({ kind: 'pull', record: pull });
  records.sort((a, b) => a.record.number - b.record.number);
  return records;
}

function findIssueOrPull(repo, number) {
  const issue = repo.issues.get(number);
  if (issue !== undefined) return { kind: 'issue', record: issue };
  const pull = repo.pulls.get(number);
  if (pull !== undefined) return { kind: 'pull', record: pull };
  return null;
}

function issuesRoute(forge, req, res, url, repo, rest, method, body, headers) {
  const json = (status, value) => sendJson(res, status, value, headers);
  const fail = (status, message) => sendError(res, status, message, headers);

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let records = issueRecords(repo);
      if (state === 'open' || state === 'closed') records = records.filter((entry) => entry.record.state === state);
      const keyOf = (entry) => (sort === 'updated' ? entry.record.updatedAt : entry.record.createdAt);
      records.sort((a, b) => {
        const ka = keyOf(a);
        const kb = keyOf(b);
        if (ka !== kb) return (ka < kb ? -1 : 1) * (direction === 'asc' ? 1 : -1);
        return (a.record.number - b.record.number) * (direction === 'asc' ? 1 : -1);
      });
      const views = records.map((entry) => (entry.kind === 'issue' ? issueView(forge, repo, entry.record) : pullAsIssueView(forge, repo, entry.record)));
      json(200, paginate(req, res, url, views));
      return true;
    }
    if (method === 'POST') {
      if (typeof body.title !== 'string' || body.title === '') {
        fail(422, 'Validation Failed: a title is required');
        return true;
      }
      const labels = Array.isArray(body.labels) ? body.labels.map((entry) => (typeof entry === 'string' ? entry : entry?.name)).filter((name) => typeof name === 'string') : [];
      for (const name of labels) {
        if (!repo.labels.has(name)) {
          fail(422, `Validation Failed: the label "${name}" does not exist`);
          return true;
        }
      }
      const issue = forge.createIssue(repo, { title: body.title, body: typeof body.body === 'string' ? body.body : '', labels });
      json(201, issueView(forge, repo, issue));
      return true;
    }
    return false;
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number <= 0) return false;
  const found = findIssueOrPull(repo, number);

  if (rest.length === 1) {
    if (found === null) {
      fail(404, 'Not Found');
      return true;
    }
    if (method === 'GET') {
      json(200, found.kind === 'issue' ? issueView(forge, repo, found.record) : pullAsIssueView(forge, repo, found.record));
      return true;
    }
    if (method === 'PATCH') {
      const record = found.record;
      if (typeof body.title === 'string') record.title = body.title;
      if (typeof body.body === 'string') record.body = body.body;
      if (body.state === 'open' || body.state === 'closed') record.state = body.state;
      if (found.kind === 'issue' && Array.isArray(body.labels)) {
        const labels = body.labels.map((entry) => (typeof entry === 'string' ? entry : entry?.name)).filter((name) => typeof name === 'string');
        for (const name of labels) {
          if (!repo.labels.has(name)) {
            fail(422, `Validation Failed: the label "${name}" does not exist`);
            return true;
          }
        }
        record.labels = labels;
      }
      record.updatedAt = forge.nowIso();
      forge.touch(repo);
      json(200, found.kind === 'issue' ? issueView(forge, repo, record) : pullAsIssueView(forge, repo, record));
      return true;
    }
    return false;
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (found === null || found.kind !== 'issue') {
      // Comments live on issues; a pull request number works too (GitHub
      // serves issue comments for pull requests at this same route).
      if (found === null) {
        fail(404, 'Not Found');
        return true;
      }
    }
    const issue = found.kind === 'issue' ? found.record : null;
    if (method === 'GET') {
      const comments = issue === null ? [] : issue.comments.map((comment) => commentView(forge, comment));
      json(200, paginate(req, res, url, comments));
      return true;
    }
    if (method === 'POST') {
      if (issue === null) {
        fail(404, 'Not Found');
        return true;
      }
      if (typeof body.body !== 'string') {
        fail(422, 'Validation Failed: a comment body is required');
        return true;
      }
      const comment = forge.addComment(repo, issue, body.body);
      json(201, commentView(forge, comment));
      return true;
    }
    return false;
  }
  return false;
}

// ---------------------------------------------------------------- pulls

function pullsRoute(forge, req, res, url, repo, rest, method, body, headers) {
  const json = (status, value) => sendJson(res, status, value, headers);
  const fail = (status, message) => sendError(res, status, message, headers);

  if (rest.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => a.number - b.number);
      const direction = url.searchParams.get('direction') ?? 'asc';
      if (direction === 'desc') pulls.reverse();
      json(200, paginate(req, res, url, pulls.map((pull) => pullView(forge, repo, pull))));
      return true;
    }
    if (method === 'POST') {
      if (typeof body.title !== 'string' || body.title === '' || typeof body.head !== 'string' || typeof body.base !== 'string') {
        fail(422, 'Validation Failed: title, head and base are required');
        return true;
      }
      const headRef = body.head.includes(':') ? body.head.split(':').pop() : body.head;
      const baseRef = body.base.includes(':') ? body.base.split(':').pop() : body.base;
      try {
        validateNewPull(repo, headRef, baseRef);
      } catch (error) {
        if (error instanceof PullError) {
          fail(error.status, error.message);
          return true;
        }
        throw error;
      }
      const pull = forge.createPull(repo, { title: body.title, body: typeof body.body === 'string' ? body.body : '', headRef, baseRef });
      json(201, pullView(forge, repo, pull));
      return true;
    }
    return false;
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number <= 0) return false;
  const pull = repo.pulls.get(number);

  if (rest.length === 1) {
    if (pull === undefined) {
      fail(404, 'Not Found');
      return true;
    }
    if (method === 'GET') {
      json(200, pullView(forge, repo, pull));
      return true;
    }
    if (method === 'PATCH') {
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
      pull.updatedAt = forge.nowIso();
      forge.touch(repo);
      json(200, pullView(forge, repo, pull));
      return true;
    }
    return false;
  }

  if (rest.length === 2 && rest[1] === 'files') {
    if (pull === undefined) {
      fail(404, 'Not Found');
      return true;
    }
    if (method !== 'GET') return false;
    const files = prFiles(repo, pull).map((file) => ({
      sha: file.sha,
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    }));
    json(200, paginate(req, res, url, files));
    return true;
  }

  if (rest.length === 2 && rest[1] === 'merge') {
    if (pull === undefined) {
      fail(404, 'Not Found');
      return true;
    }
    if (method !== 'PUT') return false;
    const methodName = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
    try {
      const sha = mergePull(forge, repo, pull, methodName, {
        title: typeof body.commit_title === 'string' ? body.commit_title : undefined,
        message: typeof body.commit_message === 'string' ? body.commit_message : undefined,
      });
      json(200, { sha, merged: true, message: 'Pull Request successfully merged' });
    } catch (error) {
      if (error instanceof PullError) {
        fail(error.status, error.message);
        return true;
      }
      throw error;
    }
    return true;
  }
  return false;
}
