import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, angle } from '../js/form-analysis.js';
import { buildWeek, paces, fmtPace } from '../js/program.js';
import { evaluateRun, vdot, predictTime } from '../js/run-analysis.js';

const rad = (d) => (d * Math.PI) / 180;

// 측면(오른쪽을 바라봄) 막대 인형으로 MediaPipe 형식 랜드마크 생성
function figure({ phi, shin, lean, armDown = true, elbowAng = null }) {
  const ankle = { x: 0.5, y: 0.9 };
  const toe = { x: 0.56, y: 0.9 };
  const knee = { x: ankle.x + 0.2 * Math.sin(rad(shin)), y: ankle.y - 0.2 * Math.cos(rad(shin)) };
  const hip = { x: knee.x - 0.2 * Math.sin(rad(phi)), y: knee.y - 0.2 * Math.cos(rad(phi)) };
  const shoulder = { x: hip.x + 0.25 * Math.sin(rad(lean)), y: hip.y - 0.25 * Math.cos(rad(lean)) };
  let elbow;
  let wrist;
  if (elbowAng != null) {
    elbow = { x: shoulder.x - 0.12, y: shoulder.y };
    const a = rad(180 - elbowAng);
    wrist = { x: elbow.x + 0.12 * Math.cos(a), y: elbow.y - 0.12 * Math.sin(a) };
  } else if (armDown) {
    elbow = { x: shoulder.x, y: shoulder.y + 0.13 };
    wrist = { x: shoulder.x, y: shoulder.y + 0.26 };
  } else {
    elbow = { x: shoulder.x - 0.05, y: shoulder.y + 0.05 };
    wrist = { x: shoulder.x, y: shoulder.y };
  }
  const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.1 }));
  const set = (i, p) => { lm[i] = { x: p.x, y: p.y, z: 0, visibility: 0.95 }; };
  set(12, shoulder); set(14, elbow); set(16, wrist); set(24, hip); set(26, knee); set(28, ankle); set(32, toe);
  return lm;
}

function squatFrames(phiMax, reps = 3) {
  const frames = [];
  const per = 40;
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < per; i++) {
      const u = Math.sin((Math.PI * i) / per);
      frames.push({ t: (r * per + i) / 15, lm: figure({ phi: 5 + u * (phiMax - 5), shin: u * 30, lean: 10 + u * 30, armDown: false }) });
    }
  }
  frames.push({ t: (reps * per) / 15, lm: figure({ phi: 5, shin: 0, lean: 10, armDown: false }) });
  return frames;
}

test('angle()', () => {
  assert.equal(Math.round(angle({ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 })), 90);
});

test('깊은 스쿼트: 3회 인식, 깊이 OK', () => {
  const res = analyze(squatFrames(110), 'squat');
  assert.ok(res.ok, res.error);
  assert.equal(res.reps.length, 3);
  for (const r of res.reps) {
    assert.ok(r.metrics.depth >= 0, `depth ${r.metrics.depth}`);
    assert.ok(r.issues.some((i) => i.level === 'good' && i.text.includes('깊이')));
  }
  assert.ok(res.score >= 80, `score ${res.score}`);
});

test('얕은 스쿼트: 깊이 부족 지적', () => {
  const res = analyze(squatFrames(65), 'squat');
  assert.ok(res.ok);
  assert.ok(res.reps.every((r) => r.issues.some((i) => i.level === 'bad' && i.text.includes('깊이 부족'))));
  assert.ok(res.summary.some((i) => i.text.includes('반복적으로')));
  assert.ok(res.score < 85);
});

test('데드리프트: 반복 인식 및 락아웃 확인', () => {
  const frames = [];
  const per = 45;
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < per; i++) {
      const u = Math.sin((Math.PI * i) / per); // 0=바닥, 1=락아웃
      frames.push({ t: (r * per + i) / 15, lm: figure({ phi: 70 * (1 - u), shin: 15 * (1 - u), lean: 60 * (1 - u) }) });
    }
  }
  frames.push({ t: 90 / 15, lm: figure({ phi: 70, shin: 15, lean: 60 }) });
  const res = analyze(frames, 'deadlift');
  assert.ok(res.ok, res.error);
  assert.equal(res.reps.length, 2);
  assert.ok(res.reps.every((r) => r.issues.some((i) => i.text === '락아웃 완료')));
});

test('벤치: 락아웃 불완전 감지', () => {
  const frames = [];
  for (let i = 0; i <= 60; i++) {
    const u = Math.sin((Math.PI * i) / 30) ** 2; // 0=상단, 1=하단
    // 누운 자세 근사: 몸통 수평, 팔꿈치 각도 변화
    const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.1 }));
    const set = (k, x, y) => { lm[k] = { x, y, z: 0, visibility: 0.95 }; };
    const sh = { x: 0.4, y: 0.6 };
    const elbowAng = 140 - u * 60; // 140°(불완전 락아웃) → 80°
    const elbow = { x: sh.x - 0.02, y: sh.y - 0.15 * Math.sin(rad(elbowAng / 2)) * 0.2 + u * 0.05 };
    const upper = { x: elbow.x - sh.x, y: elbow.y - sh.y };
    const ua = Math.atan2(upper.y, upper.x);
    const wa = ua + Math.PI - rad(elbowAng);
    const wrist = { x: elbow.x + 0.14 * Math.cos(wa), y: elbow.y + 0.14 * Math.sin(wa) };
    set(12, sh.x, sh.y); set(14, elbow.x, elbow.y); set(16, wrist.x, wrist.y);
    set(24, 0.7, 0.62); set(26, 0.85, 0.55); set(28, 0.9, 0.8); set(32, 0.93, 0.8);
    frames.push({ t: i / 15, lm });
  }
  const res = analyze(frames, 'bench');
  assert.ok(res.ok, res.error);
  assert.ok(res.reps.some((r) => r.issues.some((i) => i.text.includes('락아웃 불완전'))));
});

test('주간 프로그램: 5일, 1주차 스쿼트 무게', () => {
  const s = { squat1rm: 140, bench1rm: 100, deadlift1rm: 180, tmPercent: 90, days: 5, weeklyKm: 20, fiveK: '25:00' };
  const w = buildWeek(s, 0);
  const sq = w.days[0].items[0];
  assert.match(sq.detail, /5세트 × 5회 @ 95kg/); // 140*0.9*0.75 = 94.5 → 95
  const trainDays = w.days.filter((d) => !d.rest).length;
  assert.equal(trainDays, 5);
  const km = w.days.flatMap((d) => d.items).filter((i) => i.type === 'run').reduce((a, i) => a + i.km, 0);
  assert.ok(Math.abs(km - 20) <= 2, `km ${km}`);
  // 디로드 주간은 러닝 감소
  assert.ok(buildWeek(s, 3).weeklyKm < w.weeklyKm);
  // 다음 주기 TM 증가
  assert.ok(buildWeek(s, 4).tm.squat > w.tm.squat);
  for (const d of [4, 6]) assert.equal(buildWeek({ ...s, days: d }, 0).days.filter((x) => !x.rest).length, d);
});

test('페이스 계산', () => {
  assert.equal(fmtPace(paces('25:00').race5k), '5:00');
});

test('VDOT: 5K 20:00 ≈ 49.8, 역산 일치', () => {
  const v = vdot(5000, 1200);
  assert.ok(Math.abs(v - 49.8) < 0.5, `vdot ${v}`);
  assert.ok(Math.abs(predictTime(v, 5000) - 1200) < 2);
});

test('러닝 평가: 너무 빠른 이지 런 감점', () => {
  const settings = { fiveK: '25:00', hrMax: 190, hrRest: 60, squat1rm: 140, bench1rm: 100, deadlift1rm: 180, days: 5, weeklyKm: 20, startDate: '2026-11-23' };
  const easyOk = evaluateRun({ type: 'easy', distanceKm: 6, duration: '38:00', avgHr: 140, rpe: 3, date: '2026-11-24' }, settings);
  const easyFast = evaluateRun({ type: 'easy', distanceKm: 6, duration: '29:00', avgHr: 178, rpe: 7, date: '2026-11-24' }, settings);
  assert.ok(easyOk.ok && easyFast.ok);
  assert.equal(easyOk.zone, 2);
  assert.ok(easyFast.score < easyOk.score - 20, `${easyFast.score} vs ${easyOk.score}`);
  const bad = evaluateRun({ type: 'easy', distanceKm: 0, duration: '' }, settings);
  assert.equal(bad.ok, false);
});
