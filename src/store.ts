// Single shared state for the forge: repositories, their git objects and refs,
// plus issues, labels, pull requests and comments. REST, GraphQL, MCP and the
// git smart-HTTP endpoints all read and write this one store.
// Every id and timestamp is derived from a plain sequence counter, never from
// the wall clock, so a scenario replays to byte-identical results.
import {
  hashObject, parseCommit, parseTree, buildTree, buildCommit, writePack,
  type GitObject, type ObjectType, type TreeEntry,
} from './gitobj.ts';
import { VIEWER as SCENARIO_VIEWER, STRANGER as SCENARIO_STRANGER } from './scenario.ts';

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

export const VIEWER_LOGIN = SCENARIO_VIEWER.login;
export const STRANGER_LOGIN = SCENARIO_STRANGER.login;

export class Store {
  repos = new Map<string, Repo>(); // key `${owner}/${name}` (owner is always the viewer here)
  private counter = 1;

  nextId(): number { return this.counter++; }

  createRepo(name: string, description = '', privateFlag = true): Repo {
    const key = `${VIEWER_LOGIN}/${name}`;
    const known = this.repos.get(key);
    if (known) return known;
    const repo = assembleRepo(key, name, description, privateFlag, this.nextId(), this.nextId());
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(`${owner}/${name}`);
  }
}

/** Build the record for a brand-new repository; seq and id come from the store's counter. */
function assembleRepo(key: string, name: string, description: string, privateFlag: boolean, seq: number, id: number): Repo {
  return {
    key, name, owner: VIEWER_LOGIN, description, privateFlag, default_branch: 'main',
    id, objects: new Map(), refs: new Map(), labels: new Map(),
    issues: new Map(), pulls: new Map(), nextIssue: 1, nextPull: 1, nextCommentId: 1,
    seq, created_at: dateFromSeq(seq),
  };
}

/** Deterministic timestamp from a sequence number (never a wall clock). */
export function dateFromSeq(seq: number): string {
  const base = 1767225600; // 2026-01-01T00:00:00Z
  return new Date((base + seq * 10) * 1000).toISOString().replace('.000Z', 'Z');
}

// ---------------------------------------------------------------- git object helpers

/** Store a loose object and hand back its oid; duplicates keep the first copy. */
export function putObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** Ref spellings a bare name may use, tried in order. */
function refSpellings(name: string): string[] {
  return [name, `refs/${name}`, `refs/heads/${name}`, `refs/tags/${name}`];
}

/** Resolve a ref name (refs/heads/x, heads/x, x, HEAD) to its oid. */
export function resolveRef(repo: Repo, name: string): string | undefined {
  if (name === 'HEAD') return repo.refs.get(`refs/heads/${repo.default_branch}`);
  for (const spelling of refSpellings(name)) {
    const oid = repo.refs.get(spelling);
    if (oid) return oid;
  }
  return undefined;
}

/** Peel a tag object's payload down to the object id it names, if it names one. */
function tagTarget(data: Buffer): string | undefined {
  const match = data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
  return match ? match[1] : undefined;
}

/** Follow refs and tags until a commit oid is reached, or give up with undefined. */
export function refCommit(repo: Repo, ref: string): string | undefined {
  let oid = resolveRef(repo, ref);
  while (oid) {
    const object = repo.objects.get(oid);
    if (!object) return undefined;
    if (object.type === 'commit') return oid;
    if (object.type !== 'tag') return undefined;
    oid = tagTarget(object.data) ?? '';
    if (!oid) return undefined;
  }
  return undefined;
}

/** Path lookup inside a tree: returns the blob oid, the parent tree oid and the entry. */
export function treeLookup(repo: Repo, treeOid: string, path: string): { blob: string; tree: string; entry: TreeEntry } | { tree: string; entries: TreeEntry[] } | undefined {
  return descendTree(repo, treeOid, path.split('/').filter((part) => part.length > 0), 0);
}

function descendTree(repo: Repo, oid: string, parts: string[], depth: number): { blob: string; tree: string; entry: TreeEntry } | { tree: string; entries: TreeEntry[] } | undefined {
  if (depth === parts.length) return { tree: oid, entries: readEntries(repo, oid) };
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tree') return undefined;
  const entry = parseTree(object.data).find((candidate) => candidate.name === parts[depth]);
  if (!entry) return undefined;
  if (depth === parts.length - 1) {
    if (entry.mode === '40000') return { tree: entry.oid, entries: readEntries(repo, entry.oid) };
    return { blob: entry.oid, tree: oid, entry };
  }
  if (entry.mode !== '40000') return undefined;
  return descendTree(repo, entry.oid, parts, depth + 1);
}

/** Parse a tree object, tolerating a missing one. */
function readEntries(repo: Repo, oid: string): TreeEntry[] {
  return parseTree(repo.objects.get(oid)?.data ?? Buffer.alloc(0));
}

/** Every file path in a tree, with mode and blob oid. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Array<{ path: string; mode: string; oid: string }> {
  const out: Array<{ path: string; mode: string; oid: string }> = [];
  gatherFiles(repo, treeOid, prefix, out);
  return out;
}

function gatherFiles(repo: Repo, oid: string, prefix: string, out: Array<{ path: string; mode: string; oid: string }>): void {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tree') return;
  for (const entry of parseTree(object.data)) {
    if (entry.mode === '160000') continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') gatherFiles(repo, entry.oid, path, out);
    else out.push({ path, mode: entry.mode, oid: entry.oid });
  }
}

/**
 * Build a commit that sets `changes` (path -> blob data or null to delete) on top of `parentCommit`
 * (empty when the repository is unborn). Returns the new commit oid.
 */
export function commitChanges(repo: Repo, parentCommit: string | undefined, changes: Record<string, Buffer | null>, message: string): string {
  // Start from the parent tree as a flat path -> {mode, oid} map.
  const files = parentCommit ? snapshotFiles(repo, parentCommit) : new Map<string, { mode: string; oid: string }>();
  for (const [path, data] of Object.entries(changes)) {
    if (data === null) files.delete(path);
    else files.set(path, { mode: '100644', oid: putObject(repo, 'blob', data) });
  }
  // Rehydrate nested trees from the flat map.
  const treeOid = assembleTree(repo, files);
  return putObject(repo, 'commit', buildCommit({ tree: treeOid, parents: parentCommit ? [parentCommit] : [], message }));
}

function snapshotFiles(repo: Repo, parentCommit: string): Map<string, { mode: string; oid: string }> {
  const files = new Map<string, { mode: string; oid: string }>();
  const commitObject = repo.objects.get(parentCommit);
  if (commitObject) {
    const view = parseCommit(commitObject.data);
    for (const file of flattenTree(repo, view.tree)) files.set(file.path, { mode: file.mode, oid: file.oid });
  }
  return files;
}

function assembleTree(repo: Repo, files: Map<string, { mode: string; oid: string }>): string {
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
  const writeNode = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, child] of node.children) entries.push({ mode: '40000', name, oid: writeNode(child) });
    if (node.leafs) for (const [name, blob] of node.leafs) entries.push({ mode: blob.mode, name, oid: blob.oid });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return writeNode(root);
}

/** Line diff counts between two blobs (additions/deletions for pull files). */
export function diffCounts(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
  const oldLines = oldText === null ? [] : oldText.split('\n');
  const newLines = newText === null ? [] : newText.split('\n');
  const oldTally = tallyLines(oldLines);
  const newTally = tallyLines(newLines);
  let additions = 0;
  for (const [line, count] of newTally) {
    const surplus = count - (oldTally.get(line) ?? 0);
    if (surplus > 0) additions += surplus;
  }
  let deletions = 0;
  for (const [line, count] of oldTally) {
    const surplus = count - (newTally.get(line) ?? 0);
    if (surplus > 0) deletions += surplus;
  }
  if (oldText === null) additions = newLines.length;
  if (newText === null) deletions = oldLines.length;
  return { additions, deletions };
}

function tallyLines(lines: string[]): Map<string, number> {
  const tally = new Map<string, number>();
  for (const line of lines) tally.set(line, (tally.get(line) ?? 0) + 1);
  return tally;
}

/** Files changed between two commits (or unborn). */
export function pullFiles(repo: Repo, baseCommit: string | undefined, headCommit: string | undefined): PullFile[] {
  const baseFiles = commitFileIndex(repo, baseCommit);
  const headFiles = headCommit ? new Map(flattenTree(repo, parseCommit(repo.objects.get(headCommit)!.data).tree).map((file) => [file.path, file])) : new Map();
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

function commitFileIndex(repo: Repo, oid: string | undefined): Map<string, { mode: string; oid: string }> {
  if (!oid) return new Map();
  const object = repo.objects.get(oid);
  const tree = object ? parseCommit(object.data).tree : '';
  return new Map(flattenTree(repo, tree).map((file) => [file.path, file]));
}

/** Ancestors-first commit walk from a tip (newest first). */
export function commitHistory(repo: Repo, tip: string, limit = 1000): string[] {
  const out: string[] = [];
  const queue: string[] = [tip];
  const visited = new Set<string>();
  let cursor = 0;
  while (cursor < queue.length && out.length < limit) {
    const oid = queue[cursor++];
    if (visited.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    visited.add(oid);
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
  const mergeCommit = putObject(repo, 'commit', buildCommit({ tree: headTree, parents: baseCommit ? [baseCommit] : [], message: squashMessage(pull) }));
  repo.refs.set(`refs/heads/${pull.base}`, mergeCommit);
  return mergeCommit;
}

function squashMessage(pull: Pull): string {
  return `${pull.title} (#${pull.number})\n\n${pull.body}`;
}

export function isDescendant(repo: Repo, ancestor: string, commit: string): boolean {
  return commitHistory(repo, commit, 100000).includes(ancestor);
}

export { writePack, parseTree, parseCommit, buildTree, buildCommit, hashObject };
