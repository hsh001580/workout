import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateForm } from '../js/form-eval.js';
import { findActiveWindow } from '../js/set-window.js';

const rad = (x) => (x * Math.PI) / 180;
const FPS = 15;

// 측면(오른쪽 바라봄) 인물. dx: 몸 전체 수평 이동, arms: 손목 위치 지정 함수
function body({ u = 0, dx = 0, step = 0, wrist = null }) {
  const phi = 5 + u * 105;
  const shin = u * 30;
  const lean = 10 + u * 30;
  const ankle = { x: 0.5 + dx + step, y: 0.9 };
  const ankle2 = { x: 0.5 + dx - step, y: 0.9 };
  const knee = { x: ankle.x + 0.2 * Math.sin(rad(shin)), y: ankle.y - 0.2 * Math.cos(rad(shin)) };
  const hip = { x: knee.x - 0.2 * Math.sin(rad(phi)), y: knee.y - 0.2 * Math.cos(rad(phi)) };
  const sh = { x: hip.x + 0.25 * Math.sin(rad(lean)), y: hip.y - 0.25 * Math.cos(rad(lean)) };
  const wr = wrist ? wrist(sh) : { x: sh.x, y: sh.y }; // 기본: 바를 등에 멤
  const el = { x: (sh.x + wr.x) / 2 - 0.03, y: (sh.y + wr.y) / 2 + 0.03 };
  const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.1 }));
  const set = (ids, p) => ids.forEach((i) => { lm[i] = { x: p.x, y: p.y, z: 0, visibility: 0.95 }; });
  set([11, 12], sh); set([13, 14], el); set([15, 16], wr); set([23, 24], hip); set([25, 26], knee);
  set([27], ankle); set([28], ankle2); set([31], { x: ankle.x + 0.06, y: 0.9 }); set([32], { x: ankle2.x + 0.06, y: 0.9 });
  return lm;
}

function seq(parts) {
  const frames = [];
  let t = 0;
  for (const [dur, fn] of parts) {
    const n = Math.round(dur * FPS);
    for (let i = 0; i < n; i++) { frames.push({ t: +t.toFixed(4), lm: fn(i / n) }); t += 1 / FPS; }
  }
  return frames;
}

const hang = (sh) => ({ x: sh.x, y: sh.y + 0.26 });

test('스쿼트: 랙 안에서 바 메기 + 워크아웃 + 워크인 + 랙 + 손 놓기 제외', () => {
  const frames = seq([
    [1.5, (p) => body({ u: 0.5 * (1 - p), dx: 0.15 })], // 랙 안에서 숙였다 일어나며 언랙
    [1.5, (p) => body({ dx: 0.15 * (1 - p), step: 0.04 * Math.sin(p * Math.PI * 3) })], // 뒤로 걸어 나옴
    [8, (p) => body({ u: Math.sin(Math.PI * ((p * 3) % 1)) })], // 3회
    [1.5, (p) => body({ dx: 0.15 * p, step: 0.04 * Math.sin(p * Math.PI * 3) })], // 앞으로 걸어 들어감
    [1, (p) => body({ u: 0.3 * Math.sin(Math.PI * p), dx: 0.15 })], // 랙에 걸며 살짝 앉음
    [1, () => body({ dx: 0.15, wrist: hang })], // 손 놓음
  ]);
  const w = findActiveWindow(frames, 'squat');
  assert.ok(w.trimmed);
  assert.ok(w.t0 > 2.5 && w.t0 < 3.2, `t0 ${w.t0}`);
  assert.ok(w.t1 > 10.5 && w.t1 < 11.4, `t1 ${w.t1}`);
  const res = evaluateForm({ frames, lift: 'squat', view: 'side' });
  assert.ok(res.ok, res.error);
  assert.equal(res.reps.length, 3);
  assert.match(res.summary[0].text, /준비 구간 자동 제외/);
});

const press = (h) => (sh) => ({ x: sh.x + 0.01, y: sh.y - 0.02 - 0.24 * h });

test('OHP: 워크아웃 + 3회 + 워크인 + 랙에 걸고 팔 내림 제외', () => {
  const frames = seq([
    [1.5, (p) => body({ dx: 0.15 * (1 - p), step: 0.04 * Math.sin(p * Math.PI * 3), wrist: press(0) })],
    [7.5, (p) => body({ wrist: press(Math.sin(Math.PI * ((p * 3) % 1)) ** 2) })],
    [1.5, (p) => body({ dx: 0.15 * p, step: 0.04 * Math.sin(p * Math.PI * 3), wrist: press(0) })],
    [2, (p) => body({ dx: 0.15, wrist: p < 0.3 ? press(0) : hang })],
  ]);
  const res = evaluateForm({ frames, lift: 'ohp', view: 'side' });
  assert.ok(res.ok, res.error);
  assert.equal(res.reps.length, 3);
  assert.ok(res.window.trimmed);
});

test('OHP: 팔 내림 구간 때문에 반복을 못 찾던 문제 (제외 전 실패 재현)', () => {
  const frames = seq([
    [7.5, (p) => body({ wrist: press(Math.sin(Math.PI * ((p * 3) % 1)) ** 2) })],
    [3, () => body({ wrist: hang })],
  ]);
  const res = evaluateForm({ frames, lift: 'ohp', view: 'side' });
  assert.ok(res.ok, res.error);
  assert.equal(res.reps.length, 3);
});

// 벤치: 누운 자세 (머리가 왼쪽). 손목 높이 h(0=가슴, 1=락아웃), 랙 위치 r(0=어깨 위, 1=얼굴 위)
function benchBody(h, r = 0, released = false) {
  const lm = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.1 }));
  const set = (ids, x, y) => ids.forEach((i) => { lm[i] = { x, y, z: 0, visibility: 0.95 }; });
  const sh = { x: 0.4, y: 0.6 };
  const wr = released ? { x: 0.45, y: 0.68 } : { x: sh.x - 0.12 * r, y: sh.y - 0.06 - 0.16 * h };
  set([0], 0.3, 0.6); // 코 (머리 쪽)
  set([11, 12], sh.x, sh.y); set([13, 14], (sh.x + wr.x) / 2 + 0.03, (sh.y + wr.y) / 2 + 0.02); set([15, 16], wr.x, wr.y);
  set([23, 24], 0.7, 0.62); set([25, 26], 0.85, 0.55); set([27, 28], 0.9, 0.8); set([31, 32], 0.93, 0.8);
  return lm;
}

test('벤치: 랙에서 바 빼기·다시 걸기·손 놓기 제외', () => {
  const frames = seq([
    [1, () => benchBody(0.9, 1)], // 랙 위치에서 쥐고 있음
    [1, (p) => benchBody(1, 1 - p)], // 어깨 위로 이동
    [8, (p) => benchBody(1 - Math.sin(Math.PI * ((p * 3) % 1)) ** 2)], // 3회
    [1, (p) => benchBody(1, p)], // 랙 쪽으로 이동
    [0.7, (p) => benchBody(1 - 0.15 * p, 1)], // 고리에 내려놓음
    [1.5, () => benchBody(0, 0, true)], // 손 놓음
  ]);
  const res = evaluateForm({ frames, lift: 'bench', view: 'side' });
  assert.ok(res.ok, res.error);
  assert.equal(res.reps.length, 3);
  assert.ok(res.window.trimmed);
});

test('준비 구간이 없는 영상은 자르지 않음', () => {
  const frames = seq([[8, (p) => body({ u: Math.sin(Math.PI * ((p * 3) % 1)) })]]);
  const w = findActiveWindow(frames, 'squat');
  assert.equal(w.trimmed, false);
});
