// Fresh take on git plumbing for the forge: object hashing, loose object
// codecs, pkt-line framing, and packfile read/write with delta resolution.
// Node 22 built-ins only, no dependencies.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject { type: ObjectType; data: Buffer }

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export const ZERO_OID = '0'.repeat(40);
const OID_RE = /^[0-9a-f]{40}$/;
export function isObjectId(value: string): boolean { return OID_RE.test(value); }

export function hashObject(type: ObjectType, data: Uint8Array): string {
  const body = Buffer.from(data);
  const sha = createHash('sha1');
  sha.update(Buffer.from(`${type} ${body.length}\u0000`, 'utf8'));
  sha.update(body);
  return sha.digest('hex');
}

// ------------------------------------------------------------- pkt-line

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const head = Buffer.allocUnsafe(4);
  head.write((body.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, body]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' };

export function decodePktLines(bytes: Uint8Array, allowTrailing = false): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  const buf = Buffer.from(bytes);
  let pos = 0;
  while (buf.length - pos >= 4) {
    const head = buf.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      if (allowTrailing) break;
      return { packets, rest: buf.subarray(pos) };
    }
    const total = parseInt(head, 16);
    if (total === 0) { packets.push({ kind: 'flush' }); pos += 4; continue; }
    if (total <= 2) { packets.push({ kind: 'delim' }); pos += 4; continue; }
    if (buf.length - pos < total) {
      if (allowTrailing) break;
      return { packets, rest: buf.subarray(pos) };
    }
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + total) });
    pos += total;
  }
  return { packets, rest: buf.subarray(pos) };
}

export function dataLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

// ------------------------------------------------------- tree and commit

export interface TreeEntry { mode: string; name: string; oid: string }

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buf = Buffer.from(data);
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const sp = buf.indexOf(0x20, pos);
    const nul = buf.indexOf(0x00, sp + 1);
    entries.push({
      mode: buf.subarray(pos, sp).toString('ascii'),
      name: buf.subarray(sp + 1, nul).toString('utf8'),
      oid: buf.subarray(nul + 1, nul + 21).toString('hex'),
    });
    pos = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): Buffer {
  return Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const ordered = [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  const chunks: Buffer[] = [];
  for (const entry of ordered) {
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    chunks.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

export interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string }

export function parseCommit(data: Uint8Array): CommitView {
  const buf = Buffer.from(data);
  const split = buf.indexOf('\n\n');
  const headText = buf.subarray(0, split < 0 ? buf.length : split).toString('utf8');
  const view: CommitView = {
    tree: '', parents: [], author: '', committer: '',
    message: split < 0 ? '' : buf.subarray(split + 2).toString('utf8'),
  };
  for (const line of headText.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
  }
  return view;
}

export function buildCommit(fields: { tree: string; parents?: readonly string[]; message: string; timestamp?: number }): Buffer {
  const stamp = fields.timestamp ?? 1700000000;
  const who = `Forge <forge@localhost> ${stamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

// ---------------------------------------------------------------- deltas

export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const src = Buffer.from(base);
  const ins = Buffer.from(delta);
  let pos = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = ins[pos++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) return value;
    }
  };
  readSize();
  const target = readSize();
  const out = Buffer.allocUnsafe(target);
  let filled = 0;
  while (pos < ins.length) {
    const op = ins[pos++];
    if (op & 0x80) {
      let from = 0;
      let size = 0;
      for (let bit = 0, scale = 0; bit < 4; bit += 1, scale += 8) {
        if (op & (1 << bit)) from += ins[pos++] * 2 ** scale;
      }
      for (let bit = 4, scale = 0; bit < 7; bit += 1, scale += 8) {
        if (op & (1 << bit)) size += ins[pos++] * 2 ** scale;
      }
      if (size === 0) size = 0x10000;
      src.copy(out, filled, from, from + size);
      filled += size;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      ins.copy(out, filled, pos, pos + literal);
      pos += literal;
      filled += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  return out;
}

// --------------------------------------------------------------- pack read

interface PackSlot {
  at: number;
  code: number;
  size: number;
  raw: Buffer;
  baseAt?: number;
  baseOid?: string;
  done?: { type: ObjectType; data: Buffer; oid: string };
}

function readEntryHeader(buffer: Buffer, start: number): { size: number; next: number; kind: number } {
  let byte = buffer[start];
  const kind = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let pos = start + 1;
  while (byte & 0x80) {
    byte = buffer[pos++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: pos, kind };
}

function readOfsDistance(buffer: Buffer, start: number): { distance: number; next: number } {
  let byte = buffer[start];
  let pos = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[pos++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { distance: value, next: pos };
}

function inflateAt(buffer: Buffer, start: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(start), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: start + result.engine.bytesWritten };
}

/** Read a packfile, resolving OFS_DELTA / REF_DELTA against the pack and an optional external store. */
export function readPack(pack: Uint8Array, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  const buffer = Buffer.from(pack);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declared = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const slots: PackSlot[] = [];
  const byOffset = new Map<number, PackSlot>();
  let pos = 12;
  for (let index = 0; index < declared; index += 1) {
    const at = pos;
    const head = readEntryHeader(buffer, pos);
    pos = head.next;
    const code = (head.kind >> 4) & 0x07;
    const slot: PackSlot = { at, code, size: head.size, raw: Buffer.alloc(0) };
    if (code === 6) {
      const base = readOfsDistance(buffer, pos);
      pos = base.next;
      slot.baseAt = at - base.distance;
    } else if (code === 7) {
      slot.baseOid = buffer.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else if (!CODE_TYPE[code]) {
      throw new Error(`pack entry ${index} has unknown type code ${code}`);
    }
    const blown = inflateAt(buffer.subarray(0, trailerStart), pos);
    slot.raw = blown.data;
    pos = blown.next;
    slots.push(slot);
    byOffset.set(at, slot);
  }
  const objects = new Map<string, GitObject>();
  const byOid = new Map<string, PackSlot>();
  const busy = new Set<number>();
  const materialize = (slot: PackSlot): { type: ObjectType; data: Buffer; oid: string } => {
    if (slot.done) return slot.done;
    if (busy.has(slot.at)) throw new Error('delta cycle');
    busy.add(slot.at);
    let type: ObjectType;
    let data: Buffer;
    if (slot.code === 6) {
      const baseSlot = byOffset.get(slot.baseAt!);
      if (!baseSlot) throw new Error('ofs-delta base not in pack');
      const base = materialize(baseSlot);
      type = base.type;
      data = applyDelta(base.data, slot.raw);
    } else if (slot.code === 7) {
      const baseSlot = byOid.get(slot.baseOid!);
      if (baseSlot) {
        const base = materialize(baseSlot);
        type = base.type;
        data = applyDelta(base.data, slot.raw);
      } else {
        const external = resolveBase?.(slot.baseOid!);
        if (!external) throw new Error(`ref-delta base ${slot.baseOid} missing`);
        type = external.type;
        data = applyDelta(external.data, slot.raw);
      }
    } else {
      type = CODE_TYPE[slot.code];
      data = slot.raw;
    }
    const oid = hashObject(type, data);
    slot.done = { type, data, oid };
    byOid.set(oid, slot);
    busy.delete(slot.at);
    return slot.done;
  };
  for (const slot of slots) {
    const got = materialize(slot);
    if (!objects.has(got.oid)) objects.set(got.oid, { type: got.type, data: got.data });
  }
  return objects;
}

// -------------------------------------------------------------- pack write

function entryHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let rest = size;
  let first = (code << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  const chunks: Buffer[] = [head];
  for (const obj of list) {
    chunks.push(entryHeader(obj.type, obj.data.length), deflateSync(obj.data));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
