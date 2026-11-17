// Scenario fixture: deterministic identities rebuilt from one fixed seed, so a fresh server
// always hands out the same token owner the checks address (/repos/{owner}/{repo}).

export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
export const U64_MASK = 0xffffffffffffffffn;
export const SCENARIO_USERS = 12;

// Name pools; both stay frozen so the fixture cannot mutate itself at runtime.
const GIVEN_NAMES: readonly string[] = Object.freeze([
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
]);
const FAMILY_NAMES: readonly string[] = Object.freeze([
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
]);

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_STEP = 0x100000001b3n;
const SPLITMIX_GOLDEN = 0x9e3779b97f4a7c15n;

/** FNV-1a (64-bit), folded one UTF-16 code unit at a time. */
export function fnv1a64(text: string): bigint {
  let hash = FNV_OFFSET;
  for (let at = 0; at < text.length; at += 1) {
    hash = ((hash ^ BigInt(text.charCodeAt(at))) * FNV_STEP) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer: full avalanche of one 64-bit word. */
export function mix64(value: bigint): bigint {
  let mixed = (value + SPLITMIX_GOLDEN) & U64_MASK;
  mixed = ((mixed ^ (mixed >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  mixed = ((mixed ^ (mixed >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (mixed ^ (mixed >> 31n)) & U64_MASK;
}

export function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

export interface ScenarioUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** xorshift64*: a 64-bit state walked by three shifts and one multiply. */
export class Rng {
  state: bigint;

  constructor(seed: bigint) {
    const clamped = seed & U64_MASK;
    this.state = clamped === 0n ? SCENARIO_SEED : clamped;
  }

  nextU64(): bigint {
    let block = this.state;
    block = (block ^ (block >> 12n)) & U64_MASK;
    block = (block ^ (block << 25n)) & U64_MASK;
    block = (block ^ (block >> 27n)) & U64_MASK;
    this.state = block;
    return (block * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An integer in [0, maxExclusive), kept unbiased by rejection sampling. */
  nextInt(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`nextInt needs a positive safe integer, not ${String(maxExclusive)}`);
    }
    if (maxExclusive === 1) return 0;
    const span = 4_294_967_296;
    const cutoff = span - (span % maxExclusive);
    const draw = this.nextU32();
    // Success returns at once; a rejected draw retries the whole step instead of looping.
    if (draw < cutoff) return draw % maxExclusive;
    return this.nextInt(maxExclusive);
  }

  fraction(): number {
    return this.nextU32() / 4_294_967_296;
  }

  chance(probability: number): boolean {
    return this.fraction() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from an empty list');
    return items[this.nextInt(items.length)] as T;
  }
}

export function scenarioRng(label: string): Rng {
  return new Rng(scenarioSeedFor(label));
}

/** The stem itself when free, otherwise the first `stem-<tag>` nobody has claimed yet. */
function reserveLogin(taken: Set<string>, stem: string): string {
  if (!taken.has(stem)) return stem;
  for (let tag = 2; ; tag += 1) {
    const candidate = `${stem}-${tag}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** `count` users with unique logins, deterministic for `rng` — wire.ts's generator, verbatim. */
export function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const taken = new Set<string>();
  const total = Math.max(0, Math.trunc(count));
  const users: ScenarioUser[] = [];
  let index = 0;
  while (index < total) {
    const given = rng.pick(GIVEN_NAMES);
    const family = rng.pick(FAMILY_NAMES);
    const stem = `${given}${family}`.replace(/[^a-z0-9-]/g, '');
    const login = reserveLogin(taken, stem);
    taken.add(login);
    users.push(Object.freeze({ id: 1000 + index, login, name: `${given} ${family}`, email: `${login}@example.invalid` }));
    index += 1;
  }
  return users;
}

const fixedRoster = generateUsers(scenarioRng('users'), SCENARIO_USERS);
export const VIEWER = fixedRoster[0] as ScenarioUser;
export const TEAMMATE = fixedRoster[1] as ScenarioUser;
export const STRANGER = fixedRoster[2] as ScenarioUser;
