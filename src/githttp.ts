// Git smart HTTP: upload-pack (v2 + v0) and receive-pack (v0), served at /{owner}/{repo}.git/...
import { Store, resolveRef } from './store.ts';
import {
  encodePktLine, PKT_FLUSH, PKT_DELIM, decodePktLines, hashObject, parseTree, parseCommit,
  readPack, writePack, isObjectId, ZERO_OID,
  type GitObject, type ObjectType,
} from './gitobj.ts';

const AGENT = 'forge/1.0';

interface Ctx {
  repoKey: string;
  owner: string;
  repo: string;
}

/** Split an owner/repo.git path; returns undefined when it is not a git path. */
export function parseGitPath(pathname: string): Ctx | undefined {
  const match = pathname.match(/^\/([^/]+)\/([^/]+)\.git(\/(.*))?$/);
  if (!match) return undefined;
  return { repoKey: `${match[1]}/${match[2]}`, owner: match[1], repo: match[2] };
}

// ---------------------------------------------------------------- helpers

type Reply = { status: number; contentType: string; body: Buffer | string; headers?: Record<string, string> };

function pktLines(items: ReadonlyArray<string | typeof PKT_FLUSH>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) parts.push(item === PKT_FLUSH ? PKT_FLUSH : encodePktLine(item));
  return Buffer.concat(parts);
}

function sideband(payload: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < payload.length; offset += 65519) {
    const chunk = payload.subarray(offset, offset + 65519);
    const frame = Buffer.allocUnsafe(chunk.length + 5);
    frame.write((chunk.length + 5).toString(16).padStart(4, '0'), 0, 4, 'ascii');
    frame[4] = 1;
    chunk.copy(frame, 5);
    parts.push(frame);
  }
  return Buffer.concat(parts);
}

function v0RefAdvertisement(store: Store, ctx: Ctx, service: 'git-upload-pack' | 'git-receive-pack'): Reply {
  const repo = store.getRepo(ctx.owner, ctx.repo);
  if (!repo) return { status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Not Found' }) };
  const caps = service === 'git-upload-pack'
    ? `side-band-64k multi_ack_detailed multi_ack thin-pack ofs-delta shallow agent=${AGENT} symref=HEAD:refs/heads/${repo.default_branch} object-format=sha1`
    : `report-status report-status-v2 side-band-64k delete-refs ofs-delta quiet atomic agent=${AGENT} object-format=sha1`;
  const parts: Buffer[] = [];
  parts.push(encodePktLine(`# service=${service}\n`));
  parts.push(PKT_FLUSH);
  const refs = new Map<string, string>(repo.refs);
  const headOid = resolveRef(repo, 'HEAD');
  const hasRefs = [...refs.keys()].some((name) => name.startsWith('refs/'));
  if (!hasRefs) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
    parts.push(PKT_FLUSH);
    return { status: 200, contentType: `application/x-${service}-advertisement`, body: Buffer.concat(parts) };
  }
  // HEAD first, then heads, then tags (git's order).
  const ordered: Array<[string, string]> = [];
  if (headOid) ordered.push(['HEAD', headOid]);
  for (const [name, oid] of refs) if (name.startsWith('refs/heads/')) ordered.push([name, oid]);
  for (const [name, oid] of refs) if (name.startsWith('refs/tags/')) ordered.push([name, oid]);
  let first = true;
  for (const [name, oid] of ordered) {
    if (name === 'HEAD' && oid === ZERO_OID) continue;
    const line = `${oid} ${name}${first ? `\u0000${caps}` : ''}\n`;
    parts.push(encodePktLine(line));
    first = false;
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      const match = object.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
      if (match) parts.push(encodePktLine(`${match[1]} ${name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: `application/x-${service}-advertisement`, body: Buffer.concat(parts) };
}

function v2CapabilityAdvertisement(): Reply {
  const body = pktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    PKT_FLUSH,
  ]);
  return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
}

// ---------------------------------------------------------------- upload-pack


function reachableObjects(store: Store, ctx: Ctx, tips: readonly string[], boundaries: Set<string>, exclude: Set<string>): GitObject[] {
  const repo = store.getRepo(ctx.owner, ctx.repo);
  if (!repo) return [];
  const seen = new Set<string>();
  const out: GitObject[] = [];
  const walkTree = (oid: string): void => {
    if (seen.has(oid) || exclude.has(oid)) return;
    const object = repo.objects.get(oid);
    if (!object) return;
    seen.add(oid);
    out.push(object);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        walkTree(entry.oid);
      }
    }
  };
  const walkCommit = (oid: string, depth: number): void => {
    if (seen.has(oid) || boundaries.has(oid) || exclude.has(oid)) return;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return;
    seen.add(oid);
    out.push(object);
    const view = parseCommit(object.data);
    walkTree(view.tree);
    if (depth === 1) {
      boundaries.add(oid);
      return;
    }
    for (const parent of view.parents) walkCommit(parent, depth - 1);
  };
  for (const tip of tips) walkCommit(tip, Number.POSITIVE_INFINITY);
  return out;
}

/** Full (unbounded) walk where exclude removes object subtrees already sent. */
function reachableAll(store: Store, ctx: Ctx, tips: readonly string[], exclude: Set<string>): GitObject[] {
  return reachableObjects(store, ctx, tips, new Set(), exclude);
}

/** Objects for a bounded fetch: commit walk with depth and client shallow boundaries. */
function shallowObjects(store: Store, ctx: Ctx, tips: readonly string[], depth: number, clientShallow: readonly string[], unshallow: string[]): { objects: GitObject[]; shallow: string[] } {
  const repo = store.getRepo(ctx.owner, ctx.repo);
  const objects: GitObject[] = [];
  const shallow: string[] = [];
  if (!repo) return { objects, shallow };
  const seen = new Set<string>();
  const clientBoundaries = new Set(clientShallow);
  const walkTree = (oid: string): void => {
    if (seen.has(oid)) return;
    const object = repo.objects.get(oid);
    if (!object) return;
    seen.add(oid);
    objects.push(object);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        walkTree(entry.oid);
      }
    }
  };
  const walkCommit = (oid: string, remaining: number): void => {
    if (seen.has(oid)) return;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') return;
    seen.add(oid);
    objects.push(object);
    const view = parseCommit(object.data);
    walkTree(view.tree);
    const wasBoundary = clientBoundaries.has(oid);
    if (remaining <= 1 || (wasBoundary && view.parents.length === 0)) {
      if (remaining <= 1 && view.parents.length > 0) shallow.push(oid);
      return;
    }
    if (wasBoundary && view.parents.length > 0) unshallow.push(oid);
    for (const parent of view.parents) walkCommit(parent, remaining - 1);
  };
  for (const tip of tips) walkCommit(tip, depth);
  return { objects, shallow };
}

function handleUploadPackV2(store: Store, ctx: Ctx, body: Buffer): Reply {
  const repo = store.getRepo(ctx.owner, ctx.repo);
  if (!repo) return { status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Not Found' }) };
  const { packets, rest } = decodePktLines(body, true);
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  let command = '';
  for (const line of lines) {
    if (line.startsWith('command=')) command = line.slice('command='.length);
    if (line === 'flush') break;
  }
  if (command === 'ls-refs') return lsRefsV2(repo);
  if (command === 'fetch') return fetchV2(store, ctx, lines);
  // Unknown command: an empty response after the command section.
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: PKT_FLUSH };
}

function lsRefsV2(repo: NonNullable<ReturnType<Store['getRepo']>>): Reply {
  const parts: Buffer[] = [];
  const headOid = resolveRef(repo, 'HEAD');
  if (headOid) parts.push(encodePktLine(`${headOid} HEAD symref-target:refs/heads/${repo.default_branch}\n`));
  else parts.push(encodePktLine(`unborn refs/heads/${repo.default_branch} symref-target:refs/heads/${repo.default_branch}\n`));
  for (const [name, oid] of repo.refs) {
    if (name.startsWith('refs/heads/')) parts.push(encodePktLine(`${oid} ${name}\n`));
  }
  for (const [name, oid] of repo.refs) {
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'tag') {
        const match = object.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
        if (match) parts.push(encodePktLine(`${oid} ${name} peeled:${match[1]}\n`));
        else parts.push(encodePktLine(`${oid} ${name}\n`));
      } else {
        parts.push(encodePktLine(`${oid} ${name}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function fetchV2(store: Store, ctx: Ctx, lines: readonly string[]): Reply {
  const repo = store.getRepo(ctx.owner, ctx.repo);
  if (!repo) return { status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Not Found' }) };
  let depth: number | null = null;
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let inCommand = true;
  for (const line of lines) {
    if (line === '' || line === 'delim' || line === 'flush') { if (line === 'flush') break; continue; }
    if (line.startsWith('command=') || line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    if (line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta' || line.startsWith('filter ') || line === 'done') continue;
    if (line === 'deepen-since' || line.startsWith('deepen-not ')) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'deepen') { depth = Math.max(1, parseInt(value, 10)); continue; }
    if (key === 'want') { if (isObjectId(value)) wants.push(value); continue; }
    if (key === 'have') { if (isObjectId(value)) haves.push(value); continue; }
    if (key === 'shallow') { if (isObjectId(value)) clientShallow.push(value); continue; }
    if (key === 'deepen-not') continue;
    void inCommand;
  }
  const packable = wants.filter((want) => repo.objects.has(want));
  const sections: Buffer[] = [];
  // acknowledgments: NAK when the client sent haves or nothing useful to send.
  const haveSet = new Set(haves);
  const clientHasAll = packable.length === 0 || haves.length > 0;
  if (haves.length > 0 || packable.length === 0) {
    sections.push(encodePktLine('acknowledgments\n'));
    if (haves.some((have) => repo.objects.has(have))) sections.push(encodePktLine('NAK\n'));
    else sections.push(encodePktLine('NAK\n'));
    sections.push(PKT_FLUSH);
  }
  let packObjects: GitObject[] = [];
  if (packable.length > 0) {
    if (depth !== null) {
      const unshallow: string[] = [];
      const result = shallowObjects(store, ctx, packable, depth, clientShallow, unshallow);
      packObjects = result.objects;
      const shallowLines = result.shallow.filter((oid) => !clientShallow.includes(oid));
      const unshallowLines = unshallow;
      if (shallowLines.length || unshallowLines.length) {
        sections.push(encodePktLine('shallow-info\n'));
        for (const oid of shallowLines) sections.push(encodePktLine(`shallow ${oid}\n`));
        for (const oid of unshallowLines) sections.push(encodePktLine(`unshallow ${oid}\n`));
        sections.push(PKT_FLUSH);
      }
    } else {
      const exclude = new Set<string>();
      if (haveSet.size > 0) {
        // Mark every object reachable from haves as already held.
        for (const have of haves) {
          if (!repo.objects.has(have)) continue;
          markReachable(repo, have, exclude);
        }
      }
      packObjects = reachableAll(store, ctx, packable, exclude);
    }
    if (packObjects.length === 0) {
      // Nothing new: acknowledgments only.
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(sections) };
    }
  } else {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(sections) };
  }
  sections.push(encodePktLine('packfile\n'));
  const pack = writePack(dedupeObjects(packObjects));
  sections.push(sideband(pack));
  sections.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(sections) };
}

function dedupeObjects(objects: readonly GitObject[]): GitObject[] {
  const seen = new Set<string>();
  const out: GitObject[] = [];
  for (const object of objects) {
    const oid = hashObject(object.type, object.data);
    if (seen.has(oid)) continue;
    seen.add(oid);
    out.push(object);
  }
  return out;
}

function markReachable(repo: NonNullable<ReturnType<Store['getRepo']>>, tip: string, exclude: Set<string>): void {
  const queue: string[] = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (exclude.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    exclude.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      queue.push(view.tree, ...view.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
}

function handleUploadPackV0(store: Store, ctx: Ctx, body: Buffer): Reply {
  const repo = store.getRepo(ctx.owner, ctx.repo);
  if (!repo) return { status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Not Found' }) };
  const { packets } = decodePktLines(body, true);
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  let section = 0; // 0 = wants, 1 = negotiation
  for (const line of lines) {
    if (line === '') continue;
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5).split(' ');
        if (isObjectId(rest[0])) wants.push(rest[0]);
        continue;
      }
      if (line.startsWith('shallow ')) { const v = line.slice(8); if (isObjectId(v)) clientShallow.push(v); continue; }
      if (line.startsWith('deepen ')) { depth = Math.max(1, parseInt(line.slice(7), 10)); continue; }
      if (line.startsWith('deepen-since') || line.startsWith('deepen-not ') || line.startsWith('filter ')) continue;
      if (line === 'flush') { section = 1; continue; }
    } else {
      if (line.startsWith('have ')) { const v = line.slice(5); if (isObjectId(v)) haves.push(v); continue; }
      if (line === 'done') { break; }
      if (line === 'flush') break;
    }
  }
  const packable = wants.filter((want) => repo.objects.has(want));
  const out: Buffer[] = [];
  if (depth !== null) {
    const unshallow: string[] = [];
    const result = shallowObjects(store, ctx, packable, depth, clientShallow, unshallow);
    const shallowLines = result.shallow.filter((oid) => !clientShallow.includes(oid));
    for (const oid of shallowLines) out.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) out.push(encodePktLine(`unshallow ${oid}\n`));
    if (packable.length > 0) {
      out.push(encodePktLine('NAK\n'));
      const pack = writePack(dedupeObjects(result.objects));
      out.push(sideband(pack));
    }
  } else if (packable.length === 0) {
    out.push(encodePktLine('NAK\n'));
  } else {
    const exclude = new Set<string>();
    for (const have of haves) if (repo.objects.has(have)) markReachable(repo, have, exclude);
    const objects = reachableAll(store, ctx, packable, exclude);
    out.push(encodePktLine('NAK\n'));
    if (objects.length > 0) out.push(sideband(writePack(dedupeObjects(objects))));
  }
  out.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(out) };
}

// ---------------------------------------------------------------- receive-pack

function handleReceivePack(store: Store, ctx: Ctx, body: Buffer): Reply {
  const repo = store.getRepo(ctx.owner, ctx.repo);
  if (!repo) return { status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Not Found' }) };
  const { packets, rest } = decodePktLines(body, true);
  interface Command { oldOid: string; newOid: string; ref: string }
  const commands: Command[] = [];
  let commandSection = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') { if (packet.kind === 'flush') commandSection = false; continue; }
    if (!commandSection) continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length >= 3 && isObjectId(parts[0]) && isObjectId(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
  }
  const packBytes = rest;
  let unpackOk = true;
  if (commands.some((command) => command.newOid !== ZERO_OID)) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (hashObject(object.type, object.data) !== oid) throw new Error('object hash mismatch');
        repo.objects.set(oid, object);
      }
    } catch {
      unpackOk = false;
    }
  }
  const report: string[] = [unpackOk ? 'unpack ok\n' : 'unpack index-pack failed\n'];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // delete
        if (current === undefined || current !== command.oldOid) {
          report.push(`ng ${command.ref} non-fast-forward\n`);
          continue;
        }
        repo.refs.delete(command.ref);
        report.push(`ok ${command.ref}\n`);
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        if (current !== undefined) {
          report.push(`ng ${command.ref} non-fast-forward\n`);
          continue;
        }
        if (!repo.objects.has(command.newOid)) {
          report.push(`ng ${command.ref} missing necessary objects\n`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        report.push(`ok ${command.ref}\n`);
        continue;
      }
      if (current !== command.oldOid || !repo.objects.has(command.newOid)) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}\n`);
    }
  }
  // Build the sideband-framed report-status response.
  const reportBody = Buffer.concat(report.map((line) => encodePktLine(line)));
  const response = Buffer.concat([sideband(reportBody), PKT_FLUSH]);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: response };
}

// ---------------------------------------------------------------- router entry

export function handleGitRequest(store: Store, ctx: Ctx, method: string, suffix: string, search: URLSearchParams, gitProtocol: string | null, body: Buffer): Reply {
  const service = search.get('service');
  if (method === 'GET' && suffix === '/info/refs') {
    if (service === 'git-upload-pack') {
      if (store.getRepo(ctx.owner, ctx.repo) === undefined) {
        return { status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Not Found' }) };
      }
      if (gitProtocol === 'version=2') return v2CapabilityAdvertisement();
      return v0RefAdvertisement(store, ctx, 'git-upload-pack');
    }
    if (service === 'git-receive-pack') return v0RefAdvertisement(store, ctx, 'git-receive-pack');
    return { status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Not Found' }) };
  }
  if (method === 'POST' && suffix === '/git-upload-pack') {
    if (gitProtocol === 'version=2') return handleUploadPackV2(store, ctx, body);
    return handleUploadPackV0(store, ctx, body);
  }
  if (method === 'POST' && suffix === '/git-receive-pack') return handleReceivePack(store, ctx, body);
  return { status: 404, contentType: 'application/json', body: JSON.stringify({ message: 'Not Found' }) };
}
