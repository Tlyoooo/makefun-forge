// The REST v3 surface: /api/v3/... — repositories, branches, git refs,
// commits, contents, labels, issues, comments and pull requests.
//
// Every reply is a JSON value (errors are {"message": ...}); the transport
// in main.ts adds the content type and the X-GitHub-Request-Id header.
// Handlers return {status, body?, headers?}; a missing body means an empty
// response (204).

import {
  commitTree,
  getObject,
  headRef,
  listCommits,
  lookupPath,
  objectId,
  parseCommit,
  parseTree,
  peelToCommit,
  resolveRevision,
} from './store.ts';
import {
  branchTip,
  commentJson,
  commitFiles,
  createIssue,
  createPull,
  issueJson,
  labelJson,
  pullFiles,
  pullJson,
  repoJson,
  squashMerge,
  userJson,
} from './domain.ts';

function fail(status, message) {
  return { status, body: { message } };
}

function decode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function paginate(items, query, url) {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const links = [];
  const linkUrl = (n) => `${url}?per_page=${perPage}&page=${n}`;
  if (page < totalPages) {
    links.push(`<${linkUrl(page + 1)}>; rel="next"`, `<${linkUrl(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${linkUrl(1)}>; rel="first"`, `<${linkUrl(page - 1)}>; rel="prev"`);
  }
  return { slice, headers: links.length > 0 ? { link: links.join(', ') } : {} };
}

export function handleRest(forge, req) {
  const { method, path, query, body } = req;
  const json = body ?? {};

  if (path === '/api/v3' || path === '/api/v3/') {
    if (method !== 'GET') return fail(404, 'Not Found');
    return {
      status: 200,
      headers: { 'x-oauth-scopes': 'repo, read:org' },
      body: {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_url: '/api/v3/repos/{owner}/{repo}/issues{/number}',
      },
    };
  }
  if (path === '/api/v3/meta') {
    if (method !== 'GET') return fail(404, 'Not Found');
    return { status: 200, body: { installed_version: 'koyuki-forge 1.0.0', verifiable_password_authentication: false } };
  }
  if (path === '/api/v3/user') {
    if (method !== 'GET') return fail(404, 'Not Found');
    return { status: 200, body: userJson(forge.viewer) };
  }
  if (path === '/api/v3/user/repos') {
    if (method === 'GET') {
      const all = forge.listRepos().map((repo) => repoJson(repo));
      const { slice, headers } = paginate(all, query, `http://${req.host}${path}`);
      return { status: 200, body: slice, headers };
    }
    if (method === 'POST') {
      if (typeof json.name !== 'string' || json.name.length === 0) {
        return fail(422, 'Repository creation failed: name is required');
      }
      if (forge.getRepo(forge.viewer.login, json.name)) {
        return fail(422, 'Repository creation failed: name already exists on this account');
      }
      const repo = forge.createRepo({
        name: json.name,
        description: typeof json.description === 'string' ? json.description : '',
        isPrivate: json.private === true,
        defaultBranch: typeof json.default_branch === 'string' ? json.default_branch : 'main',
      });
      return { status: 201, body: repoJson(repo) };
    }
    return fail(404, 'Not Found');
  }

  const repoMatch = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!repoMatch) return fail(404, 'Not Found');
  const owner = decode(repoMatch[1]);
  const name = decode(repoMatch[2]);
  const tail = repoMatch[3] ?? '';
  const repo = forge.getRepo(owner, name);
  if (!repo) return fail(404, 'Not Found');

  if (tail === '') {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      if (typeof json.description === 'string') repo.description = json.description;
      if (typeof json.private === 'boolean') repo.private = json.private;
      if (typeof json.default_branch === 'string' && json.default_branch) {
        repo.defaultBranch = json.default_branch;
      }
      repo.updatedAt = forge.nowIso();
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, name);
      return { status: 204 };
    }
    return fail(404, 'Not Found');
  }

  if (tail === '/branches' && method === 'GET') {
    const branches = [];
    for (const [ref, oid] of repo.refs) {
      if (ref.startsWith('refs/heads/')) {
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
      }
    }
    branches.sort((a, b) => (a.name < b.name ? -1 : 1));
    return { status: 200, body: branches };
  }
  if (tail.startsWith('/branches/') && method === 'GET') {
    const branch = decode(tail.slice('/branches/'.length));
    const tip = branchTip(repo, branch);
    if (!tip) return fail(404, 'Branch not found');
    return { status: 200, body: { name: branch, commit: { sha: tip }, protected: false } };
  }

  if (tail === '/git/refs' && method === 'POST') {
    const ref = json.ref;
    const sha = json.sha;
    if (typeof ref !== 'string' || !ref.startsWith('refs/')) return fail(422, 'ref is invalid');
    if (typeof sha !== 'string' || !getObject(repo, sha)) return fail(422, 'Object does not exist');
    if (repo.refs.has(ref)) return fail(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    const obj = getObject(repo, sha);
    return { status: 201, body: { ref, object: { sha, type: obj.type } } };
  }
  if (tail.startsWith('/git/refs/') && method === 'GET') {
    const ref = `refs/${decode(tail.slice('/git/refs/'.length))}`;
    const oid = repo.refs.get(ref);
    if (!oid) return fail(404, 'Reference not found');
    const obj = getObject(repo, oid);
    return { status: 200, body: { ref, object: { sha: oid, type: obj ? obj.type : 'commit' } } };
  }

  if (tail === '/commits' && method === 'GET') {
    const shaParam = query.get('sha');
    const tip = shaParam ? resolveRevision(repo, shaParam) : repo.refs.get(headRef(repo)) ?? null;
    if (!tip) return { status: 200, body: [] };
    const commitOid = peelToCommit(repo, tip) ?? tip;
    const commits = listCommits(repo, commitOid).map((oid) => {
      const parsed = parseCommit(getObject(repo, oid).data);
      const authorMatch = parsed.author.match(/^(.*) <(.*)> (\d+)/);
      return {
        sha: oid,
        commit: {
          message: parsed.message.trimEnd(),
          author: authorMatch
            ? { name: authorMatch[1], email: authorMatch[2], date: new Date(Number(authorMatch[3]) * 1000).toISOString() }
            : { name: '', email: '', date: repo.createdAt },
          tree: { sha: parsed.tree },
        },
        parents: parsed.parents.map((parent) => ({ sha: parent })),
      };
    });
    return { status: 200, body: commits };
  }

  if (tail === '/contents' || tail.startsWith('/contents/')) {
    const contentPath = tail === '/contents' ? '' : decode(tail.slice('/contents/'.length));
    return handleContents(forge, repo, method, contentPath, query, json);
  }

  if (tail === '/labels') {
    if (method === 'GET') {
      return { status: 200, body: [...repo.labels.values()].map((label) => labelJson(label)) };
    }
    if (method === 'POST') {
      if (typeof json.name !== 'string' || !json.name) return fail(422, 'Label name is required');
      if (repo.labels.has(json.name)) return fail(422, 'Label already exists');
      const label = {
        id: forge.nextLabelId,
        name: json.name,
        color: typeof json.color === 'string' ? json.color : 'ededed',
        description: typeof json.description === 'string' ? json.description : null,
      };
      forge.nextLabelId += 1;
      repo.labels.set(label.name, label);
      return { status: 201, body: labelJson(label) };
    }
    return fail(404, 'Not Found');
  }

  if (tail === '/issues') {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let issues = [...repo.numbers.values()].filter((record) => record.kind === 'issue');
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      const direction = query.get('direction') ?? 'desc';
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const mapped = issues.map((issue) => issueJson(forge, repo, issue));
      const { slice, headers } = paginate(mapped, query, `http://${req.host}${path}`);
      return { status: 200, body: slice, headers };
    }
    if (method === 'POST') {
      const labelNames = Array.isArray(json.labels)
        ? json.labels.map((label) => (typeof label === 'string' ? label : label && label.name)).filter(Boolean)
        : [];
      const { issue, error } = createIssue(forge, repo, {
        title: json.title,
        body: typeof json.body === 'string' ? json.body : '',
        labelNames,
      });
      if (error) return fail(error.status, error.message);
      return { status: 201, body: issueJson(forge, repo, issue) };
    }
    return fail(404, 'Not Found');
  }

  const issueMatch = tail.match(/^\/issues\/(\d+)$/);
  if (issueMatch) {
    const record = repo.numbers.get(Number(issueMatch[1]));
    if (!record || record.kind !== 'issue') return fail(404, 'Issue not found');
    if (method === 'GET') return { status: 200, body: issueJson(forge, repo, record) };
    if (method === 'PATCH') {
      if (json.state === 'open' || json.state === 'closed') record.state = json.state;
      if (typeof json.title === 'string') record.title = json.title;
      if (typeof json.body === 'string') record.body = json.body;
      record.updatedAt = forge.nowIso();
      return { status: 200, body: issueJson(forge, repo, record) };
    }
    return fail(404, 'Not Found');
  }

  const commentsMatch = tail.match(/^\/issues\/(\d+)\/comments$/);
  if (commentsMatch) {
    const record = repo.numbers.get(Number(commentsMatch[1]));
    if (!record) return fail(404, 'Issue not found');
    if (method === 'GET') {
      return { status: 200, body: record.comments.map((comment) => commentJson(forge, comment)) };
    }
    if (method === 'POST') {
      if (typeof json.body !== 'string' || !json.body) return fail(422, 'Comment body is required');
      const comment = { id: forge.nextCommentId, body: json.body, createdAt: forge.nowIso() };
      forge.nextCommentId += 1;
      record.comments.push(comment);
      return { status: 201, body: commentJson(forge, comment) };
    }
    return fail(404, 'Not Found');
  }

  if (tail === '/pulls') {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.numbers.values()].filter((record) => record.kind === 'pull');
      if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.number - a.number);
      const mapped = pulls.map((pull) => pullJson(forge, repo, pull));
      const { slice, headers } = paginate(mapped, query, `http://${req.host}${path}`);
      return { status: 200, body: slice, headers };
    }
    if (method === 'POST') {
      const { pull, error } = createPull(forge, repo, {
        title: typeof json.title === 'string' ? json.title : '',
        body: typeof json.body === 'string' ? json.body : '',
        head: json.head,
        base: json.base,
      });
      if (error) return fail(error.status, error.message);
      return { status: 201, body: pullJson(forge, repo, pull) };
    }
    return fail(404, 'Not Found');
  }

  const pullMatch = tail.match(/^\/pulls\/(\d+)$/);
  if (pullMatch && method === 'GET') {
    const record = repo.numbers.get(Number(pullMatch[1]));
    if (!record || record.kind !== 'pull') return fail(404, 'Pull request not found');
    return { status: 200, body: pullJson(forge, repo, record) };
  }

  const filesMatch = tail.match(/^\/pulls\/(\d+)\/files$/);
  if (filesMatch && method === 'GET') {
    const record = repo.numbers.get(Number(filesMatch[1]));
    if (!record || record.kind !== 'pull') return fail(404, 'Pull request not found');
    return { status: 200, body: pullFiles(repo, record) };
  }

  const mergeMatch = tail.match(/^\/pulls\/(\d+)\/merge$/);
  if (mergeMatch && method === 'PUT') {
    const record = repo.numbers.get(Number(mergeMatch[1]));
    if (!record || record.kind !== 'pull') return fail(404, 'Pull request not found');
    const { sha, error } = squashMerge(forge, repo, record);
    if (error) return fail(error.status, error.message);
    return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
  }

  return fail(404, 'Not Found');
}

function handleContents(forge, repo, method, contentPath, query, json) {
  if (method === 'GET') {
    const refParam = query.get('ref') ?? repo.defaultBranch;
    const tip = resolveRevision(repo, refParam);
    if (!tip) return fail(404, 'Not Found');
    const commitOid = peelToCommit(repo, tip);
    if (!commitOid) return fail(404, 'Not Found');
    const tree = commitTree(repo, commitOid);
    if (!tree) return fail(404, 'Not Found');
    if (contentPath === '') {
      return { status: 200, body: dirListing(repo, tree, '') };
    }
    const found = lookupPath(repo, tree, contentPath);
    if (!found) return fail(404, 'Not Found');
    if (found.kind === 'dir') return { status: 200, body: dirListing(repo, found.oid, contentPath) };
    const obj = getObject(repo, found.oid);
    if (!obj) return fail(404, 'Not Found');
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        content: obj.data.toString('base64'),
        sha: found.oid,
        size: obj.data.length,
        name: contentPath.split('/').pop(),
        path: contentPath,
      },
    };
  }

  if (method === 'PUT') {
    if (!contentPath) return fail(422, 'A file path is required');
    if (typeof json.content !== 'string') return fail(422, 'content (base64) is required');
    const branch = typeof json.branch === 'string' && json.branch ? json.branch : repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    if (!repo.refs.has(ref) && branch !== repo.defaultBranch) {
      const defaultTip = repo.refs.get(headRef(repo));
      if (!defaultTip) return fail(404, 'Branch not found');
      repo.refs.set(ref, defaultTip);
    }
    const tip = repo.refs.get(ref) ?? null;
    const tree = tip ? commitTree(repo, tip) : null;
    const existing = tree ? lookupPath(repo, tree, contentPath) : null;
    if (existing && existing.kind === 'dir') return fail(422, 'The path is a directory');
    if (existing) {
      if (typeof json.sha !== 'string' || !json.sha) return fail(422, '"sha" wasn\'t supplied');
      if (json.sha !== existing.oid) return fail(409, 'The provided sha does not match the current file');
    }
    const bytes = Buffer.from(json.content, 'base64');
    const blobOid = objectId('blob', bytes);
    const message = typeof json.message === 'string' && json.message
      ? json.message
      : `${existing ? 'Update' : 'Create'} ${contentPath}`;
    const commitSha = commitFiles(forge, repo, branch, new Map([[contentPath, bytes]]), message);
    return {
      status: existing ? 200 : 201,
      body: {
        content: {
          name: contentPath.split('/').pop(),
          path: contentPath,
          sha: blobOid,
          size: bytes.length,
          type: 'file',
          encoding: 'base64',
        },
        commit: { sha: commitSha, message },
      },
    };
  }

  if (method === 'DELETE') {
    if (!contentPath) return fail(422, 'A file path is required');
    const branch = typeof json.branch === 'string' && json.branch ? json.branch : repo.defaultBranch;
    const tip = branchTip(repo, branch);
    if (!tip) return fail(404, 'Branch not found');
    const tree = commitTree(repo, tip);
    const existing = tree ? lookupPath(repo, tree, contentPath) : null;
    if (!existing || existing.kind !== 'file') return fail(404, 'Not Found');
    if (typeof json.sha === 'string' && json.sha && json.sha !== existing.oid) {
      return fail(409, 'The provided sha does not match the current file');
    }
    const message = typeof json.message === 'string' && json.message ? json.message : `Delete ${contentPath}`;
    const commitSha = commitFiles(forge, repo, branch, new Map([[contentPath, null]]), message);
    return { status: 200, body: { content: null, commit: { sha: commitSha, message } } };
  }

  return fail(404, 'Not Found');
}

function dirListing(repo, treeOid, prefix) {
  const obj = getObject(repo, treeOid);
  if (!obj || obj.type !== 'tree') return [];
  return parseTree(obj.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: prefix ? `${prefix}/${entry.name}` : entry.name,
    sha: entry.oid,
  }));
}
