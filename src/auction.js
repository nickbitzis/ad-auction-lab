// Programmatic ad auction simulator for one synthetic day. No DOM code.
// One config drives five pieces:
//   1. Supply: page views over 24 hours with a daily traffic shape. Each has a
//      user (from a pool where a few heavy users see many pages), the user's
//      segment, a page context, a quality factor, and a floor price.
//   2. Demand: made-up advertisers with budgets, a CPA or ROAS goal, a value
//      per conversion, and a bidding strategy: fixed bid, value-based (bid the
//      goal value of the predicted conversion), bid shading for first price
//      (a shading factor learned from "minimum bid to win" feedback), and a
//      budget-constrained optimal bidder (value times a multiplier set by a
//      pacing controller).
//   3. Auctions: second price with a reserve, first price, and generalized
//      second price over three ad slots with position click-through effects.
//   4. Pacing and frequency: no pacing, even pacing (a PI throttle on the
//      share of auctions entered against a target spend curve), or bid
//      multiplier pacing; plus a per-user, per-advertiser daily frequency cap.
//      Repeat exposures to the same user lose click-through (ad fatigue).
//   5. Metrics: per advertiser impressions, clicks, conversions, spend, CPM,
//      CPA, ROAS, budget use, budget exhaustion time, reach, and wasted
//      impressions; publisher revenue, advertiser surplus, and welfare.
// Clicks and conversions are expected counts: the sum over won impressions of
// the true click and conversion probabilities. Money is in dollars; bids and
// prices are dollars per impression inside the engine and CPM in the UI.

// ---------------------------------------------------------------------------
// Randomness

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Independent but reproducible seed for stream `i` of base seed `seed`. */
export function subSeed(seed, i) {
  let h = (Math.imul(seed >>> 0, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/** A uniform in [0, 1) fixed by (seed, a, b), so every run sees the same draw for the same auction and bidder. */
export function hashU(seed, a, b) {
  let h = (Math.imul(seed >>> 0, 0x9e3779b1) ^ Math.imul(a + 1, 0x85ebca77) ^ Math.imul(b + 7, 0xc2b2ae3d)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function normal(r) {
  const u = Math.max(1e-12, r()), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Lognormal factor with mean 1. */
const lnMean1 = (r, s) => Math.exp(s * normal(r) - (s * s) / 2);

// ---------------------------------------------------------------------------
// Domain constants

export const SEGMENTS = ["Commuters", "Parents", "Gamers", "Travel planners", "Home cooks"];
const SEG_SHARE = [0.22, 0.2, 0.18, 0.18, 0.22];
export const CONTEXTS = [
  { label: "News", floorCpm: 1.2 },
  { label: "Sports", floorCpm: 1.5 },
  { label: "Recipes", floorCpm: 0.8 },
  { label: "Video", floorCpm: 2.5 },
  { label: "Travel guides", floorCpm: 2.0 },
];
/** Where each segment spends most of its time: Commuters read news, parents watch video, and so on. */
const SEG_HOME = [0, 3, 3, 4, 2];
const HOME_SHARE = 0.45;

export const SEG_MATCH = 1.8, SEG_MISS = 0.85, CTX_MATCH = 1.3;
/** Click-through falls by this factor for each earlier exposure of the same ad to the same user today. */
export const FATIGUE = 0.7;
/** Exposures after this many are counted as wasted (fatigue has cut click-through by more than half). */
export const WASTE_AFTER = 3;
/** GSP position effects: slot 2 gets 60% of slot 1's clicks, slot 3 gets 35%. */
export const SLOT_CTR = [1, 0.6, 0.35];
export const INTERVAL_MIN = 15;
export const INTERVALS = 1440 / INTERVAL_MIN; // 96
/** Below this share of budget left, an advertiser is out for the day. */
export const EXHAUSTED = 0.01;

export const STRATEGIES = {
  fixed: { label: "Fixed bid", note: "Bids the same CPM on every impression, whatever the user or page." },
  value: { label: "Value-based", note: "Bids the goal value of the predicted conversion: target CPA, or value over target ROAS, times predicted conversion rate." },
  shade: { label: "Bid shading", note: "Value-based, but in first price it bids a learned share of value, from the exchange's minimum-bid-to-win feedback. In second price it bids value." },
  optimal: { label: "Budget-optimal", note: "Value times a multiplier at or below 1, set by a pacing controller so the budget lasts the day. Always paced this way." },
};

export const FORMATS = {
  sp: { label: "Second price", note: "The highest bid at or over the floor wins and pays the larger of the second bid and the floor." },
  fp: { label: "First price", note: "The highest bid at or over the floor wins and pays its own bid." },
  gsp: { label: "GSP, 3 slots", note: "Three ad slots per page. Bidders are ranked by bid; slot k pays its click share times the next bid down (or the floor)." },
};

export const PACINGS = {
  none: { label: "None", note: "Spend as fast as the auctions allow until the budget runs out." },
  throttle: { label: "Even (throttle)", note: "A PI controller sets the share of auctions each advertiser enters, so spend tracks a target curve shaped like the day's traffic." },
  multiplier: { label: "Bid multiplier", note: "A PI controller scales each bid by a multiplier at or below 1, so spend tracks the target curve." },
};

// ---------------------------------------------------------------------------
// Traffic

/** Relative traffic at hour h: quiet at 04:00, a morning commute bump, lunch, and an evening peak. */
export function traffic(h) {
  const g = (mu, sd) => Math.exp(-0.5 * ((h - mu) / sd) ** 2) + Math.exp(-0.5 * ((h - mu - 24) / sd) ** 2) + Math.exp(-0.5 * ((h - mu + 24) / sd) ** 2);
  return 0.12 + 0.55 * g(8.5, 1.6) + 0.45 * g(12.75, 1.4) + 1.0 * g(20.5, 2.3);
}

/** Cumulative share of the day's traffic at each minute, length 1441, from 0 to 1. */
export const TRAFFIC_CUM = (() => {
  const c = new Float64Array(1441);
  for (let m = 0; m < 1440; m++) c[m + 1] = c[m] + traffic((m + 0.5) / 60);
  for (let m = 0; m <= 1440; m++) c[m] /= c[1440];
  return c;
})();

/** The pacing target: share of budget that should be spent by the end of each 15 minute interval (length 97). */
export const TARGET_CURVE = Array.from({ length: INTERVALS + 1 }, (_, k) => TRAFFIC_CUM[k * INTERVAL_MIN]);

// ---------------------------------------------------------------------------
// Presets: made-up advertisers

const adv = (name, o) => ({ name, goal: "cpa", target: 20, value: 40, strategy: "value", fixedCpm: 6, budget: 50, ctr: 0.8, cvr: 5, seg: 0, ctx: 0, ...o });

export const PRESETS = {
  brands: {
    label: "Big brands, tight CPA goals",
    note: "Four large advertisers with tight CPA and ROAS goals and budgets that cannot buy the whole day. Second price, bid multiplier pacing, a cap of 6 ads per user per day.",
    format: "sp", pacing: "multiplier", cap: 6,
    advertisers: [
      adv("Larkspur Travel", { goal: "roas", target: 4, value: 180, budget: 90, ctr: 0.7, cvr: 3, seg: 3, ctx: 4 }),
      adv("Cobalt Mobile", { goal: "cpa", target: 30, value: 60, strategy: "optimal", budget: 70, ctr: 0.9, cvr: 5, seg: 0, ctx: 0 }),
      adv("Fennel Kitchen", { goal: "cpa", target: 18, value: 40, strategy: "optimal", budget: 60, ctr: 1.0, cvr: 6, seg: 4, ctx: 2 }),
      adv("Pixel Forge Games", { goal: "cpa", target: 12, value: 25, budget: 60, ctr: 1.4, cvr: 7, seg: 2, ctx: 3 }),
    ],
  },
  small: {
    label: "Many small advertisers",
    note: "Twelve small advertisers with $8 to $35 a day. Half bid a fixed CPM, half bid value. Second price, no pacing, no frequency cap.",
    format: "sp", pacing: "none", cap: 0,
    advertisers: [
      adv("Halvard Shoes", { strategy: "fixed", fixedCpm: 7, budget: 25, target: 22, value: 45, seg: 0, ctx: 1 }),
      adv("Brightpath Insurance", { target: 35, value: 70, budget: 35, ctr: 0.5, cvr: 4, seg: 1, ctx: 0 }),
      adv("Juniper Kids", { strategy: "fixed", fixedCpm: 5, budget: 15, target: 15, value: 30, seg: 1, ctx: 3 }),
      adv("Quillfeather Books", { target: 10, value: 22, budget: 12, ctr: 1.1, cvr: 6, seg: 4, ctx: 0 }),
      adv("Ember Coffee", { strategy: "fixed", fixedCpm: 4, budget: 10, target: 8, value: 18, seg: 0, ctx: 0 }),
      adv("Marigold Pets", { target: 16, value: 35, budget: 20, ctr: 0.9, cvr: 5, seg: 1, ctx: 2 }),
      adv("Stonebridge Auto", { strategy: "fixed", fixedCpm: 9, budget: 30, target: 60, value: 120, ctr: 0.4, cvr: 3, seg: 0, ctx: 1 }),
      adv("Saltmarsh Outdoors", { target: 20, value: 45, budget: 18, ctr: 0.8, cvr: 4, seg: 3, ctx: 4 }),
      adv("Tidewell Fitness", { strategy: "fixed", fixedCpm: 6, budget: 14, target: 14, value: 30, seg: 2, ctx: 1 }),
      adv("Cinder Gameworks", { target: 9, value: 20, budget: 16, ctr: 1.5, cvr: 6, seg: 2, ctx: 3 }),
      adv("Orchard Grocers", { strategy: "fixed", fixedCpm: 3.5, budget: 8, target: 7, value: 15, seg: 4, ctx: 2 }),
      adv("Lantern Hostels", { target: 12, value: 28, budget: 15, ctr: 0.9, cvr: 4, seg: 3, ctx: 4 }),
    ],
  },
  fp: {
    label: "First-price exchange with shading",
    note: "Six advertisers on a first-price exchange. Three shade their bids from win and loss feedback, two bid full value, one bids a fixed CPM. Even pacing, a cap of 8.",
    format: "fp", pacing: "throttle", cap: 8,
    advertisers: [
      adv("Larkspur Travel", { goal: "roas", target: 4, value: 180, strategy: "shade", budget: 90, ctr: 0.7, cvr: 3, seg: 3, ctx: 4 }),
      adv("Cobalt Mobile", { goal: "cpa", target: 30, value: 60, strategy: "shade", budget: 80, ctr: 0.9, cvr: 5, seg: 0, ctx: 0 }),
      adv("Fennel Kitchen", { goal: "cpa", target: 18, value: 40, strategy: "value", budget: 60, ctr: 1.0, cvr: 6, seg: 4, ctx: 2 }),
      adv("Pixel Forge Games", { goal: "cpa", target: 12, value: 25, strategy: "shade", budget: 70, ctr: 1.4, cvr: 7, seg: 2, ctx: 3 }),
      adv("Brightpath Insurance", { goal: "cpa", target: 35, value: 70, strategy: "value", budget: 50, ctr: 0.5, cvr: 4, seg: 1, ctx: 0 }),
      adv("Halvard Shoes", { strategy: "fixed", fixedCpm: 8, budget: 40, target: 22, value: 45, seg: 0, ctx: 1 }),
    ],
  },
};

// ---------------------------------------------------------------------------
// Config

const BASE = { format: "sp", pacing: "multiplier", cap: 0, reserve: 100, noise: 30, traffic: 50, seed: 7, focus: 0 };
const LIMITS = { cap: [0, 50], reserve: [0, 500], noise: [0, 100], traffic: [5, 150], seed: [0, 1e9] };
/** Editable advertiser fields and their limits. */
export const ADV_FIELDS = { budget: [1, 100000], target: [0.1, 1000], value: [0.5, 5000], fixedCpm: [0.1, 200] };
const ADV_FIXED = { ctr: [0.01, 20], cvr: [0.01, 100], seg: [0, SEGMENTS.length - 1], ctx: [0, CONTEXTS.length - 1] };

export function presetValues(id) {
  const key = PRESETS[id] ? id : "brands";
  const p = PRESETS[key];
  return { preset: key, ...BASE, format: p.format, pacing: p.pacing, cap: p.cap, advertisers: p.advertisers.map((a) => ({ ...a })) };
}

export const DEFAULTS = presetValues("brands");

const round2 = (v) => Math.round(v * 100) / 100;

export function clampAdv(a, base) {
  const out = { ...base, ...a };
  out.name = String(out.name ?? base.name).slice(0, 40);
  if (!STRATEGIES[out.strategy]) out.strategy = base.strategy;
  if (out.goal !== "cpa" && out.goal !== "roas") out.goal = base.goal;
  for (const [k, [lo, hi]] of Object.entries({ ...ADV_FIELDS, ...ADV_FIXED })) {
    let v = Number(out[k]);
    if (!Number.isFinite(v)) v = base[k];
    v = Math.min(hi, Math.max(lo, v));
    out[k] = k === "seg" || k === "ctx" ? Math.round(v) : round2(v);
  }
  return out;
}

export function clamp(cfg) {
  const preset = PRESETS[cfg?.preset] ? cfg.preset : DEFAULTS.preset;
  const base = presetValues(preset);
  const c = { ...base, ...cfg, preset };
  if (!FORMATS[c.format]) c.format = base.format;
  if (!PACINGS[c.pacing]) c.pacing = base.pacing;
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    let v = Number(c[k]);
    if (!Number.isFinite(v)) v = base[k];
    c[k] = Math.round(Math.min(hi, Math.max(lo, v)));
  }
  const given = Array.isArray(c.advertisers) ? c.advertisers : [];
  c.advertisers = base.advertisers.map((b, i) => clampAdv(given[i] ?? {}, b));
  let f = Math.round(Number(c.focus));
  if (!Number.isFinite(f)) f = 0;
  c.focus = Math.min(c.advertisers.length - 1, Math.max(0, f));
  return c;
}

export const makeConfig = (over = {}) => clamp(over);

/** Only the preset and values that differ from it go in the URL, so links stay short. */
export function encodeConfig(cfg) {
  const base = presetValues(cfg.preset);
  const p = new URLSearchParams();
  p.set("preset", cfg.preset);
  for (const k of Object.keys(base)) {
    if (k === "preset" || k === "advertisers") continue;
    if (cfg[k] !== base[k]) p.set(k, String(cfg[k]));
  }
  cfg.advertisers.forEach((a, i) => {
    for (const k of ["strategy", "goal", ...Object.keys(ADV_FIELDS)]) if (a[k] !== base.advertisers[i][k]) p.set(`a${i}.${k}`, String(a[k]));
  });
  return p.toString();
}

export function decodeConfig(hash) {
  const p = new URLSearchParams(String(hash ?? "").replace(/^#/, ""));
  const preset = PRESETS[p.get("preset")] ? p.get("preset") : DEFAULTS.preset;
  const base = presetValues(preset);
  const over = { preset };
  for (const k of Object.keys(base)) if (k !== "preset" && k !== "advertisers" && p.has(k)) over[k] = p.get(k);
  over.advertisers = base.advertisers.map((a, i) => {
    const o = { ...a };
    for (const k of ["strategy", "goal", ...Object.keys(ADV_FIELDS)]) if (p.has(`a${i}.${k}`)) o[k] = p.get(`a${i}.${k}`);
    return o;
  });
  return makeConfig(over);
}

// ---------------------------------------------------------------------------
// Supply

/**
 * The day's page views, sorted by time, and the bidders' prediction noise.
 * Depends on the seed, traffic, reserve, noise, and number of advertisers, not on format or pacing,
 * so every format and pacing mode is compared on the same impressions.
 */
export function generateWorld(cfgIn) {
  const cfg = clamp(cfgIn);
  const A = cfg.advertisers.length;
  const N = cfg.traffic * 1000;
  const U = Math.max(50, Math.round(N / 5));
  const r = mulberry32(subSeed(cfg.seed, 1));

  // Users: visit weights fall off like a power law, so a few heavy users see hundreds of pages.
  const userSeg = new Uint8Array(U), userCum = new Float64Array(U);
  let acc = 0;
  for (let u = 0; u < U; u++) {
    acc += (u + 1) ** -0.8;
    userCum[u] = acc;
    let x = r(), s = 0;
    while (s < SEGMENTS.length - 1 && x >= SEG_SHARE[s]) { x -= SEG_SHARE[s]; s++; }
    userSeg[u] = s;
  }
  const pickUser = (x) => {
    const target = x * acc;
    let lo = 0, hi = U - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (userCum[mid] < target) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const pickMinute = (x) => {
    let lo = 0, hi = 1439;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (TRAFFIC_CUM[mid + 1] < x) lo = mid + 1; else hi = mid; }
    return lo;
  };

  const times = new Float64Array(N);
  for (let j = 0; j < N; j++) times[j] = pickMinute(r()) + r();
  times.sort();
  const user = new Uint32Array(N), seg = new Uint8Array(N), ctx = new Uint8Array(N), q = new Float32Array(N), floor = new Float32Array(N);
  for (let j = 0; j < N; j++) {
    const u = pickUser(r());
    user[j] = u;
    seg[j] = userSeg[u];
    ctx[j] = r() < HOME_SHARE ? SEG_HOME[userSeg[u]] : Math.floor(r() * CONTEXTS.length);
    q[j] = lnMean1(r, 0.4);
    floor[j] = (CONTEXTS[ctx[j]].floorCpm * (0.8 + 0.4 * r()) * cfg.reserve) / 100 / 1000;
  }
  const rn = mulberry32(subSeed(cfg.seed, 2)), s = cfg.noise / 100;
  const noise = new Float32Array(N * A);
  for (let k = 0; k < N * A; k++) noise[k] = s > 0 ? lnMean1(rn, s) : 1;
  return { N, U, A, seed: cfg.seed, times, user, seg, ctx, q, floor, noise };
}

// ---------------------------------------------------------------------------
// Auction mechanics (pure, used by the simulator and the tests)

/**
 * Clear one auction. `bids` is indexed by bidder, in dollars per impression for the top slot;
 * NaN, missing, or below the floor means no bid. Ties go to the lower index.
 * Returns the ranked eligible bidders and the winners with their slot and price.
 */
export function runAuction(bids, floor, format, slots = SLOT_CTR.length) {
  const ranked = [];
  for (let i = 0; i < bids.length; i++) if (bids[i] >= floor) ranked.push(i);
  ranked.sort((x, y) => bids[y] - bids[x] || x - y);
  const K = format === "gsp" ? Math.min(slots, SLOT_CTR.length) : 1;
  const winners = [];
  for (let k = 0; k < Math.min(K, ranked.length); k++) {
    const i = ranked[k], b = bids[i];
    const next = k + 1 < ranked.length ? bids[ranked[k + 1]] : floor;
    const alpha = format === "gsp" ? SLOT_CTR[k] : 1;
    const price = format === "fp" ? b : alpha * Math.max(next, floor);
    winners.push({ i, slot: k, alpha, price });
  }
  return { ranked, winners };
}

/**
 * Best shading factor from past "minimum bid to win" over own value ratios:
 * the s in [0.3, 1] that maximizes (1 - s) x P(ratio <= s), the expected surplus share.
 */
export function optimalShade(ratios, lo = 0.3) {
  const n = ratios.length;
  if (!n) return 1;
  const sorted = Float64Array.from(ratios).sort();
  let best = 1, bestU = 0, idx = 0;
  for (let s100 = Math.round(lo * 100); s100 <= 100; s100++) {
    const s = s100 / 100;
    while (idx < n && sorted[idx] <= s + 1e-12) idx++;
    const u = (1 - s) * (idx / n);
    if (u > bestU + 1e-12) { bestU = u; best = s; }
  }
  return best;
}

export const PACE = {
  throttle: { kp: 6, ki: 1.2, lo: 0.02, hi: 1 },
  multiplier: { kp: 8, ki: 1.6, lo: Math.log(0.05), hi: 0 },
};

/**
 * One step of the velocity-form PI pacing controller. `e` is the spend error as a share of budget
 * (target share minus spent share; positive means behind). For the throttle, x is the share of
 * auctions entered; for the multiplier, x is the log of the bid multiplier. Clamping x is the anti-windup.
 */
export function paceStep(x, e, ePrev, mode) {
  const g = PACE[mode];
  return Math.min(g.hi, Math.max(g.lo, x + g.kp * (e - ePrev) + g.ki * e));
}

export const goalValue = (a) => (a.goal === "roas" ? a.value / a.target : a.target);

// ---------------------------------------------------------------------------
// The day

const SHADE_WINDOW = 400, SHADE_EVERY = 50, SHADE_START = 0.85;
export const PRICE_BIN = 1, PRICE_BINS = 30; // $1 CPM bins, last one is 29+

/**
 * Run one day. `advs` are clamped advertiser rows. Options: format, pacing, cap, trace (keep every bid
 * for the inspector), and probe ({ i, factor }): advertiser i bids factor x its true value per
 * impression with no budget limit or pacing, for the truthfulness test.
 */
export function runSim(world, advs, opts = {}) {
  const { N, U, A, times, user, seg, ctx, q, floor, noise, seed } = world;
  if (advs.length !== A) throw new Error("world was generated for a different number of advertisers");
  const format = opts.format ?? "sp", pacing = opts.pacing ?? "none", cap = opts.cap ?? 0, probe = opts.probe ?? null;
  const K = format === "gsp" ? SLOT_CTR.length : 1;

  const budget = advs.map((a, i) => (probe && probe.i === i ? Infinity : a.budget));
  const mode = advs.map((a, i) => (probe && probe.i === i ? "none" : a.strategy === "optimal" || pacing === "multiplier" ? "multiplier" : pacing === "throttle" ? "throttle" : "none"));
  const gv = advs.map((a, i) => (probe && probe.i === i ? a.value : goalValue(a)));
  const ctrB = advs.map((a) => a.ctr / 100), cvr = advs.map((a) => a.cvr / 100);

  const spent = new Float64Array(A), x = new Float64Array(A), ePrev = new Float64Array(A);
  for (let i = 0; i < A; i++) x[i] = mode[i] === "throttle" ? 1 : 0;
  const shade = new Float64Array(A).fill(SHADE_START), ring = new Float64Array(A * SHADE_WINDOW), ringN = new Uint32Array(A);
  const seen = new Uint16Array(U * A);
  const out = advs.map(() => ({ imps: 0, clicks: 0, conv: 0, value: 0, spend: 0, reach: 0, wasted: 0, entered: 0, wins: 0, capped: 0, throttled: 0, exhaustT: -1, bidSum: 0 }));
  const spendAt = advs.map(() => new Float64Array(INTERVALS + 1));
  const ctlAt = advs.map(() => new Float64Array(INTERVALS + 1));
  const enteredH = new Float64Array(A * 24), winsH = new Float64Array(A * 24);
  const hist = new Float64Array(A * PRICE_BINS);
  let revenue = 0, filled = 0, adImps = 0, probeSurplus = 0, probeSpend = 0, probeImps = 0;
  const T = opts.trace ? {
    bids: new Float32Array(N * A).fill(NaN), vals: new Float32Array(N * A), status: new Int8Array(N * A),
    win: new Int16Array(N * K).fill(-1), price: new Float32Array(N * K), ctl: new Float32Array(N * A),
  } : null;

  const ctlValue = (i) => (mode[i] === "multiplier" ? Math.exp(x[i]) : mode[i] === "throttle" ? x[i] : 1);
  for (let i = 0; i < A; i++) ctlAt[i][0] = ctlValue(i);

  const endInterval = (k) => {
    const target = TARGET_CURVE[k + 1];
    for (let i = 0; i < A; i++) {
      spendAt[i][k + 1] = spent[i];
      if (mode[i] !== "none" && out[i].exhaustT < 0) {
        const e = target - spent[i] / budget[i];
        x[i] = paceStep(x[i], e, ePrev[i], mode[i]);
        ePrev[i] = e;
      }
      ctlAt[i][k + 1] = ctlValue(i);
    }
  };

  const took = new Uint8Array(A), bids = new Float64Array(A), vals = new Float64Array(A), pconv = new Float64Array(A), base = new Float64Array(A);
  let k = 0;
  for (let j = 0; j < N; j++) {
    const t = times[j];
    while (t >= (k + 1) * INTERVAL_MIN && k < INTERVALS - 1) endInterval(k++);
    const u = user[j], sg = seg[j], cx = ctx[j], fl = floor[j], h = Math.floor(t / 60);

    for (let i = 0; i < A; i++) {
      const a = advs[i];
      const b0ctr = ctrB[i] * (a.seg === sg ? SEG_MATCH : SEG_MISS) * (a.ctx === cx ? CTX_MATCH : 1) * q[j];
      base[i] = b0ctr;
      pconv[i] = b0ctr * noise[j * A + i] * cvr[i];
      vals[i] = gv[i] * pconv[i];
      bids[i] = NaN;
      let st = 0;
      const remaining = budget[i] - spent[i];
      if (out[i].exhaustT >= 0) st = 4;
      else if (cap > 0 && seen[u * A + i] >= cap) { st = 3; out[i].capped++; }
      else if (mode[i] === "throttle" && hashU(seed, j, i) >= x[i]) { st = 2; out[i].throttled++; }
      else {
        let b;
        if (probe && probe.i === i) b = probe.factor * vals[i];
        else {
          b = a.strategy === "fixed" ? a.fixedCpm / 1000 : vals[i];
          if (a.strategy === "shade" && format === "fp") b *= shade[i];
          if (mode[i] === "multiplier") b *= Math.exp(x[i]);
        }
        b = Math.min(b, remaining);
        if (b < fl) st = 1;
        else { bids[i] = b; out[i].entered++; out[i].bidSum += b; enteredH[i * 24 + h]++; }
        if (T) T.bids[j * A + i] = b;
      }
      took[i] = st <= 1 ? 1 : 0;
      if (T) { T.status[j * A + i] = st; T.vals[j * A + i] = vals[i]; T.ctl[j * A + i] = ctlValue(i); }
    }

    const { ranked, winners } = runAuction(bids, fl, format);
    if (winners.length) filled++;
    for (const w of winners) {
      const i = w.i, o = out[i], a = advs[i];
      const s = seen[u * A + i];
      const ctrTrue = base[i] * w.alpha * FATIGUE ** s;
      o.imps++; o.wins++; adImps++;
      o.clicks += ctrTrue;
      o.conv += ctrTrue * cvr[i];
      o.value += ctrTrue * cvr[i] * a.value;
      o.spend += w.price;
      spent[i] += w.price;
      revenue += w.price;
      if (s === 0) o.reach++;
      if (s >= WASTE_AFTER) o.wasted++;
      if (s < 65535) seen[u * A + i] = s + 1;
      winsH[i * 24 + h]++;
      hist[i * PRICE_BINS + Math.min(PRICE_BINS - 1, Math.floor((w.price * 1000) / PRICE_BIN))]++;
      if (probe && probe.i === i) { probeSurplus += pconv[i] * w.alpha * a.value - w.price; probeSpend += w.price; probeImps++; }
      if (T) { T.win[j * K + w.slot] = i; T.price[j * K + w.slot] = w.price; }
      if (o.exhaustT < 0 && spent[i] >= (1 - EXHAUSTED) * budget[i]) o.exhaustT = t;
    }

    // Bid shading feedback: in first price the exchange tells each bidder the lowest bid that would have won.
    if (format === "fp" && ranked.length) {
      const top = bids[ranked[0]], second = ranked.length > 1 ? bids[ranked[1]] : fl;
      for (let i = 0; i < A; i++) {
        if (advs[i].strategy !== "shade" || (probe && probe.i === i) || !(vals[i] > 0)) continue;
        if (!took[i]) continue; // only bidders that took part (bid, or were under the floor) get feedback
        const minWin = ranked[0] === i ? Math.max(second, fl) : Math.max(top, fl);
        ring[i * SHADE_WINDOW + (ringN[i] % SHADE_WINDOW)] = minWin / vals[i];
        ringN[i]++;
        if (ringN[i] % SHADE_EVERY === 0) {
          const n = Math.min(ringN[i], SHADE_WINDOW);
          shade[i] = optimalShade(ring.subarray(i * SHADE_WINDOW, i * SHADE_WINDOW + n));
        }
      }
    }
  }
  while (k < INTERVALS) endInterval(k++);

  let welfare = 0, conv = 0, clicks = 0, spendTotal = 0;
  const rows = advs.map((a, i) => {
    const o = out[i];
    welfare += o.value; conv += o.conv; clicks += o.clicks; spendTotal += o.spend;
    return {
      name: a.name, strategy: a.strategy, mode: mode[i], budget: budget[i],
      imps: o.imps, clicks: o.clicks, conv: o.conv, value: o.value, spend: o.spend,
      cpm: o.imps ? (o.spend / o.imps) * 1000 : NaN,
      cpa: o.conv > 0 ? o.spend / o.conv : NaN,
      roas: o.spend > 0 ? o.value / o.spend : NaN,
      util: Number.isFinite(budget[i]) ? o.spend / budget[i] : NaN,
      exhaustT: o.exhaustT, reach: o.reach, freq: o.reach ? o.imps / o.reach : NaN, wasted: o.wasted,
      entered: o.entered, wins: o.wins, winRate: o.entered ? o.wins / o.entered : NaN,
      avgBidCpm: o.entered ? (o.bidSum / o.entered) * 1000 : NaN,
      capped: o.capped, throttled: o.throttled, surplus: o.value - o.spend,
      shade: a.strategy === "shade" && format === "fp" ? shade[i] : NaN,
      ctl: ctlValue(i),
    };
  });

  return {
    format, pacing, cap, N, A, K,
    revenue, welfare, surplus: welfare - revenue, conv, clicks, spend: spendTotal,
    filled, fill: filled / N, adImps, cpm: adImps ? (revenue / adImps) * 1000 : NaN,
    rows, spendAt, ctlAt, enteredH, winsH, hist,
    probe: probe ? { ...probe, surplus: probeSurplus, spend: probeSpend, imps: probeImps } : null,
    trace: T,
  };
}

// ---------------------------------------------------------------------------
// Entry points

/** The configured day with full detail. */
export function simulate(cfgIn, { trace = false, world = null, format, pacing } = {}) {
  const cfg = clamp(cfgIn);
  const w = world ?? generateWorld(cfg);
  return runSim(w, cfg.advertisers, { format: format ?? cfg.format, pacing: pacing ?? cfg.pacing, cap: cfg.cap, trace });
}

/** A result without the large arrays, for tables and messages. */
export function slim(r) {
  const { spendAt, ctlAt, enteredH, winsH, hist, trace, ...rest } = r;
  return rest;
}

export const FORMAT_IDS = Object.keys(FORMATS);
export const PACING_IDS = Object.keys(PACINGS);
export const PROBE_FACTORS = [0.3, 0.5, 0.7, 0.85, 1, 1.15, 1.3, 1.6];

/** Same impressions and advertisers under each auction format. */
export function compareFormats(cfgIn, world = null) {
  const cfg = clamp(cfgIn);
  const w = world ?? generateWorld(cfg);
  return FORMAT_IDS.map((f) => ({ id: f, label: FORMATS[f].label, ...slim(runSim(w, cfg.advertisers, { format: f, pacing: cfg.pacing, cap: cfg.cap })) }));
}

/** Same impressions and advertisers under each pacing mode, in the configured format. */
export function comparePacing(cfgIn, world = null) {
  const cfg = clamp(cfgIn);
  const w = world ?? generateWorld(cfg);
  return PACING_IDS.map((p) => ({ id: p, label: PACINGS[p].label, ...slim(runSim(w, cfg.advertisers, { format: cfg.format, pacing: p, cap: cfg.cap })) }));
}

/**
 * Best-response check for one bidder against fixed competition. `others[j]` is the highest competing
 * bid in auction j, `floors[j]` the floor, `values[j]` the bidder's value. For each factor, the bidder
 * bids factor x value; it wins when that reaches the larger of the competing bid and the floor.
 * Returns its surplus, spend, and wins under second-price and first-price payment.
 */
export function bestResponse(values, others, floors, factors = PROBE_FACTORS) {
  return factors.map((f) => {
    const r = { factor: f, sp: { surplus: 0, spend: 0, wins: 0 }, fp: { surplus: 0, spend: 0, wins: 0 } };
    for (let j = 0; j < values.length; j++) {
      const v = values[j], bid = f * v, need = Math.max(others[j], floors[j]);
      if (!(v > 0) || bid < need) continue;
      r.sp.surplus += v - need; r.sp.spend += need; r.sp.wins++;
      r.fp.surplus += v - bid; r.fp.spend += bid; r.fp.wins++;
    }
    return r;
  });
}

/** The highest competing bid against bidder p in every auction of a traced run, its value, and the floors. */
export function competition(world, run, p) {
  const { N, A, floor } = world, T = run.trace;
  const values = new Float64Array(N), others = new Float64Array(N);
  for (let j = 0; j < N; j++) {
    let m = 0;
    for (let i = 0; i < A; i++) if (i !== p && T.bids[j * A + i] > m) m = T.bids[j * A + i];
    others[j] = m;
    values[j] = T.vals[j * A + p];
  }
  return { values, others, floors: floor };
}

/**
 * Truthfulness check: the focus advertiser has no budget limit and values each impression at its value
 * per conversion times its predicted conversion rate. Everyone else bids as they did in a day where the
 * focus advertiser bid its value. It then tries bidding below and above value: expected surplus (own
 * predicted value minus price) per factor, with second-price payment and first-price payment, each
 * against the competition recorded in that format.
 */
export function truthfulness(cfgIn, world = null, factors = PROBE_FACTORS) {
  const cfg = clamp(cfgIn);
  const w = world ?? generateWorld(cfg);
  const comp = (format) => {
    const run = runSim(w, cfg.advertisers, { format, pacing: cfg.pacing, cap: cfg.cap, probe: { i: cfg.focus, factor: 1 }, trace: true });
    const c = competition(w, run, cfg.focus);
    return bestResponse(c.values, c.others, c.floors, factors);
  };
  const sp = comp("sp"), fp = comp("fp");
  return factors.map((f, k) => ({ factor: f, sp: sp[k].sp, fp: fp[k].fp }));
}

/** Everything the page shows apart from the main run. */
export function compareAll(cfgIn, world = null) {
  const cfg = clamp(cfgIn);
  const w = world ?? generateWorld(cfg);
  return { formats: compareFormats(cfg, w), pacing: comparePacing(cfg, w), truth: truthfulness(cfg, w) };
}

// ---------------------------------------------------------------------------
// Formatting

export const fmtInt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "n/a");
export const fmtMoney = (n, d = 0) => (Number.isFinite(n) ? `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}` : "n/a");
export const fmtCpm = (perImp) => (Number.isFinite(perImp) ? `$${(perImp * 1000).toFixed(2)}` : "n/a");
export const pct = (x, d = 0) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : "n/a");
export const fmt1 = (n) => (Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : "n/a");
export function fmtTime(t) {
  if (!Number.isFinite(t) || t < 0) return "never";
  const m = Math.min(1439, Math.floor(t));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
