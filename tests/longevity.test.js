// 지속 성장 평가 체계: 척추 굽힘(등 윤곽), 세트 후반 무너짐, 평가 목적 모드, 자세 유지 한계 강도
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../js/form-analysis.js';
import { evaluateForm, fatigueDrift } from '../js/form-eval.js';
import { DEFAULT_THRESHOLDS as BASE } from '../js/thresholds.js';
import { prescribe, phaseAt } from '../js/coach.js';

const rad = (d) => (d * Math.PI) / 180;
const FPS = 15;

// 측면 인물 (오른쪽을 바라봄). phi: 허벅지(수직 기준), shin: 정강이 기울기, lean: 상체, dx: 발 이동
function fig({ phi, shin, lean, dx = 0, armDown = false }) {
  const ankle = { x: 0.5 + dx, y: 0.9 };
  const toe = { x: 0.56 + dx, y: 0.9 };
  const knee = { x: ankle.x + 0.2 * Math.sin(rad(shin)), y: ankle.y - 0.2 * Math.cos(rad(shin)) };
  const hip = { x: knee.x - 0.2 * Math.sin(rad(phi)), y: knee.y - 0.2 * Math.cos(rad(phi)) };
  const sh = { x: hip.x + 0.25 * Math.sin(rad(lean)), y: hip.y - 0.25 * Math.cos(rad(lean)) };
  const wr = armDown ? { x: sh.x, y: sh.y + 0.26 } : sh;
  const el = armDown ? { x: sh.x, y: sh.y + 0.13 } : { x: sh.x - 0.05, y: sh.y + 0.05 };
  const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.1 }));
  const set = (i, p) => { lm[i] = { x: p.x, y: p.y, z: 0, visibility: 0.95 }; };
  set(12, sh); set(14, el); set(16, wr); set(24, hip); set(26, knee); set(28, ankle); set(32, toe);
  return lm;
}
function seq(fn, dur, t0 = 0) {
  const n = Math.round(dur * FPS);
  return Array.from({ length: n }, (_, i) => ({ t: t0 + i / FPS, lm: fn(i / n) }));
}
const sq = (u, extra = {}) => fig({ phi: 5 + u * 105, shin: u * 30, lean: (extra.lean0 ?? 10) + u * (extra.leanAdd ?? 30), dx: extra.dx || 0 });
function squatReps(us, extra = {}) {
  const frames = [];
  let t = 0;
  const add = (arr) => { arr.forEach((f) => { frames.push({ t: +t.toFixed(4), lm: f.lm }); t += 1 / FPS; }); };
  add(seq(() => sq(0, extra), 1));
  for (const path of us) add(seq(path, 2.4));
  add(seq(() => sq(0, extra), 1));
  return frames;
}
const rep = (depth = 1, extra = {}) => (p) => sq(depth * Math.sin(Math.PI * p), extra);

const T = (style = {}) => ({ ...BASE, _style: style });
const texts = (res) => res.reps.flatMap((r) => r.issues.map((i) => `${i.cat}/${i.level}:${i.text}`)).concat(res.summary.map((i) => `${i.cat}/${i.level}:${i.text}`)).join('\n');

// 등 윤곽 값 주입: 서 있을 때 base, 하단 근처에서 base + flex (회차별)
function withBack(frames, base, flexPerRep, repDur = 2.4, lead = 1) {
  return frames.map((f) => {
    const k = Math.floor((f.t - lead) / repDur);
    const p = ((f.t - lead) % repDur) / repDur;
    const flex = k >= 0 && k < flexPerRep.length ? flexPerRep[k] * Math.sin(Math.PI * Math.min(1, Math.max(0, p))) : 0;
    return { ...f, back: { lumbar: base + flex, thoracic: 0 } };
  });
}

test('척추 굽힘: 스쿼트 하단에서 허리가 말리면 부하 위험 (등 윤곽 기준값 대비)', () => {
  const frames = withBack(squatReps([rep(), rep(), rep()]), -0.03, [0.08, 0.08, 0.08]);
  const res = analyze(frames, 'squat', 1, T());
  res.finalize();
  assert.match(texts(res), /risk\/bad:허리가 둥글게 말림/);
  assert.ok(res.reps.every((r) => r.metrics.lumbarFlex > 6.5 && r.metrics.lumbarFlex <= 8), JSON.stringify(res.reps.map((r) => r.metrics.lumbarFlex)));
  const ok = analyze(withBack(squatReps([rep(), rep()]), -0.03, [0.01, 0.01]), 'squat', 1, T());
  assert.doesNotMatch(texts(ok), /허리가/);
});

test('척추: 더 젖혀지는 것은 굽힘이 아님, 등 윤곽 정보가 없으면 판정 안 함, 대각선은 참고용', () => {
  const frames = squatReps([rep(0.6), rep(0.6), rep(0.6)]);
  const res = analyze(withBack(frames, -0.03, [-0.06, -0.06, -0.06]), 'squat', 1, T());
  assert.doesNotMatch(texts(res), /허리가 둥글게/); // 더 젖혀짐은 스쿼트 굽힘이 아님
  const none = analyze(squatReps([rep(), rep()]), 'squat', 1, T());
  assert.ok(none.reps.every((r) => r.metrics.lumbarFlex == null));
  const obl = analyze(withBack(squatReps([rep(), rep()]), -0.03, [0.08, 0.08]), 'squat', 1, { ...T(), _oblique: true });
  assert.match(texts(obl), /risk\/info:허리가 둥글게 말림.*참고용/);
});

test('세트 후반 무너짐: 깊이 감소 + 허리 말림 → 자세 무너짐(breakdown)', () => {
  const frames = withBack(squatReps([rep(1.15), rep(1.15), rep(0.85), rep(0.8)]), -0.03, [0, 0, 0.04, 0.045]);
  const res = evaluateForm({ frames, lift: 'squat', view: 'side' });
  assert.ok(res.ok, res.error);
  const t = texts(res);
  assert.match(t, /fatigue\/warn:세트 후반에 자세 무너짐: 깊이/);
  assert.match(t, /fatigue\/warn:세트 후반에 자세 무너짐: 허리 말림/);
  assert.match(t, /fatigue\/bad:이 무게·반복 수는/);
  assert.equal(res.stats.breakdown, true);
  const steady = evaluateForm({ frames: squatReps([rep(), rep(), rep(), rep()]), lift: 'squat', view: 'side' });
  assert.equal(steady.stats.breakdown, false);
  assert.deepEqual(fatigueDrift(steady.reps.slice(0, 2), 'squat'), []);
});

test('평가 목적: 지속 성장 모드는 실격·대회 문구 없이 가동범위·통제로, 대회 모드는 규정 판정', () => {
  const redip = (p) => {
    let u;
    if (p < 0.4) u = Math.sin((Math.PI / 2) * (p / 0.4));
    else if (p < 0.55) u = 1 - 0.4 * ((p - 0.4) / 0.15);
    else if (p < 0.7) u = 0.6 + 0.3 * ((p - 0.55) / 0.15);
    else u = 0.9 * (1 - (p - 0.7) / 0.3);
    return sq(u);
  };
  const frames = squatReps([rep(), redip, rep()]);
  const life = evaluateForm({ frames, lift: 'squat', view: 'side' });
  const meet = evaluateForm({ frames, lift: 'squat', view: 'side', purpose: 'meet' });
  const lt = texts(life);
  assert.doesNotMatch(lt, /실격|규정 판정|IPF/);
  assert.match(lt, /rom\/bad:상승 중 하강·재하강/);
  assert.ok(!life.reps.some((r) => r.issues.some((i) => i.cat === 'rule')));
  assert.match(texts(meet), /rule\/bad:상승 중 하강·재하강 \(실격\)/);
  assert.match(texts(meet), /규정 판정: 3회 중 2회 성공/);
});

const settings = { squat1rm: 140, bench1rm: 100, deadlift1rm: 180, ohp1rm: 60 };

test('자세 유지 한계 강도: 무너진 세션이 2회 이상이면 그 강도 아래로 탑세트 제한', () => {
  const log = (date, weight, breakdown) => ({ lift: 'squat', date, weight, reps: 3, rpe: 8, score: 70, issues: [], stats: { breakdown } });
  const logs = [log('2026-11-01', 120, true), log('2026-11-05', 118, false), log('2026-11-09', 122.5, true), log('2026-11-13', 115, false)];
  const phase = phaseAt(5, {}); // 강화 3주차: 3회 @ RPE 8.5 (약 89%)
  const rx = prescribe('squat', { state: { formLogs: logs, runLogs: [], checkins: {}, coach: {} }, settings, phase, date: '2026-11-20' });
  assert.ok(rx.reasons.some((r) => /자세 유지 한계 강도/.test(r)), JSON.stringify(rx.reasons));
  assert.ok(rx.kg / rx.e1rm < 0.86, `${rx.kg}/${rx.e1rm}`);
  const free = prescribe('squat', { state: { formLogs: logs.map((l) => ({ ...l, stats: { breakdown: false } })), runLogs: [], checkins: {}, coach: {} }, settings, phase, date: '2026-11-20' });
  assert.ok(free.kg > rx.kg);
});

test('지난 세션 후반 무너짐 → 세트당 반복↓, 세트 수↑', () => {
  const prev = { lift: 'squat', date: '2026-11-20', weight: 110, reps: 6, rpe: 8, score: 75, stats: { breakdown: true }, issues: [{ level: 'bad', text: '이 무게·반복 수는 지금 자세를 끝까지 유지하기 어려운 수준', cat: 'fatigue' }] };
  const phase = phaseAt(1, {});
  const base = prescribe('squat', { state: { formLogs: [], runLogs: [], checkins: {}, coach: {} }, settings, phase, date: '2026-11-24' });
  const rx = prescribe('squat', { state: { formLogs: [prev], runLogs: [], checkins: {}, coach: {} }, settings, phase, date: '2026-11-24' });
  assert.equal(rx.reps, base.reps - 1);
  assert.equal(rx.backoff.sets, base.backoff.sets + 1);
  assert.ok(rx.reasons.some((r) => /세트 후반에 자세가 무너짐/.test(r)));
});
