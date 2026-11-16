// The forge's in-memory store: repositories, git objects, refs, issues, labels, pulls, comments.
// All surfaces (REST, GraphQL, MCP, git smart HTTP) act on this one store.
import {
  hashObject, parseCommit, parseTree, buildTree, buildCommit, writePack,
  type GitObject, type ObjectType, type TreeEntry,
} from './gitobj.ts';

export interface IssueComment { id: number; body: string; user: string; created_at: string; updated_at: string }
export interface Issue {
  repoKey: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  user: string;
}
export interface PullFile { filename: string; status: string; additions: number; deletions: number; changes: number }
export interface Pull {
  repoKey: string;
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  merge_commit_sha: string | null;
  merged_at: string | null;
  created_at: string;
  user: string;
}
export interface Repo {
  key: string;
  name: string;
  owner: string;
  description: string;
  privateFlag: boolean;
  default_branch: string;
  id: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextIssue: number;
  nextPull: number;
  nextCommentId: number;
  seq: number;
  created_at: string;
}

export const VIEWER_LOGIN = 'octocat-forge';
export const STRANGER_LOGIN = 'not-the-owner';

export class Store {
  repos = new Map<string, Repo>(); // key `${owner}/${name}` (owner is always the viewer here)
  private counter = 1;

  nextId(): number { return this.counter++; }

  createRepo(name: string, description = '', privateFlag = true): Repo {
    const key = `${VIEWER_LOGIN}/${name}`;
    const existing = this.repos.get(key);
    if (existing) return existing;
    const seq = this.nextId();
    const repo: Repo = {
      key, name, owner: VIEWER_LOGIN, description, privateFlag, default_branch: 'main',
      id: this.nextId(), objects: new Map(), refs: new Map(), labels: new Map(),
      issues: new Map(), pulls: new Map(), nextIssue: 1, nextPull: 1, nextCommentId: 1,
      seq, created_at: dateFromSeq(seq),
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(`${owner}/${name}`);
  }
}

/** Deterministic timestamp from a sequence number (never a wall clock). */
export function dateFromSeq(seq: number): string {
  const base = 1767225600; // 2026-01-01T00:00:00Z
  return new Date((base + seq * 10) * 1000).toISOString().replace('.000Z', 'Z');
}

// ---------------------------------------------------------------- git object helpers

export function putObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** Resolve a ref name (refs/heads/x, heads/x, x, HEAD) to its oid. */
export function resolveRef(repo: Repo, name: string): string | undefined {
  if (name === 'HEAD') return repo.refs.get(`refs/heads/${repo.default_branch}`);
  const candidates = [name, `refs/${name}`, `refs/heads/${name}`, `refs/tags/${name}`];
  for (const candidate of candidates) {
    const oid = repo.refs.get(candidate);
    if (oid) return oid;
  }
  return undefined;
}

export function refCommit(repo: Repo, ref: string): string | undefined {
  let oid = resolveRef(repo, ref);
  if (!oid) return undefined;
  for (;;) {
    const object = repo.objects.get(oid);
    if (!object) return undefined;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') {
      const match = Buffer.from(object.data).toString('utf8').match(/^object ([0-9a-f]{40})/m);
      if (!match) return undefined;
      oid = match[1];
      continue;
    }
    return undefined;
  }
}

/** Path lookup inside a tree: returns the blob oid, the parent tree oid and the entry. */
export function treeLookup(repo: Repo, treeOid: string, path: string): { blob: string; tree: string; entry: TreeEntry } | { tree: string; entries: TreeEntry[] } | undefined {
  const parts = path.split('/').filter((part) => part.length > 0);
  let current = treeOid;
  for (let index = 0; index < parts.length; index += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return undefined;
    const entries = parseTree(object.data);
    if (index === parts.length - 1) {
      const entry = entries.find((candidate) => candidate.name === parts[index]);
      if (!entry) return undefined;
      if (entry.mode === '40000') return { tree: entry.oid, entries: parseTree(repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0)) };
      return { blob: entry.oid, tree: current, entry };
    }
    const entry = entries.find((candidate) => candidate.name === parts[index] && candidate.mode === '40000');
    if (!entry) return undefined;
    current = entry.oid;
  }
  return { tree: current, entries: parseTree(repo.objects.get(current)?.data ?? Buffer.alloc(0)) };
}

/** Every file path in a tree, with mode and blob oid. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Array<{ path: string; mode: string; oid: string }> {
  const out: Array<{ path: string; mode: string; oid: string }> = [];
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    if (entry.mode === '160000') continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') out.push(...flattenTree(repo, entry.oid, path));
    else out.push({ path, mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/**
 * Build a commit that sets `changes` (path -> blob data or null to delete) on top of `parentCommit`
 * (empty when the repository is unborn). Returns the new commit oid.
 */
export function commitChanges(repo: Repo, parentCommit: string | undefined, changes: Record<string, Buffer | null>, message: string): string {
  // Load the current tree as a mutable map path -> {mode, oid}.
  const files = new Map<string, { mode: string; oid: string }>();
  if (parentCommit) {
    const commitObject = repo.objects.get(parentCommit);
    if (commitObject) {
      const view = parseCommit(commitObject.data);
      for (const file of flattenTree(repo, view.tree)) files.set(file.path, { mode: file.mode, oid: file.oid });
    }
  }
  for (const [path, data] of Object.entries(changes)) {
    if (data === null) files.delete(path);
    else files.set(path, { mode: '100644', oid: putObject(repo, 'blob', data) });
  }
  // Rebuild nested trees from the flat map.
  const treeOid = buildNestedTree(repo, files);
  const commitOid = putObject(repo, 'commit', buildCommit({ tree: treeOid, parents: parentCommit ? [parentCommit] : [], message }));
  return commitOid;
}

function buildNestedTree(repo: Repo, files: Map<string, { mode: string; oid: string }>): string {
  interface Node { children: Map<string, Node>; leafs?: Map<string, { mode: string; oid: string }> }
  const root: Node = { children: new Map() };
  for (const [path, blob] of files) {
    const parts = path.split('/');
    let node = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      let child = node.children.get(parts[index]);
      if (!child) { child = { children: new Map() }; node.children.set(parts[index], child); }
      node = child;
    }
    node.leafs ??= new Map();
    node.leafs.set(parts[parts.length - 1], blob);
  }
  const write = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, child] of node.children) entries.push({ mode: '40000', name, oid: write(child) });
    if (node.leafs) for (const [name, blob] of node.leafs) entries.push({ mode: blob.mode, name, oid: blob.oid });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return write(root);
}

/** Line diff counts between two blobs (additions/deletions for pull files). */
export function diffCounts(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
  const oldLines = oldText === null ? [] : oldText.split('\n');
  const newLines = newText === null ? [] : newText.split('\n');
  const oldSet = new Map<string, number>();
  for (const line of oldLines) oldSet.set(line, (oldSet.get(line) ?? 0) + 1);
  const newSet = new Map<string, number>();
  for (const line of newLines) newSet.set(line, (newSet.get(line) ?? 0) + 1);
  let additions = 0;
  for (const [line, count] of newSet) {
    const surplus = count - (oldSet.get(line) ?? 0);
    if (surplus > 0) additions += surplus;
  }
  let deletions = 0;
  for (const [line, count] of oldSet) {
    const surplus = count - (newSet.get(line) ?? 0);
    if (surplus > 0) deletions += surplus;
  }
  if (oldText === null) additions = newLines.length;
  if (newText === null) deletions = oldLines.length;
  return { additions, deletions };
}

/** Files changed between two commits (or unborn). */
export function pullFiles(repo: Repo, baseCommit: string | undefined, headCommit: string | undefined): PullFile[] {
  const baseFiles = new Map(baseCommit ? flattenTree(repo, repo.objects.get(baseCommit)! ? parseCommit(repo.objects.get(baseCommit)!.data).tree : '').map((file) => [file.path, file]) : []);
  const headFiles = new Map(headCommit ? flattenTree(repo, parseCommit(repo.objects.get(headCommit)!.data).tree).map((file) => [file.path, file]) : []);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const files: PullFile[] = [];
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before && after && before.oid === after.oid) continue;
    const oldText = before ? repo.objects.get(before.oid)!.data.toString('utf8') : null;
    const newText = after ? repo.objects.get(after.oid)!.data.toString('utf8') : null;
    const counts = diffCounts(oldText, newText);
    files.push({
      filename: path,
      status: !before ? 'added' : !after ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return files;
}

/** Ancestors-first commit walk from a tip (newest first). */
export function commitHistory(repo: Repo, tip: string, limit = 1000): string[] {
  const out: string[] = [];
  const queue: string[] = [tip];
  const seen = new Set<string>();
  while (queue.length && out.length < limit) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    queue.push(...parseCommit(object.data).parents);
  }
  return out;
}

/** Squash-merge a pull: commit the head tree onto the base branch. Returns the merge commit oid. */
export function squashMerge(repo: Repo, pull: Pull): string | null {
  const baseCommit = refCommit(repo, `refs/heads/${pull.base}`);
  const headObject = repo.objects.get(pull.headSha);
  if (!headObject) return null;
  const headTree = parseCommit(headObject.data).tree;
  const message = `${pull.title} (#${pull.number})\n\n${pull.body}`;
  const mergeCommit = putObject(repo, 'commit', buildCommit({ tree: headTree, parents: baseCommit ? [baseCommit] : [], message }));
  repo.refs.set(`refs/heads/${pull.base}`, mergeCommit);
  return mergeCommit;
}

export function isDescendant(repo: Repo, ancestor: string, commit: string): boolean {
  return commitHistory(repo, commit, 100000).includes(ancestor);
}

export { writePack, parseTree, parseCommit, buildTree, buildCommit, hashObject };