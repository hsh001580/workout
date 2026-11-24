// 측면(시상면) 자세 평가 + 반복 인식 + 브레이싱 근사 지표
// frames: [{ t: 초, lm: [{x, y, z, visibility}] x33 }]  (x, y는 0~1 정규화, y는 아래로 증가)
import { DEFAULT_THRESHOLDS } from './thresholds.js';

const IDX = {
  left: { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27, toe: 31 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28, toe: 32 },
};

export const LIFT_LABEL = { squat: '스쿼트', bench: '벤치프레스', deadlift: '데드리프트', ohp: '오버헤드 프레스' };

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// b를 꼭짓점으로 하는 각도(도)
export function angle(a, b, c) {
  const v1 = [a.x - b.x, a.y - b.y];
  const v2 = [c.x - b.x, c.y - b.y];
  const d = Math.hypot(...v1) * Math.hypot(...v2);
  if (!d) return NaN;
  const cos = Math.min(1, Math.max(-1, (v1[0] * v2[0] + v1[1] * v2[1]) / d));
  return (Math.acos(cos) * 180) / Math.PI;
}

// 수직선 대비 상체 기울기(도)
export function torsoLean(sh, hip) {
  return (Math.atan2(Math.abs(sh.x - hip.x), Math.abs(hip.y - sh.y)) * 180) / Math.PI;
}

export function pickSide(frames) {
  let l = 0;
  let r = 0;
  for (const f of frames) {
    for (const k of Object.keys(IDX.left)) {
      l += f.lm[IDX.left[k]]?.visibility ?? 0;
      r += f.lm[IDX.right[k]]?.visibility ?? 0;
    }
  }
  return l >= r ? 'left' : 'right';
}

// 화면 비율 보정 + 한쪽 측면 관절만 추출
export function extract(frames, aspect = 1) {
  const side = pickSide(frames);
  const ids = IDX[side];
  const out = [];
  for (const f of frames) {
    if (!f.lm) continue;
    const p = {};
    let vis = 0;
    let n = 0;
    for (const [k, i] of Object.entries(ids)) {
      const lm = f.lm[i];
      if (!lm) continue;
      p[k] = { x: lm.x * aspect, y: lm.y };
      vis += lm.visibility ?? 1;
      n++;
    }
    if (n === Object.keys(ids).length && vis / n > 0.5) {
      const nose = f.lm[0];
      if (nose && (nose.visibility ?? 1) > 0.6) p.nose = { x: nose.x * aspect, y: nose.y }; // 벤치 머리 들림 판정용 (선택)
      out.push({ t: f.t, p });
    }
  }
  return { side, pts: smooth(out) };
}

function smooth(pts, w = 1) {
  return pts.map((f, i) => {
    const lo = Math.max(0, i - w);
    const hi = Math.min(pts.length - 1, i + w);
    const p = {};
    for (const k of Object.keys(f.p)) {
      let x = 0;
      let y = 0;
      let c = 0;
      for (let j = lo; j <= hi; j++) {
        const q = pts[j].p[k];
        if (!q) continue;
        x += q.x;
        y += q.y;
        c++;
      }
      p[k] = { x: x / c, y: y / c };
    }
    return { t: f.t, p };
  });
}

// 바닥(하단) 지점일수록 큰 값이 되는 신호.
// 화면 속 절대 위치가 아니라 몸 기준 상대 높이를 팔·다리 길이로 나눠 쓰므로
// 손으로 든 카메라, 줌, 걸어 나오기 등 카메라·거리 변화에 영향을 덜 받는다.
function segLen(pts, a, b, c) {
  const v = pts.map((f) => dist(f.p[a], f.p[b]) + (c ? dist(f.p[b], f.p[c]) : 0)).sort((x, y) => x - y);
  return v[Math.floor(v.length / 2)] || 1;
}
function signalSeries(pts, lift) {
  if (lift === 'squat') {
    const L = segLen(pts, 'hip', 'knee', 'ankle');
    return pts.map((f) => -(f.p.ankle.y - f.p.hip.y) / L); // 발목 위 고관절 높이
  }
  if (lift === 'bench' || lift === 'ohp') {
    const L = segLen(pts, 'shoulder', 'elbow', 'wrist');
    return pts.map((f) => -(f.p.shoulder.y - f.p.wrist.y) / L); // 어깨 위 손목 높이
  }
  const L = segLen(pts, 'shoulder', 'hip', 'knee') + segLen(pts, 'knee', 'ankle');
  return pts.map((f) => -(f.p.ankle.y - f.p.shoulder.y) / L); // deadlift: 발목 위 어깨 높이
}

function medianFilter(a, w = 2) {
  return a.map((_, i) => {
    const win = a.slice(Math.max(0, i - w), i + w + 1).sort((x, y) => x - y);
    return win[Math.floor(win.length / 2)];
  });
}

// 지그재그 극값 탐지: 직전 극값에서 h 이상 반대로 움직여야 극값으로 확정.
// 영상 전체 기준선이 아니라 반전 폭으로 판단하므로 반복마다 깊이가 달라도 각 회차를 잡는다.
function zigzag(n, h) {
  const ev = [];
  let state = 0; // 0 미정, 1 하단(최대) 찾는 중, -1 상단(최소) 찾는 중
  let maxI = 0;
  let minI = 0;
  for (let i = 1; i < n.length; i++) {
    if (state === 0) {
      if (n[i] > n[maxI]) maxI = i;
      if (n[i] < n[minI]) minI = i;
      if (n[maxI] - n[minI] >= h) {
        if (maxI > minI) { ev.push({ type: 'top', i: minI }); state = 1; } else { ev.push({ type: 'bottom', i: maxI }); state = -1; minI = i; }
      }
    } else if (state === 1) {
      if (n[i] >= n[maxI]) maxI = i; // 하단은 평평한 구간의 끝 (실제로 올라가기 시작한 시점)
      if (n[maxI] - n[i] >= h) { ev.push({ type: 'bottom', i: maxI }); state = -1; minI = i; }
    } else {
      if (n[i] < n[minI]) minI = i; // 상단은 처음 도달한 시점 (올라오기를 마친 순간)
      if (n[i] - n[minI] >= h) { ev.push({ type: 'top', i: minI }); state = 1; maxI = i; }
    }
  }
  // 마지막으로 진행 중이던 극값 (영상이 그 자세에서 끝난 경우)
  const last = ev[ev.length - 1];
  if (state === 1 && last && n[maxI] - n[last.i] >= h && maxI > last.i) ev.push({ type: 'bottom', i: maxI });
  if (state === -1 && last && n[last.i] - n[minI] >= h && minI > last.i) ev.push({ type: 'top', i: minI });
  return ev;
}

// 이벤트 목록에서 완전한 반복 (하단→상단 구간이 있는 것) 목록.
// 올라가는 구간(동심성)의 절반 이상이 준비 구간이 아닐 때만 인정 (걷기·랙 동작 오인 방지, 경계 회차 보존)
export function repSpans(events, lift, ok = () => true) {
  const activeFrac = (a, b) => {
    let k = 0;
    for (let i = a; i <= b; i++) if (ok(i)) k++;
    return k / (b - a + 1);
  };
  const out = [];
  for (let e = 0; e < events.length; e++) {
    const ev = events[e];
    const prev = events[e - 1];
    const next = events[e + 1];
    if (lift === 'deadlift') {
      if (ev.type === 'top' && prev?.type === 'bottom' && activeFrac(prev.i, ev.i) >= 0.5) out.push({ start: prev.i, top: ev.i, bottom: prev.i });
    } else if (ev.type === 'bottom' && next?.type === 'top' && activeFrac(ev.i, next.i) >= 0.5) {
      out.push({ prevTop: prev?.type === 'top' ? prev.i : null, bottom: ev.i, nextTop: next.i });
    }
  }
  return out;
}

/**
 * 하단(bottom)/상단(top) 극값 이벤트 탐지
 * @param opts.active (t) => boolean  준비 구간(언랙·랙 등)이 아닌지
 * @param opts.expectedReps 입력한 반복 수: 이 수에 맞을 때까지 민감도를 자동 조정
 */
export function findEvents(pts, lift, opts = {}) {
  if (pts.length < 5) return { events: [], range: 0 };
  const raw = medianFilter(signalSeries(pts, lift), 2);
  const s = raw.map((_, i) => (raw[Math.max(0, i - 1)] + raw[i] + raw[Math.min(raw.length - 1, i + 1)]) / 3);
  const act = pts.map((f) => (opts.active ? opts.active(f.t) : true));
  // 범위는 준비 구간을 뺀 프레임의 5~95 백분위 (순간 오인식·팔 내림 영향 제거)
  let vals = s.filter((_, i) => act[i]);
  if (vals.length < 5) vals = s;
  const sorted = [...vals].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
  const lo = q(0.05);
  const hi = q(0.95);
  const range = hi - lo;
  if (range < 0.12) return { events: [], range }; // 팔·다리 길이의 12% 미만 움직임은 반복으로 보지 않음
  const n = s.map((v) => Math.min(1.5, Math.max(-0.5, (v - lo) / range)));
  const ok = (i) => act[i];
  const expected = Number(opts.expectedReps) || 0;
  const levels = expected ? [0.5, 0.42, 0.35, 0.28, 0.22, 0.17, 0.13] : [0.35];
  let best = null;
  for (const h of levels) {
    const events = zigzag(n, h);
    const count = repSpans(events, lift, ok).length;
    const cand = { events, h, count, diff: expected ? Math.abs(count - expected) : 0 };
    if (!best || cand.diff < best.diff) best = cand;
    if (cand.diff === 0) break; // 가장 둔감한(노이즈에 강한) 수준에서 일치하면 채택
  }
  return { events: best.events, range, n, h: best.h, ok, act, signal: s };
}

// 판정 범주: rule 대회 규정(심판 판정) · eff 효율(힘 전달) · risk 근거 있는 위험 신호 · cons 회차 간 일관성
function issue(level, text, cat = 'eff') {
  return { level, text, cat };
}

function midfoot(p) {
  return (p.ankle.x + p.toe.x) / 2;
}

// 극값 주변에서 거의 움직이지 않은 시간 (호흡·브레이싱 시간)
function dwell(pts, n, i, tol = 0.06) {
  let a = i;
  let b = i;
  while (a > 0 && Math.abs(n[a - 1] - n[i]) < tol) a--;
  while (b < pts.length - 1 && Math.abs(n[b + 1] - n[i]) < tol) b++;
  return pts[b].t - pts[a].t;
}

// 올라가는 구간(n 감소)에서 다시 내려가는 움직임: 상승 중 하강·더블 바운스·히칭 (규정 실격 사유)
function downwardIn(n, a, b, tol) {
  let runMin = n[a];
  let worst = 0;
  let streak = 0;
  for (let i = a + 1; i <= b; i++) {
    runMin = Math.min(runMin, n[i]);
    const back = n[i] - runMin;
    streak = back > tol ? streak + 1 : 0;
    if (streak >= 2) worst = Math.max(worst, back);
  }
  return worst;
}

// 반복 동안 발의 수평 이동 (다리 길이 대비). 발볼-뒤꿈치 구르기(수직)는 제외
function feetShift(seg, ref, legLen) {
  return Math.max(...seg.map((f) => Math.max(Math.abs(f.p.ankle.x - ref.ankle.x), Math.abs(f.p.toe.x - ref.toe.x)))) / legLen;
}

// 스쿼트 (IPF: 고관절 상단이 무릎 상단보다 아래, 상승 중 하강·발 이동은 실격)
// 상체각은 바 위치(스타일)별 기준: 로우바는 원래 더 숙여짐
function analyzeSquatRep(pts, prevTop, bottom, nextTop, n, T) {
  const p = pts[bottom].p;
  const thigh = dist(p.hip, p.knee);
  const leg = thigh + dist(p.knee, p.ankle);
  const depth = (p.hip.y - p.knee.y) / thigh;
  const lean = torsoLean(p.shoulder, p.hip);
  const knee = angle(p.hip, p.knee, p.ankle);
  const style = T._style?.squat;
  const [tw, tb, styleKo] = style === 'lowbar' ? [T.torsoLowWarn, T.torsoLowBad, '로우바'] : style === 'highbar' ? [T.torsoHighWarn, T.torsoHighBad, '하이바'] : [T.torsoLeanWarn, T.torsoLeanBad, '스타일 미지정'];
  const issues = [];
  const metrics = { depth: +depth.toFixed(2), torso: +lean.toFixed(0), knee: +knee.toFixed(0) };

  // 규정: 깊이
  if (depth >= Math.max(0, T.squatDepthWarn)) issues.push(issue('good', '규정 깊이 통과 (고관절이 무릎보다 아래)', 'rule'));
  else if (depth > T.squatDepthWarn) issues.push(issue('warn', '깊이 경계: 심판 시야에 따라 실패 가능, 1~3cm 더 앉기', 'rule'));
  else issues.push(issue('bad', '깊이 미달 (실격): 고관절을 무릎 높이 아래까지', 'rule'));

  // 규정: 상승 중 하강, 발 이동
  if (nextTop != null) {
    const back = downwardIn(n, bottom, nextTop, T.downwardTol);
    if (back > 0) issues.push(issue('bad', '상승 중 하강·재하강 (실격): 바운스 후 멈칫해도 다시 내려가지 않게 한 번에 일어서기', 'rule'));
  }
  const lo = prevTop ?? Math.max(0, bottom - 30);
  const hi = nextTop ?? Math.min(pts.length - 1, bottom + 30);
  const seg = pts.slice(lo, hi + 1);
  if (feetShift(seg, pts[lo].p, leg) > 0.08) issues.push(issue('bad', '발 위치 이동 (실격): 반복 중 발을 고정', 'rule'));

  // 효율: 상체각(스타일별), 엉덩이 먼저 뜸, 바-미드풋
  if (lean > tb) issues.push(issue('warn', `상체가 ${styleKo} 기준보다 크게 숙여짐 (${lean.toFixed(0)}°): 바가 앞으로 쏠리기 쉬움, 등 상부로 바를 받치기`));
  else if (lean > tw) issues.push(issue('info', `상체각 ${lean.toFixed(0)}° (${styleKo} 기준 상단)`));
  const mf = midfoot(p);
  const drift = Math.max(...seg.map((f) => Math.abs(f.p.shoulder.x - mf))) / thigh;
  if (drift > 0.45) issues.push(issue('warn', '어깨(바 위치)가 미드풋에서 벗어남: 무게중심을 발 중앙에 유지'));
  if (nextTop != null) {
    const k = Math.min(nextTop, bottom + Math.max(2, Math.round((nextTop - bottom) * 0.35)));
    const q = pts[k].p;
    const leanUp = torsoLean(q.shoulder, q.hip);
    metrics.leanUp = Math.round(leanUp - lean);
    const tol = T.hipShootDeg + (style === 'lowbar' ? 4 : 0);
    if (leanUp - lean > tol) issues.push(issue('warn', `올라올 때 엉덩이가 먼저 뜸 (상체 +${(leanUp - lean).toFixed(0)}°): 가슴과 엉덩이를 같이 밀어 올리기`));
  }
  return {
    metrics,
    issues,
    conc: nextTop != null ? [pts[bottom].t, pts[nextTop].t] : null,
    ecc: prevTop != null ? [pts[prevTop].t, pts[bottom].t] : null,
    descent: prevTop != null ? pts[bottom].t - pts[prevTop].t : null,
    ascent: nextTop != null ? pts[nextTop].t - pts[bottom].t : null,
    keyFrame: bottom,
    braceI: prevTop,
  };
}

// 벤치프레스 (파워리프팅 기술 기준, 측면)
//  셋업: 견갑 후인·하강 + 상부 등 아치 + 엉덩이·발 고정 → 프레스 중 어깨·엉덩이·발이 움직이면 셋업이 풀린 것
//  호흡: 락아웃에서 들이쉬고 반복 중 유지 (하단 복압 재설정은 없음)
//  하강: 1~2초 통제, 명치 부근 일정한 터치 / 하단: 전완 수직, 대회는 정지
//  프레스: 가슴 → 어깨 쪽(얼굴 방향) J 경로, 락아웃은 바가 어깨 관절 위
function analyzeBenchRep(pts, prevTop, bottom, nextTop, n, T) {
  const p = pts[bottom].p;
  const torso = dist(p.shoulder, p.hip) || 1;
  const headDir = Math.sign(p.shoulder.x - p.hip.x) || -1; // 머리 쪽 방향 (화면 x)
  const elbowBottom = angle(p.shoulder, p.elbow, p.wrist);
  const forearm = dist(p.elbow, p.wrist);
  const stack = Math.abs(p.wrist.x - p.elbow.x) / forearm;
  const issues = [];
  const metrics = { elbow: +elbowBottom.toFixed(0) };

  // 터치 위치: 어깨(0) → 골반(1) 방향 몸통 길이 비율. 명치 부근 ≈ 0.15~0.5
  const touch = ((p.wrist.x - p.shoulder.x) * -headDir) / torso;
  metrics.touch = +touch.toFixed(2);
  if (touch < 0.08) issues.push(issue('warn', `터치 위치가 높음 (쇄골·목 쪽, ${touch.toFixed(2)}): 명치 부근으로 내리고 팔꿈치를 몸 쪽으로 살짝 모으기 (어깨 부담↑)`, 'risk'));
  else if (touch > 0.6) issues.push(issue('warn', `터치 위치가 낮음 (배 쪽, ${touch.toFixed(2)}): 가슴 아래쪽·명치에 터치`));
  else issues.push(issue('good', '터치 위치 적정 (명치 부근)'));

  if (stack < 0.3) issues.push(issue('good', '하단에서 전완이 수직 (손목-팔꿈치 정렬)'));
  else issues.push(issue('warn', '하단에서 전완이 기울어짐: 그립 너비나 팔꿈치 위치를 조정해 손목을 팔꿈치 위로'));
  if (elbowBottom > 110) issues.push(issue('info', `팔꿈치 ${elbowBottom.toFixed(0)}° (큰 아치·넓은 그립이면 정상)`));
  // 규정 (IPF 2023~): 하단에서 팔꿈치 아래쪽이 어깨 관절 위쪽과 같거나 더 낮아야 함
  const elbowAbove = (p.shoulder.y - p.elbow.y) / torso; // + = 팔꿈치가 어깨보다 천장 쪽
  metrics.elbowAbove = +elbowAbove.toFixed(2);
  if (elbowAbove > T.benchElbowAbove * 2) issues.push(issue('bad', '팔꿈치 깊이 미달 (실격 가능): 바를 가슴까지 완전히 내려 팔꿈치가 어깨 높이 이하로', 'rule'));
  else if (elbowAbove > T.benchElbowAbove) issues.push(issue('warn', '팔꿈치 깊이 경계: 팔꿈치가 어깨 높이보다 높을 수 있음 (2023 IPF 규정)', 'rule'));
  else issues.push(issue('good', '팔꿈치 깊이 규정 통과', 'rule'));

  // 하강 통제
  if (prevTop != null) {
    // 락아웃에서 쉬는 시간은 빼고, 실제로 내려가기 시작한 시점부터
    let start = prevTop;
    while (start < bottom - 1 && n[start + 1] - n[prevTop] < 0.05) start++;
    const down = pts[bottom].t - pts[start].t;
    metrics.descentSec = +down.toFixed(1);
    if (down < 0.6) issues.push(issue('warn', `하강이 너무 빠름 (${down.toFixed(1)}초): 통제하며 1~2초에 내리고 가슴에서 튕기지 않기`));
  }

  // 정지(퍼즈)
  let pause = 0;
  for (let i = bottom; i > 0 && n[i] > 0.92; i--) pause += pts[i].t - pts[i - 1].t;
  for (let i = bottom; i < pts.length - 1 && n[i] > 0.92; i++) pause += pts[i + 1].t - pts[i].t;
  metrics.pause = +pause.toFixed(1);
  if (pause >= 0.4) issues.push(issue('good', `가슴에서 정지 ${pause.toFixed(1)}초 (대회 퍼즈 OK)`, 'rule'));
  else if (T.benchPauseRequired) issues.push(issue('bad', '가슴에서 정지 없음: 대회 기준 실패 (프레스 신호까지 정지)', 'rule'));
  else issues.push(issue('info', '터치앤고: 대회 준비 중이면 1초 정지 연습'));

  if (nextTop != null) {
    const t = pts[nextTop].p;
    const conc = pts.slice(bottom, nextTop + 1);
    if (!T._oblique) {
      const lock = angle(t.shoulder, t.elbow, t.wrist);
      if (lock < T.benchLockout) issues.push(issue('warn', `락아웃 불완전 (${lock.toFixed(0)}°): 팔꿈치를 끝까지 펴기`, 'rule'));
      else issues.push(issue('good', '락아웃 완료', 'rule'));
    }
    // J 경로: 하단 → 락아웃에서 바가 머리 쪽(어깨 위)으로 돌아와야 함
    const jBack = ((t.wrist.x - p.wrist.x) * headDir) / torso;
    const overShoulder = Math.abs(t.wrist.x - t.shoulder.x) / torso;
    metrics.jBack = +jBack.toFixed(2);
    if (jBack < 0.03 && touch > 0.15) issues.push(issue('warn', '바가 어깨 쪽으로 돌아오지 않고 올라감: 가슴에서 밀어낼 때 얼굴 방향으로 밀어 J 경로로 락아웃'));
    if (overShoulder > 0.2) issues.push(issue('warn', `락아웃 위치가 어깨 위가 아님 (${(overShoulder * 100).toFixed(0)}% 벗어남): 바를 어깨 관절 위에서 마무리`));
    // 셋업 유지: 엉덩이·어깨·발
    const hipUp = Math.max(...conc.map((f) => (p.hip.y - f.p.hip.y) / torso));
    const shoulderUp = Math.max(...conc.map((f) => (p.shoulder.y - f.p.shoulder.y) / torso));
    const feet = feetShift(conc, p, torso); // 수평 이동만 (발볼-뒤꿈치 구르기는 2026 규정상 허용)
    metrics.buttLift = Math.round(Math.max(0, hipUp) * 100);
    metrics.shoulderLift = Math.round(Math.max(0, shoulderUp) * 100);
    if (hipUp > 0.08) issues.push(issue('bad', '엉덩이가 벤치에서 뜸 (대회 실격): 레그 드라이브는 발로 바닥을 머리 쪽으로 밀고 엉덩이는 붙인 채', 'rule'));
    if (shoulderUp > 0.12) issues.push(issue('warn', '프레스 중 어깨가 들림 (견갑 풀림): 견갑을 뒤로·아래로 고정한 채 밀고, 락아웃에서 어깨를 내밀지 않기', 'rule'));
    if (feet > 0.12) issues.push(issue('bad', '발을 옮김 (2026 IPF 실격): 앞뒤·옆으로 옮기지 말기, 발볼-뒤꿈치 구르기는 허용', 'rule'));
    // 규정: 프레스 시작 후 하강, 머리 들림
    if (downwardIn(n, bottom, nextTop, T.downwardTol) > 0) issues.push(issue('bad', '프레스 중 하강 (실격): 밀기 시작한 뒤 바가 다시 내려가지 않게 끝까지 가속', 'rule'));
    if (p.nose && conc.every((f) => f.p.nose)) {
      const headUp = Math.max(...conc.map((f) => (p.nose.y - f.p.nose.y) / torso));
      if (headUp > 0.12) issues.push(issue('bad', '머리 들림 (실격): 뒤통수로 벤치를 누른 채 프레스', 'rule'));
    }
  }

  return {
    metrics,
    issues,
    conc: nextTop != null ? [pts[bottom].t, pts[nextTop].t] : null,
    ecc: prevTop != null ? [pts[prevTop].t, pts[bottom].t] : null,
    descent: prevTop != null ? pts[bottom].t - pts[prevTop].t : null,
    ascent: nextTop != null ? pts[nextTop].t - pts[bottom].t : null,
    keyFrame: bottom,
    braceI: null, // 벤치는 하단 복압 재설정 개념이 없음 (호흡은 락아웃에서)
  };
}

function analyzeOhpRep(pts, prevTop, bottom, nextTop, n, T) {
  const p = pts[bottom].p;
  const torso = dist(p.shoulder, p.hip);
  const forearm = dist(p.elbow, p.wrist);
  const facing = Math.sign(p.toe.x - p.ankle.x) || 1;
  const issues = [];
  const stack = Math.abs(p.wrist.x - p.elbow.x) / forearm;
  if (stack < 0.35) issues.push(issue('good', '시작 자세에서 전완이 수직'));
  else if (T._oblique) issues.push(issue('info', '시작 자세에서 전완이 기울어 보임 (대각선 추정이라 그립 너비가 섞일 수 있음, 정측면 영상으로 확인 권장)'));
  else issues.push(issue('warn', '시작 자세에서 팔꿈치가 바 아래에 있지 않음: 팔꿈치를 바 바로 아래로'));

  const lo = prevTop ?? Math.max(0, bottom - 30);
  const hi = nextTop ?? Math.min(pts.length - 1, bottom + 30);
  const seg = pts.slice(Math.min(lo, bottom), Math.max(hi, bottom) + 1);
  const layback = Math.max(...seg.map((f) => {
    const back = -(f.p.shoulder.x - f.p.hip.x) * facing;
    return (Math.atan2(back, Math.abs(f.p.hip.y - f.p.shoulder.y)) * 180) / Math.PI;
  }));
  if (layback > T.ohpLaybackBad) issues.push(issue('warn', `상체를 과하게 젖힘 (${layback.toFixed(0)}°): 둔근·복근 조여 허리 보호`, 'risk'));
  else if (layback > T.ohpLaybackWarn) issues.push(issue('warn', `상체 젖힘 ${layback.toFixed(0)}°: 갈비뼈를 내리고 코어 고정`));
  // 무릎 반동: 반복 시작(랙 자세) 대비 무릎이 더 굽혀진 정도
  const kneeRef = angle(p.hip, p.knee, p.ankle);
  const conc = nextTop != null ? pts.slice(bottom, nextTop + 1) : seg;
  const minKnee = Math.min(...conc.map((f) => angle(f.p.hip, f.p.knee, f.p.ankle)));
  const dip = kneeRef - minKnee;
  if (dip > T.kneeDipDeg) issues.push(issue('warn', `무릎 반동 사용 (시작 대비 ${dip.toFixed(0)}° 굽힘): 스트릭트 프레스는 다리를 고정`));

  if (nextTop != null) {
    const t = pts[nextTop].p;
    const lock = angle(t.shoulder, t.elbow, t.wrist);
    const over = Math.abs(t.wrist.x - midfoot(t)) / torso;
    if (!T._oblique) {
      if (lock < T.lockoutAngle) issues.push(issue('warn', `락아웃 불완전 (${lock.toFixed(0)}°): 팔꿈치를 끝까지 펴기`));
      else issues.push(issue('good', '락아웃 완료'));
    }
    if (over > 0.25) issues.push(issue('warn', '락아웃에서 바가 미드풋 위에 있지 않음: 머리를 바 아래로 밀어 넣기'));
  }
  return {
    metrics: { layback: Math.max(0, Math.round(layback)), kneeDip: Math.max(0, Math.round(dip)) },
    issues,
    conc: nextTop != null ? [pts[bottom].t, pts[nextTop].t] : null,
    ecc: prevTop != null ? [pts[prevTop].t, pts[bottom].t] : null,
    descent: prevTop != null ? pts[bottom].t - pts[prevTop].t : null,
    ascent: nextTop != null ? pts[nextTop].t - pts[bottom].t : null,
    keyFrame: bottom,
    braceI: prevTop,
  };
}

// 데드리프트 (현역 기준): 시작 자세는 고정 각도 대신 바-미드풋·어깨-바 위치·초반 등 각도 유지로 판단.
// 컨벤셔널: 어깨가 바보다 약간 앞 / 스모: 상체가 더 서고 어깨가 바 위.
// IPF: 히칭(당기는 중 하강·허벅지 지지)·락아웃 미완(무릎 미잠금·똑바로 서지 않음)은 실격
function analyzeDeadliftRep(pts, start, top, n, T) {
  const s = pts[start].p;
  const t = pts[top].p;
  const thigh = dist(s.hip, s.knee);
  const leg = thigh + dist(s.knee, s.ankle);
  const kneeStart = angle(s.hip, s.knee, s.ankle);
  const hipStart = angle(s.shoulder, s.hip, s.knee);
  const facing = Math.sign(s.toe.x - s.ankle.x) || 1;
  const sumo = T._style?.deadlift === 'sumo';
  const issues = [];
  const metrics = { kneeStart: +kneeStart.toFixed(0), hipStart: +hipStart.toFixed(0) };

  // 효율: 셋업
  const barOff = Math.abs(s.wrist.x - midfoot(s)) / thigh;
  if (barOff > 0.45) issues.push(issue('bad', '바가 미드풋에서 멀리 떨어진 채 시작: 바를 발 중앙 위에 두고 정강이에 붙이기'));
  else if (barOff > 0.3) issues.push(issue('warn', '바가 미드풋보다 앞에서 시작: 정강이 쪽으로 붙이기'));
  const shoulderAhead = ((s.shoulder.x - s.wrist.x) * facing) / thigh;
  metrics.shoulderAhead = +shoulderAhead.toFixed(2);
  if (!sumo && shoulderAhead < -0.05) issues.push(issue('warn', '어깨가 바 뒤에 있는 채 시작: 바가 몸에서 멀어지기 쉬움, 어깨를 바 바로 위나 약간 앞에'));
  if (sumo && kneeStart > 150) issues.push(issue('warn', `스모인데 무릎이 거의 펴진 채 시작 (${kneeStart.toFixed(0)}°): 엉덩이를 바에 더 가깝게, 무릎을 바깥으로`));
  if (!sumo && kneeStart > 165) issues.push(issue('info', `무릎을 거의 편 채 시작 (${kneeStart.toFixed(0)}°): 의도한 스타일이 아니면 엉덩이를 조금 낮추기`));

  // 효율: 바닥에서 뗄 때 등 각도 유지 (엉덩이만 먼저 뜨면 등 각도가 수평 쪽으로 무너짐)
  const k = start + Math.max(2, Math.round((top - start) * 0.3));
  const m = pts[Math.min(k, top)].p;
  const backShift = torsoLean(m.shoulder, m.hip) - torsoLean(s.shoulder, s.hip);
  metrics.backShift = Math.round(backShift);
  const limit = sumo ? T.dlBackShiftSumo : T.dlBackShiftConv;
  if (backShift > limit) issues.push(issue('warn', `초반에 등 각도가 무너짐 (엉덩이 먼저 뜸, +${backShift.toFixed(0)}°): 다리로 바닥을 밀며 가슴과 엉덩이를 같이 올리기`));

  // 효율: 바를 몸에 붙임
  const seg = pts.slice(start, top + 1);
  const kneePass = seg.reduce((a, f) => (Math.abs(f.p.wrist.y - f.p.knee.y) < Math.abs(a.p.wrist.y - a.p.knee.y) ? f : a), seg[0]);
  const gap = ((kneePass.p.wrist.x - kneePass.p.knee.x) * facing) / thigh;
  metrics.kneeGap = +gap.toFixed(2);
  if (gap > 0.25) issues.push(issue('warn', '무릎 높이에서 바가 다리에서 멀어짐: 광배근으로 바를 몸에 붙이기'));
  const path = (Math.max(...seg.map((f) => f.p.wrist.x)) - Math.min(...seg.map((f) => f.p.wrist.x))) / thigh;
  if (path > 0.35) issues.push(issue('warn', '바가 앞뒤로 흔들림: 바를 수직으로 끌어올리기'));

  // 규정: 히칭·당기는 중 하강, 발 이동, 락아웃
  if (downwardIn(n, start, top, T.downwardTol) > 0) issues.push(issue('bad', '당기는 중 하강·히칭 (실격): 허벅지에 바를 얹거나 다시 내렸다 올리지 않고 한 번에 락아웃', 'rule'));
  if (feetShift(seg, s, leg) > 0.08) issues.push(issue('warn', '당기는 중 발 위치 이동: 발 고정', 'rule'));
  const hipTop = angle(t.shoulder, t.hip, t.knee);
  const kneeTop = angle(t.hip, t.knee, t.ankle);
  metrics.hipTop = +hipTop.toFixed(0);
  const backLean = (t.shoulder.x - t.hip.x) * facing;
  const backDeg = (Math.atan2(-backLean, Math.abs(t.hip.y - t.shoulder.y)) * 180) / Math.PI;
  const minLock = Math.min(hipTop, kneeTop);
  if (minLock < T.lockoutAngle - 10) issues.push(issue('bad', `락아웃 미완 (실격): 고관절 ${hipTop.toFixed(0)}°, 무릎 ${kneeTop.toFixed(0)}°, 무릎 잠그고 똑바로 서기`, 'rule'));
  else if (minLock < T.lockoutAngle) issues.push(issue('warn', `락아웃 불완전 (고관절 ${hipTop.toFixed(0)}°, 무릎 ${kneeTop.toFixed(0)}°): 둔근 조이며 끝까지 서기`, 'rule'));
  else issues.push(issue('good', '락아웃 완료 (무릎 잠금·똑바로 섬)', 'rule'));
  if (backDeg > 15) issues.push(issue('info', `락아웃에서 뒤로 젖힘 (${backDeg.toFixed(0)}°): 규정상 필요 없음, 똑바로 서면 충분`, 'risk'));

  return {
    metrics,
    issues,
    conc: [pts[start].t, pts[top].t],
    ecc: null,
    descent: null,
    ascent: pts[top].t - pts[start].t,
    keyFrame: start,
    braceI: null, // 데드리프트는 바닥 셋업에서 브레이싱 (반복 사이 정지 판정 안 함)
  };
}

// 브레이싱 근사 지표 (복압 자체는 영상으로 측정 불가)
function bracing(pts, n, rep, refTrunk, lift, T, sagittal = true) {
  const out = [];
  const metrics = {};
  // 1) 반복 직전 정지 시간: 숨 채우고 복압 잡을 시간
  if (rep.braceI != null && lift !== 'bench') {
    const d = dwell(pts, n, rep.braceI);
    metrics.braceSec = +d.toFixed(1);
    if (d < T.rebraceSec) out.push(issue(lift === 'squat' ? 'warn' : 'info', `반복 직전 정지 ${d.toFixed(1)}초: 숨을 다시 채우고 복압을 잡을 시간 없이 연속 수행. 무거운 세트는 반복마다 재브레이싱`));
  }
  const [t0, t1] = [rep.ecc?.[0] ?? rep.conc?.[0], rep.conc?.[1] ?? rep.ecc?.[1]];
  if (t0 == null || t1 == null) return { issues: out, metrics };
  const seg = pts.filter((f) => f.t >= t0 && f.t <= t1);
  if (seg.length < 3) return { issues: out, metrics };
  // 2) 몸통 길이 감소: 척추가 굽거나 복압이 풀려 몸통이 접힘 (벤치는 아치, OHP는 어깨 으쓱 때문에 제외)
  if (sagittal && (lift === 'squat' || lift === 'deadlift') && refTrunk) {
    const minTrunk = Math.min(...seg.map((f) => dist(f.p.shoulder, f.p.hip)));
    const shrink = ((refTrunk - minTrunk) / refTrunk) * 100;
    metrics.trunkShrink = Math.max(0, Math.round(shrink));
    if (shrink > T.trunkShrinkPct) {
      out.push(lift === 'deadlift'
        ? issue('info', `몸통 길이 ${shrink.toFixed(0)}% 짧아짐 (등 라운딩): 최대 중량에서 흔한 전략이지만 허리 통증이 있으면 줄이기`, 'risk')
        : issue('warn', `몸통 길이 ${shrink.toFixed(0)}% 짧아짐: 등이 말리거나 복압이 풀린 신호. 하강 전 360° 복압, 갈비뼈 고정`));
    }
  }
  // 3) 상승 중 상체가 순간적으로 꺾임
  if (sagittal && rep.conc && lift !== 'bench') {
    const cs = pts.filter((f) => f.t >= rep.conc[0] && f.t <= rep.conc[1]);
    let jerk = 0;
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length && cs[j].t - cs[i].t <= 0.2; j++) {
        jerk = Math.max(jerk, torsoLean(cs[j].p.shoulder, cs[j].p.hip) - torsoLean(cs[i].p.shoulder, cs[i].p.hip));
      }
    }
    metrics.torsoJerk = Math.round(jerk);
    if (jerk > T.torsoJerkDeg) out.push(issue('warn', `상승 중 상체가 0.2초 사이 ${jerk.toFixed(0)}° 꺾임: 브레이싱이 유지되지 않아 힘이 새는 구간`));
  }
  return { issues: out, metrics };
}

// 범주별 감점: 규정 위반이 가장 크고, 일관성은 작게
const PENALTY = { rule: { bad: 25, warn: 10 }, eff: { bad: 12, warn: 6 }, risk: { bad: 15, warn: 7 }, cons: { bad: 8, warn: 5 } };
function scoreIssues(issues) {
  let s = 100;
  for (const i of issues) s -= PENALTY[i.cat || 'eff']?.[i.level] || 0;
  return Math.max(0, s);
}

/**
 * @param opts.sagittal false면 측면 판정을 생략하고 반복 인식과 브레이싱 시간만 계산 (정면 촬영용)
 */
export function analyze(frames, lift, aspect = 1, T = DEFAULT_THRESHOLDS, opts = {}) {
  const sagittal = opts.sagittal !== false;
  const { side, pts } = extract(frames, aspect);
  if (pts.length < 10) {
    return { ok: false, error: '관절 인식이 충분하지 않습니다. 몸 전체가 보이도록 촬영해 주세요.' };
  }
  const { events, n, range, ok, act, signal, h } = findEvents(pts, lift, opts);
  const fn = { squat: analyzeSquatRep, bench: analyzeBenchRep, ohp: analyzeOhpRep }[lift];
  const reps = repSpans(events, lift, ok || (() => true)).map((sp) => (lift === 'deadlift'
    ? analyzeDeadliftRep(pts, sp.start, sp.top, n, T)
    : fn(pts, sp.prevTop, sp.bottom, sp.nextTop, n, T)));
  if (!reps.length) {
    const why = range < 0.12
      ? `움직임이 거의 잡히지 않았습니다 (관절 인식 ${pts.length}/${frames.length}프레임). 종목 선택이 맞는지, 몸 전체가 화면에 보이는지 확인해 주세요.`
      : `움직임은 잡혔지만 시작-끝이 완전한 반복을 찾지 못했습니다 (관절 인식 ${pts.length}/${frames.length}프레임). 영상이 반복 중간에 시작·종료되지 않았는지, 종목 선택이 맞는지 확인해 주세요.`;
    return { ok: false, error: `반복 동작을 찾지 못했습니다. ${why}` };
  }

  // 기준 몸통 길이: 상단(서 있는) 자세들의 중앙값
  const tops = events.filter((e) => e.type === (lift === 'deadlift' ? 'top' : 'top')).map((e) => dist(pts[e.i].p.shoulder, pts[e.i].p.hip)).sort((a, b) => a - b);
  const refTrunk = tops.length ? tops[Math.floor(tops.length / 2)] : null;

  reps.forEach((r, i) => {
    r.rep = i + 1;
    if (!sagittal) { r.issues = []; r.metrics = {}; }
    const b = bracing(pts, n, r, sagittal ? refTrunk : null, lift, T, sagittal);
    r.issues.push(...b.issues);
    Object.assign(r.metrics, b.metrics);
  });

  const summary = [];
  if (lift === 'bench' && sagittal) {
    const touches = reps.map((r) => r.metrics.touch).filter(Number.isFinite);
    if (touches.length >= 2) {
      const mean = touches.reduce((a, b) => a + b, 0) / touches.length;
      const sd = Math.sqrt(touches.reduce((a, b) => a + (b - mean) ** 2, 0) / touches.length);
      if (sd > 0.06) summary.push(issue('warn', `터치 위치가 회차마다 다름 (편차 ${(sd * 100).toFixed(0)}%): 하강 중 견갑 고정을 유지해 매번 같은 지점에 터치`, 'cons'));
      else summary.push(issue('good', '회차 간 터치 위치 일정', 'cons'));
    }
  }
  if (sagittal && reps.length >= 2) {
    // 일관성: 내 최고 회차와 같은 동작을 반복하는가 (현역 코칭에서 기술 숙련의 핵심 지표)
    const sd = (k) => {
      const v = reps.map((r) => r.metrics[k]).filter(Number.isFinite);
      if (v.length < 2) return null;
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
    };
    const lim = T.consistencyPct / 100;
    const checks = {
      squat: [['depth', lim, '깊이가 회차마다 다름'], ['torso', T.consistencyPct * 0.6, '상체각이 회차마다 다름 (°)']],
      deadlift: [['kneeStart', T.consistencyPct * 0.8, '시작 자세가 회차마다 다름 (무릎각 °)'], ['backShift', T.consistencyPct * 0.8, '바닥에서 뗄 때 등 각도 변화가 회차마다 다름 (°)']],
      ohp: [['layback', T.consistencyPct * 0.6, '상체 젖힘이 회차마다 다름 (°)']],
    }[lift] || [];
    for (const [k, l, label] of checks) {
      const v = sd(k);
      if (v != null && v > l) summary.push(issue('warn', `${label}: 편차 ${k === 'depth' ? (v * 100).toFixed(0) + '%' : v.toFixed(1)}. 매 회차 같은 셋업·템포로`, 'cons'));
    }
  }
  const asc = reps.map((r) => r.ascent).filter((x) => x != null);
  if (asc.length >= 2) {
    const slow = asc[asc.length - 1] / asc[0];
    if (slow > 1.6) summary.push(issue('warn', `마지막 반복 상승 시간이 첫 반복의 ${slow.toFixed(1)}배: RPE 9 이상 추정, 다음 세트 무게 유지 또는 감량`));
    else summary.push(issue('good', '반복 간 상승 시간이 일정함'));
  }
  const timeline = { t: pts.map((f) => f.t), n, active: act, h };
  return { ok: true, side, lift, reps, summary, pts, events, n, timeline, finalize: () => finalize(reps, summary) };
}

// 바벨·정면 분석 결과를 합친 뒤 점수 계산
export function finalize(reps, summary) {
  reps.forEach((r) => {
    r.issues.forEach((i) => { i.cat = i.cat || 'eff'; });
    r.score = scoreIssues(r.issues);
    r.rulePass = !r.issues.some((i) => i.cat === 'rule' && i.level === 'bad');
  });
  // 세트 요약의 일관성 지적은 모든 회차 점수에 반영
  const consPenalty = summary.filter((i) => i.cat === 'cons').reduce((a, i) => a + (PENALTY.cons[i.level] || 0), 0);
  const counts = {};
  reps.forEach((r) => r.issues.forEach((i) => {
    if ((i.level === 'bad' || i.level === 'warn') && i.cat !== 'rule' && !i.text.startsWith('스티킹 포인트')) {
      const key = i.text.replace(/[\d.]+/g, '#');
      counts[key] = counts[key] || { n: 0, text: i.text };
      counts[key].n++;
    }
  }));
  const recurring = Object.values(counts).filter((c) => c.n >= Math.max(2, Math.ceil(reps.length / 2)));
  recurring.forEach((c) => summary.push(issue('bad', `반복적으로 나타남 (${c.n}회): ${c.text}`, 'cons')));
  const passed = reps.filter((r) => r.rulePass).length;
  if (reps.some((r) => r.issues.some((i) => i.cat === 'rule'))) summary.unshift(issue(passed === reps.length ? 'good' : 'bad', `규정 판정: ${reps.length}회 중 ${passed}회 성공${passed < reps.length ? ` (실패: ${reps.filter((r) => !r.rulePass).map((r) => r.rep + '회차').join(', ')})` : ''}`, 'rule'));
  const score = Math.round(reps.reduce((a, r) => a + r.score, 0) / reps.length - recurring.length * 3 - consPenalty);
  return Math.max(0, Math.min(100, score));
}

// 셀프 체크리스트 점수 (영상 없이도 매일 기록 가능)
export const CHECKLIST = {
  squat: ['바 위치·그립 매번 같게 (하이바/로우바)', '숨 크게 들이쉬고 벨트에 360° 복압', '발 전체로 지면 누르기 (발 고정)', '규정 깊이: 고관절이 무릎보다 아래', '하단에서 한 번에 일어서기 (재하강 없음)', '바가 미드풋 위 수직 경로'],
  bench: ['견갑 후인·하강 고정 (어깨를 뒤로·아래로)', '아치 + 머리·어깨·엉덩이 벤치에 고정', '발 고정 (옮기지 않기), 바닥을 밀어 레그 드라이브', '락아웃에서 숨 채우고 반복 중 유지 (가슴 높게)', '팔꿈치가 어깨 높이 이하까지 내리고 가슴에서 정지', '전완 수직, 바는 손바닥 아래쪽', '어깨 쪽으로 밀어 J 경로, 락아웃은 어깨 위'],
  ohp: ['둔근·복근 조여 갈비뼈 내리기 (과도한 젖힘 없이)', '랙 자세에서 팔꿈치가 바 아래나 약간 앞', '바가 이마를 지나면 머리를 바 아래로', '락아웃에서 바가 미드풋 위', '무릎 반동 없음'],
  deadlift: ['바를 미드풋 위, 정강이에 붙이고 셋업', '광배근 긴장 + 슬랙 제거 (바를 살짝 당겨 두기)', '숨 채우고 복압 후 다리로 바닥 밀기', '등 각도 유지하며 바닥에서 떼기', '락아웃까지 한 번에 (히칭 없음), 무릎 잠그고 똑바로 서기'],
};

export function checklistScore(checked, total, rpe, pain) {
  let s = Math.round((checked / total) * 100);
  if (pain) s -= 20;
  if (rpe >= 9.5) s -= 5;
  return Math.max(0, s);
}
