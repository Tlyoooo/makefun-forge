// graphql.ts — the GraphQL v4 surface at /api/graphql: a hand-written lexer,
// parser and executor over the forge store, covering the documents gh and
// github-mcp-server send: viewer, repository reads, issue/pull-request
// connections with cursor pagination, the five mutations, Relay node(id:),
// batched operations, and the __type introspection probes. A GraphQL-level
// failure is a 200 with an `errors` array; an unknown repository is
// data.repository = null with no errors.

import { VIEWER, globalId, parseGlobalId } from './store.ts';
import { PullError, mergePull, prFiles, prMergeable, validateNewPull } from './pulls.ts';
import { sendJson } from './web.ts';

// ---------------------------------------------------------------- lexer

function tokenize(source) {
  const tokens = [];
  let i = 0;
  const isNameStart = (ch) => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch) => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: '...', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: ch, value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1];
          const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
          } else if (esc in escapes) {
            value += escapes[esc];
            i += 2;
          } else throw new Error(`invalid escape \\${esc}`);
        } else {
          value += source[i];
          i += 1;
        }
      }
      if (i >= source.length) throw new Error('unterminated string');
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- parser

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  next() {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  expect(kind) {
    const token = this.next();
    if (token.kind !== kind) throw new Error(`expected ${kind}, found ${token.kind} ${JSON.stringify(token.value)}`);
    return token;
  }

  expectName(value) {
    const token = this.expect('name');
    if (value !== undefined && token.value !== value) throw new Error(`expected "${value}", found "${token.value}"`);
    return token.value;
  }

  parseDocument() {
    const definitions = [];
    while (this.peek().kind !== 'eof') definitions.push(this.parseDefinition());
    return definitions;
  }

  parseDefinition() {
    const token = this.peek();
    if (token.kind === '{') {
      return { kind: 'operation', operation: 'query', name: null, variables: [], selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      this.next();
      let name = null;
      if (this.peek().kind === 'name') name = this.next().value;
      const variables = this.peek().kind === '(' ? this.parseVariableDefinitions() : [];
      this.parseDirectives();
      return { kind: 'operation', operation: token.value, name, variables, selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      this.parseDirectives();
      return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    throw new Error(`unexpected definition start ${token.kind} ${JSON.stringify(token.value)}`);
  }

  parseVariableDefinitions() {
    this.expect('(');
    const variables = [];
    while (this.peek().kind !== ')') {
      this.expect('$');
      const name = this.expectName();
      this.expect(':');
      const type = this.parseType();
      let defaultValue;
      if (this.peek().kind === '=') {
        this.next();
        defaultValue = this.parseValue(true);
      }
      variables.push({ name, type, defaultValue });
    }
    this.expect(')');
    return variables;
  }

  parseType() {
    let type;
    if (this.peek().kind === '[') {
      this.next();
      const inner = this.parseType();
      this.expect(']');
      type = `[${inner}]`;
    } else {
      type = this.expectName();
    }
    if (this.peek().kind === '!') {
      this.next();
      type = `${type}!`;
    }
    return type;
  }

  parseDirectives() {
    const directives = [];
    while (this.peek().kind === '@') {
      this.next();
      const name = this.expectName();
      const args = this.peek().kind === '(' ? this.parseArguments() : {};
      directives.push({ name, args });
    }
    return directives;
  }

  parseArguments() {
    this.expect('(');
    const args = {};
    while (this.peek().kind !== ')') {
      const name = this.expectName();
      this.expect(':');
      args[name] = this.parseValue(false);
    }
    this.expect(')');
    return args;
  }

  parseValue(constant) {
    const token = this.next();
    if (token.kind === '$') {
      if (constant) throw new Error('variables are not allowed in constant values');
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === '[') {
      const values = [];
      while (this.peek().kind !== ']') values.push(this.parseValue(constant));
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token.kind === '{') {
      const fields = {};
      while (this.peek().kind !== '}') {
        const name = this.expectName();
        this.expect(':');
        fields[name] = this.parseValue(constant);
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${token.kind}`);
  }

  parseSelectionSet() {
    this.expect('{');
    const selections = [];
    while (this.peek().kind !== '}') selections.push(this.parseSelection());
    this.expect('}');
    return selections;
  }

  parseSelection() {
    if (this.peek().kind === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        return { kind: 'inline', typeCondition, directives, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      const directives = this.parseDirectives();
      return { kind: 'spread', name, directives };
    }
    let name = this.expectName();
    let alias = null;
    if (this.peek().kind === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.peek().kind === '(' ? this.parseArguments() : {};
    const directives = this.parseDirectives();
    const selectionSet = this.peek().kind === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }
}

function valueOf(node, variables) {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum': return node.value;
    case 'null': return null;
    case 'list': return node.values.map((value) => valueOf(value, variables));
    case 'object': {
      const out = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = valueOf(value, variables);
      return out;
    }
    default: return undefined;
  }
}

// ---------------------------------------------------------------- the schema description (introspection)

const ENUM_TYPES = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'],
};

const OBJECT_FIELDS = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email', 'url', 'isViewer', 'databaseId'],
  Organization: ['id', 'login', 'name', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'isPrivate', 'description', 'url', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt'],
  Ref: ['name', 'target', 'repository'],
  Commit: ['oid', 'message', 'messageHeadline', 'committedDate', 'author'],
  GitActor: ['name', 'email', 'date'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'author', 'repository', 'labels', 'comments', 'createdAt', 'updatedAt', 'closed', 'locked'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'repository', 'createdAt', 'updatedAt', 'url', 'mergedAt', 'mergeCommit'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  RateLimit: ['limit', 'cost', 'remaining', 'resetAt', 'used'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
  __Directive: ['name', 'description', 'locations', 'args'],
};

const KIND_OF = (name) => {
  if (ENUM_TYPES[name] !== undefined) return 'ENUM';
  if (name === 'Node') return 'INTERFACE';
  if (name.startsWith('__')) return 'OBJECT';
  return 'OBJECT';
};

// ---------------------------------------------------------------- domain lookups

function findRepoById(forge, numericId) {
  for (const repo of forge.repos.values()) if (repo.id === numericId) return repo;
  return null;
}

function findIssueByGlobal(forge, numericId) {
  for (const repo of forge.repos.values()) {
    for (const issue of repo.issues.values()) if (issue.id === numericId) return { repo, issue };
  }
  return null;
}

function findPullByGlobal(forge, numericId) {
  for (const repo of forge.repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.id === numericId) return { repo, pull };
  }
  return null;
}

function findCommentByGlobal(forge, numericId) {
  for (const repo of forge.repos.values()) {
    for (const issue of repo.issues.values()) {
      for (const comment of issue.comments) if (comment.id === numericId) return { repo, issue, comment };
    }
  }
  return null;
}

const wrapUser = (user) => ({ __typename: user.type === 'Organization' ? 'Organization' : 'User', user });
const wrapRepo = (repo) => ({ __typename: 'Repository', repo });
const wrapIssue = (repo, issue) => ({ __typename: 'Issue', repo, issue });
const wrapPull = (repo, pull) => ({ __typename: 'PullRequest', repo, pull });
const wrapComment = (repo, issue, comment) => ({ __typename: 'IssueComment', repo, issue, comment });

function nodeByGlobalId(forge, value) {
  const parsed = parseGlobalId(value);
  if (parsed === null) return null;
  if (parsed.kind === 'R') {
    const repo = findRepoById(forge, parsed.numericId);
    return repo === null ? null : wrapRepo(repo);
  }
  if (parsed.kind === 'I') {
    const found = findIssueByGlobal(forge, parsed.numericId);
    return found === null ? null : wrapIssue(found.repo, found.issue);
  }
  if (parsed.kind === 'P') {
    const found = findPullByGlobal(forge, parsed.numericId);
    return found === null ? null : wrapPull(found.repo, found.pull);
  }
  if (parsed.kind === 'C') {
    const found = findCommentByGlobal(forge, parsed.numericId);
    return found === null ? null : wrapComment(found.repo, found.issue, found.comment);
  }
  if (parsed.kind === 'U') {
    for (const user of forge.users.values()) if (user.id === parsed.numericId) return wrapUser(user);
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- connections

function cursorOf(number) {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor) {
  if (typeof cursor !== 'string') return null;
  try {
    const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

/**
 * Page an ordered list of wrapped nodes ({ number, node }) by first/after.
 * The cursor names the item number, so pages are stable under the order.
 */
function connection(typeName, items, args) {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 100;
  let start = 0;
  if (args.after !== undefined && args.after !== null) {
    const number = numberFromCursor(args.after);
    const index = items.findIndex((item) => item.number === number);
    if (index >= 0) start = index + 1;
  }
  const page = items.slice(start, start + first);
  const hasNextPage = start + page.length < items.length;
  return {
    __typename: typeName,
    nodes: page.map((item) => item.node),
    edges: page.map((item) => ({ __typename: typeName.replace('Connection', 'Edge'), node: item.node, cursor: cursorOf(item.number) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorOf(page[0].number) : null,
      endCursor: page.length > 0 ? cursorOf(page[page.length - 1].number) : null,
    },
    totalCount: items.length,
  };
}

function sortIssues(issues, orderBy) {
  const field = orderBy?.field ?? 'CREATED_AT';
  const direction = orderBy?.direction ?? 'DESC';
  const key = (issue) => (field === 'UPDATED_AT' ? issue.updatedAt : issue.createdAt);
  const sorted = [...issues].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return a.number - b.number;
  });
  if (direction === 'DESC') sorted.reverse();
  return sorted;
}

// ---------------------------------------------------------------- resolvers

function resolvers(forge) {
  const R = {};
  const def = (type, field, fn) => {
    if (R[type] === undefined) R[type] = {};
    R[type][field] = fn;
  };

  // Query
  def('Query', 'viewer', () => wrapUser(VIEWER));
  def('Query', 'repository', (_source, args) => {
    const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
    return repo === null ? null : wrapRepo(repo);
  });
  def('Query', 'node', (_source, args) => nodeByGlobalId(forge, args.id));
  def('Query', 'nodes', (_source, args) => (Array.isArray(args.ids) ? args.ids.map((id) => nodeByGlobalId(forge, id)) : []));
  def('Query', 'rateLimit', () => ({ __typename: 'RateLimit', limit: 5000, cost: 1, remaining: 4999, used: 1, resetAt: forge.nowIso() }));
  def('Query', '__type', (_source, args) => typeDescription(args.name));
  def('Query', '__schema', () => ({ __typename: '__Schema' }));

  // User / Organization
  for (const type of ['User', 'Organization']) {
    def(type, 'id', (source) => globalId('U', source.user.id));
    def(type, 'login', (source) => source.user.login);
    def(type, 'name', (source) => source.user.name);
    def(type, 'email', (source) => source.user.email ?? '');
    def(type, 'url', () => '');
    def(type, 'databaseId', (source) => source.user.id);
  }
  def('User', 'isViewer', (source) => source.user.login === VIEWER.login);

  // Repository
  def('Repository', 'id', (source) => globalId('R', source.repo.id));
  def('Repository', 'databaseId', (source) => source.repo.id);
  def('Repository', 'name', (source) => source.repo.name);
  def('Repository', 'nameWithOwner', (source) => `${source.repo.owner}/${source.repo.name}`);
  def('Repository', 'owner', (source) => wrapUser(forge.user(source.repo.owner) ?? { login: source.repo.owner, id: 0, name: source.repo.owner, email: '', type: 'User' }));
  def('Repository', 'defaultBranchRef', (source) => {
    const ref = `refs/heads/${source.repo.defaultBranch}`;
    if (!source.repo.refs.has(ref)) return null;
    return { __typename: 'Ref', name: source.repo.defaultBranch, repo: source.repo };
  });
  def('Repository', 'viewerPermission', (source) => (source.repo.owner === VIEWER.login ? 'ADMIN' : 'READ'));
  def('Repository', 'hasIssuesEnabled', () => true);
  def('Repository', 'isPrivate', (source) => source.repo.private);
  def('Repository', 'description', (source) => source.repo.description);
  def('Repository', 'url', () => '');
  def('Repository', 'createdAt', (source) => source.repo.createdAt);
  def('Repository', 'updatedAt', (source) => source.repo.updatedAt);
  def('Repository', 'issue', (source, args) => {
    const issue = source.repo.issues.get(Number(args.number));
    return issue === undefined ? null : wrapIssue(source.repo, issue);
  });
  def('Repository', 'issues', (source, args) => {
    let issues = [...source.repo.issues.values()];
    if (Array.isArray(args.states)) {
      const wanted = args.states.map((state) => String(state).toLowerCase());
      issues = issues.filter((issue) => wanted.includes(issue.state));
    }
    const ordered = sortIssues(issues, args.orderBy ?? undefined);
    return connection('IssueConnection', ordered.map((issue) => ({ number: issue.number, node: wrapIssue(source.repo, issue) })), args);
  });
  def('Repository', 'pullRequest', (source, args) => {
    const pull = source.repo.pulls.get(Number(args.number));
    return pull === undefined ? null : wrapPull(source.repo, pull);
  });
  def('Repository', 'pullRequests', (source, args) => {
    let pulls = [...source.repo.pulls.values()];
    if (Array.isArray(args.states)) {
      const wanted = args.states.map((state) => String(state));
      pulls = pulls.filter((pull) => {
        const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
        return wanted.includes(state);
      });
    }
    pulls.sort((a, b) => a.number - b.number);
    return connection('PullRequestConnection', pulls.map((pull) => ({ number: pull.number, node: wrapPull(source.repo, pull) })), args);
  });

  // Ref
  def('Ref', 'name', (source) => source.name);
  def('Ref', 'target', (source) => {
    const oid = source.repo.refs.get(`refs/heads/${source.name}`) ?? source.repo.refs.get(`refs/tags/${source.name}`);
    return oid === undefined ? null : { __typename: 'Commit', oid, repo: source.repo };
  });
  def('Ref', 'repository', (source) => wrapRepo(source.repo));

  // Commit (only what the surface can be asked for)
  def('Commit', 'oid', (source) => source.oid);
  def('Commit', 'message', (source) => {
    const object = source.repo.objects.get(source.oid);
    return object === undefined ? '' : object.data.toString('utf8').split('\n\n').slice(1).join('\n\n');
  });
  def('Commit', 'messageHeadline', (source) => {
    const object = source.repo.objects.get(source.oid);
    if (object === undefined) return '';
    const message = object.data.toString('utf8').split('\n\n').slice(1).join('\n\n');
    return message.split('\n')[0] ?? '';
  });

  // Issue
  def('Issue', 'id', (source) => globalId('I', source.issue.id));
  def('Issue', 'number', (source) => source.issue.number);
  def('Issue', 'title', (source) => source.issue.title);
  def('Issue', 'body', (source) => source.issue.body);
  def('Issue', 'state', (source) => source.issue.state.toUpperCase());
  def('Issue', 'url', () => '');
  def('Issue', 'author', (source) => wrapUser(forge.user(source.issue.user) ?? VIEWER));
  def('Issue', 'repository', (source) => wrapRepo(source.repo));
  def('Issue', 'createdAt', (source) => source.issue.createdAt);
  def('Issue', 'updatedAt', (source) => source.issue.updatedAt);
  def('Issue', 'closed', (source) => source.issue.state === 'closed');
  def('Issue', 'locked', () => false);
  def('Issue', 'labels', (source, args) => connection('LabelConnection',
    source.issue.labels
      .map((name) => source.repo.labels.get(name))
      .filter((label) => label !== undefined)
      .map((label, index) => ({ number: index + 1, node: { __typename: 'Label', label } })), args));
  def('Issue', 'comments', (source, args) => connection('IssueCommentConnection',
    source.issue.comments.map((comment) => ({ number: comment.id, node: wrapComment(source.repo, source.issue, comment) })), args));

  // Label
  def('Label', 'id', (source) => Buffer.from(`Label:${source.label.name}`, 'utf8').toString('base64'));
  def('Label', 'name', (source) => source.label.name);
  def('Label', 'color', (source) => source.label.color);
  def('Label', 'description', (source) => source.label.description ?? '');

  // IssueComment
  def('IssueComment', 'id', (source) => globalId('C', source.comment.id));
  def('IssueComment', 'body', (source) => source.comment.body);
  def('IssueComment', 'author', (source) => wrapUser(forge.user(source.comment.user) ?? VIEWER));
  def('IssueComment', 'createdAt', (source) => source.comment.createdAt);
  def('IssueComment', 'updatedAt', (source) => source.comment.updatedAt);
  def('IssueComment', 'url', () => '');

  // PullRequest
  def('PullRequest', 'id', (source) => globalId('P', source.pull.id));
  def('PullRequest', 'number', (source) => source.pull.number);
  def('PullRequest', 'title', (source) => source.pull.title);
  def('PullRequest', 'body', (source) => source.pull.body);
  def('PullRequest', 'state', (source) => (source.pull.merged ? 'MERGED' : source.pull.state.toUpperCase()));
  def('PullRequest', 'merged', (source) => source.pull.merged);
  def('PullRequest', 'mergeable', (source) => {
    if (source.pull.state !== 'open') return 'UNKNOWN';
    return prMergeable(source.repo, source.pull) ? 'MERGEABLE' : 'CONFLICTING';
  });
  def('PullRequest', 'headRefName', (source) => source.pull.headRef);
  def('PullRequest', 'baseRefName', (source) => source.pull.baseRef);
  def('PullRequest', 'headRef', (source) => (source.repo.refs.has(`refs/heads/${source.pull.headRef}`)
    ? { __typename: 'Ref', name: source.pull.headRef, repo: source.repo }
    : null));
  def('PullRequest', 'baseRef', (source) => (source.repo.refs.has(`refs/heads/${source.pull.baseRef}`)
    ? { __typename: 'Ref', name: source.pull.baseRef, repo: source.repo }
    : null));
  def('PullRequest', 'author', (source) => wrapUser(forge.user(source.pull.user) ?? VIEWER));
  def('PullRequest', 'repository', (source) => wrapRepo(source.repo));
  def('PullRequest', 'createdAt', (source) => source.pull.createdAt);
  def('PullRequest', 'updatedAt', (source) => source.pull.updatedAt);
  def('PullRequest', 'url', () => '');
  def('PullRequest', 'mergedAt', (source) => source.pull.mergedAt);
  def('PullRequest', 'mergeCommit', (source) => (source.pull.mergeCommitSha === null
    ? null
    : { __typename: 'Commit', oid: source.pull.mergeCommitSha, repo: source.repo }));
  def('PullRequest', 'files', (source, args) => connection('PullRequestChangedFileConnection',
    prFiles(source.repo, source.pull).map((file, index) => ({
      number: index + 1,
      node: { __typename: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions, status: file.status },
    })), args));

  // PullRequestChangedFile
  def('PullRequestChangedFile', 'path', (source) => source.path);
  def('PullRequestChangedFile', 'additions', (source) => source.additions);
  def('PullRequestChangedFile', 'deletions', (source) => source.deletions);
  def('PullRequestChangedFile', 'changeType', (source) => (source.status === 'removed' ? 'DELETED' : source.status.toUpperCase()));

  // Connections and page info read straight off the built value.
  for (const type of ['IssueConnection', 'PullRequestConnection', 'LabelConnection', 'IssueCommentConnection', 'PullRequestChangedFileConnection']) {
    def(type, 'nodes', (source) => source.nodes);
    def(type, 'edges', (source) => source.edges);
    def(type, 'pageInfo', (source) => source.pageInfo);
    def(type, 'totalCount', (source) => source.totalCount);
  }
  for (const type of ['IssueEdge', 'PullRequestEdge', 'LabelEdge', 'IssueCommentEdge', 'PullRequestChangedFileEdge', 'CommentEdge']) {
    def(type, 'node', (source) => source.node);
    def(type, 'cursor', (source) => source.cursor);
  }
  for (const field of ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']) {
    def('PageInfo', field, (source) => source[field]);
  }

  // Mutations
  def('Mutation', 'createIssue', (_source, args) => {
    const input = args.input ?? {};
    const parsed = parseGlobalId(input.repositoryId);
    const repo = parsed !== null && parsed.kind === 'R' ? findRepoById(forge, parsed.numericId) : null;
    if (repo === null) throw new Error(`Could not resolve repository id ${String(input.repositoryId)}`);
    if (typeof input.title !== 'string' || input.title === '') throw new Error('A title is required');
    const issue = forge.createIssue(repo, { title: input.title, body: typeof input.body === 'string' ? input.body : '' });
    return { __typename: 'CreateIssuePayload', issue: wrapIssue(repo, issue), clientMutationId: input.clientMutationId ?? null };
  });
  def('Mutation', 'closeIssue', (_source, args) => {
    const input = args.input ?? {};
    const parsed = parseGlobalId(input.issueId);
    const found = parsed !== null && parsed.kind === 'I' ? findIssueByGlobal(forge, parsed.numericId) : null;
    if (found === null) throw new Error(`Could not resolve issue id ${String(input.issueId)}`);
    found.issue.state = 'closed';
    found.issue.updatedAt = forge.nowIso();
    return { __typename: 'CloseIssuePayload', issue: wrapIssue(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null };
  });
  def('Mutation', 'createPullRequest', (_source, args) => {
    const input = args.input ?? {};
    const parsed = parseGlobalId(input.repositoryId);
    const repo = parsed !== null && parsed.kind === 'R' ? findRepoById(forge, parsed.numericId) : null;
    if (repo === null) throw new Error(`Could not resolve repository id ${String(input.repositoryId)}`);
    try {
      validateNewPull(repo, String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
    } catch (error) {
      if (error instanceof PullError) throw new Error(error.message);
      throw error;
    }
    const pull = forge.createPull(repo, {
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
      headRef: String(input.headRefName),
      baseRef: String(input.baseRefName),
    });
    return { __typename: 'CreatePullRequestPayload', pullRequest: wrapPull(repo, pull), clientMutationId: input.clientMutationId ?? null };
  });
  def('Mutation', 'mergePullRequest', (_source, args) => {
    const input = args.input ?? {};
    const parsed = parseGlobalId(input.pullRequestId);
    const found = parsed !== null && parsed.kind === 'P' ? findPullByGlobal(forge, parsed.numericId) : null;
    if (found === null) throw new Error(`Could not resolve pull request id ${String(input.pullRequestId)}`);
    const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
    try {
      mergePull(forge, found.repo, found.pull, method, {});
    } catch (error) {
      if (error instanceof PullError) throw new Error(error.message);
      throw error;
    }
    return { __typename: 'MergePullRequestPayload', pullRequest: wrapPull(found.repo, found.pull), clientMutationId: input.clientMutationId ?? null };
  });
  def('Mutation', 'addComment', (_source, args) => {
    const input = args.input ?? {};
    const parsed = parseGlobalId(input.subjectId);
    const found = parsed !== null && parsed.kind === 'I' ? findIssueByGlobal(forge, parsed.numericId) : null;
    if (found === null) throw new Error(`Could not resolve subject id ${String(input.subjectId)}`);
    const comment = forge.addComment(found.repo, found.issue, typeof input.body === 'string' ? input.body : '');
    return {
      __typename: 'AddCommentPayload',
      commentEdge: { __typename: 'CommentEdge', node: wrapComment(found.repo, found.issue, comment), cursor: cursorOf(comment.id) },
      clientMutationId: input.clientMutationId ?? null,
    };
  });
  for (const [type, key] of [['CreateIssuePayload', 'issue'], ['CloseIssuePayload', 'issue'], ['CreatePullRequestPayload', 'pullRequest'], ['MergePullRequestPayload', 'pullRequest'], ['AddCommentPayload', 'commentEdge']]) {
    def(type, key, (source) => source[key === 'issue' ? 'issue' : key]);
    def(type, 'clientMutationId', (source) => source.clientMutationId);
  }

  // Introspection types
  def('__Type', 'name', (source) => source.name);
  def('__Type', 'kind', (source) => KIND_OF(source.name));
  def('__Type', 'description', () => null);
  def('__Type', 'fields', (source) => (OBJECT_FIELDS[source.name] ?? []).map((name) => ({ __typename: '__Field', name })));
  def('__Type', 'enumValues', (source) => (ENUM_TYPES[source.name] ?? []).map((name) => ({ __typename: '__EnumValue', name })));
  def('__Type', 'possibleTypes', (source) => (source.name === 'Node'
    ? ['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment'].map((name) => typeDescription(name))
    : []));
  def('__Type', 'inputFields', () => []);
  def('__Type', 'ofType', () => null);
  def('__Type', 'specifiedByURL', () => null);
  def('__Field', 'name', (source) => source.name);
  def('__Field', 'description', () => null);
  def('__Field', 'args', () => []);
  def('__Field', 'type', () => typeDescription('String'));
  def('__Field', 'isDeprecated', () => false);
  def('__Field', 'deprecationReason', () => null);
  def('__EnumValue', 'name', (source) => source.name);
  def('__EnumValue', 'description', () => null);
  def('__EnumValue', 'isDeprecated', () => false);
  def('__EnumValue', 'deprecationReason', () => null);
  def('__Schema', 'types', () => [...Object.keys(OBJECT_FIELDS), ...Object.keys(ENUM_TYPES), 'Node'].map((name) => typeDescription(name)));
  def('__Schema', 'queryType', () => typeDescription('Query'));
  def('__Schema', 'mutationType', () => typeDescription('Mutation'));
  def('__Schema', 'subscriptionType', () => null);
  def('__Schema', 'directives', () => []);
  def('RateLimit', 'limit', (source) => source.limit);
  def('RateLimit', 'cost', (source) => source.cost);
  def('RateLimit', 'remaining', (source) => source.remaining);
  def('RateLimit', 'used', (source) => source.used);
  def('RateLimit', 'resetAt', (source) => source.resetAt);

  return R;
}

function typeDescription(name) {
  if (typeof name !== 'string') return null;
  if (OBJECT_FIELDS[name] === undefined && ENUM_TYPES[name] === undefined && name !== 'Node') return null;
  return { __typename: '__Type', name };
}

// ---------------------------------------------------------------- executor

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

function executeOperation(forge, resolverMap, document, operation, variables) {
  const errors = [];
  const fragments = new Map();
  for (const definition of document) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const rootValue = { __typename: rootType };
  const ctx = { forge, resolverMap, fragments, variables, errors };
  const data = executeSelectionSet(ctx, rootValue, rootType, operation.selectionSet, []);
  return { data, errors };
}

function directivesAllow(ctx, directives) {
  for (const directive of directives ?? []) {
    if (directive.name === 'skip' && valueOf(directive.args.if ?? { kind: 'boolean', value: false }, ctx.variables) === true) return false;
    if (directive.name === 'include' && valueOf(directive.args.if ?? { kind: 'boolean', value: true }, ctx.variables) === false) return false;
  }
  return true;
}

function executeSelectionSet(ctx, source, typeName, selections, path) {
  const out = {};
  const fields = collectFields(ctx, source, typeName, selections);
  for (const [responseKey, field] of fields) {
    out[responseKey] = resolveField(ctx, source, typeName, field, [...path, responseKey]);
  }
  return out;
}

/** Flatten a selection set (fragments merged) into responseKey -> field. */
function collectFields(ctx, source, typeName, selections) {
  const fields = new Map();
  const visit = (selectionSet, currentType) => {
    for (const selection of selectionSet ?? []) {
      if (!directivesAllow(ctx, selection.directives)) continue;
      if (selection.kind === 'field') {
        const key = selection.alias ?? selection.name;
        if (!fields.has(key)) fields.set(key, selection);
      } else if (selection.kind === 'inline') {
        if (selection.typeCondition === undefined || selection.typeCondition === currentType || selection.typeCondition === 'Node') {
          visit(selection.selectionSet, selection.typeCondition ?? currentType);
        }
      } else if (selection.kind === 'spread') {
        const fragment = ctx.fragments.get(selection.name);
        if (fragment !== undefined && (fragment.typeCondition === currentType || fragment.typeCondition === 'Node')) {
          visit(fragment.selectionSet, fragment.typeCondition);
        }
      }
    }
  };
  visit(selections, typeName);
  return fields;
}

function resolveField(ctx, source, typeName, field, path) {
  const name = field.name;
  if (name === '__typename') return source?.__typename ?? typeName;
  const typeResolvers = ctx.resolverMap[typeName] ?? {};
  const resolver = typeResolvers[name] ?? (typeName === 'Query' || typeName === 'Mutation' ? undefined : undefined);
  if (resolver === undefined) {
    // Meta-fields live on Query but are resolved through the same table.
    const meta = ctx.resolverMap.Query?.[name];
    if ((name === '__type' || name === '__schema') && meta !== undefined) {
      return completeValue(ctx, meta(source, coerceArgs(field, ctx.variables)), field, path);
    }
    ctx.errors.push({ message: `Field '${name}' doesn't exist on type '${typeName}'`, path });
    return null;
  }
  let value;
  try {
    value = resolver(source, coerceArgs(field, ctx.variables));
  } catch (error) {
    ctx.errors.push({ message: error instanceof Error ? error.message : String(error), path });
    return null;
  }
  return completeValue(ctx, value, field, path);
}

function coerceArgs(field, variables) {
  const args = {};
  for (const [key, node] of Object.entries(field.args ?? {})) args[key] = valueOf(node, variables);
  return args;
}

function completeValue(ctx, value, field, path) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item, index) => completeValue(ctx, item, field, [...path, index]));
  if (typeof value === 'object') {
    const typeName = value.__typename;
    if (typeName !== undefined && field.selectionSet !== null) {
      return executeSelectionSet(ctx, value, typeName, field.selectionSet, path);
    }
    if (field.selectionSet !== null && typeName === undefined) return value;
    return value;
  }
  return value;
}

// ---------------------------------------------------------------- HTTP

function runOperation(forge, resolverMap, body) {
  if (body === null || typeof body !== 'object' || typeof body.query !== 'string') {
    return { errors: [{ message: 'A GraphQL query string is required' }] };
  }
  let document;
  try {
    document = new Parser(tokenize(body.query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: `Parse error: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  const operations = document.filter((definition) => definition.kind === 'operation');
  let operation = operations[0];
  if (typeof body.operationName === 'string') {
    operation = operations.find((candidate) => candidate.name === body.operationName) ?? operation;
  }
  if (operation === undefined) return { errors: [{ message: 'No operation found in the document' }] };
  const variables = {};
  for (const definition of operation.variables ?? []) {
    if (definition.defaultValue !== undefined) variables[definition.name] = valueOf(definition.defaultValue, {});
  }
  if (body.variables !== null && typeof body.variables === 'object') {
    for (const [key, value] of Object.entries(body.variables)) variables[key] = value;
  }
  const { data, errors } = executeOperation(forge, resolverMap, document, operation, variables);
  const result = { data };
  if (errors.length > 0) result.errors = errors;
  return result;
}

/** Handle one POST /api/graphql (single operation or a batched array). */
export function handleGraphql(forge, res, bodyBuffer) {
  let body;
  try {
    body = JSON.parse(bodyBuffer.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Malformed JSON in request body' }] });
    return;
  }
  const resolverMap = resolvers(forge);
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map((entry) => runOperation(forge, resolverMap, entry)));
    return;
  }
  sendJson(res, 200, runOperation(forge, resolverMap, body));
}
