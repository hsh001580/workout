import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracker } from '../js/bar-track.js';
import { barSeries, concentric, estimate1RM, rirFromVelocity } from '../js/bar-analysis.js';
import { evaluateForm } from '../js/form-eval.js';
import { getThresholds, PRESETS } from '../js/thresholds.js';

// ---------- 바벨 추적 ----------
function plateImage(w, h, cx, cy, r) {
  const g = new Float32Array(w * h).fill(90);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < r) {
        // 원판: 어두운 원 + 밝은 허브 + 비대칭 무늬(로고)
        g[y * w + x] = d < r * 0.25 ? 220 : 30 + 40 * Math.sin((x - cx) * 0.35) + (y - cy > r * 0.4 ? 60 : 0);
      }
    }
  }
  return g;
}

test('원판 추적: 위아래로 움직이는 원판을 1px 이내로 따라감', () => {
  const w = 160;
  const h = 200;
  const r = 24;
  const path = Array.from({ length: 40 }, (_, i) => ({ x: 80 + 3 * Math.sin(i / 6), y: 100 + 50 * Math.sin((Math.PI * i) / 20) }));
  const tr = createTracker(plateImage(w, h, path[0].x, path[0].y, r), w, h, path[0].x, path[0].y, r);
  let maxErr = 0;
  for (const p of path.slice(1)) {
    const res = tr.update(plateImage(w, h, p.x, p.y, r));
    assert.ok(!res.lost);
    maxErr = Math.max(maxErr, Math.hypot(res.x - p.x, res.y - p.y));
  }
  assert.ok(maxErr < 1.2, `maxErr ${maxErr}`);
});

// ---------- 바벨 속도 ----------
test('동심성 속도·스티킹 포인트', () => {
  // 0.5m 상승. 처음 빠르다가 40% 지점에서 감속 후 재가속
  const fps = 30;
  const track = [];
  let y = 1.0; // 정규화 좌표 (scale=1 → 1단위=1m)
  for (let i = 0; i <= 45; i++) {
    const t = i / fps;
    const v = t < 0.3 ? 0.6 : t < 0.7 ? 0.2 : 0.55; // m/s
    if (i) y -= v / fps;
    track.push({ t, x: 0.5, y, lost: false });
  }
  const s = barSeries(track, 1);
  const c = concentric(s, 0, 1.5, 1);
  assert.ok(c.mcv > 0.3 && c.mcv < 0.45, `mcv ${c.mcv}`);
  assert.ok(c.sticking, 'sticking');
  assert.ok(c.sticking.heightPct > 25 && c.sticking.heightPct < 75, `h ${c.sticking.heightPct}`);
});

test('하중-속도 1RM 추정 / RIR', () => {
  const e = estimate1RM([{ kg: 100, mcv: 0.7 }, { kg: 120, mcv: 0.55 }, { kg: 140, mcv: 0.42 }], 'squat');
  assert.ok(e > 150 && e < 170, `e1rm ${e}`);
  assert.equal(estimate1RM([{ kg: 100, mcv: 0.7 }], 'squat'), null);
  assert.ok(Math.abs(rirFromVelocity('squat', 0.3)) < 0.01);
});

test('프리셋', () => {
  assert.equal(getThresholds({ formPreset: 'meet' }).benchPauseRequired, 1);
  assert.equal(getThresholds({ formPreset: 'lowbar', customThresholds: { torsoLeanBad: 75 } }).torsoLeanBad, 75);
  assert.ok(Object.keys(PRESETS).length >= 4);
});

// ---------- 3D 대각선 분석 ----------
// 전역 좌표(m, y 아래)로 사람을 만든 뒤 MediaPipe처럼 골반 중심 원점으로 이동
function person(u, { valgusR = 0, shift = 0 } = {}) {
  const P = {};
  const hipY = 0.55 * u;
  const set = (i, x, y, z) => { P[i] = { x, y, z }; };
  set(23, -0.1 + shift * u, hipY, -0.3 * u); set(24, 0.1 + shift * u, hipY, -0.3 * u);
  set(25, -0.14, 0.45 + 0.05 * u, 0.2 * u); set(26, 0.14 - valgusR * u, 0.45 + 0.05 * u, 0.2 * u);
  set(27, -0.13, 0.9, 0); set(28, 0.13, 0.9, 0);
  set(29, -0.13, 0.93, -0.05); set(30, 0.13, 0.93, -0.05);
  set(31, -0.16, 0.95, 0.15); set(32, 0.16, 0.95, 0.15);
  const lean = (40 * u * Math.PI) / 180;
  set(11, -0.18, hipY - 0.5 * Math.cos(lean), -0.3 * u + 0.5 * Math.sin(lean)); set(12, 0.18, hipY - 0.5 * Math.cos(lean), -0.3 * u + 0.5 * Math.sin(lean));
  set(13, -0.25, P[11].y + 0.1, P[11].z - 0.1); set(14, 0.25, P[12].y + 0.1, P[12].z - 0.1);
  set(15, -0.3, P[11].y, P[11].z); set(16, 0.3, P[12].y, P[12].z);
  const c = { x: (P[23].x + P[24].x) / 2, y: (P[23].y + P[24].y) / 2, z: (P[23].z + P[24].z) / 2 };
  const world = Array.from({ length: 33 }, (_, i) => (P[i] ? { x: P[i].x - c.x, y: P[i].y - c.y, z: P[i].z - c.z } : { x: 0, y: 0, z: 0 }));
  const lm = Array.from({ length: 33 }, (_, i) => ({ x: 0.5 + (P[i]?.x ?? 0) * 0.4, y: 0.1 + (P[i]?.y ?? 0) * 0.8, z: 0, visibility: P[i] ? 0.95 : 0.1 }));
  return { world, lm };
}

function squatSet(opts, reps = 3) {
  const frames = [];
  const per = 40;
  for (let r = 0; r < reps; r++) for (let i = 0; i < per; i++) frames.push({ t: (r * per + i) / 15, ...person(Math.sin((Math.PI * i) / per), opts) });
  frames.push({ t: (reps * per) / 15, ...person(0, opts) });
  return frames;
}

test('후방 45° 3D: 정상 스쿼트는 밸거스 없음, 깊이·반복 인식', () => {
  const res = evaluateForm({ frames: squatSet({}), lift: 'squat', view: 'oblique' });
  assert.ok(res.ok, res.error);
  assert.equal(res.reps.length, 3);
  assert.ok(res.stats.valgus < 5, `valgus ${res.stats.valgus}`);
  assert.ok(res.reps.every((r) => r.issues.some((i) => i.text.includes('깊이 충분'))), JSON.stringify(res.reps[0].issues));
});

test('후방 45° 3D: 오른 무릎 밸거스와 힙 시프트 감지', () => {
  const res = evaluateForm({ frames: squatSet({ valgusR: 0.14, shift: 0.06 }), lift: 'squat', view: 'oblique', T: getThresholds({}) });
  assert.ok(res.ok, res.error);
  assert.ok(res.stats.valgus > 12, `valgus ${res.stats.valgus}`);
  const texts = res.reps.flatMap((r) => r.issues.map((i) => i.text)).join('\n');
  assert.match(texts, /오른쪽 무릎이 안쪽으로/);
  assert.match(texts, /골반이 오른쪽으로 [\d.]+cm 이동/);
  assert.ok(Math.abs(res.stats.hipShiftCm - 6) < 1, `shift ${res.stats.hipShiftCm}`);
  assert.ok(res.score < 90);
});
