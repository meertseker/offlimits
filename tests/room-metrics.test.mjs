import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics } from '../hooks/lib/room/metrics.mjs';
import { STRINGS, strings } from '../hooks/lib/room/i18n.mjs';

const H = 3600_000;
const NOW = Date.parse('2026-11-07T18:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const ev = (type, lane, msAgo, extra = {}) => ({ v: 1, type, lane, project: 'p', ts: iso(msAgo), ...extra });

test('event metrics: merges, first-pass green, review findings, brief to merge', () => {
  const events = [
    ev('lane.briefed', 'a', 50 * H), ev('lane.delivered', 'a', 40 * H, { checks: [{ name: 't', ok: true }] }),
    ev('lane.delivered', 'a', 30 * H, { checks: [{ name: 't', ok: false }] }), ev('lane.merged', 'a', 40 * H),
    ev('lane.briefed', 'b', 30 * H), ev('lane.delivered', 'b', 20 * H, { checks: [{ name: 't', ok: false }, { name: 'u', ok: true }] }), ev('lane.merged', 'b', 10 * H),
    ev('lane.merged', 'c', 10 * 24 * H),
    ev('review', 'a', 5 * H, { verdict: 'pass', defects: 0 }), ev('review', 'b', 5 * H, { verdict: 'fail' }), ev('review', 'b', 4 * H, { defects: 2 }),
  ];
  const m = computeMetrics({ events, requests: [], lanes: [], history: null, now: () => NOW });
  assert.equal(m.lanesMerged7d, 2);
  assert.equal(m.events, 11);
  assert.deepEqual(m.firstPassGreen, { n: 2, share: 0.5 });
  assert.deepEqual(m.reviewFindings, { n: 3, share: 2 / 3 });
  assert.deepEqual(m.briefToMerge, { n: 2, medianH: 15, p90H: 20 });
});

test('approval answer time is never negative; lane counts; prompts and orchestration from history', () => {
  const requests = [
    { requestedAt: NOW - 60 * 60_000, answers: [{ at: new Date(NOW - 51 * 60_000).toISOString() }] },
    { requestedAt: NOW - 10 * 60_000, answers: [{ at: new Date(NOW - 20 * 60_000).toISOString() }] },
    { requestedAt: NOW - 8 * 24 * H, answers: [{ at: new Date(NOW - 8 * 24 * H + 60_000).toISOString() }] },
    { requestedAt: NOW, answers: [] },
  ];
  const lanes = [{ state: 'main' }, { state: 'building' }, { state: 'delivered' }, { state: 'stale' }, { state: 'merged' }, { state: 'missing' }];
  const history = { days: [{ date: 'd', total: 3, byProject: {} }], thisWeek: { prompts: 40, orchestration: 0.25 }, lastWeek: { prompts: 30, orchestration: 0.5 } };
  const m = computeMetrics({ events: [], requests, lanes, history, now: () => NOW });
  assert.equal(m.approvalsAnswered7d, 2);
  assert.deepEqual(m.answerTime, { n: 3, medianMin: 1 });
  assert.deepEqual([m.openLanes, m.staleLanes, m.cleanupLanes], [3, 1, 2]);
  assert.equal(m.prompts7d, 40);
  assert.deepEqual(m.orchestration, { thisWeek: 0.25, lastWeek: 0.5 });
  assert.deepEqual(m.promptsPerDay, history.days);
});

test('no data gives nulls, not zeros pretending to be measurements', () => {
  const m = computeMetrics({ events: [], requests: [], lanes: [], history: null, now: () => NOW });
  assert.equal(m.events, 0);
  assert.equal(m.firstPassGreen, null);
  assert.equal(m.reviewFindings, null);
  assert.equal(m.briefToMerge, null);
  assert.equal(m.answerTime, null);
  assert.equal(m.orchestration, null);
  assert.equal(m.prompts7d, null);
  assert.deepEqual(m.promptsPerDay, []);
});

test('English and Turkish strings have the same keys, and unknown languages fall back to English', () => {
  assert.deepEqual(Object.keys(STRINGS.tr).sort(), Object.keys(STRINGS.en).sort());
  for (const [k, v] of Object.entries(STRINGS.tr)) {
    const want = (STRINGS.en[k].match(/\{\w+\}/g) || []).sort();
    assert.deepEqual((v.match(/\{\w+\}/g) || []).sort(), want, `placeholders differ for ${k}`);
  }
  assert.equal(strings('xx'), STRINGS.en);
  assert.equal(strings('tr').title, 'Kumanda');
});
