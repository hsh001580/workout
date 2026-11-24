import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backCurve } from '../js/back-curve.js';

const rad = (d) => (d * Math.PI) / 180;

// 몸통 실루엣 마스크: 엉덩이→어깨 축, 등 쪽 윤곽 offset(t), 배 쪽 0.14L
function torsoMask({ lean = 40, facing = 1, back = () => 0.12, w = 400, h = 400 }) {
  const L = 200;
  const hip = { x: 200, y: 330 };
  const u = { x: facing * Math.sin(rad(lean)), y: -Math.cos(rad(lean)) };
  const shoulder = { x: hip.x + u.x * L, y: hip.y + u.y * L };
  const nb = { x: -facing * Math.cos(rad(lean)), y: -Math.sin(rad(lean)) }; // 등 방향 법선
  const mask = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x - hip.x;
      const py = y - hip.y;
      const t = (px * u.x + py * u.y) / L;
      const s = (px * nb.x + py * nb.y) / L;
      if (t >= -0.05 && t <= 1.05 && s <= back(Math.min(1, Math.max(0, t))) && s >= -0.14) mask[y * w + x] = 1;
    }
  }
  return { mask, w, h, hip, shoulder, facing };
}

const run = (o) => { const m = torsoMask(o); return backCurve(m.mask, m.w, m.h, m.hip, m.shoulder, m.facing); };
// 요추 구간(엉덩이→어깨 선의 10~42%) 안에서 휘는 윤곽
const lumbarShape = (amp) => (t) => 0.12 + (t > 0.1 && t < 0.42 ? amp * Math.sin((Math.PI * (t - 0.1)) / 0.32) : 0);
const lordosis = lumbarShape(-0.025);
const rounded = lumbarShape(0.03);
const kyphosis = (t) => 0.12 + (t > 0.42 ? 0.05 * Math.sin((Math.PI * (t - 0.42)) / 0.48) : 0);

test('허리: 둥글게 말림 > 곧음 > 정상 아치, 변화량이 실제 윤곽 변화와 일치', () => {
  for (const lean of [5, 40, 65]) {
    for (const facing of [1, -1]) {
      const a = run({ lean, facing, back: lordosis });
      const s = run({ lean, facing, back: () => 0.12 });
      const r = run({ lean, facing, back: rounded });
      assert.ok(a && s && r, `lean ${lean} facing ${facing}`);
      assert.ok(Math.abs(s.lumbar) < 0.01, `straight ${s.lumbar}`);
      assert.ok(a.lumbar < -0.015, `lordosis ${a.lumbar}`);
      assert.ok(r.lumbar > 0.02, `rounded ${r.lumbar}`);
      assert.ok(Math.abs(r.lumbar - a.lumbar - 0.055) < 0.012, `delta ${r.lumbar - a.lumbar}`);
    }
  }
});

test('등 상부 굽힘은 허리와 분리해 측정', () => {
  const k = run({ lean: 45, back: kyphosis });
  assert.ok(k.thoracic > 0.035, `thoracic ${k.thoracic}`);
  assert.ok(Math.abs(k.lumbar) < 0.01, `lumbar ${k.lumbar}`);
});

test('윤곽을 못 찾으면 null (관절선이 몸 밖)', () => {
  const m = torsoMask({});
  assert.equal(backCurve(m.mask, m.w, m.h, { x: 5, y: 5 }, { x: 5, y: 300 }, 1), null);
});
