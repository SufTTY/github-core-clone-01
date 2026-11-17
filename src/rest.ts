// GitHub REST v3 mounted at /api/v3: a route table over the shared in-memory store.
import { Store, VIEWER_LOGIN, commitChanges, refCommit, resolveRef, treeLookup, commitHistory, parseCommit, squashMerge, pullFiles, dateFromSeq, type Repo, type Issue, type Pull } from './store.ts';
import { hashObject, parseTree } from './gitobj.ts';

export const REPO_NOT_FOUND = { message: 'Not Found' };
export const AUTH_REQUIRED = { message: 'Requires authentication' };

export interface Reply { status: number; body: unknown | null; headers?: Record<string, string>; empty?: boolean }

let requestsServed = 0;

function send(status: number, payload: unknown, extra: Record<string, string> = {}): Reply {
  requestsServed += 1;
  return { status, body: payload, headers: { 'x-github-request-id': `${String(100000000 + requestsServed)}`, ...extra } };
}

function fail(status: number, text: string, extra: Record<string, string> = {}): Reply {
  return send(status, { message: text }, extra);
}

function empty(): Reply {
  requestsServed += 1;
  return { status: 204, body: null, empty: true, headers: { 'x-github-request-id': String(100000000 + requestsServed) } };
}

// ---------------------------------------------------------------- rendered JSON

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.privateFlag,
    owner: { login: repo.owner, id: 1, type: 'User' },
    html_url: `https://forge.local/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    default_branch: repo.default_branch,
    created_at: repo.created_at,
    updated_at: repo.created_at,
    pushed_at: repo.created_at,
    has_issues: true,
    has_pull_requests: true,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

export function globalId(kind: string, id: number | string): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: 1000 + issue.number,
    node_id: globalId('Issue', `${repo.id}_${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name) ?? 'ededed' })),
    user: { login: issue.user },
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: 2000 + pull.number,
    node_id: globalId('PullRequest', `${repo.id}_${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.merge_commit_sha,
    merged_at: pull.merged_at,
    closed_at: pull.state === 'closed' ? pull.merged_at ?? pull.created_at : null,
    created_at: pull.created_at,
    updated_at: pull.created_at,
    user: { login: pull.user },
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}`, repo: repoJson(repo) },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}`, repo: repoJson(repo) },
    labels: [],
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
    commits: [] as unknown[],
    files_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/files`,
  };
}

function commentView(repo: Repo, issue: Issue, comment: { id: number; body: string; user: string; created_at: string; updated_at: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    user: { login: comment.user },
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

// ---------------------------------------------------------------- request decoding

function readJson(raw: string | undefined): { body: Record<string, unknown> } | { error: Reply } {
  if (raw === undefined || raw === '') return { body: {} };
  try {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { error: fail(400, 'Problems parsing JSON') };
    return { body: value as Record<string, unknown> };
  } catch {
    return { error: fail(400, 'Problems parsing JSON') };
  }
}

function pageWindow(url: URL, fallback = 30): { page: number; size: number } {
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const size = Math.max(1, Math.min(100, parseInt(url.searchParams.get('per_page') ?? String(fallback), 10) || fallback));
  return { page, size };
}

function paged(url: URL, items: unknown[], fallback = 30, origin = ''): Reply {
  const { page, size } = pageWindow(url, fallback);
  const start = (page - 1) * size;
  const slice = items.slice(start, start + size);
  const headers: Record<string, string> = {};
  if (start + size < items.length) {
    const next = new URL(url.toString());
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(size));
    const last = Math.max(1, Math.ceil(items.length / size));
    headers.link = `<${origin}${next.pathname}${next.search}>; rel="next", <${origin}${next.pathname}${next.search}&page=${last}>; rel="last"`;
  }
  return send(200, slice, headers);
}

// ---------------------------------------------------------------- dispatch

interface RestCall {
  store: Store;
  url: URL;
  method: string;
  body: string | undefined;
  authed: boolean;
  origin: string;
  segments: string[];
}

interface Route {
  hit: (call: RestCall) => boolean;
  run: (call: RestCall) => Reply;
}

const topRoutes: Route[] = [
  { hit: (c) => c.segments.length === 0 && c.method === 'GET', run: rootIndex },
  { hit: (c) => c.segments[0] === 'meta' && c.method === 'GET', run: metaVersion },
  { hit: (c) => c.segments[0] === 'user' && c.segments[1] === 'repos', run: viewerRepos },
  { hit: (c) => c.segments[0] === 'user' && c.segments[1] === undefined && c.method === 'GET', run: viewerProfile },
  { hit: (c) => c.segments[0] === 'repos' && c.segments.length >= 3, run: enterRepo },
];

export function handleRest(store: Store, url: URL, method: string, rawBody: string | undefined, authed: boolean, origin = ''): Reply {
  const path = url.pathname.replace(/^\/api\/v3\/?/, '');
  const segments = path.split('/').filter((segment) => segment.length > 0).map((segment) => decodeURIComponent(segment));
  const call: RestCall = { store, url, method, body: rawBody, authed, origin, segments };
  for (const route of topRoutes) {
    if (route.hit(call)) return route.run(call);
  }
  return fail(404, 'Not Found');
}

function rootIndex(): Reply {
  return send(200, {
    current_user_url: '/api/v3/user',
    user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
    repository_url: '/api/v3/repos/{owner}/{repo}',
    issue_url: '/api/v3/repos/{owner}/{repo}/issues{?number}',
  }, { 'x-oauth-scopes': 'repo, read:org' });
}

function metaVersion(): Reply {
  return send(200, { installed_version: '2.0.1' });
}

function viewerProfile(): Reply {
  return send(200, { login: VIEWER_LOGIN, id: 1, type: 'User' });
}

function viewerRepos(call: RestCall): Reply {
  if (!call.authed) return fail(401, 'Requires authentication');
  if (call.method === 'GET') {
    const list = [...call.store.repos.values()].sort((a, b) => a.seq - b.seq).map(repoJson);
    return paged(call.url, list, 30, call.origin);
  }
  if (call.method === 'POST') {
    const parsed = readJson(call.body);
    if (parsed.error) return parsed.error;
    const name = parsed.body.name;
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.endsWith('.git')) {
      return fail(422, 'Validation Failed: name is invalid');
    }
    if (call.store.getRepo(VIEWER_LOGIN, name)) return fail(422, 'name already exists on this account');
    const privateFlag = parsed.body.private === undefined ? false : parsed.body.private === true;
    const description = typeof parsed.body.description === 'string' ? parsed.body.description : '';
    const repo = call.store.createRepo(name, description, privateFlag);
    return send(201, repoJson(repo));
  }
  return fail(404, 'Not Found');
}

// ---------------------------------------------------------------- repository routes

interface RepoCall {
  store: Store;
  repo: Repo;
  method: string;
  url: URL;
  body: string | undefined;
  origin: string;
  tail: string[];
}

interface RepoRoute {
  hit: (call: RepoCall) => boolean;
  run: (call: RepoCall) => Reply;
}

const exactly = (tail: readonly string[], ...parts: string[]): boolean =>
  tail.length === parts.length && parts.every((part, index) => tail[index] === part);

const repoRoutes: RepoRoute[] = [
  { hit: (c) => exactly(c.tail) && c.method === 'GET', run: repoRead },
  { hit: (c) => exactly(c.tail) && c.method === 'PATCH', run: repoEdit },
  { hit: (c) => exactly(c.tail) && c.method === 'DELETE', run: repoDrop },
  { hit: (c) => exactly(c.tail, 'branches') && c.method === 'GET', run: listBranches },
  { hit: (c) => exactly(c.tail, 'commits') && c.method === 'GET', run: listCommits },
  { hit: (c) => exactly(c.tail, 'git', 'refs') && c.method === 'POST', run: makeRef },
  { hit: (c) => exactly(c.tail, 'labels') && c.method === 'POST', run: makeLabel },
  { hit: (c) => c.tail[0] === 'issues', run: issueRoutes },
  { hit: (c) => c.tail[0] === 'pulls', run: pullRoutes },
  { hit: (c) => c.tail[0] === 'contents', run: contentRoutes },
];

function enterRepo(call: RestCall): Reply {
  const owner = call.segments[1];
  const name = call.segments[2].replace(/\.git$/, '');
  const repo = call.store.getRepo(owner, name);
  if (!repo) return fail(404, 'Not Found');
  if (!call.authed) return fail(401, 'Requires authentication');
  const inner: RepoCall = { store: call.store, repo, method: call.method, url: call.url, body: call.body, origin: call.origin, tail: call.segments.slice(3) };
  for (const route of repoRoutes) {
    if (route.hit(inner)) return route.run(inner);
  }
  return fail(404, 'Not Found');
}

function repoRead(call: RepoCall): Reply {
  return send(200, repoJson(call.repo));
}

function repoEdit(call: RepoCall): Reply {
  const parsed = readJson(call.body);
  if (parsed.error) return parsed.error;
  const repo = call.repo;
  if (typeof parsed.body.description === 'string') repo.description = parsed.body.description;
  if (typeof parsed.body.default_branch === 'string' && repo.refs.has(`refs/heads/${parsed.body.default_branch}`)) {
    repo.default_branch = parsed.body.default_branch;
  }
  return send(200, repoJson(repo));
}

function repoDrop(call: RepoCall): Reply {
  call.store.repos.delete(call.repo.key);
  return empty();
}

function listBranches(call: RepoCall): Reply {
  const repo = call.repo;
  const branches: unknown[] = [];
  for (const refName of [...repo.refs.keys()].filter((name) => name.startsWith('refs/heads/')).sort()) {
    const branch = refName.slice('refs/heads/'.length);
    branches.push({ name: branch, commit: { sha: repo.refs.get(refName) }, protected: false });
  }
  if (!repo.refs.has(`refs/heads/${repo.default_branch}`)) branches.unshift({ name: repo.default_branch, commit: { sha: null }, protected: false });
  return send(200, branches);
}

function listCommits(call: RepoCall): Reply {
  const repo = call.repo;
  const ref = call.url.searchParams.get('sha') ?? repo.default_branch;
  const tip = refCommit(repo, ref) ?? resolveRef(repo, `refs/heads/${ref}`);
  if (!tip) return fail(404, 'Not Found');
  const commits = commitHistory(repo, tip, 250).map((oid) => {
    const view = parseCommit(repo.objects.get(oid)!.data);
    return {
      sha: oid,
      node_id: globalId('Commit', oid),
      commit: {
        message: view.message,
        author: { name: personName(view.author), email: personMail(view.author), date: personTime(view.author) },
        committer: { name: personName(view.committer), email: personMail(view.committer), date: personTime(view.committer) },
      },
      parents: view.parents.map((parent) => ({ sha: parent })),
      html_url: `https://forge.local/${repo.owner}/${repo.name}/commit/${oid}`,
    };
  });
  return send(200, commits);
}

function makeRef(call: RepoCall): Reply {
  const repo = call.repo;
  const parsed = readJson(call.body);
  if (parsed.error) return parsed.error;
  const refName = typeof parsed.body.ref === 'string' ? parsed.body.ref : '';
  const sha = typeof parsed.body.sha === 'string' ? parsed.body.sha : '';
  if (!refName.startsWith('refs/heads/') && !refName.startsWith('refs/tags/')) return fail(422, 'Validation Failed: ref must start with refs/heads/ or refs/tags/');
  if (!repo.objects.has(sha)) return fail(422, 'Validation Failed: object does not exist');
  if (repo.refs.has(refName)) return fail(422, 'Reference already exists');
  repo.refs.set(refName, sha);
  return send(201, { ref: refName, node_id: globalId('GitRef', `${repo.id}_${refName}`), object: { sha, type: 'commit' }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${refName}` });
}

function makeLabel(call: RepoCall): Reply {
  const repo = call.repo;
  const parsed = readJson(call.body);
  if (parsed.error) return parsed.error;
  const labelName = typeof parsed.body.name === 'string' ? parsed.body.name : '';
  if (!labelName) return fail(422, 'Validation Failed: name is required');
  const color = typeof parsed.body.color === 'string' ? parsed.body.color : 'ededed';
  repo.labels.set(labelName, color);
  return send(201, { name: labelName, color, id: 5000 + repo.labels.size, node_id: globalId('Label', `${repo.id}_${labelName}`) });
}

function personName(ident: string): string {
  const match = ident.match(/^(.*?)\s+</);
  return match ? match[1] : ident;
}

function personMail(ident: string): string {
  const match = ident.match(/<([^>]*)>/);
  return match ? match[1] : '';
}

function personTime(ident: string): string {
  const match = ident.match(/>\s+(\d+)\s+([+-]\d{4})/);
  if (!match) return '1970-01-01T00:00:00Z';
  return new Date(parseInt(match[1], 10) * 1000).toISOString().replace('.000Z', 'Z');
}

// ---------------------------------------------------------------- issues

function issueRoutes(call: RepoCall): Reply {
  const repo = call.repo;
  const segments = call.tail.slice(1);
  if (segments.length === 0 && call.method === 'GET') {
    const state = call.url.searchParams.get('state') ?? 'open';
    const direction = call.url.searchParams.get('direction') ?? 'desc';
    const list = [...repo.issues.values()]
      .filter((issue) => state === 'all' || issue.state === state)
      .sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq))
      .map((issue) => issueView(repo, issue));
    return paged(call.url, list, 30, call.origin);
  }
  if (segments.length === 0 && call.method === 'POST') {
    const parsed = readJson(call.body);
    if (parsed.error) return parsed.error;
    const title = parsed.body.title;
    if (typeof title !== 'string' || title === '') return fail(422, 'Validation Failed: title is required');
    const names = Array.isArray(parsed.body.labels) ? parsed.body.labels.filter((label): label is string => typeof label === 'string') : [];
    for (const name of names) {
      if (!repo.labels.has(name)) return fail(422, `Validation Failed: label "${name}" does not exist`);
    }
    const now = dateFromSeq(call.store.nextId());
    const issue: Issue = {
      repoKey: repo.key, number: repo.nextIssue++, title,
      body: typeof parsed.body.body === 'string' ? parsed.body.body : '',
      state: 'open', labels: [...names], comments: [], seq: call.store.nextId(),
      created_at: now, updated_at: now, closed_at: null, user: VIEWER_LOGIN,
    };
    repo.issues.set(issue.number, issue);
    return send(201, issueView(repo, issue));
  }
  const number = parseInt(segments[0], 10);
  if (!Number.isInteger(number) || number <= 0) return fail(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (!issue) return fail(404, 'Not Found');
  if (segments.length === 1) {
    if (call.method === 'GET') return send(200, issueView(repo, issue));
    if (call.method === 'PATCH') {
      const parsed = readJson(call.body);
      if (parsed.error) return parsed.error;
      if (typeof parsed.body.title === 'string') issue.title = parsed.body.title;
      if (typeof parsed.body.body === 'string') issue.body = parsed.body.body;
      if (parsed.body.state === 'open' || parsed.body.state === 'closed') {
        issue.state = parsed.body.state;
        issue.closed_at = issue.state === 'closed' ? dateFromSeq(call.store.nextId()) : null;
      }
      if (Array.isArray(parsed.body.labels)) {
        const names = parsed.body.labels.filter((label): label is string => typeof label === 'string');
        for (const name of names) if (!repo.labels.has(name)) return fail(422, `Validation Failed: label "${name}" does not exist`);
        issue.labels = [...names];
      }
      issue.updated_at = dateFromSeq(call.store.nextId());
      return send(200, issueView(repo, issue));
    }
    return fail(404, 'Not Found');
  }
  if (segments[1] === 'comments') {
    if (segments.length === 2 && call.method === 'GET') {
      return send(200, issue.comments.map((comment) => commentView(repo, issue, comment)));
    }
    if (segments.length === 2 && call.method === 'POST') {
      const parsed = readJson(call.body);
      if (parsed.error) return parsed.error;
      const text = typeof parsed.body.body === 'string' ? parsed.body.body : '';
      if (text === '') return fail(422, 'Validation Failed: body is required');
      const comment = { id: repo.nextCommentId++, body: text, user: VIEWER_LOGIN, created_at: dateFromSeq(call.store.nextId()), updated_at: dateFromSeq(call.store.nextId()) };
      issue.comments.push(comment);
      return send(201, commentView(repo, issue, comment));
    }
  }
  return fail(404, 'Not Found');
}

// ---------------------------------------------------------------- pulls

function pullRoutes(call: RepoCall): Reply {
  const repo = call.repo;
  const segments = call.tail.slice(1);
  if (segments.length === 0 && call.method === 'GET') {
    const state = call.url.searchParams.get('state') ?? 'open';
    const list = [...repo.pulls.values()]
      .filter((pull) => state === 'all' || (state === 'open' ? pull.state === 'open' : pull.state === 'closed'))
      .sort((a, b) => a.number - b.number)
      .map((pull) => pullView(repo, pull));
    return paged(call.url, list, 30, call.origin);
  }
  if (segments.length === 0 && call.method === 'POST') {
    const parsed = readJson(call.body);
    if (parsed.error) return parsed.error;
    const headRef = typeof parsed.body.head === 'string' ? parsed.body.head : '';
    const baseRef = typeof parsed.body.base === 'string' ? parsed.body.base : '';
    const title = typeof parsed.body.title === 'string' ? parsed.body.title : '';
    const text = typeof parsed.body.body === 'string' ? parsed.body.body : '';
    const headSha = refCommit(repo, `refs/heads/${headRef}`);
    const baseSha = refCommit(repo, `refs/heads/${baseRef}`);
    if (!headSha || !baseSha) return fail(422, 'Validation Failed: head or base branch does not exist');
    if (headRef === baseRef) return fail(422, 'Validation Failed: head and base are the same branch');
    const open = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.head === headRef && pull.base === baseRef);
    if (open) return fail(422, 'Validation Failed: a pull request already exists for this head and base');
    const pull: Pull = {
      repoKey: repo.key, number: repo.nextPull++, title, body: text, head: headRef, base: baseRef,
      headSha, baseSha, state: 'open', merged: false, merge_commit_sha: null, merged_at: null,
      created_at: dateFromSeq(call.store.nextId()), user: VIEWER_LOGIN,
    };
    repo.pulls.set(pull.number, pull);
    return send(201, pullView(repo, pull));
  }
  const number = parseInt(segments[0], 10);
  if (!Number.isInteger(number)) return fail(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (!pull) return fail(404, 'Not Found');
  if (segments.length === 1 && call.method === 'GET') return send(200, pullView(repo, pull));
  if (segments[1] === 'files' && segments.length === 2 && call.method === 'GET') {
    return send(200, pullFiles(repo, pull.baseSha, pull.headSha));
  }
  if (segments[1] === 'merge' && segments.length === 2 && call.method === 'PUT') {
    return mergePull(call, repo, pull);
  }
  return fail(404, 'Not Found');
}

function mergePull(call: RepoCall, repo: Repo, pull: Pull): Reply {
  const parsed = readJson(call.body);
  if (parsed.error) return parsed.error;
  if (pull.merged) return fail(405, 'Pull Request is not mergeable: already merged');
  const baseSha = refCommit(repo, `refs/heads/${pull.base}`);
  if (!baseSha) return fail(405, 'Pull Request is not mergeable: base branch is gone');
  const changed = pullFiles(repo, pull.baseSha, pull.headSha).map((file) => file.filename);
  for (const path of changed) {
    const headNow = refCommit(repo, `refs/heads/${pull.head}`);
    if (!headNow) return fail(405, 'Pull Request is not mergeable: head branch is gone');
    const headTree = parseCommit(repo.objects.get(headNow)!.data).tree;
    const currentTree = parseCommit(repo.objects.get(baseSha)!.data).tree;
    const originalTree = parseCommit(repo.objects.get(pull.baseSha)!.data).tree;
    const headBlob = blobInTree(repo, headTree, path);
    const baseBlob = blobInTree(repo, currentTree, path);
    const originalBlob = blobInTree(repo, originalTree, path);
    if (baseBlob !== originalBlob && headBlob !== baseBlob && headBlob !== originalBlob) {
      return fail(405, 'Pull Request is not mergeable: merge conflict');
    }
  }
  const mergeSha = squashMerge(repo, pull);
  pull.state = 'closed';
  pull.merged = true;
  pull.merge_commit_sha = mergeSha;
  pull.merged_at = dateFromSeq(call.store.nextId());
  return send(200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
}

function blobInTree(repo: Repo, treeOid: string, path: string): string | null {
  const found = treeLookup(repo, treeOid, path);
  if (!found || !('blob' in found)) return null;
  return found.blob;
}

// ---------------------------------------------------------------- contents

function contentRoutes(call: RepoCall): Reply {
  const repo = call.repo;
  const path = call.tail.slice(1).join('/');
  const ref = call.url.searchParams.get('ref') ?? repo.default_branch;

  if (call.method === 'GET') {
    const tip = refCommit(repo, `refs/heads/${ref}`);
    if (!tip) return fail(404, 'Not Found');
    const tree = parseCommit(repo.objects.get(tip)!.data).tree;
    const found = treeLookup(repo, tree, path);
    if (!found) return fail(404, 'Not Found');
    const baseName = path.split('/').filter((part) => part.length > 0).pop() ?? path;
    if ('blob' in found) {
      const blob = repo.objects.get(found.blob)!;
      return send(200, {
        type: 'file',
        name: baseName,
        path,
        sha: found.blob,
        size: blob.data.length,
        encoding: 'base64',
        content: blob.data.toString('base64'),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      });
    }
    return send(200, found.entries.map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: `${path}/${entry.name}`,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : repo.objects.get(entry.oid)?.data.length ?? 0,
      encoding: entry.mode === '40000' ? undefined : 'base64',
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}/${entry.name}`,
    })));
  }

  if (call.method === 'PUT') {
    const parsed = readJson(call.body);
    if (parsed.error) return parsed.error;
    const message = typeof parsed.body.message === 'string' ? parsed.body.message : 'update';
    const branch = typeof parsed.body.branch === 'string' ? parsed.body.branch : repo.default_branch;
    const content = typeof parsed.body.content === 'string' ? parsed.body.content.replace(/\n/g, '') : '';
    let data: Buffer;
    try {
      data = Buffer.from(content, 'base64');
    } catch {
      return fail(422, 'Validation Failed: content is not valid base64');
    }
    const tip = refCommit(repo, `refs/heads/${branch}`);
    const existingTip = tip;
    const currentTree = existingTip ? parseCommit(repo.objects.get(existingTip)!.data).tree : null;
    const existing = currentTree ? treeLookup(repo, currentTree, path) : undefined;
    const existingBlob = existing && 'blob' in existing ? existing.blob : null;
    if (existingBlob !== null) {
      const sha = typeof parsed.body.sha === 'string' ? parsed.body.sha : '';
      if (!sha) return fail(422, 'Validation Failed: sha is required when updating an existing file');
      if (sha !== existingBlob) return fail(409, `${path} does not match ${sha}`);
    }
    const commitSha = commitChanges(repo, existingTip, { [path]: data }, message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return send(existingBlob !== null ? 200 : 201, {
      content: { sha: hashObject('blob', data), encoding: 'base64', name: path.split('/').pop(), path, size: data.length, type: 'file' },
      commit: { sha: commitSha, message, author: { name: VIEWER_LOGIN, email: 'forge@localhost', date: dateFromSeq(repo.id) }, html_url: `https://forge.local/${repo.owner}/${repo.name}/commit/${commitSha}` },
    });
  }

  if (call.method === 'DELETE') {
    const parsed = readJson(call.body);
    if (parsed.error) return parsed.error;
    const message = typeof parsed.body.message === 'string' ? parsed.body.message : 'delete';
    const branch = typeof parsed.body.branch === 'string' ? parsed.body.branch : repo.default_branch;
    const tip = refCommit(repo, `refs/heads/${branch}`);
    if (!tip) return fail(404, 'Not Found');
    const tree = parseCommit(repo.objects.get(tip)!.data).tree;
    const existing = treeLookup(repo, tree, path);
    if (!existing || !('blob' in existing)) return fail(404, 'Not Found');
    const sha = typeof parsed.body.sha === 'string' ? parsed.body.sha : '';
    if (sha && sha !== existing.blob) return fail(409, `${path} does not match ${sha}`);
    const commitSha = commitChanges(repo, tip, { [path]: null }, message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return send(200, { commit: { sha: commitSha, message } });
  }

  return fail(404, 'Not Found');
}

