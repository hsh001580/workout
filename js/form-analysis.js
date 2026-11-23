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
    if (n === Object.keys(ids).length && vis / n > 0.5) out.push({ t: f.t, p });
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
      for (let j = lo; j <= hi; j++) {
        x += pts[j].p[k].x;
        y += pts[j].p[k].y;
      }
      const c = hi - lo + 1;
      p[k] = { x: x / c, y: y / c };
    }
    return { t: f.t, p };
  });
}

// 바닥(하단) 지점일수록 큰 값이 되는 신호
function signalOf(lift, p) {
  if (lift === 'squat') return p.hip.y;
  if (lift === 'bench' || lift === 'ohp') return p.wrist.y;
  return p.shoulder.y; // deadlift: 바닥에서 시작
}

// 하단(bottom)/상단(top) 극값 이벤트 탐지
export function findEvents(pts, lift) {
  const s = pts.map((f) => signalOf(lift, f.p));
  if (s.length < 5) return { events: [], range: 0 };
  const min = Math.min(...s);
  const max = Math.max(...s);
  const range = max - min;
  if (range < 0.03) return { events: [], range };
  const n = s.map((v) => (v - min) / range);
  const events = [];
  let zone = null;
  let best = -1;
  const flush = () => {
    if (zone && best >= 0) {
      const last = events[events.length - 1];
      if (last && last.type === zone) {
        const better = zone === 'bottom' ? n[best] > n[last.i] : n[best] < n[last.i];
        if (better) last.i = best;
      } else events.push({ type: zone, i: best });
    }
  };
  for (let i = 0; i < n.length; i++) {
    const z = n[i] > 0.65 ? 'bottom' : n[i] < 0.35 ? 'top' : null;
    if (z && z !== zone) {
      flush();
      zone = z;
      best = i;
    } else if (z && z === zone) {
      if ((z === 'bottom' && n[i] > n[best]) || (z === 'top' && n[i] < n[best])) best = i;
    }
  }
  flush();
  return { events, range, n };
}

function issue(level, text) {
  return { level, text };
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

function analyzeSquatRep(pts, prevTop, bottom, nextTop, n, T) {
  const p = pts[bottom].p;
  const thigh = dist(p.hip, p.knee);
  const depth = (p.hip.y - p.knee.y) / thigh;
  const lean = torsoLean(p.shoulder, p.hip);
  const knee = angle(p.hip, p.knee, p.ankle);
  const issues = [];
  if (depth >= Math.max(0, T.squatDepthWarn)) issues.push(issue('good', '깊이 충분 (고관절이 무릎 아래)'));
  else if (depth > T.squatDepthWarn) issues.push(issue('warn', '거의 패러렐: 1~3cm 더 앉기 (대회 기준 미달 가능)'));
  else issues.push(issue('bad', '깊이 부족: 고관절을 무릎 높이 아래까지 내리기'));
  if (lean > T.torsoLeanBad) issues.push(issue('bad', `상체가 과도하게 숙여짐 (${lean.toFixed(0)}°): 가슴 들고 등 상부 긴장 유지`));
  else if (lean > T.torsoLeanWarn) issues.push(issue('warn', `상체 기울기 큼 (${lean.toFixed(0)}°): 선택한 스타일 기준보다 숙여짐`));

  const lo = prevTop ?? Math.max(0, bottom - 30);
  const hi = nextTop ?? Math.min(pts.length - 1, bottom + 30);
  const seg = pts.slice(lo, hi + 1);
  const mf = midfoot(p);
  const drift = Math.max(...seg.map((f) => Math.abs(f.p.shoulder.x - mf))) / thigh;
  if (drift > 0.45) issues.push(issue('warn', '어깨(바 위치)가 미드풋에서 벗어남: 무게중심을 발 중앙에 유지'));

  // 리바운드 후 엉덩이만 먼저 뜨는 '굿모닝 스쿼트' 탐지
  if (nextTop != null) {
    const k = Math.min(nextTop, bottom + Math.max(2, Math.round((nextTop - bottom) * 0.35)));
    const q = pts[k].p;
    const leanUp = torsoLean(q.shoulder, q.hip);
    if (leanUp - lean > T.hipShootDeg) issues.push(issue('bad', '올라올 때 엉덩이가 먼저 뜸: 가슴과 엉덩이를 같이 밀어 올리기'));
  }
  return {
    metrics: { depth: +depth.toFixed(2), torso: +lean.toFixed(0), knee: +knee.toFixed(0) },
    issues,
    conc: nextTop != null ? [pts[bottom].t, pts[nextTop].t] : null,
    ecc: prevTop != null ? [pts[prevTop].t, pts[bottom].t] : null,
    descent: prevTop != null ? pts[bottom].t - pts[prevTop].t : null,
    ascent: nextTop != null ? pts[nextTop].t - pts[bottom].t : null,
    keyFrame: bottom,
    braceI: prevTop,
  };
}

function analyzeBenchRep(pts, prevTop, bottom, nextTop, n, T) {
  const p = pts[bottom].p;
  const elbowBottom = angle(p.shoulder, p.elbow, p.wrist);
  const forearm = dist(p.elbow, p.wrist);
  const stack = Math.abs(p.wrist.x - p.elbow.x) / forearm;
  const issues = [];
  if (stack < 0.3) issues.push(issue('good', '하단에서 전완이 수직 (손목-팔꿈치 정렬)'));
  else issues.push(issue('warn', '하단에서 손목이 팔꿈치 위에 있지 않음: 바 위치나 그립 너비 조정'));
  if (elbowBottom > 110) issues.push(issue('warn', `가동범위 부족 가능 (팔꿈치 ${elbowBottom.toFixed(0)}°): 바가 가슴에 닿는지 확인`));

  if (nextTop != null) {
    const t = pts[nextTop].p;
    const lock = angle(t.shoulder, t.elbow, t.wrist);
    if (lock < T.benchLockout) issues.push(issue('warn', `락아웃 불완전 (${lock.toFixed(0)}°): 팔꿈치를 끝까지 펴기`));
    else issues.push(issue('good', '락아웃 완료'));
  }
  // 정지(퍼즈) 시간
  let pause = 0;
  for (let i = bottom; i > 0 && n[i] > 0.92; i--) pause += pts[i].t - pts[i - 1].t;
  for (let i = bottom; i < pts.length - 1 && n[i] > 0.92; i++) pause += pts[i + 1].t - pts[i].t;
  if (pause >= 0.4) issues.push(issue('good', `가슴에서 정지 ${pause.toFixed(1)}초 (대회 퍼즈 OK)`));
  else if (T.benchPauseRequired) issues.push(issue('bad', '가슴에서 정지 없음: 대회 기준 실패 (1초 정지 필요)'));
  else issues.push(issue('info', '터치앤고: 대회 준비 중이면 1초 정지 연습'));

  return {
    metrics: { elbow: +elbowBottom.toFixed(0), pause: +pause.toFixed(1) },
    issues,
    conc: nextTop != null ? [pts[bottom].t, pts[nextTop].t] : null,
    ecc: prevTop != null ? [pts[prevTop].t, pts[bottom].t] : null,
    descent: prevTop != null ? pts[bottom].t - pts[prevTop].t : null,
    ascent: nextTop != null ? pts[nextTop].t - pts[bottom].t : null,
    keyFrame: bottom,
    braceI: prevTop,
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
  else issues.push(issue('warn', '시작 자세에서 팔꿈치가 바 아래에 있지 않음: 팔꿈치를 바 바로 아래로'));

  const lo = prevTop ?? Math.max(0, bottom - 30);
  const hi = nextTop ?? Math.min(pts.length - 1, bottom + 30);
  const seg = pts.slice(Math.min(lo, bottom), Math.max(hi, bottom) + 1);
  const layback = Math.max(...seg.map((f) => {
    const back = -(f.p.shoulder.x - f.p.hip.x) * facing;
    return (Math.atan2(back, Math.abs(f.p.hip.y - f.p.shoulder.y)) * 180) / Math.PI;
  }));
  if (layback > T.ohpLaybackBad) issues.push(issue('bad', `상체를 과하게 젖힘 (${layback.toFixed(0)}°): 둔근·복근 조여 허리 보호`));
  else if (layback > T.ohpLaybackWarn) issues.push(issue('warn', `상체 젖힘 ${layback.toFixed(0)}°: 갈비뼈를 내리고 코어 고정`));
  const minKnee = Math.min(...seg.map((f) => angle(f.p.hip, f.p.knee, f.p.ankle)));
  if (minKnee < 160) issues.push(issue('warn', `무릎 반동 사용 (${minKnee.toFixed(0)}°): 스트릭트 프레스는 다리를 고정`));

  if (nextTop != null) {
    const t = pts[nextTop].p;
    const lock = angle(t.shoulder, t.elbow, t.wrist);
    const over = Math.abs(t.wrist.x - midfoot(t)) / torso;
    if (lock < T.lockoutAngle) issues.push(issue('warn', `락아웃 불완전 (${lock.toFixed(0)}°): 팔꿈치를 끝까지 펴기`));
    else issues.push(issue('good', '락아웃 완료'));
    if (over > 0.25) issues.push(issue('warn', '락아웃에서 바가 미드풋 위에 있지 않음: 머리를 바 아래로 밀어 넣기'));
  }
  return {
    metrics: { layback: Math.max(0, Math.round(layback)), knee: Math.round(minKnee) },
    issues,
    conc: nextTop != null ? [pts[bottom].t, pts[nextTop].t] : null,
    ecc: prevTop != null ? [pts[prevTop].t, pts[bottom].t] : null,
    descent: prevTop != null ? pts[bottom].t - pts[prevTop].t : null,
    ascent: nextTop != null ? pts[nextTop].t - pts[bottom].t : null,
    keyFrame: bottom,
    braceI: prevTop,
  };
}

function analyzeDeadliftRep(pts, start, top, n, T) {
  const s = pts[start].p;
  const t = pts[top].p;
  const thigh = dist(s.hip, s.knee);
  const kneeStart = angle(s.hip, s.knee, s.ankle);
  const hipStart = angle(s.shoulder, s.hip, s.knee);
  const facing = Math.sign(s.toe.x - s.ankle.x) || 1;
  const issues = [];

  if (kneeStart > 155) issues.push(issue('warn', `시작 시 엉덩이가 높음 (무릎 ${kneeStart.toFixed(0)}°): 스티프 레그가 되지 않게 정강이를 바에 붙이기`));
  else if (kneeStart < 95) issues.push(issue('warn', `시작 시 엉덩이가 너무 낮음 (무릎 ${kneeStart.toFixed(0)}°): 스쿼트처럼 앉지 말기`));
  else issues.push(issue('good', '시작 자세 고관절 높이 적절'));

  const barOff = Math.abs(s.wrist.x - midfoot(s)) / thigh;
  if (barOff > 0.3) issues.push(issue('bad', '바가 미드풋에서 멀리 떨어짐: 바를 정강이에 붙이고 시작'));

  const k = start + Math.max(2, Math.round((top - start) * 0.35));
  const m = pts[Math.min(k, top)].p;
  const hipRise = s.hip.y - m.hip.y;
  const shRise = s.shoulder.y - m.shoulder.y;
  if (shRise > 0 && hipRise / shRise > 1.6) issues.push(issue('bad', '엉덩이가 먼저 뜸: 다리로 바닥을 밀며 가슴과 엉덩이를 같이 올리기'));

  const seg = pts.slice(start, top + 1);
  const path = (Math.max(...seg.map((f) => f.p.wrist.x)) - Math.min(...seg.map((f) => f.p.wrist.x))) / thigh;
  if (path > 0.35) issues.push(issue('warn', '바 경로가 앞뒤로 흔들림: 광배근을 조여 바를 몸에 붙이기'));

  const hipTop = angle(t.shoulder, t.hip, t.knee);
  const kneeTop = angle(t.hip, t.knee, t.ankle);
  const backLean = (t.shoulder.x - t.hip.x) * facing;
  const backDeg = (Math.atan2(-backLean, Math.abs(t.hip.y - t.shoulder.y)) * 180) / Math.PI;
  if (hipTop < T.lockoutAngle || kneeTop < T.lockoutAngle) issues.push(issue('warn', `락아웃 불완전 (고관절 ${hipTop.toFixed(0)}°, 무릎 ${kneeTop.toFixed(0)}°): 둔근 조이며 끝까지 서기`));
  else if (backDeg > 15) issues.push(issue('warn', `락아웃에서 허리 과신전 (${backDeg.toFixed(0)}°): 젖히지 말고 똑바로 서기`));
  else issues.push(issue('good', '락아웃 완료'));

  return {
    metrics: { kneeStart: +kneeStart.toFixed(0), hipStart: +hipStart.toFixed(0), hipTop: +hipTop.toFixed(0) },
    issues,
    conc: [pts[start].t, pts[top].t],
    ecc: null,
    descent: null,
    ascent: pts[top].t - pts[start].t,
    keyFrame: start,
    braceI: start,
  };
}

// 브레이싱 근사 지표 (복압 자체는 영상으로 측정 불가)
function bracing(pts, n, rep, refTrunk, lift, T) {
  const out = [];
  const metrics = {};
  // 1) 반복 직전 정지 시간: 숨 채우고 복압 잡을 시간
  if (rep.braceI != null) {
    const d = dwell(pts, n, rep.braceI);
    metrics.braceSec = +d.toFixed(1);
    if (d < T.rebraceSec) out.push(issue('warn', `반복 직전 정지 ${d.toFixed(1)}초: 숨을 다시 채우고 복압을 잡을 시간 없이 연속 수행. 무거운 세트는 반복마다 재브레이싱`));
  }
  const [t0, t1] = [rep.ecc?.[0] ?? rep.conc?.[0], rep.conc?.[1] ?? rep.ecc?.[1]];
  if (t0 == null || t1 == null) return { issues: out, metrics };
  const seg = pts.filter((f) => f.t >= t0 && f.t <= t1);
  if (seg.length < 3) return { issues: out, metrics };
  // 2) 몸통 길이 감소: 척추가 굽거나 복압이 풀려 몸통이 접힘 (벤치는 아치 때문에 제외)
  if (lift !== 'bench' && refTrunk) {
    const minTrunk = Math.min(...seg.map((f) => dist(f.p.shoulder, f.p.hip)));
    const shrink = ((refTrunk - minTrunk) / refTrunk) * 100;
    metrics.trunkShrink = Math.max(0, Math.round(shrink));
    if (shrink > T.trunkShrinkPct) out.push(issue('warn', `몸통 길이 ${shrink.toFixed(0)}% 짧아짐: 등이 말리거나 복압이 풀린 신호. 하강 전 360° 복압, 갈비뼈 고정`));
  }
  // 3) 상승 중 상체가 순간적으로 꺾임
  if (rep.conc && lift !== 'bench') {
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

function scoreIssues(issues) {
  let s = 100;
  for (const i of issues) s -= i.level === 'bad' ? 15 : i.level === 'warn' ? 7 : 0;
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
  const { events, n } = findEvents(pts, lift);
  const reps = [];
  for (let e = 0; e < events.length; e++) {
    const ev = events[e];
    const prev = events[e - 1];
    const next = events[e + 1];
    if (lift === 'deadlift') {
      if (ev.type === 'top' && prev && prev.type === 'bottom') reps.push(analyzeDeadliftRep(pts, prev.i, ev.i, n, T));
    } else if (ev.type === 'bottom' && (prev || next)) {
      const pt = prev && prev.type === 'top' ? prev.i : null;
      const nt = next && next.type === 'top' ? next.i : null;
      if (pt == null && nt == null) continue;
      const fn = { squat: analyzeSquatRep, bench: analyzeBenchRep, ohp: analyzeOhpRep }[lift];
      reps.push(fn(pts, pt, ev.i, nt, n, T));
    }
  }
  if (!reps.length) {
    return { ok: false, error: '반복 동작을 찾지 못했습니다. 최소 1회 이상 완전한 반복이 담긴 영상을 사용해 주세요.' };
  }

  // 기준 몸통 길이: 상단(서 있는) 자세들의 중앙값
  const tops = events.filter((e) => e.type === (lift === 'deadlift' ? 'top' : 'top')).map((e) => dist(pts[e.i].p.shoulder, pts[e.i].p.hip)).sort((a, b) => a - b);
  const refTrunk = tops.length ? tops[Math.floor(tops.length / 2)] : null;

  reps.forEach((r, i) => {
    r.rep = i + 1;
    if (!sagittal) { r.issues = []; r.metrics = {}; }
    const b = bracing(pts, n, r, sagittal ? refTrunk : null, sagittal ? lift : 'bench', T);
    r.issues.push(...b.issues);
    Object.assign(r.metrics, b.metrics);
  });

  const summary = [];
  const asc = reps.map((r) => r.ascent).filter((x) => x != null);
  if (asc.length >= 2) {
    const slow = asc[asc.length - 1] / asc[0];
    if (slow > 1.6) summary.push(issue('warn', `마지막 반복 상승 시간이 첫 반복의 ${slow.toFixed(1)}배: RPE 9 이상 추정, 다음 세트 무게 유지 또는 감량`));
    else summary.push(issue('good', '반복 간 상승 시간이 일정함'));
  }
  return { ok: true, side, lift, reps, summary, pts, events, n, finalize: () => finalize(reps, summary) };
}

// 바벨·정면 분석 결과를 합친 뒤 점수 계산
export function finalize(reps, summary) {
  reps.forEach((r) => { r.score = scoreIssues(r.issues); });
  const counts = {};
  reps.forEach((r) => r.issues.forEach((i) => {
    if (i.level === 'bad' || i.level === 'warn') {
      const key = i.text.replace(/[\d.]+/g, '#');
      counts[key] = counts[key] || { n: 0, text: i.text };
      counts[key].n++;
    }
  }));
  const recurring = Object.values(counts).filter((c) => c.n >= Math.max(2, Math.ceil(reps.length / 2)));
  recurring.forEach((c) => summary.push(issue('bad', `반복적으로 나타남 (${c.n}회): ${c.text}`)));
  const score = Math.round(reps.reduce((a, r) => a + r.score, 0) / reps.length - recurring.length * 3);
  return Math.max(0, Math.min(100, score));
}

// 셀프 체크리스트 점수 (영상 없이도 매일 기록 가능)
export const CHECKLIST = {
  squat: ['하강 전 숨 채우고 360° 복압', '무릎이 발끝 방향으로', '발 전체(삼각지지)로 지면 누르기', '깊이 패러렐 이하', '바가 미드풋 위 수직 경로'],
  bench: ['견갑 후인·하강 유지', '엉덩이 벤치에 고정', '레그 드라이브로 힘 전달', '가슴 터치 일정한 위치', '손목 중립, 전완 수직'],
  ohp: ['둔근·복근 조여 허리 젖히지 않기', '팔꿈치가 바 바로 아래', '머리를 바 아래로 밀어 넣기', '락아웃에서 어깨 으쓱', '무릎 반동 없음'],
  deadlift: ['바를 정강이에 붙이고 시작', '광배근 긴장(바 휘게 당기기)', '당기기 전 슬랙 제거 + 복압', '엉덩이·어깨 동시 상승', '락아웃 과신전 없음'],
};

export function checklistScore(checked, total, rpe, pain) {
  let s = Math.round((checked / total) * 100);
  if (pain) s -= 20;
  if (rpe >= 9.5) s -= 5;
  return Math.max(0, s);
}
