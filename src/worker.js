// Runs the day off the main thread: the configured run first (with every bid kept for the inspector),
// then the format, pacing, and truthfulness comparisons.
import { compareAll, generateWorld, simulate } from "./auction.js";

self.onmessage = (e) => {
  const { id, cfg, only } = e.data;
  const w = generateWorld(cfg);
  if (only !== "compare") {
    const r = simulate(cfg, { trace: true, world: w });
    r.world = { times: w.times, user: w.user, seg: w.seg, ctx: w.ctx, floor: w.floor };
    const T = r.trace;
    self.postMessage({ id, kind: "main", result: r }, [T.bids.buffer, T.vals.buffer, T.status.buffer, T.win.buffer, T.price.buffer, T.ctl.buffer]);
  }
  self.postMessage({ id, kind: "compare", cmp: compareAll(cfg, w) });
};
