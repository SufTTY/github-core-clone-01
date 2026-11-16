// MCP over Streamable HTTP at /mcp: initialize, server/discover, tools/list, tools/call.
// JSON-RPC 2.0, revision 2026-07-28 with older handshake revisions accepted.
import { Store, VIEWER_LOGIN, refCommit, dateFromSeq, squashMerge, type Repo, type Issue, type Pull } from './store.ts';
import { globalId } from './rest.ts';
import { pullFiles } from './store.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  required: readonly string[];
  properties: Record<string, Record<string, unknown>>;
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'The repository name' },
      description: { type: 'string', description: 'The repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
  },
  {
    name: 'get_repo',
    description: 'Get details of one repository.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      full_name: { type: 'string', description: 'owner/repo combined' },
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      full_name: { type: 'string', description: 'owner/repo combined' },
      title: { type: 'string', description: 'The issue title' },
      body: { type: 'string', description: 'The issue body' },
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      full_name: { type: 'string', description: 'owner/repo combined' },
      state: { type: 'string', description: 'open, closed or all', enum: ['open', 'closed', 'all'] },
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a pushed head branch.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      full_name: { type: 'string', description: 'owner/repo combined' },
      title: { type: 'string', description: 'The pull request title' },
      body: { type: 'string', description: 'The pull request body' },
      head: { type: 'string', description: 'The head branch name' },
      base: { type: 'string', description: 'The base branch name' },
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash).',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      full_name: { type: 'string', description: 'owner/repo combined' },
      pull_number: { type: 'number', description: 'The pull request number' },
      merge_method: { type: 'string', description: 'merge, squash or rebase' },
    },
  },
];

function toolsListJson(): string {
  // Deterministic, so two tools/list calls answer byte for byte.
  return JSON.stringify({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object', properties: tool.properties, required: [...tool.required] },
    })),
  });
}

function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}
function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

export interface McpReply { status: number; body: string; contentType: string }

/** Split arguments: owner/repo may arrive as full_name, pull_number as pullNumber etc. */
function pick(arguments_: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    if (arguments_[name] !== undefined) return arguments_[name];
  }
  return undefined;
}

function splitFullName(value: unknown): { owner?: string; repo?: string } {
  if (typeof value !== 'string') return {};
  const slash = value.indexOf('/');
  if (slash < 0) return { repo: value };
  return { owner: value.slice(0, slash), repo: value.slice(slash + 1) };
}

export function handleMcp(store: Store, rawBody: string | undefined, authed: boolean, hasAuthHeader: boolean): McpReply {
  let message: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody ?? '');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    message = parsed as Record<string, unknown>;
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
      contentType: 'application/json',
    };
  }
  const method = typeof message.method === 'string' ? message.method : '';
  const id = message.id;
  const isNotification = id === undefined || id === null;
  const arguments_ = (message.params !== null && typeof message.params === 'object' && !Array.isArray(message.params)
    && message.params.arguments !== null && typeof (message.params as Record<string, unknown>).arguments === 'object'
    ? (message.params as Record<string, unknown>).arguments
    : undefined) as Record<string, unknown> | undefined;

  if (method === 'initialize') {
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: '2026-07-28',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'forge-github', title: 'Forge GitHub-compatible server', version: '1.0.0' },
      }),
      contentType: 'application/json',
    };
  }
  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, { supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: {} } }),
      contentType: 'application/json',
    };
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: '', contentType: 'application/json' };
  }
  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}), contentType: 'application/json' };
  }
  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, JSON.parse(toolsListJson())), contentType: 'application/json' };
  }
  if (method === 'tools/call') {
    if (!authed) return { status: 401, body: JSON.stringify({ message: 'Requires authentication' }), contentType: 'application/json' };
    const name = (message.params as Record<string, unknown> | undefined)?.name;
    if (typeof name !== 'string' || name === '') {
      return { status: 200, body: rpcError(id, -32602, 'Invalid params: tool name is required'), contentType: 'application/json' };
    }
    const lower = name.toLowerCase();
    const matched = TOOLS.find((tool) => lower === tool.name || lower.endsWith(`__${tool.name}`) || lower.endsWith(`_${tool.name}`) || lower.endsWith(`-${tool.name}`) || lower.endsWith(`/${tool.name}`));
    if (!matched) {
      return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${name}`), contentType: 'application/json' };
    }
    const args = arguments_ ?? {};
    const missing = matched.required.filter((required) => pick(args, [required]) === undefined && (required !== 'owner' && required !== 'repo' || splitFullName(args.full_name)[required === 'owner' ? 'owner' : 'repo'] === undefined));
    if (missing.length > 0) {
      return { status: 200, body: rpcResult(id, { content: [{ type: 'text', text: `Missing required argument(s): ${missing.join(', ')}` }], isError: true }), contentType: 'application/json' };
    }
    const fullName = args.full_name;
    const split = splitFullName(fullName);
    const owner = String(pick(args, ['owner']) ?? split.owner ?? VIEWER_LOGIN);
    const repoName = String(pick(args, ['repo', 'repository']) ?? split.repo ?? '');
    try {
      const result = callTool(store, matched.name, { owner, repo: repoName, arguments_: args });
      return { status: 200, body: rpcResult(id, result), contentType: 'application/json' };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { status: 200, body: rpcResult(id, { content: [{ type: 'text', text }], isError: true }), contentType: 'application/json' };
    }
  }
  if (isNotification) return { status: 202, body: '', contentType: 'application/json' };
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`), contentType: 'application/json' };
}

function textResult(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] };
}

function callTool(store: Store, name: string, context: { owner: string; repo: string; arguments_: Record<string, unknown> }): Record<string, unknown> {
  const { owner, repo: repoName, arguments_ } = context;
  if (name === 'create_repo') {
    const created = store.createRepo(repoName, String(arguments_.description ?? ''), arguments_.private === true);
    return textResult({ full_name: created.key, name: created.name, id: created.id, private: created.privateFlag, default_branch: created.default_branch });
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) throw new Error(`Repository ${owner}/${repoName} not found`);
  if (name === 'get_repo') {
    return textResult({ id: repo.id, node_id: globalId('Repository', repo.id), name: repo.name, full_name: repo.key, owner: { login: repo.owner }, default_branch: repo.default_branch, private: repo.privateFlag, description: repo.description });
  }
  if (name === 'create_issue') {
    const title = String(arguments_.title ?? '');
    if (!title) throw new Error('Missing required argument(s): title');
    const now = dateFromSeq(store.nextId());
    const issue: Issue = {
      repoKey: repo.key, number: repo.nextIssue++, title, body: String(arguments_.body ?? ''),
      state: 'open', labels: [], comments: [], seq: store.nextId(),
      created_at: now, updated_at: now, closed_at: null, user: VIEWER_LOGIN,
    };
    repo.issues.set(issue.number, issue);
    return textResult({ number: issue.number, id: globalId('Issue', `${repo.id}_${issue.number}`), title: issue.title, state: 'open', url: `/api/v3/repos/${repo.key}/issues/${issue.number}` });
  }
  if (name === 'list_issues') {
    const state = String(arguments_.state ?? 'open');
    const issues = [...repo.issues.values()]
      .filter((issue) => state === 'all' || issue.state === state)
      .map((issue) => ({ number: issue.number, title: issue.title, state: issue.state, body: issue.body, labels: issue.labels }));
    return textResult(issues);
  }
  if (name === 'create_pull_request') {
    const head = String(arguments_.head ?? arguments_.headRefName ?? '');
    const base = String(arguments_.base ?? arguments_.baseRefName ?? '');
    const title = String(arguments_.title ?? '');
    const headSha = refCommit(repo, `refs/heads/${head}`);
    const baseSha = refCommit(repo, `refs/heads/${base}`);
    if (!headSha || !baseSha) throw new Error('Head or base branch does not exist');
    const now = dateFromSeq(store.nextId());
    const pull: Pull = {
      repoKey: repo.key, number: repo.nextPull++, title, body: String(arguments_.body ?? ''),
      head, base, headSha, baseSha, state: 'open', merged: false, merge_commit_sha: null,
      merged_at: null, created_at: now, user: VIEWER_LOGIN,
    };
    repo.pulls.set(pull.number, pull);
    return textResult({ number: pull.number, id: globalId('PullRequest', `${repo.id}_${pull.number}`), state: 'open', head: head, base: base, url: `/api/v3/repos/${repo.key}/pulls/${pull.number}` });
  }
  if (name === 'merge_pull_request') {
    const number = Number(pick(arguments_, ['pull_number', 'pullNumber', 'number']));
    const pull = repo.pulls.get(number);
    if (!pull) throw new Error(`Pull request #${number} not found`);
    if (pull.merged) throw new Error('Pull request is already merged');
    const baseSha = refCommit(repo, `refs/heads/${pull.base}`);
    if (!baseSha) throw new Error('Base branch is gone');
    const mergeSha = squashMerge(repo, pull);
    pull.state = 'closed';
    pull.merged = true;
    pull.merge_commit_sha = mergeSha;
    pull.merged_at = dateFromSeq(store.nextId());
    return textResult({ merged: true, sha: mergeSha, number: pull.number, message: 'Pull Request successfully merged' });
  }
  throw new Error('Unknown tool');
}