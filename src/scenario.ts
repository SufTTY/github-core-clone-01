// Demo scenario data: deterministic identities plus RNG, rebuilt from the contest's fixed seed so
// the server's token owner always matches the owner the checks address (/repos/{owner}/{repo}).

export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
export const U64_MASK = 0xffffffffffffffffn;
export const SCENARIO_USERS = 12;

const FIRST_POOL: readonly string[] = Object.freeze([
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
]);
const LAST_POOL: readonly string[] = Object.freeze([
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
]);

const OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const GOLDEN_ADDEND = 0x9e3779b97f4a7c15n;

/** FNV-1a (64-bit), folded one UTF-16 code unit at a time. */
export function fnv1a64(text: string): bigint {
  return text.split('').reduce<bigint>(
    (hash, unit) => ((hash ^ BigInt(unit.charCodeAt(0))) * FNV_PRIME) & U64_MASK,
    OFFSET_BASIS,
  );
}

/** splitmix64's finalizer: full avalanche of one 64-bit word. */
export function mix64(value: bigint): bigint {
  let mixed = (value + GOLDEN_ADDEND) & U64_MASK;
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
    let word = this.state;
    word = (word ^ (word >> 12n)) & U64_MASK;
    word = (word ^ (word << 25n)) & U64_MASK;
    word = (word ^ (word >> 27n)) & U64_MASK;
    this.state = word;
    return (word * 0x2545f4914f6cdd1dn) & U64_MASK;
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
    let draw = this.nextU32();
    while (draw >= cutoff) draw = this.nextU32();
    return draw % maxExclusive;
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

/** `count` users with unique logins, deterministic for `rng` — wire.ts's generator, verbatim. */
export function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const taken = new Set<string>();
  const claim = (stem: string): string => {
    let login = stem;
    let tag = 2;
    while (taken.has(login)) {
      login = `${stem}-${tag}`;
      tag += 1;
    }
    return login;
  };
  const total = Math.max(0, Math.trunc(count));
  return Array.from({ length: total }, (_, i) => {
    const given = rng.pick(FIRST_POOL);
    const family = rng.pick(LAST_POOL);
    const stem = `${given}${family}`.replace(/[^a-z0-9-]/g, '');
    const login = claim(stem);
    taken.add(login);
    return Object.freeze({ id: 1000 + i, login, name: `${given} ${family}`, email: `${login}@example.invalid` });
  });
}

const roster = generateUsers(scenarioRng('users'), SCENARIO_USERS);
export const VIEWER = roster[0] as ScenarioUser;
export const TEAMMATE = roster[1] as ScenarioUser;
export const STRANGER = roster[2] as ScenarioUser;
