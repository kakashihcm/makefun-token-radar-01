// Token Radar's scoring model, radar-2.
//
// One sealed snapshot goes in — protocols with TVL, a 7-day change, an optional token and an
// optional listing date — and one ranked board comes out: every watchlist protocol plus every
// rankable pre-token protocol below the watchlist floor, ordered by an implied value that is
// read off the market itself instead of a single flat multiple.
//
// A protocol counts as pre-token when the snapshot records no token for it at all: no market
// cap, no CoinGecko id and no symbol. Live-token protocols never enter the ranking; the board
// shows their market caps as facts. Exchanges are set aside too, and so are version-numbered
// pools — a name ending in a release marker is a pool of another protocol, not a protocol.
//
// The implied value has three ingredients:
//
//   benchmark — what the market pays per dollar of TVL for this protocol's category. It is
//     the median mcap/TVL of the live-token protocols in the category, pulled toward the
//     global median when the category has few live protocols, and clamped to [0.05, 1.50].
//     A category with no live protocol at all uses the global median.
//   growth    — the 7-day change, clamped to [-60, 120] percent, weighted by one half.
//   maturity  — 0.6 plus up to 0.4 for age, reaching the full weight at 1095 days; an
//     unknown listing date counts as 365 days.
//
//   implied = max(1, round(tvl * benchmark * (1 + growth/100 * 0.5) * maturity))
//
// The shrinkage is what keeps one loud category from setting its own price: Risk Curators
// has a single live token near 2.98x TVL, but its benchmark lands near 0.74x once the
// global median pulls on it.

/** One protocol as the sealed snapshot carries it: ten fields, nothing more. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  chains: string[];
  category: string | null;
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  symbol: string | null;
  gecko_id: string | null;
  listed_at: string | null;
}

/** The whole snapshot document the sealed input holds. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  watchlist: string[];
  protocols: SnapshotProtocol[];
}

/** The model's tunables, as the dashboard prints them and the sandbox may override them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  /** Live protocols counted toward the global median before a category sets its benchmark. */
  benchmark_shrink: number;
  /** The benchmark's floor and cap, in market cap per dollar of TVL. */
  benchmark_floor: number;
  benchmark_cap: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  benchmark_shrink: 4,
  benchmark_floor: 0.05,
  benchmark_cap: 1.5,
};

/** The version the dashboard names and the rules quote. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the Live token view carries, largest market cap first. */
export const LIVE_ROWS = 24;

/** One category's benchmark: the live market's mcap/TVL for that kind of business. */
export interface CategoryBenchmark {
  category: string;
  /** Live-token protocols in the category that carry a market cap. */
  live_count: number;
  /** Their median mcap/TVL, or null when the category has no live protocol. */
  median_mcap_per_tvl: number | null;
  /** The benchmark the model uses for this category, after shrinkage and clamping. */
  benchmark: number;
}

/** One farm step: what to do, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: a ranked board row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    benchmark: number;
    benchmark_live_count: number;
    benchmark_median: number | null;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A board row in the dashboard's compact form; the page derives the farm plan itself. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  benchmark: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  watchlist: boolean;
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, the benchmarks, the model. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  global_median_mcap_per_tvl: number;
  benchmarks: CategoryBenchmark[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Thrown when the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const MS_PER_DAY = 86_400_000;

/** Round to four decimals, the precision every benchmark and multiplier is printed at. */
function to4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** A finite number, or `fallback` when the value is missing or not a number at all. */
function asFinite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, never below zero; null when either date is unusable. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  const listedMs = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(listedMs)) return null;
  return Math.max(0, Math.floor((asOfMs - listedMs) / MS_PER_DAY));
}

/** The median of an array that is already sorted ascending and non-empty. */
function medianSorted(ascending: number[]): number {
  const middle = Math.floor(ascending.length / 2);
  if (ascending.length % 2 === 1) return ascending[middle]!;
  return (ascending[middle - 1]! + ascending[middle]!) / 2;
}

/** Clamp `n` into [`lo`, `hi`]. */
function clampTo(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether the board may rank a protocol: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSION_SUFFIX.test(p.name);
}

/**
 * The market's own mcap/TVL benchmarks, one per category, read off the snapshot's live-token
 * protocols (exchanges excluded: an exchange's token is not a protocol's token). The global
 * median is the fallback for a category with no live protocol, and the shrinkage weight pulls
 * thin categories toward it before the clamp.
 */
export function categoryBenchmarks(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
): { global: number; byCategory: Map<string, CategoryBenchmark> } {
  const live = snapshot.protocols.filter(
    (p) => !isPreToken(p) && p.category !== 'CEX' && p.mcap_usd !== null && p.tvl_usd > 0,
  );
  const allRatios = live.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
  const global = allRatios.length > 0 ? medianSorted(allRatios) : 0.25;

  const ratiosByCategory = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? 'Other';
    const bucket = ratiosByCategory.get(key);
    if (bucket !== undefined) bucket.push(p.mcap_usd! / p.tvl_usd);
    else ratiosByCategory.set(key, [p.mcap_usd! / p.tvl_usd]);
  }

  const byCategory = new Map<string, CategoryBenchmark>();
  for (const [category, ratios] of ratiosByCategory) {
    const sorted = [...ratios].sort((a, b) => a - b);
    const med = medianSorted(sorted);
    const pulled = (sorted.length * med + model.benchmark_shrink * global) / (sorted.length + model.benchmark_shrink);
    byCategory.set(category, {
      category,
      live_count: sorted.length,
      median_mcap_per_tvl: to4(med),
      benchmark: to4(clampTo(pulled, model.benchmark_floor, model.benchmark_cap)),
    });
  }
  return { global, byCategory };
}

/** The benchmark one protocol's category carries, or the global median when it has none. */
export function benchmarkFor(
  category: string | null,
  bench: { global: number; byCategory: Map<string, CategoryBenchmark> },
  model: ModelConstants = MODEL,
): CategoryBenchmark {
  const key = category ?? 'Other';
  const hit = bench.byCategory.get(key);
  if (hit !== undefined) return hit;
  return {
    category: key,
    live_count: 0,
    median_mcap_per_tvl: null,
    benchmark: to4(clampTo(bench.global, model.benchmark_floor, model.benchmark_cap)),
  };
}

/** The implied value one protocol gets under `model`, with its three ingredients spelled out. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  bench: { global: number; byCategory: Map<string, CategoryBenchmark> },
  model: ModelConstants = MODEL,
): {
  implied: number;
  benchmark: CategoryBenchmark;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  age: number | null;
} {
  const age = ageDays(asOf, protocol.listed_at);
  const growthPct = clampTo(asFinite(protocol.change_7d, 0), model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const cappedAge = Math.min(Math.max(ageForModel, 0), model.maturity_days);
  const maturityMult = model.maturity_floor + (cappedAge / model.maturity_days) * model.maturity_range;
  const benchmark = benchmarkFor(protocol.category, bench, model);
  const base = protocol.tvl_usd * benchmark.benchmark;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult));
  return { implied, benchmark, growthPct, growthMult, maturityMult, age };
}

/** Index the snapshot's protocols by slug for the watchlist lookup. */
function indexBySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  const index = new Map<string, SnapshotProtocol>();
  for (const p of protocols) index.set(p.slug, p);
  return index;
}

/** Slug order for ties: the earlier slug wins, so equal scores always rank the same way. */
function bySlugAsc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The protocols the board ranks, strongest implied value first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const bench = categoryBenchmarks(snapshot, model);
  const index = indexBySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug on it is in, even one the snapshot no longer
  // carries (it cannot, but the board's coverage is the gate's row and is never gambled on a
  // missing record).
  for (const slug of snapshot.watchlist) {
    const found = index.get(slug);
    if (found !== undefined) chosen.set(slug, found);
  }
  // The early radar: every rankable pre-token protocol below the watchlist floor, richest
  // first. No cap — the floor is where the house's reading started, not where this radar
  // stops — and never a replacement for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || bySlugAsc(a.slug, b.slug));
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const scoredOne = impliedValue(p, snapshot.as_of, bench, model);
    return { p, ...scoredOne };
  });
  scored.sort((a, b) => b.implied - a.implied || bySlugAsc(a.p.slug, b.p.slug));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      benchmark: s.benchmark.benchmark,
      benchmark_live_count: s.benchmark.live_count,
      benchmark_median: s.benchmark.median_mcap_per_tvl,
      growth_pct: s.growthPct,
      growth_multiplier: to4(s.growthMult),
      maturity_multiplier: to4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let joined = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (joined.length > 600) joined = `${joined.slice(0, 596)}...`;
  if (joined.length < 20) joined = `${joined} Hold the position and check the protocol's own page.`;
  return joined;
}

/** The first chain a protocol names, or a neutral phrase when it names none. */
function firstChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** One category rule: the keywords that pick it, and the action it writes. */
interface CategoryAction {
  keys: string[];
  write: (name: string, capital: number, chain: string) => string;
}

/** The category's one action, in the words a farmer can follow. First matching rule wins. */
const ACTION_RULES: CategoryAction[] = [
  {
    keys: ['lend', 'cdp', 'collateral'],
    write: (name, capital, chain) => `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`,
  },
  {
    keys: ['dex', 'yield', 'leveraged farm'],
    write: (name, capital, chain) => `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`,
  },
  {
    keys: ['bridge'],
    write: (name, capital, chain) => `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`,
  },
  {
    keys: ['staking', 'restak'],
    write: (name, capital) => `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`,
  },
  {
    keys: ['perpetual', 'derivative'],
    write: (name, capital) => `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`,
  },
  {
    keys: ['prediction'],
    write: (name, capital) => `Fund $${capital} and place one market position on ${name}.`,
  },
  {
    keys: ['curator', 'allocator'],
    write: (name, capital, chain) => `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`,
  },
  {
    keys: ['stable'],
    write: (name, capital, chain) => `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`,
  },
  {
    keys: ['rwa'],
    write: (name, capital, chain) => `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`,
  },
  {
    keys: ['insurance'],
    write: (name, capital, chain) => `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`,
  },
];

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const category = (p.category ?? '').toLowerCase();
  for (const rule of ACTION_RULES) {
    if (rule.keys.some((key) => category.includes(key))) return rule.write(p.name, capital, chain);
  }
  return `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
}

/** One category rule: the keywords that pick it, and the weekly action it writes. */
interface WeeklyAction {
  keys: string[];
  text: string;
}

/** The weekly qualifying action, by what the protocol does: repeat use, not one deposit. */
const WEEKLY_RULES: WeeklyAction[] = [
  {
    keys: ['lend', 'cdp', 'collateral'],
    text: 'Borrow a small amount against your supply once, then repay it, so the wallet shows both sides of the market.',
  },
  {
    keys: ['dex', 'yield', 'leveraged farm'],
    text: 'Swap a small amount through the pool once a week so the wallet shows repeated use, not one deposit.',
  },
  {
    keys: ['bridge'],
    text: 'Bridge a small amount back or to a second chain once a week so the wallet shows repeated use.',
  },
  {
    keys: ['staking', 'restak'],
    text: 'Claim or compound the staking rewards once a week so the wallet shows repeated use.',
  },
  {
    keys: ['perpetual', 'derivative'],
    text: 'Open and close one small position a week so the wallet shows repeated use.',
  },
  {
    keys: ['prediction'],
    text: 'Place one small market position a week so the wallet shows repeated use.',
  },
  {
    keys: ['curator', 'allocator'],
    text: 'Check the vault allocation once a week and rebalance only if the vault itself asks for it.',
  },
  {
    keys: ['stable'],
    text: 'Mint or redeem a small amount once a week so the wallet shows repeated use.',
  },
  {
    keys: ['rwa'],
    text: 'Check the yield accrual once a week and keep the receipt token in the same wallet.',
  },
  {
    keys: ['insurance'],
    text: 'Check the cover status once a week and renew it before it lapses.',
  },
];

/** The weekly qualifying action, by what the protocol does: repeat use, not one deposit. */
function weeklyActionFor(p: SnapshotProtocol): string {
  const category = (p.category ?? '').toLowerCase();
  for (const rule of WEEKLY_RULES) {
    if (rule.keys.some((key) => category.includes(key))) return rule.text;
  }
  return 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.';
}

/** One farm step, assembled from its three parts. */
function makeStep(text: string, cost: string, time: string): FarmStep {
  return { text, cost, time };
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is
 * derived from the protocol's own record (category, chains, TVL, age), never from a
 * hand-written list of names. The third step is the weekly action for the protocol's own
 * category, so the plan says what to do every week, not just once.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = firstChain(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  return [
    makeStep(
      `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      'under $3 of gas for the first transaction',
      '5 minutes',
    ),
    makeStep(
      actionFor(p, capital, chain),
      `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      '15 minutes to set up',
    ),
    makeStep(weeklyActionFor(p), 'about $2 of gas a week', '10 minutes a week'),
    makeStep(
      `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      `the $${capital} stays in the position`,
      `${hold} days`,
    ),
    makeStep(
      `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      'no fee to check, and never pay to claim',
      '10 minutes',
    ),
    makeStep(
      `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      'nothing but the log',
      '5 minutes',
    ),
    makeStep(
      `If ${p.name} issues a token, claim from its own app only, and keep half the position for one more month in case later snapshots count it.`,
      'the gas of one claim',
      '10 minutes to claim',
    ),
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  const live = snapshot.protocols.filter((p) => !isPreToken(p) && p.category !== 'CEX');
  live.sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd);
  return live.slice(0, LIVE_ROWS).map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd,
    change_7d: p.change_7d,
  }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow, watchlist: Set<string>): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    benchmark: row.model.benchmark,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    watchlist: watchlist.has(row.slug),
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const bench = categoryBenchmarks(snapshot, model);
  const watchlistSet = new Set(snapshot.watchlist);
  const benchmarks = [...bench.byCategory.values()].sort(
    (a, b) => b.live_count - a.live_count || bySlugAsc(a.category, b.category),
  );
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    global_median_mcap_per_tvl: to4(bench.global),
    benchmarks,
    rows: board.map((r) => radarRow(r, watchlistSet)),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    }
    const p = v as Record<string, unknown>;
    const hasIdentity =
      typeof p.slug === 'string' && typeof p.name === 'string' && typeof p.tvl_usd === 'number' && Number.isFinite(p.tvl_usd);
    if (!hasIdentity) throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    const change = typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null;
    const mcap = typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null;
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: change,
      mcap_usd: mcap,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
