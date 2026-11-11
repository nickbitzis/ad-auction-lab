import {
  CONTEXTS, FORMATS, INTERVALS, INTERVAL_MIN, PACINGS, PRESETS, PRICE_BIN, PRICE_BINS, SEGMENTS, STRATEGIES, TARGET_CURVE, WASTE_AFTER,
  clamp, compareAll, decodeConfig, encodeConfig, fmt1, fmtInt, fmtMoney, fmtTime, generateWorld, pct, presetValues, simulate,
} from "./auction.js";

const $ = (id) => document.getElementById(id);
const form = $("form");
const SVG_NS = "http://www.w3.org/2000/svg";

let cfg = decodeConfig(location.hash);
let pickJ = readJ(location.hash);
let R = null; // configured run, with trace
let CMP = null; // format, pacing, truthfulness comparisons

function readJ(hash) {
  const p = new URLSearchParams(String(hash ?? "").replace(/^#/, ""));
  const v = p.has("j") ? Number(p.get("j")) : NaN;
  return Number.isFinite(v) && v >= 0 ? Math.round(v) : -1;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

const sw = (i) => el("i", { class: `swatch a${i % 12}` });
const cpm = (perImp) => (Number.isFinite(perImp) ? `$${(perImp * 1000).toFixed(2)}` : "n/a");
const money = (n) => fmtMoney(n, Math.abs(n) < 100 ? 2 : 0);
const advName = (i) => cfg.advertisers[i].name;
const fmtText = (f) => (f === "gsp" ? "GSP with 3 slots" : FORMATS[f].label.toLowerCase());
const paceText = (p) => (p === "none" ? "no pacing" : `${PACINGS[p].label.toLowerCase()} pacing`);
const saveHash = () => history.replaceState(null, "", `#${encodeConfig(cfg)}${pickJ >= 0 ? `&j=${pickJ}` : ""}`);

// ---------------------------------------------------------------------------
// Form

const F = (name, label, title, step = 1) => ({ name, label, title, step });
const GROUPS = [
  { legend: "Auction", fields: [
    { name: "format", label: "Format", type: "select", options: Object.fromEntries(Object.entries(FORMATS).map(([k, v]) => [k, v.label])), title: "How the winner and the price are set", note: "format-note" },
    F("reserve", "Floor price (% of base)", "Base floors by page: news $1.20, sports $1.50, recipes $0.80, video $2.50, travel $2.00 CPM, each varied 20% either way"),
  ] },
  { legend: "Pacing and frequency", fields: [
    { name: "pacing", label: "Budget pacing", type: "select", options: Object.fromEntries(Object.entries(PACINGS).map(([k, v]) => [k, v.label])), title: "How advertisers spread their budget over the day. The budget-optimal strategy always uses the bid multiplier", note: "pacing-note" },
    F("cap", "Frequency cap (per user per day, 0 = off)", "Most ads one advertiser can show one user today"),
  ] },
  { legend: "Supply", fields: [
    F("traffic", "Page views (thousands)", "Page views over the day, from 5 to 150 thousand"),
    F("noise", "Prediction noise (%)", "Spread of each bidder's error in predicting click-through, as a lognormal sigma"),
    F("seed", "Random seed", "Users, page views, and prediction errors all come from this seed"),
  ] },
];

function field(f) {
  if (f.type === "select") {
    return el("label", { title: f.title || null }, [f.label, el("select", { name: f.name }, Object.entries(f.options).map(([v, t]) => el("option", { value: v, text: t })))]);
  }
  return el("label", { title: f.title || null }, [f.label, el("input", { type: "number", name: f.name, step: f.step, min: 0, inputmode: "decimal" })]);
}

function buildForm() {
  form.replaceChildren(...GROUPS.map((g) => el("fieldset", {}, [
    el("legend", { text: g.legend }),
    ...g.fields.flatMap((f) => (f.note ? [field(f), el("span", { class: "field-hint", id: f.note })] : [])),
    el("div", { class: "grid2" }, g.fields.filter((f) => !f.note).map(field)),
  ])), el("fieldset", {}, [
    el("legend", { text: "Focus" }),
    el("label", { title: "Highlighted in the charts, and the bidder tested above and below value in the truthfulness table" }, ["Focus advertiser", el("select", { name: "focus" }, cfg.advertisers.map((a, i) => el("option", { value: i, text: a.name })))]),
  ]));
  fillForm();
}

function fillForm() {
  for (const f of form.elements) {
    if (!f.name || !(f.name in cfg)) continue;
    f.value = cfg[f.name];
  }
  $("format-note").textContent = FORMATS[cfg.format].note;
  $("pacing-note").textContent = PACINGS[cfg.pacing].note;
}

form.addEventListener("input", (e) => {
  const f = e.target;
  if (!f.name) return;
  let v;
  if (f.tagName === "SELECT") v = f.name === "focus" ? Number(f.value) : f.value;
  else {
    v = Number(f.value);
    if (f.value === "" || !Number.isFinite(v) || v < 0) return;
  }
  if (f.name === "focus") { setFocus(v); return; }
  cfg = clamp({ ...cfg, [f.name]: v });
  $("format-note").textContent = FORMATS[cfg.format].note;
  $("pacing-note").textContent = PACINGS[cfg.pacing].note;
  schedule();
});
form.addEventListener("change", () => fillForm());

function drawPresets() {
  $("presets").replaceChildren(...Object.entries(PRESETS).map(([id, p]) => el("button", {
    type: "button", class: "preset", "data-preset": id, "aria-pressed": String(cfg.preset === id),
  }, [el("span", { text: p.label }), el("small", { text: `${p.advertisers.length} advertisers, ${fmtText(p.format)}, ${paceText(p.pacing)}` })])));
  $("preset-note").textContent = PRESETS[cfg.preset].note;
}

$("presets").addEventListener("click", (e) => {
  const b = e.target.closest("[data-preset]");
  if (!b) return;
  cfg = clamp({ ...presetValues(b.dataset.preset), traffic: cfg.traffic, seed: cfg.seed, noise: cfg.noise });
  pickJ = -1;
  drawAll();
});

function drawAll() {
  drawPresets();
  buildForm();
  drawSetup();
  update();
}

// ---------------------------------------------------------------------------
// Advertiser setup table

function drawSetup() {
  const num = (i, k, step) => el("input", { type: "number", "data-i": i, "data-k": k, step, min: 0, inputmode: "decimal", value: cfg.advertisers[i][k], "aria-label": `${advName(i)} ${k}` });
  $("setup-rows").replaceChildren(...cfg.advertisers.map((a, i) => el("tr", { class: i === cfg.focus ? "selected" : null }, [
    el("td", { class: "name", "data-focus": i, title: "Focus this advertiser" }, [sw(i), a.name, el("small", { text: `${SEGMENTS[a.seg]}, ${CONTEXTS[a.ctx].label.toLowerCase()} pages, CTR ${a.ctr}%, CVR ${a.cvr}%` })]),
    el("td", {}, [el("select", { "data-i": i, "data-k": "strategy", "aria-label": `${a.name} strategy` }, Object.entries(STRATEGIES).map(([k, s]) => el("option", { value: k, text: s.label, selected: k === a.strategy ? "" : null })))]),
    el("td", {}, [el("select", { "data-i": i, "data-k": "goal", "aria-label": `${a.name} goal` }, [el("option", { value: "cpa", text: "CPA", selected: a.goal === "cpa" ? "" : null }), el("option", { value: "roas", text: "ROAS", selected: a.goal === "roas" ? "" : null })])]),
    el("td", { class: "num" }, [num(i, "target", a.goal === "roas" ? 0.1 : 1)]),
    el("td", { class: "num" }, [num(i, "value", 1)]),
    el("td", { class: "num" }, [num(i, "budget", 5)]),
    el("td", { class: "num" }, a.strategy === "fixed" ? [num(i, "fixedCpm", 0.5)] : [el("span", { class: "na", text: "n/a" })]),
  ])));
}

$("setup-rows").addEventListener("input", (e) => {
  const t = e.target;
  if (!t.dataset.k) return;
  const i = Number(t.dataset.i), k = t.dataset.k;
  let v = t.value;
  if (t.tagName !== "SELECT") {
    v = Number(t.value);
    if (t.value === "" || !Number.isFinite(v) || v <= 0) return;
  }
  const advs = cfg.advertisers.map((a, n) => (n === i ? { ...a, [k]: v } : a));
  cfg = clamp({ ...cfg, advertisers: advs });
  if (t.tagName === "SELECT") drawSetup();
  schedule();
});
$("setup-rows").addEventListener("click", (e) => {
  const td = e.target.closest("[data-focus]");
  if (td) setFocus(Number(td.dataset.focus));
});

function setFocus(i) {
  if (i === cfg.focus) return;
  cfg = clamp({ ...cfg, focus: i });
  fillForm();
  drawSetup();
  if (R) { drawSummary(); drawCards(); drawAdvRows(); drawSpend(); drawWins(); drawInspector(); }
  runCompare();
  saveHash();
}

let timer = 0;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(update, 300);
}

// ---------------------------------------------------------------------------
// Runs happen in a worker so the page stays responsive.

let worker = null, jobId = 0;
// ?noworker runs everything on the main thread (used for headless screenshots).
if (!new URLSearchParams(location.search).has("noworker")) try {
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    if (e.data.id !== jobId) return;
    if (e.data.kind === "main") onMain(e.data.result);
    else onCompare(e.data.cmp);
  };
  worker.onerror = () => { worker = null; runLocal(jobId, false); };
} catch {
  worker = null;
}

function runLocal(id, compareOnly) {
  setTimeout(() => {
    if (id !== jobId) return;
    const w = generateWorld(cfg);
    if (!compareOnly && !R) {
      const r = simulate(cfg, { trace: true, world: w });
      r.world = w;
      onMain(r);
    }
    setTimeout(() => { if (id === jobId && !CMP) onCompare(compareAll(cfg, w)); }, 0);
  }, 0);
}

function post(only) {
  jobId++;
  const id = jobId;
  if (worker) {
    worker.postMessage({ id, cfg, only });
    setTimeout(() => { if (id === jobId && !CMP) runLocal(id, only === "compare"); }, 8000); // fallback if the worker never answers
  } else runLocal(id, only === "compare");
}

function update() {
  R = null; CMP = null;
  $("status").textContent = `Auctioning ${fmtInt(cfg.traffic * 1000)} page views...`;
  $("cmp-status").textContent = "Rerunning the day under each format and pacing mode...";
  post();
  saveHash();
}

function runCompare() {
  CMP = null;
  $("cmp-status").textContent = "Rerunning the truthfulness test...";
  post("compare");
}

function onMain(result) {
  R = result;
  if (pickJ < 0 || pickJ >= R.N) pickJ = defaultPick();
  $("status").textContent = "";
  drawSummary();
  drawCards();
  drawAdvRows();
  drawSpend();
  drawWins();
  drawPrices();
  drawInspector();
}

function onCompare(cmp) {
  CMP = cmp;
  $("cmp-status").textContent = "";
  drawFormats();
  drawTruth();
  drawPacing();
  drawSummary();
}

// ---------------------------------------------------------------------------
// Summary and tiles

const OUT_BY = 18 * 60;

function drawSummary() {
  if (!R) return;
  const rows = R.rows;
  const early = rows.map((r, i) => ({ ...r, i })).filter((r) => r.exhaustT >= 0 && r.exhaustT < OUT_BY).sort((a, b) => a.exhaustT - b.exhaustT);
  const wasted = rows.reduce((s, r) => s + r.wasted, 0);
  const parts = [
    `Under ${fmtText(R.format)} with ${paceText(R.pacing)}, the publisher sold ${fmtInt(R.adImps)} ad impressions on ${fmtInt(R.N)} page views (${pct(R.fill)} filled) for ${money(R.revenue)}, ${cpm(R.revenue / R.adImps)} CPM on average.`,
    `Advertisers got ${fmt1(R.conv)} expected conversions worth ${money(R.welfare)}, a surplus of ${money(R.surplus)} after spend.`,
    early.length
      ? `${early.length} of ${rows.length} budgets ran out before 18:00, missing the evening peak: ${early.slice(0, 3).map((r) => `${r.name} at ${fmtTime(r.exhaustT)}`).join(", ")}${early.length > 3 ? ", and more" : ""}.`
      : "No budget ran out before 18:00.",
    `${pct(wasted / R.adImps)} of impressions went to users who had already seen that advertiser ${WASTE_AFTER} times today${R.cap ? ` (cap ${R.cap})` : ", with no frequency cap"}.`,
  ];
  if (CMP) {
    const p = Object.fromEntries(CMP.pacing.map((x) => [x.id, x]));
    const others = CMP.formats.filter((x) => x.id !== R.format);
    parts.push(`On the same impressions, ${others.map((x) => `${fmtText(x.id)} would earn the publisher ${money(x.revenue)}`).join(" and ")}.`);
    if (p.none.conv > 0) parts.push(`Pacing: ${fmt1(p.none.conv)} conversions with none, ${fmt1(p.throttle.conv)} with even pacing, ${fmt1(p.multiplier.conv)} with the bid multiplier.`);
  }
  $("rec").textContent = parts.join(" ");
}

function card(label, value, sub, title, cls = "") {
  return el("div", { class: "card", title }, [el("span", { class: "card-label", text: label }), el("span", { class: `card-total ${cls}`, text: value }), el("span", { class: "card-sub", text: sub })]);
}

function drawCards() {
  const rows = R.rows, f = rows[cfg.focus], a = cfg.advertisers[cfg.focus];
  const budget = rows.reduce((s, r) => s + r.budget, 0), wasted = rows.reduce((s, r) => s + r.wasted, 0);
  const reach = rows.reduce((s, r) => s + r.reach, 0);
  const early = rows.filter((r) => r.exhaustT >= 0 && r.exhaustT < OUT_BY).length;
  const goalMet = a.goal === "cpa" ? f.cpa <= a.target : f.roas >= a.target;
  $("cards").replaceChildren(
    card("Publisher revenue", money(R.revenue), `${cpm(R.revenue / R.adImps)} CPM, ${pct(R.fill)} of page views filled`, "Sum of prices paid"),
    card("Advertiser surplus", money(R.surplus), `on ${money(R.welfare)} of conversion value`, "Value of conversions minus spend, all advertisers"),
    card("Conversions", fmt1(R.conv), `${fmtInt(R.clicks)} clicks, ${money(R.spend / R.conv)} blended CPA`, "Expected counts"),
    card("Budget spent", pct(R.spend / budget), early ? `${early} ran out before 18:00` : "none ran out before 18:00", "All advertisers' spend over their daily budgets", early ? "bad" : ""),
    card("Wasted impressions", pct(wasted / R.adImps), `${(R.adImps / Math.max(1, reach)).toFixed(1)} ads per user reached`, `Impressions after a user's third from the same advertiser today`, wasted / R.adImps > 0.15 ? "bad" : ""),
    card(`${f.name}`, a.goal === "cpa" ? `${money(f.cpa)} CPA` : `${Number.isFinite(f.roas) ? f.roas.toFixed(2) : "n/a"}x ROAS`, `target ${a.goal === "cpa" ? money(a.target) : `${a.target}x`}, ${fmt1(f.conv)} conversions, ${pct(f.util)} of budget`, "The focus advertiser against its goal", Number.isFinite(f.cpa) ? (goalMet ? "good" : "bad") : ""),
  );
}

function drawAdvRows() {
  const rows = R.rows;
  $("adv-rows").replaceChildren(...rows.map((r, i) => {
    const a = cfg.advertisers[i];
    const goalBad = a.goal === "cpa" ? r.cpa > a.target : r.roas < a.target;
    return el("tr", { "data-i": i, class: i === cfg.focus ? "selected" : null, title: "Click to focus" }, [
      el("td", { class: "name" }, [sw(i), r.name, el("small", { text: STRATEGIES[r.strategy].label + (r.mode !== "none" ? `, ${r.mode === "multiplier" ? "multiplier" : "throttle"} ${r.ctl.toFixed(2)} at close` : "") + (Number.isFinite(r.shade) ? `, shade ${r.shade.toFixed(2)}` : "") })]),
      el("td", { class: "num", text: fmtInt(r.imps) }),
      el("td", { class: "num", text: `${fmtInt(r.reach)}, ${Number.isFinite(r.freq) ? r.freq.toFixed(1) : "n/a"}` }),
      el("td", { class: `num${r.imps && r.wasted / r.imps > 0.15 ? " bad" : ""}`, text: r.imps ? pct(r.wasted / r.imps) : "n/a" }),
      el("td", { class: "num", text: `${fmtInt(r.clicks)}, ${fmt1(r.conv)}` }),
      el("td", { class: "num", text: money(r.spend) }),
      el("td", { class: "num", text: Number.isFinite(r.cpm) ? `$${r.cpm.toFixed(2)}` : "n/a" }),
      el("td", { class: `num${a.goal === "cpa" && goalBad ? " bad" : ""}`, text: money(r.cpa) }),
      el("td", { class: `num${a.goal === "roas" && goalBad ? " bad" : ""}`, text: Number.isFinite(r.roas) ? `${r.roas.toFixed(2)}x` : "n/a" }),
      el("td", { class: "num", text: pct(r.util) }),
      el("td", { class: `num${r.exhaustT >= 0 && r.exhaustT < OUT_BY ? " bad" : ""}`, text: fmtTime(r.exhaustT) }),
    ]);
  }));
  const T = rows.reduce((s, r) => ({ imps: s.imps + r.imps, reach: s.reach + r.reach, wasted: s.wasted + r.wasted, clicks: s.clicks + r.clicks, conv: s.conv + r.conv, spend: s.spend + r.spend, value: s.value + r.value, budget: s.budget + r.budget }), { imps: 0, reach: 0, wasted: 0, clicks: 0, conv: 0, spend: 0, value: 0, budget: 0 });
  $("adv-rows").append(el("tr", { class: "total" }, [
    el("td", { text: "All" }), el("td", { class: "num", text: fmtInt(T.imps) }), el("td", { class: "num", text: "" }),
    el("td", { class: "num", text: pct(T.wasted / T.imps) }), el("td", { class: "num", text: `${fmtInt(T.clicks)}, ${fmt1(T.conv)}` }),
    el("td", { class: "num", text: money(T.spend) }), el("td", { class: "num", text: `$${((T.spend / T.imps) * 1000).toFixed(2)}` }),
    el("td", { class: "num", text: money(T.spend / T.conv) }), el("td", { class: "num", text: `${(T.value / T.spend).toFixed(2)}x` }),
    el("td", { class: "num", text: pct(T.spend / T.budget) }), el("td", { class: "num", text: "" }),
  ]));
  $("adv-note").textContent = `Clicks and conversions are expected counts: each won impression adds its true click and conversion probability, so results do not hinge on a few lucky conversions. `
    + `Red CPA or ROAS misses the advertiser's goal. Click-through falls ${Math.round(100 * (1 - 0.7))}% with each repeat exposure to the same user, so wasted impressions cost full price for little return.`;
}

$("adv-rows").addEventListener("click", (e) => {
  const tr = e.target.closest("[data-i]");
  if (tr) setFocus(Number(tr.dataset.i));
});

// ---------------------------------------------------------------------------
// Charts

const narrow = () => matchMedia("(max-width: 600px)").matches;
const tipRow = (a, b, i = -1) => el("div", { class: "tip-row" }, [el("span", {}, i >= 0 ? [sw(i), a] : [a]), el("b", { text: b })]);

function placeTip(tip, box, e) {
  tip.hidden = false;
  const left = e.clientX - box.left;
  const w = tip.offsetWidth;
  let x = left > box.width / 2 ? left - w - 12 : left + 12;
  x = Math.max(0, Math.min(box.width - w, x));
  tip.style.left = `${x}px`;
  tip.style.top = `${Math.max(0, e.clientY - box.top + 14)}px`;
}

function niceStep(span, n) {
  const raw = span / n, mag = 10 ** Math.floor(Math.log10(raw || 1));
  for (const m of [1, 2, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

let SP = null; // spend chart geometry

function drawSpend() {
  const CW = narrow() ? 440 : 800, CH = narrow() ? 300 : 300, P = { l: 44, r: 12, t: 10, b: 26 };
  const chart = $("c-spend");
  chart.setAttribute("viewBox", `0 0 ${CW} ${CH}`);
  const shares = R.spendAt.map((s, i) => Array.from(s, (v) => v / R.rows[i].budget));
  const top = Math.max(1, ...shares.flat());
  const yStep = top > 1.05 ? 0.25 : 0.2, yMax = Math.ceil((top * 1.02) / yStep) * yStep;
  const X = (k) => P.l + (k / INTERVALS) * (CW - P.l - P.r);
  const Y = (v) => P.t + (1 - v / yMax) * (CH - P.t - P.b);
  const nodes = [];
  for (let v = 0; v <= yMax + 1e-9; v += yStep) {
    nodes.push(svg("line", { x1: P.l, x2: CW - P.r, y1: Y(v), y2: Y(v), class: "grid" }));
    nodes.push(svg("text", { x: P.l - 6, y: Y(v) + 4, class: "tick", "text-anchor": "end" }, `${Math.round(v * 100)}%`));
  }
  for (let h = 0; h <= 24; h += narrow() ? 6 : 3) {
    nodes.push(svg("text", { x: X(h * 4), y: CH - 8, class: "tick", "text-anchor": h === 0 ? "start" : h === 24 ? "end" : "middle" }, `${String(h).padStart(2, "0")}:00`));
  }
  const line = (ys) => ys.map((v, k) => `${X(k).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const order = shares.map((_, i) => i).filter((i) => i !== cfg.focus).concat([cfg.focus]);
  for (const i of order) nodes.push(svg("polyline", { points: line(shares[i]), class: `l-adv s${i % 12}${i === cfg.focus ? " cur" : ""}` }));
  nodes.push(svg("polyline", { points: line(TARGET_CURVE), class: "l-target" }));
  for (const i of order) {
    const t = R.rows[i].exhaustT;
    if (t >= 0) nodes.push(svg("circle", { cx: X(t / INTERVAL_MIN), cy: Y(shares[i][Math.min(INTERVALS, Math.ceil(t / INTERVAL_MIN))]), r: i === cfg.focus ? 4.5 : 3.5, class: `dot s${i % 12}` }));
  }
  nodes.push(svg("line", { class: "crosshair", x1: 0, x2: 0, y1: P.t, y2: CH - P.b, visibility: "hidden" }));
  chart.replaceChildren(...nodes);
  SP = { CW, P, X, shares };
  $("spend-legend").replaceChildren(
    ...R.rows.map((r, i) => el("li", { "data-i": i, class: i === cfg.focus ? "cur" : null, title: "Click to focus" }, [el("i", { class: `linekey`, style: `border-top-color:var(--a${i % 12})` }), r.name])),
    el("li", {}, [el("i", { class: "linekey target" }), "Target: share of the day's traffic so far"]),
  );
  const paced = R.rows.filter((r) => r.mode !== "none");
  $("spend-note").textContent = `Cumulative spend as a share of each advertiser's budget. Dots mark when a budget ran out. The target curve follows expected traffic, so an even pacer spends little overnight and most in the evening. `
    + (paced.length ? `${paced.length} of ${R.rows.length} advertisers are paced; the controller compares spend to the target every 15 minutes.` : "Nobody is paced, so each spends as fast as it can win.");
}

$("spend-legend").addEventListener("click", (e) => {
  const li = e.target.closest("[data-i]");
  if (li) setFocus(Number(li.dataset.i));
});

{
  const chart = $("c-spend"), tip = chart.nextElementSibling;
  chart.addEventListener("pointermove", (e) => {
    if (!R || !SP) return;
    const box = chart.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * SP.CW;
    const k = Math.max(0, Math.min(INTERVALS, Math.round(((sx - SP.P.l) / (SP.CW - SP.P.l - SP.P.r)) * INTERVALS)));
    const ch = chart.querySelector(".crosshair");
    ch.setAttribute("x1", SP.X(k)); ch.setAttribute("x2", SP.X(k)); ch.setAttribute("visibility", "visible");
    const order = R.rows.map((_, i) => i).sort((a, b) => SP.shares[b][k] - SP.shares[a][k]);
    tip.replaceChildren(
      el("strong", { text: `${fmtTime(k * INTERVAL_MIN)}${k === INTERVALS ? " (end of day)" : ""}` }),
      tipRow("Target", pct(TARGET_CURVE[k])),
      ...order.map((i) => tipRow(R.rows[i].name, `${pct(SP.shares[i][k])}${R.rows[i].mode !== "none" ? ` (${R.rows[i].mode === "multiplier" ? "x" : "p"} ${R.ctlAt[i][k].toFixed(2)})` : ""}`, i)),
      el("div", { class: "tip-ev", text: "x is the bid multiplier, p the share of auctions entered." }),
    );
    placeTip(tip, chart.parentElement.getBoundingClientRect(), e);
  });
  chart.addEventListener("pointerleave", () => { tip.hidden = true; chart.querySelector(".crosshair")?.setAttribute("visibility", "hidden"); });
}

function drawWins() {
  const maxRate = Math.max(0.01, ...R.rows.map((r) => (Number.isFinite(r.winRate) ? r.winRate : 0)));
  $("win-rows").replaceChildren(...R.rows.map((r, i) => el("tr", { "data-i": i, class: i === cfg.focus ? "selected" : null }, [
    el("td", { class: "name" }, [sw(i), r.name]),
    el("td", { class: "num", text: fmtInt(r.entered) }),
    el("td", { class: "bar-col" }, [el("span", { class: "bar-bg" }, [el("span", { class: "hbar", style: `width:${(100 * (r.winRate || 0)) / maxRate}%;background:var(--a${i % 12})` })]), el("small", { text: pct(r.winRate) })]),
    el("td", { class: "num" }, [Number.isFinite(r.avgBidCpm) ? `$${r.avgBidCpm.toFixed(2)}` : "n/a", el("small", { text: `paid ${Number.isFinite(r.cpm) ? `$${r.cpm.toFixed(2)}` : "n/a"}` })]),
  ])));
}

$("win-rows").addEventListener("click", (e) => {
  const tr = e.target.closest("[data-i]");
  if (tr) setFocus(Number(tr.dataset.i));
});

let PH = null;

function drawPrices() {
  const CW = narrow() ? 440 : 520, CH = 240, P = { l: 44, r: 8, t: 10, b: 26 };
  const chart = $("c-price");
  chart.setAttribute("viewBox", `0 0 ${CW} ${CH}`);
  const A = R.A, totals = Array.from({ length: PRICE_BINS }, (_, b) => { let s = 0; for (let i = 0; i < A; i++) s += R.hist[i * PRICE_BINS + b]; return s; });
  let last = PRICE_BINS - 1;
  while (last > 5 && totals[last] === 0) last--;
  const nb = last + 1;
  const top = Math.max(1, ...totals);
  const yStep = niceStep(top * 1.05, 4), yMax = Math.ceil((top * 1.05) / yStep) * yStep;
  const bw = (CW - P.l - P.r) / nb;
  const X = (b) => P.l + b * bw;
  const Y = (v) => P.t + (1 - v / yMax) * (CH - P.t - P.b);
  const nodes = [];
  for (let v = 0; v <= yMax + 1e-9; v += yStep) {
    nodes.push(svg("line", { x1: P.l, x2: CW - P.r, y1: Y(v), y2: Y(v), class: "grid" }));
    nodes.push(svg("text", { x: P.l - 6, y: Y(v) + 4, class: "tick", "text-anchor": "end" }, v >= 1000 ? `${v / 1000}k` : fmtInt(v)));
  }
  const every = nb > 20 ? 5 : nb > 10 ? 2 : 1;
  for (let b = 0; b <= nb; b += every) nodes.push(svg("text", { x: X(b), y: CH - 8, class: "tick", "text-anchor": "middle" }, `$${b * PRICE_BIN}`));
  for (let b = 0; b < nb; b++) {
    let acc = 0;
    for (let i = 0; i < A; i++) {
      const c = R.hist[i * PRICE_BINS + b];
      if (!c) continue;
      nodes.push(svg("rect", { x: X(b) + 0.5, width: Math.max(0.5, bw - 1), y: Y(acc + c), height: Math.max(0, Y(acc) - Y(acc + c)), class: `bar s${i % 12}`, style: i === cfg.focus ? "" : "opacity:0.85" }));
      acc += c;
    }
  }
  chart.replaceChildren(...nodes);
  PH = { CW, P, bw, nb };
  let n = 0, s = 0;
  for (let b = 0; b < PRICE_BINS; b++) { n += totals[b]; s += totals[b] * (b + 0.5) * PRICE_BIN; }
  let acc = 0, med = 0;
  for (let b = 0; b < PRICE_BINS; b++) { acc += totals[b]; if (acc >= n / 2) { med = b; break; } }
  $("price-note").textContent = `Median clearing price between $${med * PRICE_BIN} and $${(med + 1) * PRICE_BIN} CPM, mean about $${(s / Math.max(1, n)).toFixed(2)}. `
    + (R.format === "gsp" ? "GSP lower slots pay a share of the next bid, so their prices sit in the low bins." : R.format === "fp" ? "In first price every winner pays its own bid, so the distribution shows bids, shaded or not." : "In second price winners pay the next bid or the floor, so prices sit well below the winning bids.");
}

{
  const chart = $("c-price"), tip = chart.nextElementSibling;
  chart.addEventListener("pointermove", (e) => {
    if (!R || !PH) return;
    const box = chart.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * PH.CW;
    const b = Math.floor((sx - PH.P.l) / PH.bw);
    if (b < 0 || b >= PH.nb) { tip.hidden = true; return; }
    const parts = R.rows.map((r, i) => [i, R.hist[i * PRICE_BINS + b]]).filter(([, c]) => c > 0).sort((x, y) => y[1] - x[1]);
    const tot = parts.reduce((s, [, c]) => s + c, 0);
    tip.replaceChildren(
      el("strong", { text: b === PRICE_BINS - 1 ? `$${b * PRICE_BIN}+ CPM` : `$${b * PRICE_BIN} to $${(b + 1) * PRICE_BIN} CPM` }),
      tipRow("Impressions", fmtInt(tot)),
      ...parts.map(([i, c]) => tipRow(R.rows[i].name, fmtInt(c), i)),
    );
    placeTip(tip, chart.parentElement.getBoundingClientRect(), e);
  });
  chart.addEventListener("pointerleave", () => { tip.hidden = true; });
}

// ---------------------------------------------------------------------------
// Comparisons

function bestCls(val, all, dir = 1) {
  const best = dir > 0 ? Math.max(...all) : Math.min(...all);
  return Math.abs(val - best) < 1e-9 ? "num good" : "num";
}

function drawFormats() {
  const rows = CMP.formats;
  const col = (k) => rows.map((r) => r[k]);
  $("fmt-rows").replaceChildren(...rows.map((r) => el("tr", { "data-format": r.id, class: r.id === cfg.format ? "selected" : null, title: "Click to use this format" }, [
    el("td", { class: "name", text: r.label }),
    el("td", { class: bestCls(r.revenue, col("revenue")), text: money(r.revenue) }),
    el("td", { class: bestCls(r.surplus, col("surplus")), text: money(r.surplus) }),
    el("td", { class: bestCls(r.welfare, col("welfare")), text: money(r.welfare) }),
    el("td", { class: bestCls(r.conv, col("conv")), text: fmt1(r.conv) }),
    el("td", { class: "num", text: fmtInt(r.adImps) }),
    el("td", { class: "num", text: cpm(r.revenue / r.adImps) }),
    el("td", { class: "num", text: pct(r.fill) }),
  ])));
  const f = Object.fromEntries(rows.map((r) => [r.id, r]));
  const shaders = cfg.advertisers.filter((a) => a.strategy === "shade").length, valueB = cfg.advertisers.filter((a) => a.strategy === "value" || a.strategy === "optimal").length;
  $("fmt-note").textContent = [
    `Same page views, users, advertisers, strategies, and pacing; only the auction rule changes. Green is the best in each column.`,
    `First price ${f.fp.revenue >= f.sp.revenue ? "earns the publisher" : "costs the publisher"} ${money(Math.abs(f.fp.revenue - f.sp.revenue))} ${f.fp.revenue >= f.sp.revenue ? "more" : "less"} than second price here`
      + (valueB && !shaders ? ", because nobody shades: value bidders pay their full bid." : shaders ? `, with ${shaders} of ${cfg.advertisers.length} advertisers shading.` : "."),
    `GSP sells three slots per page, so it sells more impressions at a lower average CPM; slots 2 and 3 get 60% and 35% of slot 1's clicks.`,
    `Where budgets bind, revenue barely moves between formats: the money is the budgets either way, and the format changes who gets which impressions.`,
  ].join(" ");
  $("fmt-rows").onclick = (e) => {
    const tr = e.target.closest("[data-format]");
    if (!tr || tr.dataset.format === cfg.format) return;
    cfg = clamp({ ...cfg, format: tr.dataset.format });
    fillForm();
    update();
  };
}

function drawTruth() {
  const rows = CMP.truth, name = advName(cfg.focus);
  $("truth-sub").textContent = `${name} with no budget limit, valuing each impression at its value per conversion times its predicted conversion rate. Everyone else bids as they did on a day when ${name} bid its value. ${name} then bids a share of that value instead.`;
  const sp = rows.map((r) => r.sp.surplus), fp = rows.map((r) => r.fp.surplus);
  $("truth-rows").replaceChildren(...rows.map((r) => el("tr", { class: r.factor === 1 ? "selected" : null }, [
    el("td", { class: "name", text: r.factor === 1 ? "100% (truthful)" : pct(r.factor) }),
    el("td", { class: bestCls(r.sp.surplus, sp), text: money(r.sp.surplus) }),
    el("td", { class: "num", text: fmtInt(r.sp.wins) }),
    el("td", { class: r.fp.surplus < 0 ? "num bad" : bestCls(r.fp.surplus, fp), text: money(r.fp.surplus) }),
    el("td", { class: "num", text: fmtInt(r.fp.wins) }),
  ])));
  const bestFp = rows.reduce((a, b) => (b.fp.surplus > a.fp.surplus ? b : a));
  $("truth-note").textContent = `In second price the price does not depend on your own bid, only on whether you win, so bidding value is the best you can do: bidding less loses auctions you would have profited from, bidding more wins auctions that cost more than they are worth. `
    + `In first price you pay what you bid, so bidding value earns nothing; of the bids tried, ${pct(bestFp.factor)} of value earns the most. That gap is what bid shading tries to learn from win and loss feedback.`;
}

function drawPacing() {
  const rows = CMP.pacing;
  const col = (k) => rows.map((r) => r[k]);
  $("pace-rows").replaceChildren(...rows.map((r) => {
    const early = r.rows.filter((x) => x.exhaustT >= 0 && x.exhaustT < OUT_BY).length;
    const first = r.rows.filter((x) => x.exhaustT >= 0).reduce((m, x) => Math.min(m, x.exhaustT), Infinity);
    return el("tr", { "data-pacing": r.id, class: r.id === cfg.pacing ? "selected" : null, title: "Click to use this pacing" }, [
      el("td", { class: "name", text: r.label }),
      el("td", { class: bestCls(r.conv, col("conv")), text: fmt1(r.conv) }),
      el("td", { class: bestCls(r.welfare, col("welfare")), text: money(r.welfare) }),
      el("td", { class: "num", text: money(r.spend) }),
      el("td", { class: bestCls(r.spend / r.conv, rows.map((x) => x.spend / x.conv), -1), text: money(r.spend / r.conv) }),
      el("td", { class: `num${early ? " bad" : ""}`, text: `${early} of ${r.rows.length}` }),
      el("td", { class: "num", text: Number.isFinite(first) ? fmtTime(first) : "never" }),
    ]);
  }));
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  const opt = cfg.advertisers.filter((a) => a.strategy === "optimal").length;
  $("pace-note").textContent = `Same impressions and format, only the pacing changes. Without pacing, budgets go to whatever is on sale first: cheap overnight and morning traffic, often to heavy users, at full value bids. `
    + `Even pacing spreads entries over the day; the bid multiplier also lowers bids, so the same budget buys more impressions at lower prices. `
    + `Here the multiplier buys ${fmt1(by.multiplier.conv - by.none.conv)} more conversions than no pacing (${pct(by.multiplier.conv / by.none.conv - 1)}).`
    + (opt ? ` ${opt} budget-optimal advertiser${opt > 1 ? "s pace themselves" : " paces itself"} in every row.` : "");
  $("pace-rows").onclick = (e) => {
    const tr = e.target.closest("[data-pacing]");
    if (!tr || tr.dataset.pacing === cfg.pacing) return;
    cfg = clamp({ ...cfg, pacing: tr.dataset.pacing });
    fillForm();
    update();
  };
}

// ---------------------------------------------------------------------------
// Auction inspector

const STATUS = ["", "Under floor", "Throttled", "Capped", "Budget out"];

function defaultPick() {
  // The first auction after 20:30 the focus advertiser bid in, else the first after 20:30.
  const { times } = R.world;
  let j = 0;
  while (j < R.N - 1 && times[j] < 20.5 * 60) j++;
  for (let k = j; k < Math.min(R.N, j + 2000); k++) if (R.trace.status[k * R.A + cfg.focus] === 0) return k;
  return j;
}

function drawInspector() {
  if (!R) return;
  const j = Math.max(0, Math.min(R.N - 1, pickJ));
  const A = R.A, K = R.K, T = R.trace, W = R.world;
  $("pick").max = String(R.N - 1);
  $("pick").value = String(j);
  const floor = W.floor[j];
  $("inspect-meta").replaceChildren(...[
    ["Auction", `${fmtInt(j + 1)} of ${fmtInt(R.N)}`],
    ["Time", fmtTime(W.times[j])],
    ["User", `#${W.user[j] + 1}, ${SEGMENTS[W.seg[j]]}`],
    ["Page", CONTEXTS[W.ctx[j]].label],
    ["Floor", cpm(floor)],
  ].map(([a, b]) => el("div", {}, [el("span", { text: a }), el("b", { text: b })])));
  const slotOf = new Map();
  for (let k = 0; k < K; k++) { const w = T.win[j * K + k]; if (w >= 0) slotOf.set(w, k); }
  const ids = Array.from({ length: A }, (_, i) => i).sort((a, b) => {
    const ba = T.status[j * A + a] <= 1 ? T.bids[j * A + a] : -1, bb = T.status[j * A + b] <= 1 ? T.bids[j * A + b] : -1;
    return bb - ba || a - b;
  });
  $("inspect-rows").replaceChildren(...ids.map((i) => {
    const st = T.status[j * A + i], bid = T.bids[j * A + i], r = R.rows[i];
    const slot = slotOf.get(i);
    const won = slot != null;
    const res = won ? el("span", { class: "status won", text: K > 1 ? `Won slot ${slot + 1}` : "Won" }) : st === 0 ? el("span", { class: "status lost", text: "Lost" }) : el("span", { class: `status${st === 4 ? " out" : ""}`, text: STATUS[st] });
    const ctl = r.mode === "multiplier" ? `x ${T.ctl[j * A + i].toFixed(2)}` : r.mode === "throttle" ? `p ${T.ctl[j * A + i].toFixed(2)}` : "";
    return el("tr", { class: i === cfg.focus ? "selected" : null }, [
      el("td", { class: "name" }, [sw(i), r.name, el("small", { text: STRATEGIES[r.strategy].label })]),
      el("td", { class: "num", text: cpm(T.vals[j * A + i]) }),
      el("td", { class: "num", text: ctl }),
      el("td", { class: "num", text: st <= 1 && Number.isFinite(bid) ? cpm(bid) : "" }),
      el("td", {}, [res]),
      el("td", { class: "num", text: won ? cpm(T.price[j * K + slot]) : "" }),
    ]);
  }));
  // One sentence on why the winner paid what it paid.
  const w0 = T.win[j * K];
  let note;
  if (w0 < 0) note = `No bid reached the ${cpm(floor)} floor, so the impression went unsold.`;
  else {
    const bids = ids.filter((i) => T.status[j * A + i] === 0).map((i) => T.bids[j * A + i]);
    const p0 = T.price[j * K];
    if (R.format === "fp") note = `${advName(w0)} bid ${cpm(bids[0])} and pays its own bid. The next bid was ${bids.length > 1 ? cpm(bids[1]) : "none"}, so it left ${bids.length > 1 ? cpm(bids[0] - Math.max(bids[1], floor)) : cpm(bids[0] - floor)} on the table.`;
    else if (R.format === "sp") note = `${advName(w0)} bid ${cpm(bids[0])} and pays ${cpm(p0)}, ${bids.length > 1 && bids[1] >= floor && Math.abs(bids[1] - p0) < 1e-9 ? "the second highest bid" : "the floor, which was above any other bid"}.`;
    else note = `Slot 1 pays the second bid; slot 2 pays 60% of the third; slot 3 pays 35% of the fourth (or the floor). ${advName(w0)} bid ${cpm(bids[0])} and pays ${cpm(p0)}.`;
  }
  $("inspect-note").textContent = note;
}

function jump(pred) {
  if (!R) return;
  for (let k = 1; k < R.N; k++) {
    const j = (pickJ + k) % R.N;
    if (pred(j)) { pickJ = j; drawInspector(); saveHash(); return; }
  }
}

$("pick").addEventListener("input", (e) => { pickJ = Number(e.target.value); drawInspector(); saveHash(); });
$("prev").addEventListener("click", () => { if (R) { pickJ = (pickJ - 1 + R.N) % R.N; drawInspector(); saveHash(); } });
$("next").addEventListener("click", () => { if (R) { pickJ = (pickJ + 1) % R.N; drawInspector(); saveHash(); } });
$("close-race").addEventListener("click", () => jump((j) => {
  const A = R.A, T = R.trace;
  let a = 0, b = 0;
  for (let i = 0; i < A; i++) if (T.status[j * A + i] === 0) { const v = T.bids[j * A + i]; if (v > a) { b = a; a = v; } else if (v > b) b = v; }
  return b > 0 && (a - b) / a < 0.05;
}));
$("focus-win").addEventListener("click", () => jump((j) => { for (let k = 0; k < R.K; k++) if (R.trace.win[j * R.K + k] === cfg.focus) return true; return false; }));

// ---------------------------------------------------------------------------

$("reset").addEventListener("click", () => {
  cfg = clamp(presetValues(cfg.preset));
  pickJ = -1;
  drawAll();
});

$("share").addEventListener("click", async () => {
  const btn = $("share");
  try {
    await navigator.clipboard.writeText(location.href);
    btn.textContent = "Link copied";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy share link"), 1500);
});

window.addEventListener("hashchange", () => {
  const next = decodeConfig(location.hash), j = readJ(location.hash);
  if (encodeConfig(next) === encodeConfig(cfg)) { if (j >= 0 && j !== pickJ) { pickJ = j; drawInspector(); } return; }
  cfg = next;
  pickJ = j;
  drawAll();
});

let wasNarrow = narrow();
window.addEventListener("resize", () => {
  if (narrow() === wasNarrow || !R) return;
  wasNarrow = narrow();
  drawSpend();
  drawPrices();
});

drawAll();
