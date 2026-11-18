// The MCP surface: POST /mcp — JSON-RPC 2.0 over streamable HTTP.
//
// The forge answers the modern discovery probe (server/discover), initialize,
// ping, tools/list and tools/call. Six tools mirror the REST domain
// operations on the same store, so an issue created over MCP is the issue
// REST reads back, with the same ids.

import {
  createIssue,
  createPull,
  issueJson,
  pullJson,
  repoJson,
  squashMerge,
} from './domain.ts';

const SERVER_INFO = { name: 'koyuki-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated account.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full name in owner/repo form.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'open, closed or all (default open).' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'number', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function requireRepo(forge, args) {
  const repo = forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
  return repo;
}

function callTool(forge, name, args) {
  switch (name) {
    case 'create_repo': {
      if (forge.getRepo(forge.viewer.login, String(args.name))) {
        return toolError(`Repository "${args.name}" already exists`);
      }
      const repo = forge.createRepo({
        name: String(args.name),
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = requireRepo(forge, args);
      if (!repo) return toolError(`Repository ${args.owner}/${args.repo} not found`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = requireRepo(forge, args);
      if (!repo) return toolError(`Repository ${args.owner}/${args.repo} not found`);
      const { issue, error } = createIssue(forge, repo, {
        title: args.title,
        body: typeof args.body === 'string' ? args.body : '',
        labelNames: [],
      });
      if (error) return toolError(error.message);
      return toolResult(issueJson(forge, repo, issue));
    }
    case 'list_issues': {
      const repo = requireRepo(forge, args);
      if (!repo) return toolError(`Repository ${args.owner}/${args.repo} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.numbers.values()].filter((record) => record.kind === 'issue');
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      return toolResult(issues.map((issue) => issueJson(forge, repo, issue)));
    }
    case 'create_pull_request': {
      const repo = requireRepo(forge, args);
      if (!repo) return toolError(`Repository ${args.owner}/${args.repo} not found`);
      const { pull, error } = createPull(forge, repo, {
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        head: args.head,
        base: args.base,
      });
      if (error) return toolError(error.message);
      return toolResult(pullJson(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = requireRepo(forge, args);
      if (!repo) return toolError(`Repository ${args.owner}/${args.repo} not found`);
      const record = repo.numbers.get(Number(args.pull_number));
      if (!record || record.kind !== 'pull') return toolError(`Pull request ${args.pull_number} not found`);
      const { sha, error } = squashMerge(forge, repo, record);
      if (error) return toolError(error.message);
      return toolResult({ ...pullJson(forge, repo, record), sha });
    }
    default:
      return null;
  }
}

/**
 * Handle one JSON-RPC message. Returns {status, body} where body is null
 * when the message was a notification (answered 202 with no content).
 */
export function handleMcpMessage(forge, message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const id = 'id' in message ? message.id : undefined;
  const method = message.method;
  if (typeof method !== 'string') {
    return { status: 200, body: rpcError(id ?? null, -32600, 'Invalid Request: method is required') };
  }
  const isNotification = id === undefined;
  const params = message.params && typeof message.params === 'object' ? message.params : {};

  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        body: rpcResult(id, {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        }),
      };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
      const protocolVersion = requested && SUPPORTED_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_VERSIONS[1];
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        }),
      };
    }
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
    case 'tools/call': {
      const name = params.name;
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${String(name)}`) };
      const missing = (tool.inputSchema.required ?? []).filter(
        (key) => args[key] === undefined || args[key] === null || args[key] === '',
      );
      if (missing.length > 0) {
        return { status: 200, body: rpcError(id, -32602, `Missing required argument: ${missing[0]}`) };
      }
      const result = callTool(forge, name, args);
      if (result === null) return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${String(name)}`) };
      return { status: 200, body: rpcResult(id, result) };
    }
    default:
      if (isNotification || method.startsWith('notifications/')) return { status: 202, body: null };
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
  }
}

/** HTTP entry: body text -> {status, body|null}. */
export function handleMcp(forge, bodyText) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error: body is not valid JSON') };
  }
  if (Array.isArray(parsed)) {
    const responses = [];
    for (const entry of parsed) {
      const { body } = handleMcpMessage(forge, entry);
      if (body !== null) responses.push(body);
    }
    return { status: 200, body: responses };
  }
  return handleMcpMessage(forge, parsed);
}
