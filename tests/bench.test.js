import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, CHECKLIST } from '../js/form-analysis.js';
import { flagsOf, prescribe, phaseAt } from '../js/coach.js';

// 누운 리프터 (머리가 화면 왼쪽). 오른쪽 측면 관절만 보임
function benchSet({ touch = 0.3, jcurve = true, descent = 1.5, pause = 0.6, buttLift = 0, shoulderLift = 0, feet = 0, reps = 3, touches = null } = {}) {
  const fps = 15;
  const frames = [];
  let t = 0;
  const S0 = { x: 0.4, y: 0.6 };
  const H0 = { x: 0.7, y: 0.62 };
  const torso = Math.hypot(H0.x - S0.x, H0.y - S0.y);
  const push = (u, asc, rep) => {
    const tc = touches ? touches[rep] : touch;
    const bottomX = S0.x + tc * torso;
    const topX = jcurve ? S0.x : bottomX;
    const sh = { x: S0.x, y: S0.y - shoulderLift * torso * asc };
    const hip = { x: H0.x, y: H0.y - buttLift * torso * asc };
    const wx = asc > 0 ? bottomX + (topX - bottomX) * (1 - u) : topX + (bottomX - topX) * u;
    const wrist = { x: wx, y: sh.y - 0.25 + 0.17 * u };
    const elbow = { x: (sh.x + wrist.x) / 2 + 0.0, y: (sh.y + wrist.y) / 2 + 0.06 * u };
    if (u > 0.9) { elbow.x = wrist.x; elbow.y = sh.y + 0.03; }
    const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.1 }));
    const set = (i, p) => { lm[i] = { x: p.x, y: p.y, z: 0, visibility: 0.95 }; };
    set(12, sh); set(14, elbow); set(16, wrist); set(24, hip);
    set(26, { x: 0.85, y: 0.55 }); set(28, { x: 0.9 + feet * asc, y: 0.8 }); set(32, { x: 0.93 + feet * asc, y: 0.8 });
    frames.push({ t: +t.toFixed(4), lm });
    t += 1 / fps;
  };
  for (let i = 0; i < 9; i++) push(0, 0, 0); // 락아웃에서 시작
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < descent * fps; i++) push(i / (descent * fps), 0, r); // 하강
    for (let i = 0; i < pause * fps; i++) push(1, 0, r); // 정지
    for (let i = 0; i <= fps; i++) push(1 - i / fps, i / fps, r); // 프레스
    for (let i = 0; i < 9; i++) push(0, 1, r); // 락아웃
  }
  return frames;
}

const texts = (res) => res.reps.flatMap((r) => r.issues.map((i) => `${i.level}:${i.text}`)).concat(res.summary.map((i) => `${i.level}:${i.text}`));

test('올바른 벤치: 결함 없음, 하단 브레이싱(복압) 문구 없음', () => {
  const res = analyze(benchSet(), 'bench');
  assert.ok(res.ok, res.error);
  res.finalize();
  assert.equal(res.reps.length, 3);
  const all = texts(res).join('\n');
  assert.doesNotMatch(all, /복압|재브레이싱|숨을 다시 채우고/);
  assert.doesNotMatch(all, /^(warn|bad):/m, all);
  assert.match(all, /터치 위치 적정/);
  assert.match(all, /회차 간 터치 위치 일정/);
  assert.ok(res.reps[0].metrics.touch > 0.2 && res.reps[0].metrics.touch < 0.4);
});

test('결함 벤치: 높은 터치·직선 경로·빠른 하강·엉덩이 뜸·어깨 들림·발 움직임 감지', () => {
  const res = analyze(benchSet({ touch: 0.02, jcurve: false, descent: 0.4, pause: 0, buttLift: 0.15, shoulderLift: 0.2, feet: 0.06 }), 'bench');
  assert.ok(res.ok, res.error);
  res.finalize();
  const all = texts(res).join('\n');
  for (const re of [/터치 위치가 높음/, /하강이 너무 빠름/, /엉덩이가 벤치에서 뜸/, /어깨가 들림/, /발을 옮김/]) assert.match(all, re);
  assert.ok(res.reps.every((r) => r.score < 75));
});

test('J 경로 없이 수직으로 밀면 지적, 터치가 회차마다 다르면 지적', () => {
  const noJ = analyze(benchSet({ touch: 0.35, jcurve: false }), 'bench');
  assert.match(texts(noJ).join('\n'), /어깨 쪽으로 돌아오지 않고/);
  const vary = analyze(benchSet({ touches: [0.1, 0.45, 0.15] }), 'bench');
  vary.finalize();
  assert.match(texts(vary).join('\n'), /터치 위치가 회차마다 다름/);
});

test('벤치 결함 → 코칭 처방 (엉덩이 뜸 → 피트업 벤치, 견갑 풀림 → 스포토 프레스·페이스 풀)', () => {
  const issues = [{ level: 'bad', text: '엉덩이가 벤치에서 뜸 (대회 실격): 레그 드라이브는', n: 3 }];
  const f = flagsOf(issues.map((i) => i.text));
  assert.equal(f.buttLift, 1);
  const settings = { squat1rm: 140, bench1rm: 100, deadlift1rm: 180, ohp1rm: 60 };
  const st = (texts2) => ({ formLogs: [{ lift: 'bench', date: '2026-11-20', weight: 80, reps: 5, rpe: 8, score: 70, issues: texts2.map((t) => ({ level: 'warn', text: t })) }], runLogs: [], checkins: {}, coach: {} });
  const rx1 = prescribe('bench', { state: st(['엉덩이가 벤치에서 뜸 (대회 실격)']), settings, phase: phaseAt(0, {}), date: '2026-11-24' });
  assert.match(rx1.variation.name, /피트업 벤치/);
  const rx2 = prescribe('bench', { state: st(['프레스 중 어깨가 들림 (견갑 풀림)']), settings, phase: phaseAt(0, {}), date: '2026-11-24' });
  assert.match(rx2.variation.name, /스포토 프레스/);
  assert.ok(rx2.accessories.some((a) => /페이스 풀/.test(a)));
  const rx3 = prescribe('bench', { state: st(['발이 움직임: 셋업에서']), settings, phase: phaseAt(0, {}), date: '2026-11-24' });
  assert.equal(rx3.variation, null); // 큐만 처방
  assert.ok(rx3.cues.some((c) => /발 위치/.test(c)));
});

test('벤치 체크리스트에 호흡은 락아웃 기준, 복압 항목 없음', () => {
  assert.ok(CHECKLIST.bench.some((c) => /락아웃에서 숨/.test(c)));
  assert.ok(!CHECKLIST.bench.some((c) => /복압/.test(c)));
});
