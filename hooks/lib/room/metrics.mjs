// Metrics for the control room. A metric without data is null; nothing is estimated.

const DAY = 86_400_000;

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function p90(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(0.9 * s.length) - 1)];
}

const round = (x, d = 1) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);
const key = (e) => `${e.project ?? ''}\u0000${e.lane ?? ''}`;
const ms = (e) => Date.parse(e.ts);

/**
 * @param {{events: object[], requests: object[], lanes: object[], history: object|null, now?: () => number}} input
 */
export function computeMetrics({ events = [], requests = [], lanes = [], history = null, now = Date.now }) {
  const t = now();
  const week = t - 7 * DAY;
  const sorted = [...events].filter((e) => Number.isFinite(ms(e))).sort((a, b) => ms(a) - ms(b));
  const lanesMerged7d = sorted.filter((e) => e.type === 'lane.merged' && ms(e) >= week).length;

  const firstDelivery = new Map();
  for (const e of sorted) if (e.type === 'lane.delivered' && e.lane && !firstDelivery.has(key(e))) firstDelivery.set(key(e), e);
  const judged = [...firstDelivery.values()].filter((e) => Array.isArray(e.checks) && e.checks.length);
  const firstPassGreen = judged.length ? { n: judged.length, share: judged.filter((e) => e.checks.every((c) => c.ok)).length / judged.length } : null;

  const reviews = sorted.filter((e) => e.type === 'review');
  const withFindings = reviews.filter((e) => (Number.isInteger(e.defects) && e.defects > 0) || e.verdict === 'fail' || e.verdict === 'changes');
  const reviewFindings = reviews.length ? { n: reviews.length, share: withFindings.length / reviews.length } : null;

  const briefed = new Map();
  const spans = [];
  const merged = new Set();
  for (const e of sorted) {
    if (!e.lane) continue;
    if (e.type === 'lane.briefed' && !briefed.has(key(e))) briefed.set(key(e), ms(e));
    if (e.type === 'lane.merged' && briefed.has(key(e)) && !merged.has(key(e))) {
      merged.add(key(e));
      spans.push((ms(e) - briefed.get(key(e))) / 3600_000);
    }
  }
  const briefToMerge = spans.length ? { n: spans.length, medianH: round(median(spans)), p90H: round(p90(spans)) } : null;

  let approvalsAnswered7d = 0;
  const waits = [];
  for (const r of requests) {
    const a = (r.answers || []).find((x) => x && x.at);
    if (!a) continue;
    const at = Date.parse(a.at);
    if (!Number.isFinite(at)) continue;
    if (at >= week) approvalsAnswered7d++;
    if (Number.isFinite(r.requestedAt)) waits.push(Math.max(0, at - r.requestedAt) / 60_000);
  }
  const answerTime = waits.length ? { n: waits.length, medianMin: round(median(waits), 0) } : null;

  const count = (...states) => lanes.filter((l) => states.includes(l.state)).length;
  const orch = history && (history.thisWeek?.orchestration != null || history.lastWeek?.orchestration != null)
    ? { thisWeek: history.thisWeek?.orchestration ?? null, lastWeek: history.lastWeek?.orchestration ?? null }
    : null;
  return {
    lanesMerged7d,
    firstPassGreen,
    reviewFindings,
    briefToMerge,
    approvalsAnswered7d,
    answerTime,
    openLanes: count('building', 'delivered', 'stale'),
    staleLanes: count('stale'),
    cleanupLanes: count('merged', 'missing'),
    prompts7d: history ? history.thisWeek?.prompts ?? 0 : null,
    orchestration: orch,
    promptsPerDay: history ? history.days || [] : [],
  };
}
