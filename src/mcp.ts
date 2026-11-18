// mcp.ts — the Model Context Protocol surface at /mcp (JSON-RPC 2.0 over
// streamable HTTP, answered as plain JSON). It speaks the current revision's
// handshake-free era (server/discover) and still answers initialize for
// older clients. The six tools drive the same store as REST: a repository or
// issue created here is the same object over there.

import { VIEWER } from './store.ts';
import { issueView, pullView, repoView } from './rest.ts';
import { PullError, mergePull, validateNewPull } from './pulls.ts';
import { sendJson } from './web.ts';

const SERVER_INFO = { name: 'github-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function toolSchema(properties, required) {
  return { type: 'object', properties, required, additionalProperties: false };
}

const STRING = (description) => ({ type: 'string', description });

/** The tool list: built once, so two tools/list answers are byte-identical. */
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: toolSchema({
      name: STRING('The repository name'),
      description: STRING('A short description of the repository'),
      private: { type: 'boolean', description: 'Whether the repository is private' },
    }, ['name']),
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: toolSchema({
      owner: STRING('The repository owner login'),
      repo: STRING('The repository name'),
    }, ['owner', 'repo']),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: toolSchema({
      owner: STRING('The repository owner login'),
      repo: STRING('The repository name'),
      title: STRING('The issue title'),
      body: STRING('The issue body'),
    }, ['owner', 'repo', 'title']),
  },
  {
    name: 'list_issues',
    description: 'List a repository\'s issues, optionally filtered by state (open, closed or all).',
    inputSchema: toolSchema({
      owner: STRING('The repository owner login'),
      repo: STRING('The repository name'),
      state: STRING('Issue state filter: open, closed or all'),
    }, ['owner', 'repo']),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: toolSchema({
      owner: STRING('The repository owner login'),
      repo: STRING('The repository name'),
      title: STRING('The pull request title'),
      body: STRING('The pull request body'),
      head: STRING('The head branch name'),
      base: STRING('The base branch name'),
    }, ['owner', 'repo', 'title', 'head', 'base']),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) and close it as merged.',
    inputSchema: toolSchema({
      owner: STRING('The repository owner login'),
      repo: STRING('The repository name'),
      pull_number: { type: 'integer', description: 'The pull request number' },
    }, ['owner', 'repo', 'pull_number']),
  },
];

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

/** A tool result in the wire shape: text content plus structured content. */
function toolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolFailure(message) {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function needRepo(forge, args) {
  const repo = forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
  if (repo === null) throw new Error(`Repository ${String(args.owner)}/${String(args.repo)} not found`);
  return repo;
}

function callTool(forge, name, args) {
  switch (name) {
    case 'create_repo': {
      const repoName = args.name;
      if (forge.getRepo(VIEWER.login, repoName) !== null) return toolFailure(`A repository named "${repoName}" already exists`);
      const repo = forge.createRepo(VIEWER.login, {
        name: repoName,
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      return toolResult(repoView(forge, repo));
    }
    case 'get_repo': {
      const repo = needRepo(forge, args);
      return toolResult(repoView(forge, repo));
    }
    case 'create_issue': {
      const repo = needRepo(forge, args);
      const issue = forge.createIssue(repo, { title: args.title, body: typeof args.body === 'string' ? args.body : '' });
      return toolResult(issueView(forge, repo, issue));
    }
    case 'list_issues': {
      const repo = needRepo(forge, args);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      return toolResult(issues.map((issue) => issueView(forge, repo, issue)));
    }
    case 'create_pull_request': {
      const repo = needRepo(forge, args);
      const headRef = String(args.head).includes(':') ? String(args.head).split(':').pop() : String(args.head);
      const baseRef = String(args.base).includes(':') ? String(args.base).split(':').pop() : String(args.base);
      try {
        validateNewPull(repo, headRef, baseRef);
      } catch (error) {
        if (error instanceof PullError) return toolFailure(error.message);
        throw error;
      }
      const pull = forge.createPull(repo, {
        title: args.title,
        body: typeof args.body === 'string' ? args.body : '',
        headRef,
        baseRef,
      });
      return toolResult(pullView(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = needRepo(forge, args);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return toolFailure(`Pull request #${String(args.pull_number)} not found`);
      try {
        mergePull(forge, repo, pull, 'squash', {});
      } catch (error) {
        if (error instanceof PullError) return toolFailure(error.message);
        throw error;
      }
      return toolResult(pullView(forge, repo, pull));
    }
    default:
      return null;
  }
}

/** Validate a tools/call against the tool's own schema (required + types). */
function validateToolArgs(tool, args) {
  const schema = TOOLS.find((candidate) => candidate.name === tool)?.inputSchema;
  if (schema === undefined) return null;
  for (const required of schema.required) {
    if (args[required] === undefined || args[required] === null) return `Missing required argument: ${required}`;
  }
  return null;
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function dispatch(forge, message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return rpcError(null, INVALID_REQUEST, 'Invalid Request');
  }
  const { id, method, params } = message;
  if (typeof method !== 'string') return rpcError(id ?? null, INVALID_REQUEST, 'Invalid Request: method must be a string');
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'initialize': {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments !== null && typeof params?.arguments === 'object' ? params.arguments : {};
      if (typeof name !== 'string' || !TOOL_NAMES.has(name)) {
        return rpcError(id, INVALID_PARAMS, `Unknown tool: ${String(name)}`);
      }
      const problem = validateToolArgs(name, args);
      if (problem !== null) return rpcError(id, INVALID_PARAMS, problem);
      try {
        return rpcResult(id, callTool(forge, name, args));
      } catch (error) {
        return rpcResult(id, toolFailure(error instanceof Error ? error.message : String(error)));
      }
    }
    default:
      if (method.startsWith('notifications/')) return null; // a notification: no answer
      return rpcError(id ?? null, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/** Handle one POST /mcp. Auth (401) is the router's job, before this runs. */
export function handleMcp(forge, res, bodyBuffer) {
  let body;
  try {
    body = JSON.parse(bodyBuffer.toString('utf8'));
  } catch {
    sendJson(res, 400, rpcError(null, PARSE_ERROR, 'Parse error'));
    return;
  }
  if (Array.isArray(body)) {
    const answers = body.map((entry) => dispatch(forge, entry)).filter((answer) => answer !== null);
    sendJson(res, 200, answers);
    return;
  }
  const isNotification = body !== null && typeof body === 'object' && !('id' in body) && typeof body.method === 'string';
  const answer = dispatch(forge, body);
  if (answer === null || isNotification) {
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return;
  }
  sendJson(res, 200, answer);
}
