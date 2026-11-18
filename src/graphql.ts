// The GraphQL surface: POST /api/graphql.
//
// A deliberately small GraphQL engine — lexer, parser (operations, aliases,
// variables, inline fragments and spreads, input objects), and an executor
// over the forge's store — covering the viewer/repository/issue/pull-request
// schema the forge advertises, Relay-style global ids and connections, the
// five mutations, and the introspection the schema checks read.

import {
  branchTip,
  createIssue,
  createPull,
  pullFiles,
  pullJson,
  pullMergeable,
  squashMerge,
} from './domain.ts';
import { headRef } from './store.ts';

// ---------------------------------------------------------------------------
// Global ids
// ---------------------------------------------------------------------------

export function toGlobalId(type, key) {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

export function fromGlobalId(id) {
  if (typeof id !== 'string') return null;
  let text;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const colon = text.indexOf(':');
  if (colon === -1) return null;
  return { type: text.slice(0, colon), key: text.slice(colon + 1) };
}

// ---------------------------------------------------------------------------
// Lexer and parser
// ---------------------------------------------------------------------------

function tokenize(source) {
  const tokens = [];
  let i = 0;
  const isNameStart = (c) => /[A-Za-z_]/.test(c);
  const isNameChar = (c) => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') { i += 1; continue; }
    if (c === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (source.startsWith('...', i)) { tokens.push({ kind: '...' }); i += 3; continue; }
    if ('{}():@$[]!|=&'.includes(c)) { tokens.push({ kind: c }); i += 1; continue; }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end === -1 ? source.length : end) });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === 'u' ? String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16)) : esc;
          j += esc === 'u' ? 6 : 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      const raw = source.slice(i, j);
      tokens.push({ kind: /[.eE]/.test(raw) ? 'float' : 'int', value: Number(raw) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

class Parser {
  constructor(source) {
    this.tokens = tokenize(source);
    this.pos = 0;
  }

  peek() { return this.tokens[this.pos]; }
  next() { const token = this.tokens[this.pos]; this.pos += 1; return token; }
  expect(kind) {
    const token = this.next();
    if (token.kind !== kind) throw new Error(`Expected ${kind}, found ${token.kind}`);
    return token;
  }
  skipDirectives() {
    while (this.peek().kind === '@') {
      this.next();
      this.expect('name');
      if (this.peek().kind === '(') this.parseArguments();
    }
  }
  parseValue() {
    const token = this.peek();
    if (token.kind === '$') { this.next(); return { kind: 'variable', name: this.expect('name').value }; }
    if (token.kind === 'string') { this.next(); return { kind: 'value', value: token.value }; }
    if (token.kind === 'int' || token.kind === 'float') { this.next(); return { kind: 'value', value: token.value }; }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'value', value: true };
      if (token.value === 'false') return { kind: 'value', value: false };
      if (token.value === 'null') return { kind: 'value', value: null };
      return { kind: 'value', value: token.value }; // enum
    }
    if (token.kind === '[') {
      this.next();
      const values = [];
      while (this.peek().kind !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token.kind === '{') {
      this.next();
      const fields = {};
      while (this.peek().kind !== '}') {
        const name = this.expect('name').value;
        this.expect(':');
        fields[name] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    throw new Error(`Unexpected value token ${token.kind}`);
  }
  parseArguments() {
    const args = {};
    this.expect('(');
    while (this.peek().kind !== ')') {
      const name = this.expect('name').value;
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }
  parseSelectionSet() {
    this.expect('{');
    const selections = [];
    while (this.peek().kind !== '}') {
      if (this.peek().kind === '...') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expect('name').value;
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.expect('name').value;
          this.skipDirectives();
          selections.push({ kind: 'fragmentSpread', name });
        }
        continue;
      }
      let name = this.expect('name').value;
      let alias = null;
      if (this.peek().kind === ':') {
        this.next();
        alias = name;
        name = this.expect('name').value;
      }
      const args = this.peek().kind === '(' ? this.parseArguments() : {};
      this.skipDirectives();
      const selectionSet = this.peek().kind === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', name, alias, args, selectionSet });
    }
    this.expect('}');
    return selections;
  }
  parseDocument() {
    const operations = [];
    const fragments = {};
    while (this.peek().kind !== 'eof') {
      if (this.peek().kind === '{') {
        operations.push({ operation: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expect('name').value;
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().kind === '(') {
          // Variable definitions: parse and discard (values arrive separately).
          let depth = 0;
          do {
            const token = this.next();
            if (token.kind === '(') depth += 1;
            if (token.kind === ')') depth -= 1;
          } while (depth > 0);
        }
        this.skipDirectives();
        operations.push({ operation: keyword, name, selectionSet: this.parseSelectionSet() });
      } else if (keyword === 'fragment') {
        const name = this.expect('name').value;
        this.expect('name'); // 'on'
        const typeCondition = this.expect('name').value;
        this.skipDirectives();
        fragments[name] = { typeCondition, selectionSet: this.parseSelectionSet() };
      } else {
        throw new Error(`Unexpected definition ${keyword}`);
      }
    }
    return { operations, fragments };
  }
}

function evaluateValue(node, variables) {
  if (!node) return undefined;
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'value': return node.value;
    case 'list': return node.values.map((value) => evaluateValue(value, variables));
    case 'object': {
      const out = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = evaluateValue(value, variables);
      return out;
    }
    default: return undefined;
  }
}

// ---------------------------------------------------------------------------
// Schema (for introspection) and object wrappers
// ---------------------------------------------------------------------------

const TYPE_FIELDS = {
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'repository', 'createdAt', 'updatedAt', 'url'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'repository', 'createdAt', 'updatedAt', 'url'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  Label: ['id', 'name', 'color', 'description'],
  Ref: ['name', 'prefix', 'target'],
  Commit: ['oid', 'message'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['types', 'queryType', 'mutationType', 'directives'],
  __Directive: ['name', 'description', 'locations', 'args'],
};

const ENUM_TYPES = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User']);

function wrap(type, data) {
  return { __type: type, ...data };
}

function cursorFor(index) {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor) {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = text.match(/^cursor:(\d+)$/);
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

/** Apply first/after pagination to a list of wrapped nodes. */
function paginate(items, args) {
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : items.length;
  let start = 0;
  if (typeof args.after === 'string') {
    const index = indexFromCursor(args.after);
    if (index >= 0) start = index + 1;
  }
  const page = items.slice(start, start + first);
  const hasNextPage = start + page.length < items.length;
  const endCursor = page.length > 0 ? cursorFor(start + page.length - 1) : (args.after ?? null);
  return { page, hasNextPage, endCursor, start };
}

function connection(type, edgeType, items, args) {
  const { page, hasNextPage, endCursor, start } = paginate(items, args);
  return wrap(type, {
    nodesValue: page,
    edgesValue: page.map((node, i) => wrap(edgeType, { nodeValue: node, cursorValue: cursorFor(start + i) })),
    pageInfoValue: wrap('PageInfo', {
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorFor(start) : null,
      endCursor,
    }),
    totalCount: items.length,
  });
}

function findRepoById(forge, id) {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return null;
}

function issueWrapper(repo, issue) {
  return wrap('Issue', { repo, record: issue });
}

function pullWrapper(repo, pull) {
  return wrap('PullRequest', { repo, record: pull });
}

function commentWrapper(repo, record, comment) {
  return wrap('IssueComment', { repo, record, comment });
}

function nodeFromGlobalId(forge, id) {
  const decoded = fromGlobalId(id);
  if (!decoded) return null;
  if (decoded.type === 'Repository') {
    const repo = findRepoById(forge, Number(decoded.key));
    return repo ? wrap('Repository', { repo }) : null;
  }
  if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
    const [repoId, number] = decoded.key.split(':').map(Number);
    const repo = findRepoById(forge, repoId);
    const record = repo ? repo.numbers.get(number) : null;
    if (!record) return null;
    if (decoded.type === 'Issue' && record.kind === 'issue') return issueWrapper(repo, record);
    if (decoded.type === 'PullRequest' && record.kind === 'pull') return pullWrapper(repo, record);
    return null;
  }
  if (decoded.type === 'User') {
    return wrap('User', { user: forge.viewer });
  }
  if (decoded.type === 'IssueComment') {
    const commentId = Number(decoded.key);
    for (const repo of forge.repos.values()) {
      for (const record of repo.numbers.values()) {
        const comment = record.comments.find((candidate) => candidate.id === commentId);
        if (comment) return commentWrapper(repo, record, comment);
      }
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

function typeWrapper(name) {
  if (TYPE_FIELDS[name]) {
    return wrap('__Type', {
      name,
      kind: 'OBJECT',
      fieldsValue: TYPE_FIELDS[name].map((field) => wrap('__Field', { name: field })),
      enumValuesValue: null,
    });
  }
  if (ENUM_TYPES[name]) {
    return wrap('__Type', {
      name,
      kind: 'ENUM',
      fieldsValue: null,
      enumValuesValue: ENUM_TYPES[name].map((value) => wrap('__EnumValue', { name: value })),
    });
  }
  return null;
}

const RESOLVERS = {
  Query: {
    viewer: (source, args, ctx) => wrap('User', { user: ctx.forge.viewer }),
    repository: (source, args, ctx) => {
      const repo = ctx.forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ? wrap('Repository', { repo }) : null;
    },
    node: (source, args, ctx) => nodeFromGlobalId(ctx.forge, args.id),
    __type: (source, args) => typeWrapper(String(args.name ?? '')),
    __schema: () => wrap('__Schema', {}),
  },
  User: {
    login: (source) => source.user.login,
    id: (source) => toGlobalId('User', source.user.login),
    name: (source) => source.user.name,
    email: (source) => source.user.email,
    url: (source) => `https://forge.invalid/${source.user.login}`,
  },
  Repository: {
    id: (source) => toGlobalId('Repository', String(source.repo.id)),
    databaseId: (source) => source.repo.id,
    name: (source) => source.repo.name,
    nameWithOwner: (source) => `${source.repo.ownerLogin}/${source.repo.name}`,
    owner: (source, args, ctx) => wrap('User', { user: ctx.forge.viewer }),
    defaultBranchRef: (source) => {
      const tip = source.repo.refs.get(headRef(source.repo));
      if (!tip) return null;
      return wrap('Ref', { name: source.repo.defaultBranch, oid: tip });
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    createdAt: (source) => source.repo.createdAt,
    updatedAt: (source) => source.repo.updatedAt,
    issue: (source, args) => {
      const record = source.repo.numbers.get(Number(args.number));
      return record && record.kind === 'issue' ? issueWrapper(source.repo, record) : null;
    },
    issues: (source, args) => {
      let issues = [...source.repo.numbers.values()].filter((record) => record.kind === 'issue');
      if (Array.isArray(args.states) && args.states.length > 0) {
        const wanted = new Set(args.states.map((state) => String(state).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const direction = args.orderBy && args.orderBy.direction === 'DESC' ? 'DESC' : 'ASC';
      issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
      return connection('IssueConnection', 'IssueEdge', issues.map((issue) => issueWrapper(source.repo, issue)), args);
    },
    pullRequest: (source, args) => {
      const record = source.repo.numbers.get(Number(args.number));
      return record && record.kind === 'pull' ? pullWrapper(source.repo, record) : null;
    },
    pullRequests: (source, args) => {
      let pulls = [...source.repo.numbers.values()].filter((record) => record.kind === 'pull');
      if (Array.isArray(args.states) && args.states.length > 0) {
        const wanted = new Set(args.states.map((state) => String(state).toUpperCase()));
        pulls = pulls.filter((pull) => {
          const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
          return wanted.has(state);
        });
      }
      pulls.sort((a, b) => a.number - b.number);
      return connection('PullRequestConnection', 'PullRequestEdge', pulls.map((pull) => pullWrapper(source.repo, pull)), args);
    },
  },
  Issue: {
    id: (source) => toGlobalId('Issue', `${source.repo.id}:${source.record.number}`),
    number: (source) => source.record.number,
    title: (source) => source.record.title,
    state: (source) => source.record.state.toUpperCase(),
    body: (source) => source.record.body ?? '',
    author: (source, args, ctx) => wrap('User', { user: ctx.forge.viewer }),
    repository: (source) => wrap('Repository', { repo: source.repo }),
    createdAt: (source) => source.record.createdAt,
    updatedAt: (source) => source.record.updatedAt,
    url: (source) => `https://forge.invalid/${source.repo.ownerLogin}/${source.repo.name}/issues/${source.record.number}`,
    labels: (source, args) => connection('LabelConnection', 'LabelEdge', [], args),
    comments: (source, args) => connection(
      'IssueCommentConnection',
      'IssueCommentEdge',
      source.record.comments.map((comment) => commentWrapper(source.repo, source.record, comment)),
      args,
    ),
  },
  PullRequest: {
    id: (source) => toGlobalId('PullRequest', `${source.repo.id}:${source.record.number}`),
    number: (source) => source.record.number,
    title: (source) => source.record.title,
    state: (source) => (source.record.merged ? 'MERGED' : source.record.state.toUpperCase()),
    body: (source) => source.record.body ?? '',
    merged: (source) => source.record.merged,
    mergeable: (source) => pullMergeable(source.repo, source.record),
    headRefName: (source) => source.record.headRef,
    baseRefName: (source) => source.record.baseRef,
    headRefOid: (source) => branchTip(source.repo, source.record.headRef) ?? '',
    baseRefOid: (source) => branchTip(source.repo, source.record.baseRef) ?? '',
    author: (source, args, ctx) => wrap('User', { user: ctx.forge.viewer }),
    repository: (source) => wrap('Repository', { repo: source.repo }),
    createdAt: (source) => source.record.createdAt,
    updatedAt: (source) => source.record.updatedAt,
    url: (source) => `https://forge.invalid/${source.repo.ownerLogin}/${source.repo.name}/pull/${source.record.number}`,
    files: (source, args) => connection(
      'PullRequestChangedFileConnection',
      'PullRequestChangedFileEdge',
      pullFiles(source.repo, source.record).map((file) => wrap('PullRequestChangedFile', { file })),
      args,
    ),
  },
  PullRequestChangedFile: {
    path: (source) => source.file.filename,
    additions: (source) => source.file.additions,
    deletions: (source) => source.file.deletions,
    changeType: (source) => (source.file.status === 'added' ? 'ADDED' : source.file.status === 'removed' ? 'DELETED' : 'MODIFIED'),
  },
  IssueComment: {
    id: (source) => toGlobalId('IssueComment', String(source.comment.id)),
    body: (source) => source.comment.body,
    author: (source, args, ctx) => wrap('User', { user: ctx.forge.viewer }),
    createdAt: (source) => source.comment.createdAt,
    updatedAt: (source) => source.comment.createdAt,
  },
  Ref: {
    name: (source) => source.name,
    prefix: () => 'refs/heads/',
    target: (source) => wrap('Commit', { oid: source.oid }),
  },
  Commit: {
    oid: (source) => source.oid,
    message: () => '',
  },
  PageInfo: {
    hasNextPage: (source) => source.hasNextPage,
    hasPreviousPage: (source) => source.hasPreviousPage,
    startCursor: (source) => source.startCursor,
    endCursor: (source) => source.endCursor,
  },
  __Type: {
    name: (source) => source.name,
    kind: (source) => source.kind,
    description: () => null,
    fields: (source) => source.fieldsValue,
    enumValues: (source) => source.enumValuesValue,
    possibleTypes: () => null,
    inputFields: () => null,
    ofType: () => null,
  },
  __Field: {
    name: (source) => source.name,
    description: () => null,
    args: () => [],
    type: () => wrap('__Type', { name: 'String', kind: 'SCALAR', fieldsValue: null, enumValuesValue: null }),
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (source) => source.name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    queryType: () => typeWrapper('Query'),
    mutationType: () => typeWrapper('Mutation'),
    types: () => [...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_TYPES)].map((name) => typeWrapper(name)).filter(Boolean),
    directives: () => [],
  },
  Mutation: {
    createIssue: (source, args, ctx) => {
      const input = args.input ?? {};
      const decoded = fromGlobalId(input.repositoryId);
      const repo = decoded && decoded.type === 'Repository' ? findRepoById(ctx.forge, Number(decoded.key)) : null;
      if (!repo) {
        ctx.errors.push({ message: 'Repository not found for the given repositoryId' });
        return null;
      }
      const { issue, error } = createIssue(ctx.forge, repo, {
        title: input.title,
        body: typeof input.body === 'string' ? input.body : '',
        labelNames: [],
      });
      if (error) {
        ctx.errors.push({ message: error.message });
        return null;
      }
      return wrap('CreateIssuePayload', { issueValue: issueWrapper(repo, issue), clientMutationId: input.clientMutationId ?? null });
    },
    closeIssue: (source, args, ctx) => {
      const input = args.input ?? {};
      const target = nodeFromGlobalId(ctx.forge, input.issueId);
      if (!target || target.__type !== 'Issue') {
        ctx.errors.push({ message: 'Issue not found for the given issueId' });
        return null;
      }
      target.record.state = 'closed';
      target.record.updatedAt = ctx.forge.nowIso();
      return wrap('CloseIssuePayload', { issueValue: target, clientMutationId: input.clientMutationId ?? null });
    },
    createPullRequest: (source, args, ctx) => {
      const input = args.input ?? {};
      const decoded = fromGlobalId(input.repositoryId);
      const repo = decoded && decoded.type === 'Repository' ? findRepoById(ctx.forge, Number(decoded.key)) : null;
      if (!repo) {
        ctx.errors.push({ message: 'Repository not found for the given repositoryId' });
        return null;
      }
      const { pull, error } = createPull(ctx.forge, repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        head: input.headRefName,
        base: input.baseRefName,
      });
      if (error) {
        ctx.errors.push({ message: error.message });
        return null;
      }
      return wrap('CreatePullRequestPayload', { pullRequestValue: pullWrapper(repo, pull), clientMutationId: input.clientMutationId ?? null });
    },
    mergePullRequest: (source, args, ctx) => {
      const input = args.input ?? {};
      const target = nodeFromGlobalId(ctx.forge, input.pullRequestId);
      if (!target || target.__type !== 'PullRequest') {
        ctx.errors.push({ message: 'Pull request not found for the given pullRequestId' });
        return null;
      }
      const { error } = squashMerge(ctx.forge, target.repo, target.record);
      if (error) {
        ctx.errors.push({ message: error.message });
        return wrap('MergePullRequestPayload', { pullRequestValue: target, clientMutationId: input.clientMutationId ?? null });
      }
      return wrap('MergePullRequestPayload', { pullRequestValue: target, clientMutationId: input.clientMutationId ?? null });
    },
    addComment: (source, args, ctx) => {
      const input = args.input ?? {};
      const target = nodeFromGlobalId(ctx.forge, input.subjectId);
      if (!target || (target.__type !== 'Issue' && target.__type !== 'PullRequest')) {
        ctx.errors.push({ message: 'Subject not found for the given subjectId' });
        return null;
      }
      const comment = { id: ctx.forge.nextCommentId, body: String(input.body ?? ''), createdAt: ctx.forge.nowIso() };
      ctx.forge.nextCommentId += 1;
      target.record.comments.push(comment);
      const node = commentWrapper(target.repo, target.record, comment);
      return wrap('AddCommentPayload', {
        commentEdgeValue: wrap('IssueCommentEdge', { nodeValue: node, cursorValue: cursorFor(target.record.comments.length - 1) }),
        subjectValue: target,
        clientMutationId: input.clientMutationId ?? null,
      });
    },
  },
  CreateIssuePayload: {
    issue: (source) => source.issueValue,
    clientMutationId: (source) => source.clientMutationId,
  },
  CloseIssuePayload: {
    issue: (source) => source.issueValue,
    clientMutationId: (source) => source.clientMutationId,
  },
  CreatePullRequestPayload: {
    pullRequest: (source) => source.pullRequestValue,
    clientMutationId: (source) => source.clientMutationId,
  },
  MergePullRequestPayload: {
    pullRequest: (source) => source.pullRequestValue,
    clientMutationId: (source) => source.clientMutationId,
  },
  AddCommentPayload: {
    commentEdge: (source) => source.commentEdgeValue,
    subject: (source) => source.subjectValue,
    clientMutationId: (source) => source.clientMutationId,
  },
};

// Connection field resolvers are shared by every connection type.
for (const type of ['IssueConnection', 'PullRequestConnection', 'PullRequestChangedFileConnection', 'IssueCommentConnection', 'LabelConnection']) {
  RESOLVERS[type] = {
    nodes: (source) => source.nodesValue,
    edges: (source) => source.edgesValue,
    pageInfo: (source) => source.pageInfoValue,
    totalCount: (source) => source.totalCount,
  };
  if (!TYPE_FIELDS[type]) TYPE_FIELDS[type] = ['nodes', 'edges', 'pageInfo', 'totalCount'];
}
for (const type of ['IssueEdge', 'PullRequestEdge', 'PullRequestChangedFileEdge', 'IssueCommentEdge', 'LabelEdge']) {
  RESOLVERS[type] = {
    node: (source) => source.nodeValue,
    cursor: (source) => source.cursorValue,
  };
  if (!TYPE_FIELDS[type]) TYPE_FIELDS[type] = ['node', 'cursor'];
}
RESOLVERS.Label = {
  id: (source) => toGlobalId('Label', source.label ? source.label.name : ''),
  name: (source) => (source.label ? source.label.name : ''),
  color: (source) => (source.label ? source.label.color : ''),
  description: (source) => (source.label ? source.label.description : null),
};
TYPE_FIELDS.Mutation = Object.keys(RESOLVERS.Mutation);

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

function resolveSelectionSet(ctx, typeName, source, selections) {
  const out = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      const condition = selection.typeCondition;
      if (condition === typeName || (condition === 'Node' && NODE_TYPES.has(typeName))) {
        Object.assign(out, resolveSelectionSet(ctx, typeName, source, selection.selectionSet));
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments[selection.name];
      if (fragment && (fragment.typeCondition === typeName || (fragment.typeCondition === 'Node' && NODE_TYPES.has(typeName)))) {
        Object.assign(out, resolveSelectionSet(ctx, typeName, source, fragment.selectionSet));
      }
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const typeResolvers = RESOLVERS[typeName] ?? {};
    const resolver = typeResolvers[selection.name];
    if (!resolver) {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "${typeName}".` });
      out[responseKey] = null;
      continue;
    }
    const args = {};
    for (const [argName, argNode] of Object.entries(selection.args)) {
      args[argName] = evaluateValue(argNode, ctx.variables);
    }
    let value;
    try {
      value = resolver(source, args, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      value = null;
    }
    out[responseKey] = completeValue(ctx, value, selection.selectionSet);
  }
  return out;
}

function completeValue(ctx, value, selectionSet) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, selectionSet));
  if (typeof value === 'object' && value.__type) {
    if (!selectionSet) return null;
    return resolveSelectionSet(ctx, value.__type, value, selectionSet);
  }
  return value;
}

export function executeGraphQL(forge, request) {
  const query = typeof request.query === 'string' ? request.query : '';
  const variables = request.variables && typeof request.variables === 'object' ? request.variables : {};
  let document;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation = request.operationName
    ? document.operations.find((op) => op.name === request.operationName) ?? document.operations[0]
    : document.operations[0];
  if (!operation) return { errors: [{ message: 'No operation found in the document' }] };
  const ctx = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = resolveSelectionSet(ctx, rootType, {}, operation.selectionSet);
  const result = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** HTTP entry: body text -> {status, body} (arrays answered with arrays). */
export function handleGraphQL(forge, bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { errors: [{ message: 'Request body is not valid JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((entry) => executeGraphQL(forge, entry ?? {})) };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { status: 400, body: { errors: [{ message: 'Request body must be an object' }] } };
  }
  return { status: 200, body: executeGraphQL(forge, parsed) };
}
