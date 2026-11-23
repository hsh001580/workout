// 원판(바벨 끝) 추적: 정규화 상호상관(NCC) 템플릿 매칭. DOM 없이 동작하는 순수 함수.

export function toGray(rgba, w, h) {
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  return g;
}

function cutPatch(gray, w, h, cx, cy, half) {
  const size = half * 2 + 1;
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const yy = Math.min(h - 1, Math.max(0, Math.round(cy) - half + y));
    for (let x = 0; x < size; x++) {
      const xx = Math.min(w - 1, Math.max(0, Math.round(cx) - half + x));
      out[y * size + x] = gray[yy * w + xx];
    }
  }
  return out;
}

function normalize(patch) {
  let m = 0;
  for (const v of patch) m += v;
  m /= patch.length;
  let s = 0;
  const out = new Float32Array(patch.length);
  for (let i = 0; i < patch.length; i++) { out[i] = patch[i] - m; s += out[i] * out[i]; }
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

// (cx, cy) 주변 ±search 범위에서 템플릿과 가장 닮은 위치
function matchAt(gray, w, h, tplN, half, cx, cy, search) {
  const size = half * 2 + 1;
  let best = { x: cx, y: cy, score: -2 };
  const scores = new Map();
  const x0 = Math.round(cx);
  const y0 = Math.round(cy);
  for (let dy = -search; dy <= search; dy++) {
    const py = y0 + dy;
    if (py - half < 0 || py + half >= h) continue;
    for (let dx = -search; dx <= search; dx++) {
      const px = x0 + dx;
      if (px - half < 0 || px + half >= w) continue;
      let sum = 0;
      let sum2 = 0;
      let dot = 0;
      for (let y = 0; y < size; y++) {
        const row = (py - half + y) * w + (px - half);
        const trow = y * size;
        for (let x = 0; x < size; x++) {
          const v = gray[row + x];
          sum += v;
          sum2 += v * v;
          dot += v * tplN[trow + x];
        }
      }
      const n = size * size;
      const varI = sum2 - (sum * sum) / n;
      const score = varI > 1e-6 ? dot / Math.sqrt(varI) : -1; // tplN은 평균 0이라 dot에 평균 보정 불필요
      scores.set(px + ',' + py, score);
      if (score > best.score) best = { x: px, y: py, score };
    }
  }
  // 포물선 보간으로 서브픽셀 위치
  const s = (x, y) => scores.get(x + ',' + y);
  const l = s(best.x - 1, best.y);
  const r = s(best.x + 1, best.y);
  const u = s(best.x, best.y - 1);
  const d = s(best.x, best.y + 1);
  let fx = best.x;
  let fy = best.y;
  if (l != null && r != null) { const den = l - 2 * best.score + r; if (den < 0) fx += Math.max(-0.5, Math.min(0.5, (l - r) / (2 * den))); }
  if (u != null && d != null) { const den = u - 2 * best.score + d; if (den < 0) fy += Math.max(-0.5, Math.min(0.5, (u - d) / (2 * den))); }
  return { x: fx, y: fy, score: best.score };
}

/**
 * @param gray 첫 프레임 회색조
 * @param cx, cy 사용자가 탭한 원판 중심 (픽셀)
 * @param rPx 원판 반지름 (픽셀)
 */
export function createTracker(gray, w, h, cx, cy, rPx) {
  const half = Math.max(6, Math.round(rPx * 0.6));
  const search = Math.max(6, Math.round(rPx * 0.6));
  let tpl = cutPatch(gray, w, h, cx, cy, half);
  let tplN = normalize(tpl);
  let pos = { x: cx, y: cy };
  let vel = { x: 0, y: 0 };
  return {
    update(g) {
      const guess = { x: pos.x + vel.x, y: pos.y + vel.y };
      let m = matchAt(g, w, h, tplN, half, guess.x, guess.y, search);
      if (m.score < 0.5) {
        // 빠른 움직임 대비 넓게 재탐색
        const wide = matchAt(g, w, h, tplN, half, pos.x, pos.y, search * 2);
        if (wide.score > m.score) m = wide;
      }
      const lost = m.score < 0.4;
      if (!lost) {
        vel = { x: m.x - pos.x, y: m.y - pos.y };
        pos = { x: m.x, y: m.y };
        // 조명·회전 변화에 천천히 적응
        if (m.score > 0.8) {
          const cur = cutPatch(g, w, h, pos.x, pos.y, half);
          for (let i = 0; i < tpl.length; i++) tpl[i] = tpl[i] * 0.9 + cur[i] * 0.1;
          tplN = normalize(tpl);
        }
      }
      return { x: pos.x, y: pos.y, score: m.score, lost };
    },
  };
}
