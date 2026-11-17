// GitHub REST v3 surface under /api/v3.
import { Store, VIEWER_LOGIN, commitChanges, putObject, refCommit, resolveRef, treeLookup, flattenTree, commitHistory, parseCommit, squashMerge, pullFiles, dateFromSeq, type Repo, type Issue, type Pull } from './store.ts';
import { hashObject, parseTree } from './gitobj.ts';

export const REPO_NOT_FOUND = { message: 'Not Found' };
export const AUTH_REQUIRED = { message: 'Requires authentication' };

export interface Reply { status: number; body: unknown | null; headers?: Record<string, string>; empty?: boolean }
let requestCounter = 0;

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  requestCounter += 1;
  return { status, body, headers: { 'x-github-request-id': `${String(100000000 + requestCounter)}`, ...headers } };
}

function err(status: number, message: string, headers: Record<string, string> = {}): Reply {
  return reply(status, { message, ...(['401', '404', '422'].includes(String(status)) ? {} : {}) }, headers);
}

function noContent(): Reply {
  requestCounter += 1;
  return { status: 204, body: null, empty: true, headers: { 'x-github-request-id': String(100000000 + requestCounter) } };
}

// ---------------------------------------------------------------- JSON shapes

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

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
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

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
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

function commentJson(repo: Repo, issue: Issue, comment: { id: number; body: string; user: string; created_at: string; updated_at: string }): Record<string, unknown> {
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

// ---------------------------------------------------------------- helpers

function parseBody(raw: string | undefined): { body: Record<string, unknown> } | { error: Reply } {
  if (raw === undefined || raw === '') return { body: {} };
  try {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { error: err(400, 'Problems parsing JSON') };
    return { body: value as Record<string, unknown> };
  } catch {
    return { error: err(400, 'Problems parsing JSON') };
  }
}

function perPage(url: URL, fallback = 30): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const perPage = Math.max(1, Math.min(100, parseInt(url.searchParams.get('per_page') ?? String(fallback), 10) || fallback));
  return { page, perPage };
}

function paginate(store: Store, url: URL, basePath: string, items: unknown[], fallbackPerPage = 30, origin = ''): Reply {
  const { page, perPage: perPageCount } = perPage(url, fallbackPerPage);
  const start = (page - 1) * perPageCount;
  const slice = items.slice(start, start + perPageCount);
  const headers: Record<string, string> = {};
  if (start + perPageCount < items.length) {
    const nextUrl = new URL(url.toString());
    nextUrl.searchParams.set('page', String(page + 1));
    nextUrl.searchParams.set('per_page', String(perPageCount));
    headers.link = `<${origin}${nextUrl.pathname}${nextUrl.search}>; rel="next", <${origin}${nextUrl.pathname}${nextUrl.search}&page=${Math.max(1, Math.ceil(items.length / perPageCount))}>; rel="last"`;
  }
  return reply(200, slice, headers);
}

// ---------------------------------------------------------------- the router

export function handleRest(store: Store, url: URL, method: string, rawBody: string | undefined, authed: boolean, origin = ''): Reply {
  const path = url.pathname.replace(/^\/api\/v3\/?/, '');
  const segments = path.split('/').filter((segment) => segment.length > 0).map((segment) => decodeURIComponent(segment));

  if (segments.length === 0) {
    if (method === 'GET') {
      return reply(200, {
        current_user_url: '/api/v3/user',
        user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_url: '/api/v3/repos/{owner}/{repo}/issues{?number}',
      }, { 'x-oauth-scopes': 'repo, read:org' });
    }
    return err(404, 'Not Found');
  }

  if (segments[0] === 'meta' && method === 'GET') return reply(200, { installed_version: '2.0.1' });
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (!authed) return err(401, 'Requires authentication');
    if (method === 'GET') {
      const repos = [...store.repos.values()].sort((a, b) => a.seq - b.seq).map(repoJson);
      return paginate(store, url, '/api/v3/user/repos', repos, 30, origin);
    }
    if (method === 'POST') {
      const parsed = parseBody(rawBody);
      if ('error' in parsed) return parsed.error;
      const name = parsed.body.name;
      if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.endsWith('.git')) {
        return err(422, 'Validation Failed: name is invalid');
      }
      const existing = store.getRepo(VIEWER_LOGIN, name);
      if (existing) return err(422, `name already exists on this account`);
      const privateFlag = parsed.body.private === undefined ? false : parsed.body.private === true;
      const description = typeof parsed.body.description === 'string' ? parsed.body.description : '';
      const repo = store.createRepo(name, description, privateFlag);
      return reply(201, repoJson(repo));
    }
    return err(404, 'Not Found');
  }
  if (segments[0] === 'user' && segments[1] === undefined && method === 'GET') {
    return reply(200, { login: VIEWER_LOGIN, id: 1, type: 'User' });
  }

  // /repos/{owner}/{repo}/...
  if (segments[0] !== 'repos' || segments.length < 3) return err(404, 'Not Found');
  const owner = segments[1];
  const name = segments[2].replace(/\.git$/, '');
  const repo = store.getRepo(owner, name);
  if (!repo) {
    // Distinguish "unknown repo name under the viewer" (still 404, but for rename-after-delete
    // semantics every miss is 404) from unknown owner: both 404.
    return err(404, 'Not Found');
  }
  const rest = segments.slice(3);
  return handleRepoRoute(store, repo, rest, method, url, rawBody, authed, origin);
}

function handleRepoRoute(store: Store, repo: Repo, segments: readonly string[], method: string, url: URL, rawBody: string | undefined, authed: boolean, origin = ''): Reply {
  if (!authed) return err(401, 'Requires authentication');

  // repository root
  if (segments.length === 0) {
    if (method === 'GET') return reply(200, repoJson(repo));
    if (method === 'PATCH') {
      const parsed = parseBody(rawBody);
      if ('error' in parsed) return parsed.error;
      if (typeof parsed.body.description === 'string') repo.description = parsed.body.description;
      if (typeof parsed.body.default_branch === 'string' && repo.refs.has(`refs/heads/${parsed.body.default_branch}`)) {
        repo.default_branch = parsed.body.default_branch;
      }
      return reply(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.repos.delete(repo.key);
      return noContent();
    }
    return err(404, 'Not Found');
  }

  const [head, ...rest] = segments;

  if (head === 'branches' && method === 'GET' && rest.length === 0) {
    const branches: unknown[] = [];
    for (const refName of [...repo.refs.keys()].filter((name) => name.startsWith('refs/heads/')).sort()) {
      const branch = refName.slice('refs/heads/'.length);
      branches.push({ name: branch, commit: { sha: repo.refs.get(refName) }, protected: false });
    }
    if (!repo.refs.has(`refs/heads/${repo.default_branch}`)) branches.unshift({ name: repo.default_branch, commit: { sha: null }, protected: false });
    return reply(200, branches);
  }

  if (head === 'commits' && method === 'GET' && rest.length === 0) {
    const ref = url.searchParams.get('sha') ?? repo.default_branch;
    const tip = refCommit(repo, ref) ?? resolveRef(repo, `refs/heads/${ref}`);
    if (!tip) return err(404, 'Not Found');
    const commits = commitHistory(repo, tip, 250).map((oid) => {
      const view = parseCommit(repo.objects.get(oid)!.data);
      return {
        sha: oid,
        node_id: globalId('Commit', oid),
        commit: {
          message: view.message,
          author: { name: nameOf(view.author), email: emailOf(view.author), date: isoOf(view.author) },
          committer: { name: nameOf(view.committer), email: emailOf(view.committer), date: isoOf(view.committer) },
        },
        parents: view.parents.map((parent) => ({ sha: parent })),
        html_url: `https://forge.local/${repo.owner}/${repo.name}/commit/${oid}`,
      };
    });
    return reply(200, commits);
  }

  if (head === 'git' && rest[0] === 'refs' && method === 'POST' && rest.length === 1) {
    const parsed = parseBody(rawBody);
    if ('error' in parsed) return parsed.error;
    const refName = typeof parsed.body.ref === 'string' ? parsed.body.ref : '';
    const sha = typeof parsed.body.sha === 'string' ? parsed.body.sha : '';
    if (!refName.startsWith('refs/heads/') && !refName.startsWith('refs/tags/')) return err(422, 'Validation Failed: ref must start with refs/heads/ or refs/tags/');
    if (!repo.objects.has(sha)) return err(422, 'Validation Failed: object does not exist');
    if (repo.refs.has(refName)) return err(422, 'Reference already exists');
    repo.refs.set(refName, sha);
    repo.refsVersion += 1;
    return reply(201, { ref: refName, node_id: globalId('GitRef', `${repo.id}_${refName}`), object: { sha, type: 'commit' }, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${refName}` });
  }

  if (head === 'labels' && method === 'POST' && rest.length === 0) {
    const parsed = parseBody(rawBody);
    if ('error' in parsed) return parsed.error;
    const labelName = typeof parsed.body.name === 'string' ? parsed.body.name : '';
    if (!labelName) return err(422, 'Validation Failed: name is required');
    const color = typeof parsed.body.color === 'string' ? parsed.body.color : 'ededed';
    repo.labels.set(labelName, color);
    return reply(201, { name: labelName, color, id: 5000 + repo.labels.size, node_id: globalId('Label', `${repo.id}_${labelName}`) });
  }

  if (head === 'issues') {
    return handleIssues(store, repo, rest, method, url, rawBody, origin);
  }

  if (head === 'pulls') {
    return handlePulls(store, repo, rest, method, url, rawBody, origin);
  }

  if (head === 'contents') {
    return handleContents(repo, rest, method, url, rawBody);
  }

  return err(404, 'Not Found');
}

function nameOf(ident: string): string {
  const match = ident.match(/^(.*?)\s+</);
  return match ? match[1] : ident;
}
function emailOf(ident: string): string {
  const match = ident.match(/<([^>]*)>/);
  return match ? match[1] : '';
}
function isoOf(ident: string): string {
  const match = ident.match(/>\s+(\d+)\s+([+-]\d{4})/);
  if (!match) return '1970-01-01T00:00:00Z';
  return new Date(parseInt(match[1], 10) * 1000).toISOString().replace('.000Z', 'Z');
}

// ---------------------------------------------------------------- issues

function handleIssues(store: Store, repo: Repo, segments: readonly string[], method: string, url: URL, rawBody: string | undefined, origin = ''): Reply {
  if (segments.length === 0 && method === 'GET') {
    const state = url.searchParams.get('state') ?? 'open';
    const direction = url.searchParams.get('direction') ?? 'desc';
    const issues = [...repo.issues.values()]
      .filter((issue) => state === 'all' || issue.state === state)
      .sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq))
      .map((issue) => issueJson(repo, issue));
    return paginate(store, url, '', issues, 30, origin);
  }
  if (segments.length === 0 && method === 'POST') {
    const parsed = parseBody(rawBody);
    if ('error' in parsed) return parsed.error;
    const title = parsed.body.title;
    if (typeof title !== 'string' || title === '') return err(422, 'Validation Failed: title is required');
    const labelNames = Array.isArray(parsed.body.labels) ? parsed.body.labels.filter((label): label is string => typeof label === 'string') : [];
    for (const label of labelNames) {
      if (!repo.labels.has(label)) return err(422, `Validation Failed: label "${label}" does not exist`);
    }
    const now = dateFromSeq(store.nextId());
    const issue: Issue = {
      repoKey: repo.key, number: repo.nextIssue++, title,
      body: typeof parsed.body.body === 'string' ? parsed.body.body : '',
      state: 'open', labels: [...labelNames], comments: [], seq: store.nextId(),
      created_at: now, updated_at: now, closed_at: null, user: VIEWER_LOGIN,
    };
    repo.issues.set(issue.number, issue);
    return reply(201, issueJson(repo, issue));
  }
  const number = parseInt(segments[0], 10);
  if (!Number.isInteger(number) || number <= 0) return err(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (!issue) return err(404, 'Not Found');

  if (segments.length === 1) {
    if (method === 'GET') return reply(200, issueJson(repo, issue));
    if (method === 'PATCH') {
      const parsed = parseBody(rawBody);
      if ('error' in parsed) return parsed.error;
      if (typeof parsed.body.title === 'string') issue.title = parsed.body.title;
      if (typeof parsed.body.body === 'string') issue.body = parsed.body.body;
      if (parsed.body.state === 'open' || parsed.body.state === 'closed') {
        issue.state = parsed.body.state;
        issue.closed_at = issue.state === 'closed' ? dateFromSeq(store.nextId()) : null;
      }
      if (Array.isArray(parsed.body.labels)) {
        const labelNames = parsed.body.labels.filter((label): label is string => typeof label === 'string');
        for (const label of labelNames) if (!repo.labels.has(label)) return err(422, `Validation Failed: label "${label}" does not exist`);
        issue.labels = [...labelNames];
      }
      issue.updated_at = dateFromSeq(store.nextId());
      return reply(200, issueJson(repo, issue));
    }
    return err(404, 'Not Found');
  }

  if (segments[1] === 'comments') {
    if (segments.length === 2 && method === 'GET') {
      return reply(200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
    }
    if (segments.length === 2 && method === 'POST') {
      const parsed = parseBody(rawBody);
      if ('error' in parsed) return parsed.error;
      const body = typeof parsed.body.body === 'string' ? parsed.body.body : '';
      if (body === '') return err(422, 'Validation Failed: body is required');
      const comment = { id: repo.nextCommentId++, body, user: VIEWER_LOGIN, created_at: dateFromSeq(store.nextId()), updated_at: dateFromSeq(store.nextId()) };
      issue.comments.push(comment);
      return reply(201, commentJson(repo, issue, comment));
    }
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------- pulls

function handlePulls(store: Store, repo: Repo, segments: readonly string[], method: string, url: URL, rawBody: string | undefined, origin = ''): Reply {
  if (segments.length === 0 && method === 'GET') {
    const state = url.searchParams.get('state') ?? 'open';
    const pulls = [...repo.pulls.values()]
      .filter((pull) => state === 'all' || (state === 'open' ? pull.state === 'open' : pull.state === 'closed'))
      .sort((a, b) => a.number - b.number)
      .map((pull) => pullJson(repo, pull));
    return paginate(store, url, '', pulls, 30, origin);
  }
  if (segments.length === 0 && method === 'POST') {
    const parsed = parseBody(rawBody);
    if ('error' in parsed) return parsed.error;
    const headRef = typeof parsed.body.head === 'string' ? parsed.body.head : '';
    const baseRef = typeof parsed.body.base === 'string' ? parsed.body.base : '';
    const title = typeof parsed.body.title === 'string' ? parsed.body.title : '';
    const body = typeof parsed.body.body === 'string' ? parsed.body.body : '';
    const headSha = refCommit(repo, `refs/heads/${headRef}`);
    const baseSha = refCommit(repo, `refs/heads/${baseRef}`);
    if (!headSha || !baseSha) return err(422, 'Validation Failed: head or base branch does not exist');
    if (headRef === baseRef) return err(422, 'Validation Failed: head and base are the same branch');
    const open = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.head === headRef && pull.base === baseRef);
    if (open) return err(422, 'Validation Failed: a pull request already exists for this head and base');
    const pull: Pull = {
      repoKey: repo.key, number: repo.nextPull++, title, body, head: headRef, base: baseRef,
      headSha, baseSha, state: 'open', merged: false, merge_commit_sha: null, merged_at: null,
      created_at: dateFromSeq(store.nextId()), user: VIEWER_LOGIN,
    };
    repo.pulls.set(pull.number, pull);
    return reply(201, pullJson(repo, pull));
  }
  const number = parseInt(segments[0], 10);
  if (!Number.isInteger(number)) return err(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (!pull) return err(404, 'Not Found');

  if (segments.length === 1 && method === 'GET') return reply(200, pullJson(repo, pull));

  if (segments[1] === 'files' && segments.length === 2 && method === 'GET') {
    return reply(200, pullFiles(repo, pull.baseSha, pull.headSha));
  }

  if (segments[1] === 'merge' && segments.length === 2 && method === 'PUT') {
    const parsed = parseBody(rawBody);
    if ('error' in parsed) return parsed.error;
    if (pull.merged) return err(405, 'Pull Request is not mergeable: already merged');
    const baseSha = refCommit(repo, `refs/heads/${pull.base}`);
    if (!baseSha) return err(405, 'Pull Request is not mergeable: base branch is gone');
    // Conflict: the pull's changed paths moved on the base since the pull opened, and the head
    // does not carry the base's current content for those paths.
    const changed = pullFiles(repo, pull.baseSha, pull.headSha).map((file) => file.filename);
    for (const path of changed) {
      const headNow = refCommit(repo, `refs/heads/${pull.head}`);
      if (!headNow) return err(405, 'Pull Request is not mergeable: head branch is gone');
      const headTree = parseCommit(repo.objects.get(headNow)!.data).tree;
      const currentTree = parseCommit(repo.objects.get(baseSha)!.data).tree;
      const originalTree = parseCommit(repo.objects.get(pull.baseSha)!.data).tree;
      const headBlob = blobAtPath(repo, headTree, path);
      const baseBlob = blobAtPath(repo, currentTree, path);
      const originalBlob = blobAtPath(repo, originalTree, path);
      if (baseBlob !== originalBlob && headBlob !== baseBlob && headBlob !== originalBlob) {
        return err(405, 'Pull Request is not mergeable: merge conflict');
      }
    }
    const mergeSha = squashMerge(repo, pull);
    pull.state = 'closed';
    pull.merged = true;
    pull.merge_commit_sha = mergeSha;
    pull.merged_at = dateFromSeq(store.nextId());
    return reply(200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
  }
  return err(404, 'Not Found');
}

function blobAtPath(repo: Repo, treeOid: string, path: string): string | null {
  const result = treeLookup(repo, treeOid, path);
  if (!result || !('blob' in result)) return null;
  return result.blob;
}

// ---------------------------------------------------------------- contents

function handleContents(repo: Repo, segments: readonly string[], method: string, url: URL, rawBody: string | undefined): Reply {
  const path = segments.join('/');
  const ref = url.searchParams.get('ref') ?? repo.default_branch;

  if (method === 'GET') {
    const tip = refCommit(repo, `refs/heads/${ref}`);
    if (!tip) return err(404, 'Not Found');
    const tree = parseCommit(repo.objects.get(tip)!.data).tree;
    const result = treeLookup(repo, tree, path);
    if (!result) return err(404, 'Not Found');
    const baseName = path.split('/').filter((part) => part.length > 0).pop() ?? path;
    if ('blob' in result) {
      const blob = repo.objects.get(result.blob)!;
      return reply(200, {
        type: 'file',
        name: baseName,
        path,
        sha: result.blob,
        size: blob.data.length,
        encoding: 'base64',
        content: blob.data.toString('base64'),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      });
    }
    return reply(200, result.entries.map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: `${path}/${entry.name}`,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : repo.objects.get(entry.oid)?.data.length ?? 0,
      encoding: entry.mode === '40000' ? undefined : 'base64',
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}/${entry.name}`,
    })));
  }

  if (method === 'PUT') {
    const parsed = parseBody(rawBody);
    if ('error' in parsed) return parsed.error;
    const message = typeof parsed.body.message === 'string' ? parsed.body.message : 'update';
    const branch = typeof parsed.body.branch === 'string' ? parsed.body.branch : repo.default_branch;
    const content = typeof parsed.body.content === 'string' ? parsed.body.content.replace(/\n/g, '') : '';
    let data: Buffer;
    try {
      data = Buffer.from(content, 'base64');
    } catch {
      return err(422, 'Validation Failed: content is not valid base64');
    }
    const tip = refCommit(repo, `refs/heads/${branch}`);
    const existingTip = tip;
    const currentTree = existingTip ? parseCommit(repo.objects.get(existingTip)!.data).tree : null;
    const existing = currentTree ? treeLookup(repo, currentTree, path) : undefined;
    const existingBlob = existing && 'blob' in existing ? existing.blob : null;
    if (existingBlob !== null) {
      // Update: a matching sha is required.
      const sha = typeof parsed.body.sha === 'string' ? parsed.body.sha : '';
      if (!sha) return err(422, 'Validation Failed: sha is required when updating an existing file');
      if (sha !== existingBlob) return err(409, `${path} does not match ${sha}`);
    }
    const commitSha = commitChanges(repo, existingTip, { [path]: data }, message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.refsVersion += 1;
    return reply(existingBlob !== null ? 200 : 201, {
      content: { sha: hashObject('blob', data), encoding: 'base64', name: path.split('/').pop(), path, size: data.length, type: 'file' },
      commit: { sha: commitSha, message, author: { name: VIEWER_LOGIN, email: 'forge@localhost', date: dateFromSeq(repo.id) }, html_url: `https://forge.local/${repo.owner}/${repo.name}/commit/${commitSha}` },
    });
  }

  if (method === 'DELETE') {
    const parsed = parseBody(rawBody);
    if ('error' in parsed) return parsed.error;
    const message = typeof parsed.body.message === 'string' ? parsed.body.message : 'delete';
    const branch = typeof parsed.body.branch === 'string' ? parsed.body.branch : repo.default_branch;
    const tip = refCommit(repo, `refs/heads/${branch}`);
    if (!tip) return err(404, 'Not Found');
    const tree = parseCommit(repo.objects.get(tip)!.data).tree;
    const existing = treeLookup(repo, tree, path);
    if (!existing || !('blob' in existing)) return err(404, 'Not Found');
    const sha = typeof parsed.body.sha === 'string' ? parsed.body.sha : '';
    if (sha && sha !== existing.blob) return err(409, `${path} does not match ${sha}`);
    const commitSha = commitChanges(repo, tip, { [path]: null }, message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    repo.refsVersion += 1;
    return reply(200, { commit: { sha: commitSha, message } });
  }

  return err(404, 'Not Found');
}