// 전 종목 평가 체계 (규정·효율·주의·일관성 + 스타일) 검증
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../js/form-analysis.js';
import { detectStyle } from '../js/form-eval.js';
import { DEFAULT_THRESHOLDS as BASE } from '../js/thresholds.js';
import { flagsOf, prescribe, phaseAt } from '../js/coach.js';

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
const all = (res) => res.reps.flatMap((r) => r.issues.map((i) => `${i.cat}/${i.level}:${i.text}`)).concat(res.summary.map((i) => `${i.cat}/${i.level}:${i.text}`)).join('\n');
const T = (style = {}) => ({ ...BASE, _style: style });

test('스쿼트 규정: 상승 중 재하강 → 해당 회차 규정 실패', () => {
  const redip = (p) => {
    let u;
    // 0.35초 동안 다시 내려가는 더블 바운스
    if (p < 0.4) u = Math.sin((Math.PI / 2) * (p / 0.4));
    else if (p < 0.55) u = 1 - 0.4 * ((p - 0.4) / 0.15);
    else if (p < 0.7) u = 0.6 + 0.3 * ((p - 0.55) / 0.15);
    else u = 0.9 * (1 - (p - 0.7) / 0.3);
    return sq(u);
  };
  const res = analyze(squatReps([rep(), redip, rep()]), 'squat', 1, T());
  assert.ok(res.ok, res.error);
  res.finalize();
  assert.equal(res.reps.length, 3);
  assert.ok(res.reps[0].rulePass && res.reps[2].rulePass);
  assert.ok(!res.reps[1].rulePass, all(res));
  assert.match(all(res), /rule\/bad:상승 중 하강/);
  assert.match(all(res), /규정 판정: 3회 중 2회 성공 \(실패: 2회차\)/);
});

test('스쿼트 규정: 반복 중 발 이동', () => {
  const moving = (p) => sq(Math.sin(Math.PI * p), { dx: 0.06 * p });
  const res = analyze(squatReps([rep(), moving, rep()]), 'squat', 1, T());
  res.finalize();
  assert.match(all(res), /rule\/bad:발 위치 이동/);
});

test('스쿼트 스타일: 같은 상체각도 하이바는 지적, 로우바는 정상', () => {
  const frames = squatReps([rep(1, { leanAdd: 47 }), rep(1, { leanAdd: 47 })]); // 하단 상체각 57°
  const hi = analyze(frames, 'squat', 1, T({ squat: 'highbar' }));
  const lo = analyze(frames, 'squat', 1, T({ squat: 'lowbar' }));
  assert.match(all(hi), /하이바 기준보다 크게 숙여짐/);
  assert.doesNotMatch(all(lo), /기준보다 크게 숙여짐/);
});

test('스쿼트 일관성: 회차마다 깊이가 다르면 지적', () => {
  const res = analyze(squatReps([rep(1.15), rep(0.8), rep(1.15)]), 'squat', 1, T());
  res.finalize();
  assert.match(all(res), /cons\/warn:깊이가 회차마다 다름/);
});

// 데드리프트: u 0 = 바닥, 1 = 락아웃
const dl = (u, { lean0 = 60, early = 0 } = {}) => {
  // 현실적인 당김: 무릎 높이까지는 등 각도 유지, 이후 상체를 세움. early: 초반에 상체가 더 숙여지는 정도(엉덩이 먼저 뜸)
  const bump = early * Math.sin(Math.PI * Math.min(1, u / 0.6));
  const lean = lean0 * (1 - Math.max(0, (u - 0.3) / 0.7)) + bump;
  return fig({ phi: 70 * (1 - u), shin: 15 * (1 - u), lean, armDown: true });
};
function dlReps(paths) {
  const frames = [];
  let t = 0;
  const add = (arr) => { arr.forEach((f) => { frames.push({ t: +t.toFixed(4), lm: f.lm }); t += 1 / FPS; }); };
  add(seq(() => dl(0), 1));
  for (const path of paths) { add(seq(path, 1.5)); add(seq(() => dl(1), 0.6)); add(seq((p) => dl(1 - p), 1)); add(seq(() => dl(0), 0.6)); }
  return frames;
}

test('데드리프트 규정: 당기는 중 하강(히칭) 감지, 정상 회차는 락아웃 통과', () => {
  // 0.3초 동안 바가 다시 내려갔다가(허벅지에 얹기) 마무리하는 히칭
  const hitch = (p) => dl(p < 0.45 ? (p / 0.45) * 0.7 : p < 0.65 ? 0.7 - ((p - 0.45) / 0.2) * 0.2 : 0.5 + ((p - 0.65) / 0.35) * 0.5);
  const res = analyze(dlReps([(p) => dl(p), hitch]), 'deadlift', 1, T());
  assert.ok(res.ok, res.error);
  res.finalize();
  assert.equal(res.reps.length, 2);
  assert.ok(res.reps[0].rulePass);
  assert.ok(res.reps[0].issues.some((i) => i.text.startsWith('락아웃 완료')));
  assert.match(res.reps[1].issues.map((i) => i.text).join('\n'), /당기는 중 하강·히칭/);
});

test('데드리프트 스타일: 초반 등 각도 변화 10°는 컨벤셔널 허용, 스모는 지적', () => {
  const frames = dlReps([(p) => dl(p, { early: 10 }), (p) => dl(p, { early: 10 })]);
  const conv = analyze(frames, 'deadlift', 1, T({ deadlift: 'conventional' }));
  const sumo = analyze(frames, 'deadlift', 1, T({ deadlift: 'sumo' }));
  assert.doesNotMatch(all(conv), /등 각도가 무너짐/);
  assert.match(all(sumo), /등 각도가 무너짐/);
});

test('스모 자동 감지 (정면: 발 너비/골반 너비)', () => {
  const mk = (feet) => Array.from({ length: 10 }, (_, i) => {
    const lm = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }));
    lm[23] = { x: 0.45, y: 0.5, visibility: 0.9 }; lm[24] = { x: 0.55, y: 0.5, visibility: 0.9 };
    lm[27] = { x: 0.5 - feet, y: 0.9, visibility: 0.9 }; lm[28] = { x: 0.5 + feet, y: 0.9, visibility: 0.9 };
    return { t: i / 15, lm };
  });
  assert.equal(detectStyle(mk(0.12), 'deadlift', 'front').deadlift, 'sumo');
  assert.equal(detectStyle(mk(0.06), 'deadlift', 'front').deadlift, 'conventional');
});

// 벤치 (누운 자세, 머리 왼쪽)
function bench({ elbowHigh = 0, headUp = 0, reps = 2 } = {}) {
  const frames = [];
  let t = 0;
  const S = { x: 0.4, y: 0.6 };
  const H = { x: 0.7, y: 0.62 };
  const torso = Math.hypot(H.x - S.x, H.y - S.y);
  const push = (u, asc) => {
    const wx = S.x + 0.3 * torso * u;
    const wrist = { x: wx, y: S.y - 0.25 + 0.17 * u };
    const elbow = u > 0.9 ? { x: wrist.x, y: S.y + 0.03 - elbowHigh * torso } : { x: (S.x + wrist.x) / 2, y: (S.y + wrist.y) / 2 + 0.06 * u };
    const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.1 }));
    const set = (i, p) => { lm[i] = { x: p.x, y: p.y, z: 0, visibility: 0.95 }; };
    set(0, { x: 0.3, y: 0.58 - headUp * torso * asc });
    set(12, S); set(14, elbow); set(16, wrist); set(24, H);
    set(26, { x: 0.85, y: 0.55 }); set(28, { x: 0.9, y: 0.8 }); set(32, { x: 0.93, y: 0.8 });
    frames.push({ t: +t.toFixed(4), lm });
    t += 1 / FPS;
  };
  for (let i = 0; i < 9; i++) push(0, 0);
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < 22; i++) push(i / 22, 0);
    for (let i = 0; i < 9; i++) push(1, 0);
    for (let i = 0; i <= 15; i++) push(1 - i / 15, i / 15);
    for (let i = 0; i < 9; i++) push(0, 1);
  }
  return frames;
}

test('벤치 규정: 팔꿈치 깊이 (2023 IPF) 통과/미달', () => {
  const ok = analyze(bench(), 'bench', 1, T());
  ok.finalize();
  assert.match(all(ok), /rule\/good:팔꿈치 깊이 규정 통과/);
  const high = analyze(bench({ elbowHigh: 0.5 }), 'bench', 1, T());
  high.finalize();
  assert.match(all(high), /rule\/bad:팔꿈치 깊이 미달/);
  assert.ok(high.reps.every((r) => !r.rulePass));
});

test('벤치 규정: 머리 들림 (코 위치가 보일 때)', () => {
  const res = analyze(bench({ headUp: 0.2 }), 'bench', 1, T());
  res.finalize();
  assert.match(all(res), /rule\/bad:머리 들림/);
  assert.doesNotMatch(all(analyze(bench(), 'bench', 1, T())), /머리 들림/);
});

test('규정 위반을 먼저 고치도록 처방 (히칭 → 블록 풀)', () => {
  const settings = { squat1rm: 140, bench1rm: 100, deadlift1rm: 180, ohp1rm: 60 };
  const issues = [
    { level: 'warn', text: '무릎 높이에서 바가 다리에서 멀어짐' }, { level: 'warn', text: '무릎 높이에서 바가 다리에서 멀어짐' },
    { level: 'bad', text: '당기는 중 하강·히칭 (실격)' },
  ];
  assert.equal(flagsOf(issues.map((i) => i.text)).downward, 1);
  const state = { formLogs: [{ lift: 'deadlift', date: '2026-11-20', weight: 160, reps: 3, rpe: 8, score: 60, issues }], runLogs: [], checkins: {}, coach: {} };
  const rx = prescribe('deadlift', { state, settings, phase: phaseAt(0, {}), date: '2026-11-24' });
  assert.match(rx.variation.name, /블록 풀/);
});
