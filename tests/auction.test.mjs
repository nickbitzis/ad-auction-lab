import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULTS, EXHAUSTED, FATIGUE, INTERVALS, PACE, PRESETS, PROBE_FACTORS, SLOT_CTR, TARGET_CURVE, TRAFFIC_CUM, WASTE_AFTER,
  bestResponse, clamp, compareAll, compareFormats, comparePacing, competition, decodeConfig, encodeConfig, fmtTime, generateWorld,
  goalValue, hashU, makeConfig, mulberry32, optimalShade, paceStep, presetValues, runAuction, runSim, simulate, slim, traffic, truthfulness,
} from "../src/auction.js";

const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);
const small = (preset, over = {}) => makeConfig({ ...presetValues(preset), traffic: 10, ...over });
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

// A tiny hand-built world: every page view the same, so bids are easy to reason about.
function flatWorld(N, A, { floorCpm = 1, users = N, seed = 1 } = {}) {
  return {
    N, U: users, A, seed,
    times: Float64Array.from({ length: N }, (_, j) => ((j + 0.5) * 1440) / N),
    user: Uint32Array.from({ length: N }, (_, j) => j % users),
    seg: new Uint8Array(N), ctx: new Uint8Array(N), q: new Float32Array(N).fill(1),
    floor: new Float32Array(N).fill(floorCpm / 1000), noise: new Float32Array(N * A).fill(1),
  };
}
const flatAdv = (o) => ({ name: "x", goal: "cpa", target: 20, value: 40, strategy: "value", fixedCpm: 5, budget: 1e6, ctr: 1, cvr: 5, seg: 0, ctx: 0, ...o });

// --- Randomness, traffic, config -------------------------------------------

test("mulberry32 and hashU are deterministic and in [0, 1)", () => {
  const a = mulberry32(3), b = mulberry32(3), c = mulberry32(4);
  const xs = Array.from({ length: 8 }, a);
  assert.deepEqual(xs, Array.from({ length: 8 }, b));
  assert.notDeepEqual(xs, Array.from({ length: 8 }, c));
  for (const x of xs) assert.ok(x >= 0 && x < 1);
  assert.equal(hashU(7, 10, 2), hashU(7, 10, 2));
  assert.notEqual(hashU(7, 10, 2), hashU(7, 10, 3));
  const us = Array.from({ length: 20000 }, (_, j) => hashU(9, j, 1));
  close(sum(us) / us.length, 0.5, 0.01);
});

test("traffic is quiet at night and peaks in the evening; target curve runs 0 to 1", () => {
  assert.ok(traffic(4) < traffic(8.5) && traffic(8.5) < traffic(20.5));
  assert.ok(traffic(13) > traffic(16));
  assert.equal(TRAFFIC_CUM[0], 0);
  close(TRAFFIC_CUM[1440], 1, 1e-12);
  assert.equal(TARGET_CURVE.length, INTERVALS + 1);
  for (let k = 1; k < TARGET_CURVE.length; k++) assert.ok(TARGET_CURVE[k] > TARGET_CURVE[k - 1]);
  assert.ok(TARGET_CURVE[24] < 0.15, "less than 15% of the day's traffic by 06:00");
});

test("the world is reproducible from the seed and follows the traffic shape", () => {
  const a = generateWorld(small("brands")), b = generateWorld(small("brands")), c = generateWorld(small("brands", { seed: 8 }));
  assert.deepEqual(a.times, b.times);
  assert.deepEqual(a.noise, b.noise);
  assert.notDeepEqual(a.times, c.times);
  assert.equal(a.N, 10000);
  for (let j = 1; j < a.N; j++) assert.ok(a.times[j] >= a.times[j - 1]);
  const night = a.times.filter((t) => t >= 180 && t < 300).length, evening = a.times.filter((t) => t >= 1170 && t < 1290).length;
  assert.ok(evening > 4 * night, `${evening} evening vs ${night} night`);
});

test("a few heavy users see many pages", () => {
  const w = generateWorld(small("brands"));
  const counts = new Map();
  for (const u of w.user) counts.set(u, (counts.get(u) ?? 0) + 1);
  const sorted = [...counts.values()].sort((x, y) => y - x);
  const top = sum(sorted.slice(0, Math.ceil(w.U * 0.05)));
  assert.ok(top / w.N > 0.25, `top 5% of users see ${top / w.N} of pages`);
});

test("floors scale with the reserve setting", () => {
  const a = generateWorld(small("brands")), b = generateWorld(small("brands", { reserve: 200 }));
  for (let j = 0; j < 50; j++) close(b.floor[j], 2 * a.floor[j], 1e-9);
});

test("config clamps bad values and round trips through the URL hash", () => {
  const c = clamp({ preset: "nope", cap: -5, traffic: 1e9, format: "dutch", advertisers: [{ budget: -1, strategy: "magic" }] });
  assert.equal(c.preset, "brands");
  assert.equal(c.cap, 0);
  assert.equal(c.traffic, 150);
  assert.equal(c.format, DEFAULTS.format);
  assert.equal(c.advertisers[0].budget, 1);
  assert.equal(c.advertisers[0].strategy, PRESETS.brands.advertisers[0].strategy);
  const cfg = makeConfig({ ...presetValues("small"), cap: 4, format: "gsp", seed: 11, focus: 3 });
  cfg.advertisers[2] = { ...cfg.advertisers[2], budget: 99, strategy: "optimal" };
  const back = decodeConfig(`#${encodeConfig(cfg)}`);
  assert.deepEqual(back, makeConfig(cfg));
  assert.equal(encodeConfig(presetValues("fp")), "preset=fp");
});

test("goal value is the target CPA, or value over target ROAS", () => {
  assert.equal(goalValue({ goal: "cpa", target: 25, value: 80 }), 25);
  assert.equal(goalValue({ goal: "roas", target: 4, value: 80 }), 20);
});

// --- Auction mechanics -------------------------------------------------------

test("second price: the winner pays the second highest bid", () => {
  const { winners } = runAuction([0.004, 0.009, 0.006], 0.001, "sp");
  assert.equal(winners.length, 1);
  assert.equal(winners[0].i, 1);
  close(winners[0].price, 0.006, 1e-12);
});

test("second price: the winner pays the reserve when it is above the second bid, or when alone", () => {
  close(runAuction([0.009, 0.002], 0.005, "sp").winners[0].price, 0.005, 1e-12);
  close(runAuction([NaN, 0.009], 0.003, "sp").winners[0].price, 0.003, 1e-12);
  assert.equal(runAuction([0.002, 0.001], 0.003, "sp").winners.length, 0, "no bid at the floor, no sale");
});

test("second price payment never exceeds the winning bid, on 500 random auctions", () => {
  const r = mulberry32(5);
  for (let n = 0; n < 500; n++) {
    const bids = Array.from({ length: 1 + Math.floor(r() * 6) }, () => r() * 0.02);
    const floor = r() * 0.01;
    const { winners } = runAuction(bids, floor, "sp");
    const eligible = bids.filter((b) => b >= floor).sort((x, y) => y - x);
    if (!eligible.length) { assert.equal(winners.length, 0); continue; }
    assert.equal(bids[winners[0].i], eligible[0]);
    close(winners[0].price, Math.max(eligible[1] ?? floor, floor), 1e-12);
    assert.ok(winners[0].price <= eligible[0] + 1e-12);
  }
});

test("first price: the winner pays its own bid", () => {
  const { winners } = runAuction([0.004, 0.009, 0.006], 0.001, "fp");
  assert.equal(winners[0].i, 1);
  assert.equal(winners[0].price, 0.009);
});

test("ties go to the lower index", () => {
  assert.equal(runAuction([0.005, 0.005], 0.001, "sp").winners[0].i, 0);
});

test("GSP on a hand-worked example: slots by bid, each pays its click share times the next bid", () => {
  // Bids (top-slot CPM) A $10, B $8, C $5, D $2, reserve $1. Slot shares 1, 0.6, 0.35.
  // A gets slot 1 and pays 1 x 8 = $8. B gets slot 2 and pays 0.6 x 5 = $3. C gets slot 3 and pays 0.35 x 2 = $0.70. D gets nothing.
  const { winners } = runAuction([0.010, 0.008, 0.005, 0.002], 0.001, "gsp");
  assert.deepEqual(winners.map((w) => w.i), [0, 1, 2]);
  assert.deepEqual(winners.map((w) => w.slot), [0, 1, 2]);
  close(winners[0].price * 1000, 8, 1e-9);
  close(winners[1].price * 1000, 3, 1e-9);
  close(winners[2].price * 1000, 0.7, 1e-9);
  assert.deepEqual(SLOT_CTR, [1, 0.6, 0.35]);
});

test("GSP with fewer bidders than slots charges the last one the reserve", () => {
  const { winners } = runAuction([0.004, 0.010], 0.002, "gsp");
  assert.deepEqual(winners.map((w) => w.i), [1, 0]);
  close(winners[0].price, 0.004, 1e-12);
  close(winners[1].price, 0.6 * 0.002, 1e-12);
});

// --- Truthfulness and shading ------------------------------------------------

test("truthful bidding is a best response in second price on a constructed case", () => {
  // One bidder with value $10 CPM against competing bids of $4, $9, $12, and $15 over four auctions, floor $2.
  const values = [0.010, 0.010, 0.010, 0.010], others = [0.004, 0.009, 0.012, 0.015], floors = [0.002, 0.002, 0.002, 0.002];
  const grid = Array.from({ length: 31 }, (_, k) => 0.5 + k * 0.05);
  const res = bestResponse(values, others, floors, grid);
  const truthful = res.find((r) => Math.abs(r.factor - 1) < 1e-9).sp.surplus;
  close(truthful, 0.006 + 0.001, 1e-12); // wins the first two, pays 4 and 9
  for (const r of res) assert.ok(r.sp.surplus <= truthful + 1e-12, `factor ${r.factor} beats truthful`);
  // Bidding above value wins the $12 auction at a loss; below value loses the $9 one.
  assert.ok(res.find((r) => Math.abs(r.factor - 1.25) < 1e-9).sp.surplus < truthful);
  assert.ok(res.find((r) => Math.abs(r.factor - 0.85) < 1e-9).sp.surplus < truthful);
});

test("in first price, bidding value earns nothing and bidding below value earns more", () => {
  const res = bestResponse([0.01, 0.01], [0.004, 0.006], [0.001, 0.001], [0.7, 1]);
  close(res[1].fp.surplus, 0, 1e-12);
  assert.ok(res[0].fp.surplus > 0);
});

test("truthfulness over a simulated day: value is best in second price, shading is best in first price", () => {
  const rows = truthfulness(small("brands", { focus: 1 }));
  assert.deepEqual(rows.map((r) => r.factor), PROBE_FACTORS);
  const at1 = rows.find((r) => r.factor === 1);
  for (const r of rows) assert.ok(r.sp.surplus <= at1.sp.surplus + 1e-9);
  close(at1.fp.surplus, 0, 1e-9);
  assert.ok(Math.max(...rows.map((r) => r.fp.surplus)) > 0);
  assert.ok(rows.find((r) => r.factor === 1.3).fp.surplus < 0);
});

test("competition reads the highest other bid from a traced run", () => {
  const w = flatWorld(3, 3);
  const run = { trace: { bids: Float32Array.from([1, 5, 3, 2, NaN, 4, 9, 8, 7]), vals: Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]) } };
  const c = competition(w, run, 1);
  assert.deepEqual([...c.others], [3, 4, 9]);
  assert.deepEqual([...c.values], [2, 5, 8]);
});

test("optimal shade on uniform ratios between 0.5 and 1 is 0.75", () => {
  // Maximize (1 - s)(2s - 1): derivative 3 - 4s = 0.
  const ratios = Array.from({ length: 2001 }, (_, k) => 0.5 + (0.5 * k) / 2000);
  close(optimalShade(ratios), 0.75, 0.011);
  assert.equal(optimalShade([]), 1);
  assert.equal(optimalShade([2, 3]), 1, "never wins below value, so do not shade");
});

test("shading reduces payments in first price on the same impressions", () => {
  const base = small("fp", { pacing: "none" });
  const asValue = { ...base, advertisers: base.advertisers.map((a) => ({ ...a, strategy: a.strategy === "shade" ? "value" : a.strategy })) };
  const w = generateWorld(base);
  const shaded = simulate(base, { world: w }), full = simulate(asValue, { world: w });
  const idx = base.advertisers.map((a, i) => (a.strategy === "shade" ? i : -1)).filter((i) => i >= 0);
  for (const i of idx) {
    assert.ok(shaded.rows[i].cpm < full.rows[i].cpm, `${base.advertisers[i].name}: ${shaded.rows[i].cpm} vs ${full.rows[i].cpm}`);
    assert.ok(shaded.rows[i].shade < 1);
  }
});

test("shading has no effect in second price", () => {
  const base = small("fp", { format: "sp", pacing: "none" });
  const asValue = { ...base, advertisers: base.advertisers.map((a) => ({ ...a, strategy: a.strategy === "shade" ? "value" : a.strategy })) };
  const a = simulate(base), b = simulate(asValue);
  close(a.revenue, b.revenue, 1e-9);
  assert.deepEqual(a.rows.map((r) => r.imps), b.rows.map((r) => r.imps));
});

// --- Pacing ------------------------------------------------------------------

test("the PI step moves toward the target and respects its limits", () => {
  assert.ok(paceStep(0.5, 0.05, 0.05, "throttle") > 0.5, "behind target: enter more auctions");
  assert.ok(paceStep(0.5, -0.05, -0.05, "throttle") < 0.5, "ahead of target: enter fewer");
  assert.equal(paceStep(1, 0.5, 0, "throttle"), PACE.throttle.hi);
  assert.equal(paceStep(0.02, -0.5, 0, "throttle"), PACE.throttle.lo);
  assert.equal(paceStep(0, 0.2, 0, "multiplier"), 0, "the multiplier never goes above 1");
});

test("the controller tracks a target on a synthetic plant", () => {
  // Spend per interval is proportional to the throttle; unthrottled spend would be 3x the target.
  let x = 1, ePrev = 0, spent = 0;
  const errs = [];
  for (let k = 0; k < INTERVALS; k++) {
    spent += 3 * x * (TARGET_CURVE[k + 1] - TARGET_CURVE[k]);
    const e = TARGET_CURVE[k + 1] - spent;
    x = paceStep(x, e, ePrev, "throttle");
    ePrev = e;
    errs.push(Math.abs(e));
  }
  assert.ok(Math.max(...errs.slice(24)) < 0.03, `error after 06:00 up to ${Math.max(...errs.slice(24))}`);
  close(spent, 1, 0.03);
});

for (const pacing of ["throttle", "multiplier"]) {
  test(`${pacing} pacing keeps spend near the target curve`, () => {
    const cfg = small("brands", { pacing, traffic: 30 });
    const r = simulate(cfg);
    for (let i = 0; i < r.A; i++) {
      if (r.rows[i].util < 0.95) continue; // pacing only binds for advertisers that can spend their budget
      for (const h of [6, 9, 12, 15, 18, 21]) {
        const share = r.spendAt[i][h * 4] / r.rows[i].budget;
        close(share, TARGET_CURVE[h * 4], 0.05);
      }
    }
    assert.ok(r.rows.filter((x) => x.util >= 0.95).length >= 2);
  });
}

test("without pacing, budgets run out early; with pacing they last into the evening", () => {
  const cfg = small("small", { traffic: 50 });
  const none = simulate(cfg, { pacing: "none" }), paced = simulate(cfg, { pacing: "throttle" });
  const early = none.rows.filter((r) => r.exhaustT >= 0 && r.exhaustT < 15 * 60).length;
  assert.ok(early >= 6, `${early} of 12 out before 15:00`);
  for (const r of paced.rows) assert.ok(r.exhaustT < 0 || r.exhaustT > 22 * 60, `${r.name} out at ${fmtTime(r.exhaustT)}`);
});

test("pacing buys more conversions with the same budgets", () => {
  const rows = comparePacing(small("small", { traffic: 50 }));
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.ok(by.throttle.conv > by.none.conv * 1.1);
  assert.ok(by.multiplier.conv > by.none.conv * 1.1);
});

test("spend never exceeds budget, and exhaustion is recorded when the budget is nearly gone", () => {
  for (const preset of Object.keys(PRESETS)) {
    for (const pacing of ["none", "throttle"]) {
      const r = simulate(small(preset), { pacing });
      for (const row of r.rows) {
        assert.ok(row.spend <= row.budget + 1e-9, `${row.name} spent ${row.spend} of ${row.budget}`);
        if (row.exhaustT >= 0) assert.ok(row.spend >= (1 - EXHAUSTED) * row.budget - 1e-9);
        else assert.ok(row.spend < (1 - EXHAUSTED) * row.budget);
      }
    }
  }
});

test("the budget-optimal bidder paces itself even when global pacing is off", () => {
  const r = simulate(small("brands"), { pacing: "none" });
  const opt = r.rows.filter((x) => x.strategy === "optimal");
  assert.ok(opt.length > 0);
  for (const o of opt) {
    assert.equal(o.mode, "multiplier");
    assert.ok(o.ctl <= 1);
  }
  assert.ok(r.rows.filter((x) => x.strategy === "value").every((x) => x.mode === "none"));
});

// --- Frequency capping -------------------------------------------------------

test("frequency cap: no user sees one advertiser more than the cap", () => {
  const cap = 3;
  const cfg = small("brands", { cap, pacing: "none" });
  const w = generateWorld(cfg);
  const r = simulate(cfg, { world: w, trace: true });
  const counts = new Map();
  for (let j = 0; j < w.N; j++) {
    const i = r.trace.win[j];
    if (i < 0) continue;
    const key = `${w.user[j]}:${i}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  assert.ok(Math.max(...counts.values()) <= cap);
  for (const row of r.rows) assert.equal(row.wasted, 0, "nothing past the third exposure with a cap of 3");
});

test("frequency cap in GSP counts every slot", () => {
  const cfg = small("small", { cap: 2, format: "gsp", pacing: "none" });
  const w = generateWorld(cfg);
  const r = simulate(cfg, { world: w, trace: true });
  const counts = new Map();
  for (let j = 0; j < w.N; j++) for (let k = 0; k < 3; k++) {
    const i = r.trace.win[j * 3 + k];
    if (i >= 0) counts.set(`${w.user[j]}:${i}`, (counts.get(`${w.user[j]}:${i}`) ?? 0) + 1);
  }
  assert.ok(Math.max(...counts.values()) <= 2);
});

test("a tighter cap trades frequency for reach and cuts wasted impressions", () => {
  const off = simulate(small("brands", { cap: 0 })), on = simulate(small("brands", { cap: 3 }));
  const wOff = sum(off.rows.map((r) => r.wasted)), wOn = sum(on.rows.map((r) => r.wasted));
  assert.ok(wOff > 0 && wOn === 0);
  assert.ok(sum(on.rows.map((r) => r.freq)) < sum(off.rows.map((r) => r.freq)));
  assert.ok(sum(on.rows.map((r) => r.reach)) >= sum(off.rows.map((r) => r.reach)));
});

test("ad fatigue: repeat exposures to one user are worth less", () => {
  // One advertiser, one user, four page views, no competition: clicks are 1 + 0.7 + 0.49 + 0.343 times the base rate
  // (1% CTR, times 1.8 for the segment match and 1.3 for the context match).
  const w = flatWorld(4, 1, { users: 1 });
  const r = runSim(w, [flatAdv({ ctr: 1 })], { format: "sp" });
  close(r.rows[0].clicks, 0.01 * 1.8 * 1.3 * (1 + FATIGUE + FATIGUE ** 2 + FATIGUE ** 3), 1e-6);
  assert.equal(r.rows[0].reach, 1);
  assert.equal(r.rows[0].wasted, 4 - WASTE_AFTER);
});

// --- Accounting --------------------------------------------------------------

test("spend equals the sum of prices paid, and publisher revenue equals total spend", () => {
  for (const format of ["sp", "fp", "gsp"]) {
    const cfg = small("small", { format });
    const r = simulate(cfg, { trace: true });
    let paid = 0;
    const byAdv = new Float64Array(r.A);
    for (let j = 0; j < r.N * r.K; j++) if (r.trace.win[j] >= 0) { paid += r.trace.price[j]; byAdv[r.trace.win[j]] += r.trace.price[j]; }
    close(r.revenue, paid, 1e-4); // the trace stores prices as 32-bit floats
    close(r.spend, r.revenue, 1e-9);
    close(r.spend, sum(r.rows.map((x) => x.spend)), 1e-9);
    r.rows.forEach((row, i) => close(row.spend, byAdv[i], 1e-4));
  }
});

test("impressions, wins, and price histogram all count the same ad impressions", () => {
  const r = simulate(small("brands", { format: "gsp" }));
  assert.equal(sum(r.rows.map((x) => x.imps)), r.adImps);
  assert.equal(sum([...r.winsH]), r.adImps);
  assert.equal(sum([...r.hist]), r.adImps);
  assert.ok(r.adImps <= 3 * r.N);
});

test("derived metrics: CPA, ROAS, CPM, budget use, welfare, and surplus", () => {
  const r = simulate(small("brands"));
  for (const x of r.rows) {
    if (x.conv > 0) close(x.cpa, x.spend / x.conv, 1e-9);
    if (x.spend > 0) close(x.roas, x.value / x.spend, 1e-9);
    if (x.imps > 0) close(x.cpm, (x.spend / x.imps) * 1000, 1e-9);
    close(x.util, x.spend / x.budget, 1e-12);
    assert.ok(x.wins <= x.entered);
  }
  close(r.welfare, sum(r.rows.map((x) => x.value)), 1e-6);
  close(r.surplus, r.welfare - r.revenue, 1e-9);
  assert.ok(r.fill > 0 && r.fill <= 1);
});

test("spend over time ends at total spend and never falls", () => {
  const r = simulate(small("fp"));
  r.spendAt.forEach((s, i) => {
    assert.equal(s[0], 0);
    for (let k = 1; k <= INTERVALS; k++) assert.ok(s[k] >= s[k - 1]);
    close(s[INTERVALS], r.rows[i].spend, 1e-9);
  });
});

test("the trace records why each bidder did or did not bid", () => {
  const cfg = small("fp", { cap: 2, traffic: 50 });
  const r = simulate(cfg, { trace: true });
  const st = r.trace.status;
  const n = (code) => st.reduce((s, v) => s + (v === code ? 1 : 0), 0);
  assert.ok(n(0) > 0 && n(2) > 0 && n(3) > 0, "bids, throttled, and capped all occur");
  assert.equal(n(3), sum(r.rows.map((x) => x.capped)));
  assert.equal(n(2), sum(r.rows.map((x) => x.throttled)));
});

// --- Formats and determinism -------------------------------------------------

test("format comparison runs the same impressions under each format", () => {
  const rows = compareFormats(small("brands"));
  assert.deepEqual(rows.map((r) => r.id), ["sp", "fp", "gsp"]);
  for (const r of rows) assert.equal(r.N, 10000);
  const gsp = rows.find((r) => r.id === "gsp"), sp = rows.find((r) => r.id === "sp");
  assert.ok(gsp.adImps > sp.adImps, "three slots sell more ad impressions");
});

test("first price with naive value bidders takes most of their surplus", () => {
  const cfg = small("small", { pacing: "none" });
  const w = generateWorld(cfg);
  const sp = simulate(cfg, { world: w, format: "sp" }), fp = simulate(cfg, { world: w, format: "fp" });
  const vi = cfg.advertisers.map((a, i) => (a.strategy === "value" ? i : -1)).filter((i) => i >= 0);
  assert.ok(sum(vi.map((i) => fp.rows[i].cpm)) > sum(vi.map((i) => sp.rows[i].cpm)));
});

test("runs are deterministic", () => {
  const cfg = small("fp");
  const a = slim(simulate(cfg)), b = slim(simulate(cfg));
  assert.deepEqual(a, b);
  const x = compareAll(cfg), y = compareAll(cfg);
  assert.deepEqual(x.formats.map((r) => r.revenue), y.formats.map((r) => r.revenue));
  assert.deepEqual(x.truth, y.truth);
});

test("a different seed gives a different day", () => {
  assert.notEqual(simulate(small("brands")).revenue, simulate(small("brands", { seed: 99 })).revenue);
});

test("every preset runs and spends money in every format", () => {
  for (const id of Object.keys(PRESETS)) {
    for (const f of compareFormats(small(id))) {
      assert.ok(f.revenue > 0, `${id} ${f.id}`);
      assert.ok(f.welfare > f.revenue * 0.5, `${id} ${f.id} welfare ${f.welfare} revenue ${f.revenue}`);
    }
  }
});

test("runSim refuses a world built for a different number of advertisers", () => {
  assert.throws(() => runSim(flatWorld(2, 2), [flatAdv({})], {}));
});

test("time formatting", () => {
  assert.equal(fmtTime(-1), "never");
  assert.equal(fmtTime(0), "00:00");
  assert.equal(fmtTime(13 * 60 + 5.7), "13:05");
});
