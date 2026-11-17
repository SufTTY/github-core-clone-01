// Model Context Protocol endpoint at POST /mcp: JSON-RPC 2.0 over Streamable HTTP.
// Revision 2026-07-28 (server/discover) is the current one; the initialize handshake
// of 2025-11-25 and earlier still answers, and every reply is a single JSON body.
import { Store, VIEWER_LOGIN, refCommit, dateFromSeq, squashMerge, type Issue, type Pull } from './store.ts';
import { globalId } from './rest.ts';

const IDENTITY = { name: 'forge-github', title: 'Forge GitHub-compatible server', version: '1.0.0' };

const REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const JSON_TYPE = 'application/json';

interface ToolSpec {
  name: string;
  blurb: string;
  needs: readonly string[];
  fields: Record<string, Record<string, unknown>>;
}

const CATALOG: readonly ToolSpec[] = [
  {
    name: 'create_repo',
    blurb: 'Create a new repository owned by the authenticated user.',
    needs: ['name'],
    fields: {
      name: { type: 'string', description: 'The repository name' },
      description: { type: 'string', description: 'The repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
  },
  {
    name: 'get_repo',
    blurb: 'Get details of one repository.',
    needs: ['owner', 'repo'],
    fields: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      full_name: { type: 'string', description: 'owner/repo combined' },
    },
  },
  {
    name: 'create_issue',
    blurb: 'Create a new issue in a repository.',
    needs: ['owner', 'repo', 'title'],
    fields: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      full_name: { type: 'string', description: 'owner/repo combined' },
      title: { type: 'string', description: 'The issue title' },
      body: { type: 'string', description: 'The issue body' },
    },
  },
  {
    name: 'list_issues',
    blurb: 'List issues in a repository.',
    needs: ['owner', 'repo'],
    fields: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      full_name: { type: 'string', description: 'owner/repo combined' },
      state: { type: 'string', description: 'open, closed or all', enum: ['open', 'closed', 'all'] },
    },
  },
  {
    name: 'create_pull_request',
    blurb: 'Open a pull request from a pushed head branch.',
    needs: ['owner', 'repo', 'title', 'head', 'base'],
    fields: {
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
    blurb: 'Merge a pull request (squash).',
    needs: ['owner', 'repo', 'pull_number'],
    fields: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      full_name: { type: 'string', description: 'owner/repo combined' },
      pull_number: { type: 'number', description: 'The pull request number' },
      merge_method: { type: 'string', description: 'merge, squash or rebase' },
    },
  },
];

function listToolsPayload(): Record<string, unknown> {
  // The catalog never changes at runtime, so this payload is the same bytes every call.
  return {
    tools: CATALOG.map((spec) => ({
      name: spec.name,
      description: spec.blurb,
      inputSchema: { type: 'object', properties: spec.fields, required: [...spec.needs] },
    })),
  };
}

function failFrame(id: unknown, code: number, why: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: why } });
}

function okFrame(id: unknown, value: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result: value });
}

export interface McpReply { status: number; body: string; contentType: string }

function send(status: number, body: string): McpReply {
  return { status, body, contentType: JSON_TYPE };
}

/** First defined value among the keys, so aliases such as repository still answer. */
function firstDefined(bag: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (bag[key] !== undefined) return bag[key];
  }
  return undefined;
}

/** Split an "owner/repo" style value into its two halves. */
function splitOwnerRepo(value: unknown): { owner?: string; repo?: string } {
  if (typeof value !== 'string') return {};
  const slash = value.indexOf('/');
  if (slash < 0) return { repo: value };
  return { owner: value.slice(0, slash), repo: value.slice(slash + 1) };
}

function textPayload(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
}

export function handleMcp(store: Store, rawBody: string | undefined, authed: boolean, hasAuthHeader: boolean): McpReply {
  let message: Record<string, unknown>;
  try {
    const decoded = JSON.parse(rawBody ?? '');
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('not an object');
    message = decoded as Record<string, unknown>;
  } catch {
    return send(400, failFrame(null, -32700, 'Parse error'));
  }
  const method = typeof message.method === 'string' ? message.method : '';
  const id = message.id;
  const params = message.params !== null && typeof message.params === 'object' && !Array.isArray(message.params)
    ? (message.params as Record<string, unknown>)
    : {};
  const args = params.arguments !== null && typeof params.arguments === 'object'
    ? (params.arguments as Record<string, unknown>)
    : undefined;

  const routes: Array<[matches: (name: string) => boolean, answer: () => McpReply]> = [
    [(name) => name === 'initialize', () => send(200, okFrame(id, {
      protocolVersion: REVISIONS[0],
      supportedVersions: REVISIONS,
      capabilities: { tools: { listChanged: false } },
      serverInfo: IDENTITY,
    }))],
    [(name) => name === 'server/discover', () => send(200, okFrame(id, {
      supportedVersions: REVISIONS,
      capabilities: { tools: { listChanged: false } },
      serverInfo: IDENTITY,
      _meta: { 'io.modelcontextprotocol/serverInfo': IDENTITY },
    }))],
    [(name) => name.startsWith('notifications/'), () => send(202, '')],
    [(name) => name === 'ping', () => send(200, okFrame(id, {}))],
    [(name) => name === 'tools/list', () => send(200, okFrame(id, listToolsPayload()))],
    [(name) => name === 'tools/call', () => answerCall(store, id, params, args, authed)],
  ];
  for (const [matches, answer] of routes) {
    if (matches(method)) return answer();
  }
  if (id === undefined || id === null) return send(202, '');
  return send(200, failFrame(id, -32601, `Method not found: ${method}`));
}

/** Answer one tools/call: auth first, then name matching, then the required arguments. */
function answerCall(store: Store, id: unknown, params: Record<string, unknown>, args: Record<string, unknown> | undefined, authed: boolean): McpReply {
  if (!authed) return send(401, JSON.stringify({ message: 'Requires authentication' }));
  const wanted = params.name;
  if (typeof wanted !== 'string' || wanted === '') {
    return send(200, failFrame(id, -32602, 'Invalid params: tool name is required'));
  }
  const lowered = wanted.toLowerCase();
  const marks = ['__', '_', '-', '/'];
  const spec = CATALOG.find((tool) => lowered === tool.name || marks.some((mark) => lowered.endsWith(`${mark}${tool.name}`)));
  if (spec === undefined) {
    return send(200, failFrame(id, -32602, `Unknown tool: ${wanted}`));
  }
  const given = args ?? {};
  const absent = spec.needs.filter(
    (key) => firstDefined(given, [key]) === undefined && (key !== 'owner' && key !== 'repo' || splitOwnerRepo(given.full_name)[key] === undefined),
  );
  if (absent.length > 0) {
    return send(200, okFrame(id, { content: [{ type: 'text', text: `Missing required argument(s): ${absent.join(', ')}` }], isError: true }));
  }
  const split = splitOwnerRepo(given.full_name);
  const owner = String(firstDefined(given, ['owner']) ?? split.owner ?? VIEWER_LOGIN);
  const repoName = String(firstDefined(given, ['repo', 'repository']) ?? split.repo ?? '');
  try {
    return send(200, okFrame(id, runTool(store, spec.name, owner, repoName, given)));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return send(200, okFrame(id, { content: [{ type: 'text', text: why }], isError: true }));
  }
}

/** Run one catalog tool against the store; a throw becomes an isError text result. */
function runTool(store: Store, tool: string, owner: string, repoName: string, given: Record<string, unknown>): Record<string, unknown> {
  if (tool === 'create_repo') {
    const wanted = String(given.name ?? repoName ?? '');
    if (wanted === '') throw new Error('Missing required argument(s): name');
    const made = store.createRepo(wanted, String(given.description ?? ''), given.private === true);
    return textPayload({ full_name: made.key, name: made.name, id: made.id, private: made.privateFlag, default_branch: made.default_branch });
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) throw new Error(`Repository ${owner}/${repoName} not found`);
  switch (tool) {
    case 'get_repo':
      return textPayload({ id: repo.id, node_id: globalId('Repository', repo.id), name: repo.name, full_name: repo.key, owner: { login: repo.owner }, default_branch: repo.default_branch, private: repo.privateFlag, description: repo.description });
    case 'create_issue': {
      const title = String(given.title ?? '');
      if (!title) throw new Error('Missing required argument(s): title');
      const now = dateFromSeq(store.nextId());
      const opened: Issue = {
        repoKey: repo.key, number: repo.nextIssue++, title, body: String(given.body ?? ''),
        state: 'open', labels: [], comments: [], seq: store.nextId(),
        created_at: now, updated_at: now, closed_at: null, user: VIEWER_LOGIN,
      };
      repo.issues.set(opened.number, opened);
      return textPayload({ number: opened.number, id: globalId('Issue', `${repo.id}_${opened.number}`), title: opened.title, state: 'open', url: `/api/v3/repos/${repo.key}/issues/${opened.number}` });
    }
    case 'list_issues': {
      const wanted = String(given.state ?? 'open');
      return textPayload(
        [...repo.issues.values()]
          .filter((entry) => wanted === 'all' || entry.state === wanted)
          .map((entry) => ({ number: entry.number, title: entry.title, state: entry.state, body: entry.body, labels: entry.labels })),
      );
    }
    case 'create_pull_request': {
      const head = String(given.head ?? given.headRefName ?? '');
      const base = String(given.base ?? given.baseRefName ?? '');
      const title = String(given.title ?? '');
      const headSha = refCommit(repo, `refs/heads/${head}`);
      const baseSha = refCommit(repo, `refs/heads/${base}`);
      if (!headSha || !baseSha) throw new Error('Head or base branch does not exist');
      const now = dateFromSeq(store.nextId());
      const opened: Pull = {
        repoKey: repo.key, number: repo.nextPull++, title, body: String(given.body ?? ''),
        head, base, headSha, baseSha, state: 'open', merged: false, merge_commit_sha: null,
        merged_at: null, created_at: now, user: VIEWER_LOGIN,
      };
      repo.pulls.set(opened.number, opened);
      return textPayload({ number: opened.number, id: globalId('PullRequest', `${repo.id}_${opened.number}`), state: 'open', head: opened.head, base: opened.base, url: `/api/v3/repos/${repo.key}/pulls/${opened.number}` });
    }
    case 'merge_pull_request': {
      const wanted = Number(firstDefined(given, ['pull_number', 'pullNumber', 'number']));
      const target = repo.pulls.get(wanted);
      if (!target) throw new Error(`Pull request #${wanted} not found`);
      if (target.merged) throw new Error('Pull request is already merged');
      const baseSha = refCommit(repo, `refs/heads/${target.base}`);
      if (!baseSha) throw new Error('Base branch is gone');
      const sha = squashMerge(repo, target);
      target.state = 'closed';
      target.merged = true;
      target.merge_commit_sha = sha;
      target.merged_at = dateFromSeq(store.nextId());
      return textPayload({ merged: true, sha, number: target.number, message: 'Pull Request successfully merged' });
    }
  }
  throw new Error('Unknown tool');
}
