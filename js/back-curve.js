// 등 윤곽선으로 척추 굽힘 추정 (MediaPipe 분할 마스크 사용)
//
// MediaPipe 관절점에는 척추 점이 없어 어깨-엉덩이 직선만으로는 등 모양을 알 수 없다.
// 대신 사람 실루엣(분할 마스크)에서 엉덩이→어깨 선을 기준으로 등 쪽 윤곽까지의 거리를 여러 높이에서 재고,
// 윤곽이 그 선 대비 얼마나 볼록한지(+ 둥글게 말림) 또는 오목한지(- 허리 아치)를 몸통 길이 대비 비율로 낸다.
// 같은 세트의 서 있는 자세와 비교한 변화량이 '하중을 받을 때 허리가 말리는 정도'다.

const SAMPLES = [0.1, 0.18, 0.26, 0.34, 0.42, 0.5, 0.58, 0.66, 0.74, 0.82, 0.9];

/**
 * @param mask Float32Array|Uint8Array (0~1 또는 0~255), w×h
 * @param hip, shoulder {x, y} 마스크 픽셀 좌표
 * @param facing 몸 앞(발끝) 방향의 화면 x 부호 (+1 오른쪽, -1 왼쪽)
 * @returns { lumbar, thoracic, overall, profile } 몸통 길이 대비 볼록도. 윤곽을 못 찾으면 null
 */
export function backCurve(mask, w, h, hip, shoulder, facing = 1) {
  const L = Math.hypot(shoulder.x - hip.x, shoulder.y - hip.y);
  if (!(L > 8)) return null;
  const u = { x: (shoulder.x - hip.x) / L, y: (shoulder.y - hip.y) / L };
  // 등 방향: 몸 앞(발끝)의 반대 + 위쪽. 상체 기울기에 따라 두 법선 중 그 방향에 가까운 것
  const sinL = Math.abs(u.x);
  const cosL = Math.max(0, -u.y);
  const want = { x: -facing * cosL, y: -sinL };
  let n = { x: -u.y, y: u.x };
  if (n.x * want.x + n.y * want.y < 0) n = { x: -n.x, y: -n.y };
  const scale = mask instanceof Uint8Array || mask instanceof Uint8ClampedArray ? 255 : 1;
  const inside = (x, y) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return false;
    return mask[yi * w + xi] / scale > 0.5;
  };
  const maxD = 0.6 * L;
  const step = Math.max(0.5, L / 200);
  const d = SAMPLES.map((t) => {
    const cx = hip.x + u.x * L * t;
    const cy = hip.y + u.y * L * t;
    if (!inside(cx, cy)) return null; // 관절선이 몸 밖이면 신뢰 불가
    let last = 0;
    for (let s = 0; s <= maxD; s += step) {
      if (inside(cx + n.x * s, cy + n.y * s)) last = s;
      else if (s - last > 3 * step) break; // 윤곽 밖으로 충분히 나감
    }
    return last >= maxD - step ? null : last / L;
  });
  if (d.filter((x) => x != null).length < SAMPLES.length - 2) return null;
  const bulge = (i0, i1) => {
    const a = d[i0];
    const b = d[i1];
    if (a == null || b == null) return null;
    // 현(chord) 대비 가장 크게 벗어난 값 (부호 유지: + 볼록·말림, - 오목·아치)
    let peak = null;
    for (let i = i0 + 1; i < i1; i++) {
      if (d[i] == null) continue;
      const chord = a + ((b - a) * (SAMPLES[i] - SAMPLES[i0])) / (SAMPLES[i1] - SAMPLES[i0]);
      const dev = d[i] - chord;
      if (peak == null || Math.abs(dev) > Math.abs(peak)) peak = dev;
    }
    return peak;
  };
  return {
    lumbar: bulge(0, 4), // 엉덩이~등 중간 아래 (허리)
    thoracic: bulge(4, 10), // 등 중간~어깨 (등 상부)
    overall: bulge(0, 10),
    profile: d,
  };
}
