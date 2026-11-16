// GitHub GraphQL v4 at /api/graphql: a small parser and resolver for the documents gh and
// github-mcp-server send (variables, aliases, inline fragments, __type introspection, mutations).
import { Store, VIEWER_LOGIN, refCommit, dateFromSeq, squashMerge, pullFiles, type Repo, type Issue, type Pull } from './store.ts';
import { globalId } from './rest.ts';

interface Field {
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selections: Field[];
}
type Value =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

// ---------------------------------------------------------------- lexer/parser

class Parser {
  private pos = 0;
  private readonly text: string;
  constructor(text: string) { this.text = text; }

  private skip(): void {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (/\s/.test(ch)) { this.pos += 1; continue; }
      if (ch === '#') { while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1; continue; }
      if (ch === ',') { this.pos += 1; continue; }
      break;
    }
  }
  private peek(): string { this.skip(); return this.text[this.pos] ?? ''; }
  private take(expected?: string): string {
    const ch = this.peek();
    if (expected !== undefined && ch !== expected) throw new GqlError(`expected ${JSON.stringify(expected)} at offset ${this.pos}`);
    this.pos += 1;
    return ch;
  }
  private name(): string {
    this.skip();
    const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(this.text.slice(this.pos));
    if (!match) throw new GqlError(`expected a name at offset ${this.pos}`);
    this.pos += match[0].length;
    return match[0];
  }

  parseDocument(): { operations: Array<{ type: 'query' | 'mutation'; name: string | null; variables: Map<string, string>; selections: Field[] }> } {
    const operations: Array<{ type: 'query' | 'mutation'; name: string | null; variables: Map<string, string>; selections: Field[] }> = [];
    for (;;) {
      this.skip();
      if (this.pos >= this.text.length) break;
      if (this.peek() === '{') {
        operations.push({ type: 'query', name: null, variables: new Map(), selections: this.selectionSet() });
        continue;
      }
      const keyword = this.name();
      if (keyword === 'fragment') {
        this.name(); // fragment name
        this.name(); // on
        this.name(); // type
        this.selectionSet();
        continue;
      }
      if (keyword !== 'query' && keyword !== 'mutation') throw new GqlError(`unsupported keyword ${keyword}`);
      let opName: string | null = null;
      if (this.peek() !== '(' && this.peek() !== '{') opName = this.name();
      const variables = new Map<string, string>();
      if (this.peek() === '(') {
        this.take('(');
        while (this.peek() !== ')') {
          this.take('$');
          const varName = this.name();
          this.take(':');
          const typeName = this.typeName();
          variables.set(varName, typeName);
          if (this.peek() === '=') { this.take('='); this.take('>'); this.defaultValue(); }
        }
        this.take(')');
      }
      operations.push({ type: keyword as 'query' | 'mutation', name: opName, variables, selections: this.selectionSet() });
    }
    return { operations };
  }

  private typeName(): string {
    let name = this.name();
    if (this.peek() === '!') this.take('!');
    if (this.peek() === '[') { this.take('['); name = this.typeName(); this.take(']'); if (this.peek() === '!') this.take('!'); }
    return name;
  }
  private defaultValue(): void { this.value(); }

  private selectionSet(): Field[] {
    this.take('{');
    const fields: Field[] = [];
    for (;;) {
      if (this.peek() === '}') { this.take('}'); break; }
      if (this.peek() === '.') {
        // inline fragment or fragment spread
        this.take('.'); this.take('.'); this.take('.');
        const next = this.peek();
        if (next === 'o' || next === 'O') { this.name(); this.name(); } // on Type
        else this.name(); // fragment spread name: skip
        if (this.peek() === '{') fields.push(...this.selectionSet());
        continue;
      }
      fields.push(this.field());
    }
    return fields;
  }

  private field(): Field {
    const name = this.name();
    let alias: string | null = null;
    if (this.peek() === ':') { this.take(':'); alias = name; return this.finishField(alias, this.name()); }
    return this.finishField(null, name);
  }

  private finishField(alias: string | null, name: string): Field {
    const args = new Map<string, Value>();
    if (this.peek() === '(') {
      this.take('(');
      while (this.peek() !== ')') {
        const argName = this.name();
        this.take(':');
        args.set(argName, this.value());
      }
      this.take(')');
    }
    // skip directives
    while (this.peek() === '@') { this.take('@'); this.name(); if (this.peek() === '(') { this.take('('); while (this.peek() !== ')') { this.name(); this.take(':'); this.value(); } this.take(')'); } }
    let selections: Field[] = [];
    if (this.peek() === '{') selections = this.selectionSet();
    return { alias, name, args, selections };
  }

  private value(): Value {
    const ch = this.peek();
    if (ch === '$') { this.take('$'); return { kind: 'var', name: this.name() }; }
    if (ch === '"') {
      this.take('"');
      let out = '';
      while (this.pos < this.text.length) {
        const c = this.text[this.pos];
        if (c === '\\') {
          const escaped = this.text[this.pos + 1];
          out += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === '"' ? '"' : escaped === '\\' ? '\\' : escaped;
          this.pos += 2;
          continue;
        }
        if (c === '"') { this.pos += 1; break; }
        out += c;
        this.pos += 1;
      }
      return { kind: 'string', value: out };
    }
    if (ch === '[') {
      this.take('[');
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.value());
      this.take(']');
      return { kind: 'list', items };
    }
    if (ch === '{') {
      this.take('{');
      const fields = new Map<string, Value>();
      while (this.peek() !== '}') {
        const key = this.name();
        this.take(':');
        fields.set(key, this.value());
      }
      this.take('}');
      return { kind: 'object', fields };
    }
    if (!/[_A-Za-z0-9-]/.test(ch)) throw new GqlError(`expected a value at offset ${this.pos}`);
    const match = /^-?[_0-9A-Za-z.]+/.exec(this.text.slice(this.pos));
    const token = match ? match[0] : this.name();
    this.pos += token.length;
    if (token === 'true') return { kind: 'bool', value: true };
    if (token === 'false') return { kind: 'bool', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: parseInt(token, 10) };
    if (/^-?\d+\.\d+$/.test(token)) return { kind: 'float', value: parseFloat(token) };
    return { kind: 'enum', value: token };
  }
}

class GqlError extends Error {}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var': return variables[value.name];
    case 'int': case 'float': case 'string': case 'bool': return value.value;
    case 'enum': return value.value;
    case 'null': return null;
    case 'list': return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.fields) out[key] = resolveValue(item, variables);
      return out;
    }
  }
}

function argValue(field: Field, name: string, variables: Record<string, unknown>): unknown {
  const value = field.args.get(name);
  return value === undefined ? undefined : resolveValue(value, variables);
}

// ---------------------------------------------------------------- schema data

const TYPE_FIELDS: Record<string, readonly string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'closedAt', 'labels', 'comments', 'repository', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'commits', 'author', 'createdAt', 'mergedAt', 'mergeCommit', 'url', 'repository'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'ref', 'url', 'createdAt', 'isPrivate'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  PullRequestFile: ['path', 'additions', 'deletions'],
  Ref: ['name', 'target'],
  User: ['login', 'id'],
};

const ENUM_VALUES: Record<string, readonly string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

// ---------------------------------------------------------------- executor

export interface GraphQLResult { status: number; body: unknown }

class Exec {
  private readonly store: Store;
  private readonly variables: Record<string, unknown>;
  private readonly authed: boolean;
  errors: Array<{ message: string }> = [];

  constructor(store: Store, variables: Record<string, unknown>, authed: boolean) {
    this.store = store;
    this.variables = variables;
    this.authed = authed;
  }

  run(selections: readonly Field[], operationType: 'query' | 'mutation'): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    for (const field of selections) {
      const key = field.alias ?? field.name;
      data[key] = this.resolveRoot(field, operationType);
    }
    return data;
  }

  private resolveRoot(field: Field, operationType: 'query' | 'mutation'): unknown {
    switch (field.name) {
      case 'viewer': return this.project({ login: VIEWER_LOGIN, id: globalId('User', 1) }, field.selections, 'User');
      case 'node': {
        const id = argValue(field, 'id', this.variables);
        return this.resolveNode(id, field.selections);
      }
      case '__type': {
        const name = argValue(field, 'name', this.variables);
        return this.introspectType(typeof name === 'string' ? name : '', field.selections);
      }
      case '__schema': return this.introspectSchema(field.selections);
      case 'repository': {
        const owner = argValue(field, 'owner', this.variables);
        const name = argValue(field, 'name', this.variables);
        const repo = typeof owner === 'string' && typeof name === 'string' ? this.store.getRepo(owner, name) : undefined;
        if (!repo) return null;
        return this.resolveRepository(repo, field.selections);
      }
      case 'createIssue': return this.mutateCreateIssue(field);
      case 'closeIssue': return this.mutateCloseIssue(field);
      case 'createPullRequest': return this.mutateCreatePullRequest(field);
      case 'mergePullRequest': return this.mutateMergePullRequest(field);
      case 'addComment': return this.mutateAddComment(field);
      default:
        this.errors.push({ message: `Field '${field.name}' doesn't exist on type '${operationType === 'mutation' ? 'Mutation' : 'Query'}'` });
        return null;
    }
  }

  private resolveNode(id: unknown, selections: readonly Field[]): unknown {
    if (typeof id !== 'string' || id === '') return null;
    let decoded: string;
    try {
      decoded = Buffer.from(id, 'base64').toString('utf8');
    } catch {
      return null;
    }
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    const kind = decoded.slice(0, colon);
    const key = decoded.slice(colon + 1);
    if (kind === 'Repository') {
      const repo = [...this.store.repos.values()].find((candidate) => String(candidate.id) === key);
      if (!repo) return null;
      return this.project(
        { id, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}`, databaseId: repo.id, owner: { login: repo.owner }, defaultBranchRef: { name: repo.default_branch } },
        selections, 'Repository',
      );
    }
    if (kind === 'Issue') {
      const sep = key.indexOf('_');
      const repoId = key.slice(0, sep);
      const number = parseInt(key.slice(sep + 1), 10);
      const repo = [...this.store.repos.values()].find((candidate) => String(candidate.id) === repoId);
      const issue = repo?.issues.get(number);
      if (!repo || !issue) return null;
      return this.project(this.issueNode(repo, issue), selections, 'Issue');
    }
    if (kind === 'PullRequest') {
      const sep = key.indexOf('_');
      const repoId = key.slice(0, sep);
      const number = parseInt(key.slice(sep + 1), 10);
      const repo = [...this.store.repos.values()].find((candidate) => String(candidate.id) === repoId);
      const pull = repo?.pulls.get(number);
      if (!repo || !pull) return null;
      return this.project(this.pullNode(repo, pull), selections, 'PullRequest');
    }
    return null;
  }

  private introspectType(name: string, selections: readonly Field[]): unknown {
    if (name === 'SearchType') {
      return this.project({ name, kind: 'ENUM', enumValues: ENUM_VALUES.SearchType.map((value) => ({ name: value })) }, selections, '__Type');
    }
    const fields = TYPE_FIELDS[name];
    if (!fields) return null;
    return this.project({ name, kind: 'OBJECT', fields: fields.map((fieldName) => ({ name: fieldName })) }, selections, '__Type');
  }

  private introspectSchema(selections: readonly Field[]): unknown {
    const types = Object.keys(TYPE_FIELDS).concat(['SearchType', 'IssueState', 'PullRequestState', 'Query', 'Mutation']);
    return this.project({ queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: types.map((name) => ({ name })) }, selections, '__Schema');
  }

  private issueNode(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: globalId('Issue', `${repo.id}_${issue.number}`),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
      author: { login: issue.user },
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      closedAt: issue.closed_at,
      url: `https://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
      repository: { id: globalId('Repository', repo.id), name: repo.name },
      labels: { nodes: issue.labels.map((name) => ({ name, color: repo.labels.get(name) ?? 'ededed' })) },
      comments: {
        nodes: issue.comments.map((comment) => ({ id: globalId('IssueComment', comment.id), body: comment.body, author: { login: comment.user }, createdAt: comment.created_at })),
      },
    };
  }

  private pullNode(repo: Repo, pull: Pull): Record<string, unknown> {
    return {
      id: globalId('PullRequest', `${repo.id}_${pull.number}`),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
      merged: pull.merged,
      mergeable: 'MERGEABLE',
      headRefName: pull.head,
      baseRefName: pull.base,
      headRefOid: pull.headSha,
      baseRefOid: pull.baseSha,
      createdAt: pull.created_at,
      url: `https://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
      files: { nodes: pullFiles(repo, pull.baseSha, pull.headSha).map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions })), pageInfo: { hasNextPage: false, endCursor: null } },
    };
  }

  private resolveRepository(repo: Repo, selections: readonly Field[]): unknown {
    return this.project({
      id: globalId('Repository', repo.id),
      databaseId: repo.id,
      name: repo.name,
      nameWithOwner: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner },
      description: repo.description,
      defaultBranchRef: { name: repo.default_branch },
      viewerPermission: 'ADMIN',
      hasIssuesEnabled: true,
      isPrivate: repo.privateFlag,
      issue: null,
      issues: null,
      pullRequest: null,
      pullRequests: null,
      __rawRepo: repo,
    }, selections, 'Repository');
  }

  /** Project selections onto a value, resolving the connection/lookup fields lazily. */
  private project(value: unknown, selections: readonly Field[], typeName: string): unknown {
    if (value === null || value === undefined) return value;
    const source = value as Record<string, unknown>;
    const repo = (source.__rawRepo as Repo | undefined) ?? null;
    const out: Record<string, unknown> = {};
    for (const field of selections) {
      const key = field.alias ?? field.name;
      out[key] = this.resolveField(source, repo, field, typeName);
    }
    return out;
  }

  private resolveField(source: Record<string, unknown>, repo: Repo | null, field: Field, typeName: string): unknown {
    // Repository-specific lookups.
    if (typeName === 'Repository' && repo) {
      if (field.name === 'issue') {
        const number = argValue(field, 'number', this.variables);
        const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
        if (!issue) return null;
        return this.project(this.issueNode(repo, issue), field.selections, 'Issue');
      }
      if (field.name === 'pullRequest') {
        const number = argValue(field, 'number', this.variables);
        const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
        if (!pull) return null;
        return this.project(this.pullNode(repo, pull), field.selections, 'PullRequest');
      }
      if (field.name === 'issues') {
        return this.issueConnection(repo, field);
      }
      if (field.name === 'pullRequests') {
        const first = argValue(field, 'first', this.variables);
        const states = argValue(field, 'states', this.variables);
        const limit = typeof first === 'number' ? first : 30;
        const list = [...repo.pulls.values()]
          .filter((pull) => {
            const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
            if (Array.isArray(states) && states.length > 0) return (states as string[]).includes(state);
            return state === 'OPEN';
          })
          .slice(0, limit)
          .map((pull) => this.pullNode(repo, pull));
        return this.project({ nodes: list, pageInfo: { hasNextPage: false, endCursor: null } }, field.selections, 'PullRequestConnection');
      }
      if (field.name === 'ref') {
        const name = argValue(field, 'name', this.variables);
        const sha = typeof name === 'string' ? refCommit(repo, name) : undefined;
        if (!sha) return null;
        return this.project({ name, target: { oid: sha, sha } }, field.selections, 'Ref');
      }
    }
    if (typeName === 'PullRequest' && field.name === 'files') {
      const first = argValue(field, 'first', this.variables);
      const nodes = Array.isArray(source.files && (source.files as Record<string, unknown>).nodes)
        ? ((source.files as Record<string, unknown>).nodes as unknown[]).slice(0, typeof first === 'number' ? first : 30)
        : [];
      return this.project({ nodes, pageInfo: { hasNextPage: false, endCursor: null } }, field.selections, 'PullRequestFileConnection');
    }
    if (!(field.name in source)) {
      this.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      return null;
    }
    const value = source[field.name];
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && field.selections.length > 0) {
      return this.project(value, field.selections, objectTypeName(field.name));
    }
    if (Array.isArray(value) && field.selections.length > 0) {
      return value.map((item) => this.project(item, field.selections, objectTypeName(field.name)));
    }
    return value;
  }

  private issueConnection(repo: Repo, field: Field): unknown {
    const first = argValue(field, 'first', this.variables);
    const after = argValue(field, 'after', this.variables);
    const states = argValue(field, 'states', this.variables);
    const orderBy = argValue(field, 'orderBy', this.variables);
    let list = [...repo.issues.values()];
    if (Array.isArray(states) && states.length > 0) {
      const wanted = (states as string[]).map((state) => (state === 'OPEN' ? 'open' : 'closed'));
      list = list.filter((issue) => wanted.includes(issue.state));
    }
    let direction = 'desc';
    if (orderBy && typeof orderBy === 'object' && 'direction' in (orderBy as Record<string, unknown>)) {
      direction = String((orderBy as Record<string, unknown>).direction).toLowerCase();
    }
    list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    const limit = typeof first === 'number' && first > 0 ? first : 30;
    let start = 0;
    if (typeof after === 'string' && after !== '') {
      start = list.findIndex((issue) => this.cursorFor(issue) === after) + 1;
      if (start <= 0) start = 0;
    }
    const slice = list.slice(start, start + limit);
    const hasNextPage = start + limit < list.length;
    const endCursor = slice.length ? this.cursorFor(slice[slice.length - 1]) : null;
    return this.project(
      { nodes: slice.map((issue) => this.issueNode(repo, issue)), pageInfo: { hasNextPage, endCursor } },
      field.selections, 'IssueConnection',
    );
  }

  private cursorFor(issue: Issue): string {
    return Buffer.from(`cursor:${issue.number}`, 'utf8').toString('base64');
  }

  // ---------------------------------------------------------------- mutations

  private inputOf(field: Field): Record<string, unknown> {
    const input = argValue(field, 'input', this.variables);
    if (input !== null && typeof input === 'object' && !Array.isArray(input)) return input as Record<string, unknown>;
    return {};
  }

  private repoById(id: unknown): Repo | null {
    if (typeof id !== 'string' || id === '') return null;
    let decoded: string;
    try {
      decoded = Buffer.from(id, 'base64').toString('utf8');
    } catch {
      return null;
    }
    if (!decoded.startsWith('Repository:')) return null;
    const repoId = decoded.slice('Repository:'.length);
    return [...this.store.repos.values()].find((candidate) => String(candidate.id) === repoId) ?? null;
  }

  private mutateCreateIssue(field: Field): unknown {
    const input = this.inputOf(field);
    const repo = this.repoById(input.repositoryId);
    if (!repo) {
      this.errors.push({ message: 'Could not resolve to a Repository with the global id' });
      return null;
    }
    const now = dateFromSeq(this.store.nextId());
    const issue: Issue = {
      repoKey: repo.key, number: repo.nextIssue++, title: String(input.title ?? ''),
      body: String(input.body ?? ''), state: 'open', labels: [], comments: [],
      seq: this.store.nextId(), created_at: now, updated_at: now, closed_at: null, user: VIEWER_LOGIN,
    };
    repo.issues.set(issue.number, issue);
    return this.project({ issue: this.issueNode(repo, issue) }, field.selections, 'CreateIssuePayload');
  }

  private mutateCloseIssue(field: Field): unknown {
    const input = this.inputOf(field);
    const found = this.issueById(input.issueId);
    if (!found) {
      this.errors.push({ message: 'Could not resolve to a node with the global id' });
      return null;
    }
    found.issue.state = 'closed';
    found.issue.closed_at = dateFromSeq(this.store.nextId());
    return this.project({ issue: this.issueNode(found.repo, found.issue) }, field.selections, 'CloseIssuePayload');
  }

  private issueById(id: unknown): { repo: Repo; issue: Issue } | null {
    if (typeof id !== 'string') return null;
    let decoded: string;
    try {
      decoded = Buffer.from(id, 'base64').toString('utf8');
    } catch {
      return null;
    }
    if (!decoded.startsWith('Issue:')) return null;
    const key = decoded.slice('Issue:'.length);
    const sep = key.indexOf('_');
    const repoId = key.slice(0, sep);
    const number = parseInt(key.slice(sep + 1), 10);
    const repo = [...this.store.repos.values()].find((candidate) => String(candidate.id) === repoId);
    const issue = repo?.issues.get(number);
    if (!repo || !issue) return null;
    return { repo, issue };
  }

  private pullById(id: unknown): { repo: Repo; pull: Pull } | null {
    if (typeof id !== 'string') return null;
    let decoded: string;
    try {
      decoded = Buffer.from(id, 'base64').toString('utf8');
    } catch {
      return null;
    }
    if (!decoded.startsWith('PullRequest:')) return null;
    const key = decoded.slice('PullRequest:'.length);
    const sep = key.indexOf('_');
    const repoId = key.slice(0, sep);
    const number = parseInt(key.slice(sep + 1), 10);
    const repo = [...this.store.repos.values()].find((candidate) => String(candidate.id) === repoId);
    const pull = repo?.pulls.get(number);
    if (!repo || !pull) return null;
    return { repo, pull };
  }

  private mutateCreatePullRequest(field: Field): unknown {
    const input = this.inputOf(field);
    const repo = this.repoById(input.repositoryId);
    if (!repo) {
      this.errors.push({ message: 'Could not resolve to a Repository with the global id' });
      return null;
    }
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? '');
    const headSha = refCommit(repo, `refs/heads/${headRef}`);
    const baseSha = refCommit(repo, `refs/heads/${baseRef}`);
    if (!headSha || !baseSha) {
      this.errors.push({ message: 'Head or base branch does not exist' });
      return null;
    }
    const now = dateFromSeq(this.store.nextId());
    const pull: Pull = {
      repoKey: repo.key, number: repo.nextPull++, title: String(input.title ?? ''),
      body: String(input.body ?? ''), head: headRef, base: baseRef, headSha, baseSha,
      state: 'open', merged: false, merge_commit_sha: null, merged_at: null,
      created_at: now, user: VIEWER_LOGIN,
    };
    repo.pulls.set(pull.number, pull);
    return this.project({ pullRequest: this.pullNode(repo, pull) }, field.selections, 'CreatePullRequestPayload');
  }

  private mutateMergePullRequest(field: Field): unknown {
    const input = this.inputOf(field);
    const found = this.pullById(input.pullRequestId);
    if (!found) {
      this.errors.push({ message: 'Could not resolve to a node with the global id' });
      return null;
    }
    const { repo, pull } = found;
    if (pull.merged) {
      this.errors.push({ message: 'Pull request is already merged' });
      return null;
    }
    const baseSha = refCommit(repo, `refs/heads/${pull.base}`);
    if (!baseSha) {
      this.errors.push({ message: 'Base branch is gone' });
      return null;
    }
    const mergeSha = squashMerge(repo, pull);
    pull.state = 'closed';
    pull.merged = true;
    pull.merge_commit_sha = mergeSha;
    pull.merged_at = dateFromSeq(this.store.nextId());
    return this.project({ pullRequest: this.pullNode(repo, pull) }, field.selections, 'MergePullRequestPayload');
  }

  private mutateAddComment(field: Field): unknown {
    const input = this.inputOf(field);
    const found = this.issueById(input.subjectId);
    if (!found) {
      this.errors.push({ message: 'Could not resolve to a node with the global id' });
      return null;
    }
    const body = String(input.body ?? '');
    const comment = { id: found.repo.nextCommentId++, body, user: VIEWER_LOGIN, created_at: dateFromSeq(this.store.nextId()), updated_at: dateFromSeq(this.store.nextId()) };
    found.issue.comments.push(comment);
    return this.project(
      { commentEdge: { node: { id: globalId('IssueComment', comment.id), body: comment.body, createdAt: comment.created_at, author: { login: comment.user } } } },
      field.selections, 'AddCommentPayload',
    );
  }
}

function objectTypeName(fieldName: string): string {
  switch (fieldName) {
    case 'owner': case 'author': return 'User';
    case 'defaultBranchRef': case 'ref': return 'Ref';
    case 'labels': case 'label': return 'Label';
    case 'comments': return 'IssueCommentConnection';
    case 'node': case 'target': return 'Node';
    case 'pageInfo': return 'PageInfo';
    case 'head': case 'base': return 'GitRef';
    case 'headRef': case 'baseRef': return 'Ref';
    case 'mergeCommit': return 'Commit';
    case 'repository': return 'Repository';
    case 'issue': return 'Issue';
    case 'pullRequest': return 'PullRequest';
    case 'issues': return 'IssueConnection';
    case 'pullRequests': return 'PullRequestConnection';
    case 'files': return 'PullRequestFileConnection';
    case 'nodes': return 'Node';
    case 'viewer': return 'User';
    default: return 'Node';
  }
}

// ---------------------------------------------------------------- entry

export function handleGraphQL(store: Store, rawBody: string | undefined, authed: boolean): GraphQLResult {
  if (!authed) return { status: 401, body: { message: 'Requires authentication' } };
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody ?? '');
  } catch {
    return { status: 400, body: { message: 'Problems parsing JSON' } };
  }
  const runOne = (operation: { query: string; variables?: Record<string, unknown>; operationName?: string }): Record<string, unknown> => {
    let document;
    try {
      document = new Parser(operation.query).parseDocument();
    } catch (error) {
      return { errors: [{ message: error instanceof Error ? error.message : 'parse error' }] };
    }
    const operations = document.operations.filter((op) => op.name === null || operation.operationName === undefined || op.name === operation.operationName);
    if (operations.length === 0) operations.push(...document.operations);
    const data: Record<string, unknown> = {};
    const exec = new Exec(store, operation.variables ?? {}, authed);
    for (const op of operations) {
      const result = exec.run(op.selections, op.type);
      Object.assign(data, result);
    }
    const body: Record<string, unknown> = { data };
    if (exec.errors.length > 0) body.errors = exec.errors;
    return body;
  };
  if (Array.isArray(parsedBody)) {
    const results = parsedBody.map((entry) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || typeof (entry as Record<string, unknown>).query !== 'string') {
        return { errors: [{ message: 'each batched operation must be an object with a query' }] };
      }
      return runOne(entry as { query: string; variables?: Record<string, unknown>; operationName?: string });
    });
    return { status: 200, body: results };
  }
  if (parsedBody === null || typeof parsedBody !== 'object' || typeof (parsedBody as Record<string, unknown>).query !== 'string') {
    return { status: 400, body: { message: 'Problems parsing JSON: query is required' } };
  }
  return { status: 200, body: runOne(parsedBody as { query: string; variables?: Record<string, unknown>; operationName?: string }) };
}