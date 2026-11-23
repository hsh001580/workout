// 정면·3D(대각선) 자세 분석: 무릎 밸거스, 무릎-발끝 정렬, 힙 시프트, 골반 기울기, 몸통 회전,
// 좌우 비대칭, 뒤꿈치 들림, 바벨 기울기, 벤치 팔꿈치 벌어짐, OHP 옆 기울기
//
// 3D 모드: MediaPipe world landmarks(미터, 골반 중심 원점, y 아래 방향)를 몸 기준 좌표계로 변환
//   ML(좌우) = 오른 고관절 - 왼 고관절, UP = 중력 반대(카메라 수평 가정), AP(앞뒤) = UP × ML
// 2D 정면 모드: 영상 좌표를 그대로 쓰며 AP 성분은 없음

const L = { shoulder: 11, elbow: 13, wrist: 15, hip: 23, knee: 25, ankle: 27, heel: 29, toe: 31 };
const R = { shoulder: 12, elbow: 14, wrist: 16, hip: 24, knee: 26, ankle: 28, heel: 30, toe: 32 };

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const norm = (a) => { const n = Math.hypot(a.x, a.y, a.z) || 1; return scale(a, 1 / n); };
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
const deg = (r) => (r * 180) / Math.PI;

function issue(level, text) {
  return { level, text };
}

/**
 * 프레임별 몸 기준 좌표로 변환
 * @param mode '3d' | 'front'
 * @returns [{t, P: {L:{...}, R:{...}, C}, hasAP, cmPerUnit}]
 */
export function toBodyFrames(frames, mode, aspect = 1) {
  const UP = { x: 0, y: -1, z: 0 };
  const raw = [];
  for (const f of frames) {
    const src = mode === '3d' ? f.world : f.lm;
    if (!src || !f.lm) continue;
    const vis = [L.hip, R.hip, L.knee, R.knee, L.ankle, R.ankle].reduce((a, i) => a + (f.lm[i]?.visibility ?? 1), 0) / 6;
    if (vis < 0.5) continue;
    const pt = (i) => (mode === '3d' ? { x: src[i].x, y: src[i].y, z: src[i].z } : { x: src[i].x * aspect, y: src[i].y, z: 0 });
    const lh = pt(L.hip);
    const rh = pt(R.hip);
    const C = mid(lh, rh);
    let ML = sub(rh, lh);
    ML = norm(sub(ML, scale(UP, dot(ML, UP))));
    const AP = mode === '3d' ? norm(cross(UP, ML)) : { x: 0, y: 0, z: 0 };
    const toBody = (p) => { const d = sub(p, C); return { ml: dot(d, ML), up: dot(d, UP), ap: dot(d, AP) }; };
    const side = (ids) => Object.fromEntries(Object.entries(ids).map(([k, i]) => [k, toBody(pt(i))]));
    raw.push({ t: f.t, L: side(L), R: side(R) });
  }
  if (!raw.length) return [];
  // AP 방향: 발끝이 앞(+)이 되도록 통일
  if (mode === '3d') {
    const s = raw.reduce((a, f) => a + (f.L.toe.ap - f.L.heel.ap) + (f.R.toe.ap - f.R.heel.ap), 0);
    if (s < 0) raw.forEach((f) => ['L', 'R'].forEach((k) => Object.values(f[k]).forEach((p) => { p.ap = -p.ap; })));
  }
  // 단위 → cm: 3D는 미터, 2D는 다리 길이(고관절~발목)를 85cm로 가정해 환산
  let cmPerUnit = 100;
  if (mode !== '3d') {
    const leg = raw.slice(0, 10).reduce((a, f) => a + (f.L.hip.up - f.L.ankle.up + f.R.hip.up - f.R.ankle.up) / 2, 0) / Math.min(10, raw.length);
    cmPerUnit = leg > 0 ? 85 / leg : 100;
  }
  return raw.map((f) => ({ ...f, hasAP: mode === '3d', cmPerUnit }));
}

// 3D 모드용: 측면 분석기를 재사용하기 위해 시상면(AP-UP)에 투영한 가짜 측면 영상 좌표 생성
export function sagittalFrames(frames) {
  const out = [];
  const bodies = toBodyFrames(frames, '3d');
  const byT = new Map(bodies.map((b) => [b.t, b]));
  const pairs = [[L, 'L'], [R, 'R']];
  for (const f of frames) {
    const b = byT.get(f.t);
    if (!b) continue;
    const lm = f.lm.map((p) => ({ x: 0.5, y: 0.5, z: 0, visibility: p.visibility }));
    // world 좌표는 골반 중심 원점이라 골반 높이 변화가 사라지므로, 지면(양 발목 중앙) 기준으로 옮긴다
    const g = { up: (b.L.ankle.up + b.R.ankle.up) / 2, ap: (b.L.ankle.ap + b.R.ankle.ap) / 2 };
    for (const [ids, k] of pairs) {
      for (const [name, i] of Object.entries(ids)) {
        const q = b[k][name];
        lm[i] = { x: 0.5 + (q.ap - g.ap) * 0.5, y: 0.9 - (q.up - g.up) * 0.5, z: 0, visibility: f.lm[i].visibility };
      }
    }
    out.push({ t: f.t, lm });
  }
  return out;
}

function angle3(a, b, c) {
  const v1 = { x: a.ml - b.ml, y: a.up - b.up, z: a.ap - b.ap };
  const v2 = { x: c.ml - b.ml, y: c.up - b.up, z: c.ap - b.ap };
  const d = Math.hypot(v1.x, v1.y, v1.z) * Math.hypot(v2.x, v2.y, v2.z);
  return d ? deg(Math.acos(Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y + v1.z * v2.z) / d)))) : NaN;
}

// 한 프레임의 원시 지표
function rawMetrics(f) {
  const k = f.cmPerUnit;
  const out = {};
  for (const [s, sign] of [['L', -1], ['R', 1]]) {
    const P = f[s];
    // 정강이 전두면 각도: 발목→무릎 벡터가 수직에서 몸 안쪽(+)/바깥쪽(-)으로 기운 각
    const medial = (P.ankle.ml - P.knee.ml) * sign;
    out['shin' + s] = deg(Math.atan2(medial, Math.max(1e-6, P.knee.up - P.ankle.up)));
    // 무릎이 발(발끝) 안쪽으로 들어간 거리
    out['kneeIn' + s] = (P.toe.ml - P.knee.ml) * sign * k;
    out['flex' + s] = 180 - angle3(P.hip, P.knee, P.ankle);
    out['heel' + s] = (P.heel.up - P.toe.up) * k; // 발끝 대비 뒤꿈치 높이
    out['wrist' + s] = P.wrist.up * k;
    out['elbowExt' + s] = angle3(P.shoulder, P.elbow, P.wrist);
    if (f.hasAP) {
      // 수평면에서 허벅지(고관절→무릎) 방향과 발(뒤꿈치→발끝) 방향 차이. 무릎이 더 안쪽이면 +
      const th = Math.atan2((P.knee.ml - P.hip.ml) * sign, P.knee.ap - P.hip.ap);
      const ft = Math.atan2((P.toe.ml - P.heel.ml) * sign, P.toe.ap - P.heel.ap);
      const thLen = Math.hypot(P.knee.ml - P.hip.ml, P.knee.ap - P.hip.ap);
      out['kneeToe' + s] = thLen * k > 15 ? deg(ft - th) : null;
      // 팔꿈치 벌어짐: 위팔과 몸통 축 사이 각
      const sm = { ml: (f.L.shoulder.ml + f.R.shoulder.ml) / 2, up: (f.L.shoulder.up + f.R.shoulder.up) / 2, ap: (f.L.shoulder.ap + f.R.shoulder.ap) / 2 };
      out['flare' + s] = angle3(P.elbow, P.shoulder, { ml: P.shoulder.ml - sm.ml, up: P.shoulder.up - sm.up, ap: P.shoulder.ap - sm.ap });
    }
  }
  const midAnkleMl = (f.L.ankle.ml + f.R.ankle.ml) / 2;
  out.hipShift = -midAnkleMl * k; // 골반 중심(원점)이 양발 중앙보다 오른쪽이면 +
  out.pelvisTilt = (f.R.hip.up - f.L.hip.up) * k;
  const shMl = f.R.shoulder.ml - f.L.shoulder.ml;
  const shAp = f.R.shoulder.ap - f.L.shoulder.ap;
  out.trunkRot = f.hasAP ? deg(Math.atan2(shAp, shMl)) : null;
  const shoulderMid = { ml: (f.L.shoulder.ml + f.R.shoulder.ml) / 2, up: (f.L.shoulder.up + f.R.shoulder.up) / 2 };
  out.lateralLean = deg(Math.atan2(shoulderMid.ml, Math.max(1e-6, shoulderMid.up)));
  return out;
}

function avgMetrics(list) {
  const out = {};
  for (const key of Object.keys(list[0] || {})) {
    const vals = list.map((m) => m[key]).filter((v) => v != null && Number.isFinite(v));
    out[key] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  return out;
}

const sideKo = (v) => (v > 0 ? '오른쪽' : '왼쪽');

/**
 * @param bodies toBodyFrames 결과
 * @param reps 측면 분석 반복 (conc/ecc 시간 포함)
 * @param topTimes 서 있는(상단) 자세 시각들 — 기준 자세
 */
export function analyzeFrontal(bodies, reps, topTimes, lift, T) {
  if (!bodies.length) return null;
  const metricsAt = bodies.map((b) => ({ t: b.t, m: rawMetrics(b) }));
  const near = (t) => metricsAt.reduce((a, x) => (Math.abs(x.t - t) < Math.abs(a.t - t) ? x : a), metricsAt[0]);
  const refList = topTimes.length ? topTimes.map((t) => near(t).m) : metricsAt.slice(0, 5).map((x) => x.m);
  const ref = avgMetrics(refList);
  const hasAP = bodies[0].hasAP;

  // 특정 시각의 기준 대비 변화 (스티킹 포인트 원인 진단용)
  const deltaAt = (t) => {
    const m = near(t).m;
    const valgus = Math.max(m.shinL - ref.shinL, m.shinR - ref.shinR);
    const shift = m.hipShift - ref.hipShift;
    return { valgus, hipShiftCm: Math.abs(shift), hipShiftDir: sideKo(shift) };
  };

  const repOut = reps.map((r) => {
    const issues = [];
    const metrics = {};
    const t0 = r.ecc?.[0] ?? r.conc?.[0];
    const t1 = r.conc?.[1] ?? r.ecc?.[1];
    if (t0 == null || t1 == null) return { rep: r.rep, issues, metrics };
    const win = metricsAt.filter((x) => x.t >= t0 && x.t <= t1).map((x) => x.m);
    if (win.length < 2) return { rep: r.rep, issues, metrics };
    const maxOf = (key, f = (v) => v) => Math.max(...win.map((m) => f(m[key])).filter(Number.isFinite));
    const legLift = lift === 'squat' || lift === 'deadlift';

    if (legLift) {
      // 무릎 밸거스: 기준 자세 대비 정강이가 안쪽으로 기운 최대 변화
      const vL = maxOf('shinL', (v) => v - ref.shinL);
      const vR = maxOf('shinR', (v) => v - ref.shinR);
      const v = Math.max(vL, vR);
      const which = vL > vR ? '왼쪽' : '오른쪽';
      metrics.valgusL = Math.round(vL);
      metrics.valgusR = Math.round(vR);
      if (v > T.valgusBad) issues.push(issue('bad', `${which} 무릎이 안쪽으로 ${v.toFixed(0)}° 모임: 발 삼각지지로 지면을 벌리듯 누르고 무릎을 발끝 방향으로`));
      else if (v > T.valgusWarn) issues.push(issue('warn', `${which} 무릎이 안쪽으로 ${v.toFixed(0)}° 모임: 둔근 활성화, 무릎-발끝 정렬 유지`));
      else issues.push(issue('good', `무릎 좌우 정렬 양호 (최대 ${Math.max(0, v).toFixed(0)}°)`));
      if (Math.abs(vL - vR) > T.valgusWarn) issues.push(issue('warn', `좌우 무릎 움직임 차이 ${Math.abs(vL - vR).toFixed(0)}°: ${which} 다리 약화 또는 가동성 차이 의심`));

      if (hasAP) {
        const kt = Math.max(maxOf('kneeToeL'), maxOf('kneeToeR'));
        if (Number.isFinite(kt)) {
          metrics.kneeToe = Math.round(kt);
          if (kt > T.kneeToeWarn) issues.push(issue('warn', `무릎이 발끝 방향보다 ${kt.toFixed(0)}° 안쪽을 향함: 무릎을 두 번째 발가락 방향으로`));
        }
      }
      // 뒤꿈치 들림
      const heel = Math.max(maxOf('heelL', (v) => v - ref.heelL), maxOf('heelR', (v) => v - ref.heelR));
      metrics.heelCm = +Math.max(0, heel).toFixed(1);
      if (heel > T.heelLiftCm) issues.push(issue('warn', `뒤꿈치 ${heel.toFixed(1)}cm 들림: 무게중심이 앞꿈치로 쏠림. 발목 가동성 확인, 뒤꿈치로 지면 누르기`));
      // 좌우 굴곡 차이 (스쿼트)
      if (lift === 'squat') {
        const asym = Math.max(...win.map((m) => Math.abs(m.flexL - m.flexR)));
        metrics.flexAsym = Math.round(asym);
        if (asym > T.depthAsymWarn) issues.push(issue('warn', `좌우 무릎 굽힘 차이 ${asym.toFixed(0)}°: 한쪽으로 체중이 쏠림`));
      }
    }

    // 힙 시프트 (모든 종목, 벤치 제외)
    if (lift !== 'bench') {
      const shifts = win.map((m) => m.hipShift - ref.hipShift);
      const s = shifts.reduce((a, v) => (Math.abs(v) > Math.abs(a) ? v : a), 0);
      metrics.hipShiftCm = +s.toFixed(1);
      if (Math.abs(s) > T.hipShiftBadCm) issues.push(issue('bad', `골반이 ${sideKo(s)}으로 ${Math.abs(s).toFixed(1)}cm 이동(힙 시프트): 반대쪽 다리로 힘이 덜 전달됨. 양발 균등 압력, 고관절 가동성 점검`));
      else if (Math.abs(s) > T.hipShiftWarnCm) issues.push(issue('warn', `골반이 ${sideKo(s)}으로 ${Math.abs(s).toFixed(1)}cm 이동`));
      const tilt = Math.max(...win.map((m) => Math.abs(m.pelvisTilt - ref.pelvisTilt)));
      metrics.pelvisTiltCm = +tilt.toFixed(1);
      if (tilt > T.pelvisTiltCm) issues.push(issue('warn', `골반 좌우 높이 ${tilt.toFixed(1)}cm 기울어짐`));
    }
    // 몸통 회전
    if (hasAP && ref.trunkRot != null) {
      const rot = Math.max(...win.map((m) => Math.abs(m.trunkRot - ref.trunkRot)));
      metrics.trunkRot = Math.round(rot);
      if (rot > T.trunkRotWarn) issues.push(issue('warn', `몸통이 ${rot.toFixed(0)}° 회전: 복압과 광배근 긴장으로 몸통 고정`));
    }
    // 바벨 기울기 (손목 높이 차)
    if (lift !== 'squat') {
      const tilt = Math.max(...win.map((m) => Math.abs((m.wristL - m.wristR) - (ref.wristL - ref.wristR))));
      metrics.barTiltCm = +tilt.toFixed(1);
      if (tilt > T.barTiltCm) issues.push(issue('warn', `바벨이 좌우로 ${tilt.toFixed(1)}cm 기울어짐: 약한 쪽 팔·등 보강, 그립 위치 대칭 확인`));
    }
    // 벤치: 팔꿈치 벌어짐, 락아웃 좌우 차이
    if (lift === 'bench' && hasAP) {
      const bottom = near(r.conc?.[0] ?? t1).m;
      const flare = (bottom.flareL + bottom.flareR) / 2;
      if (Number.isFinite(flare)) {
        metrics.flare = Math.round(flare);
        if (flare > T.elbowFlareMax) issues.push(issue('warn', `하단에서 팔꿈치 벌어짐 ${flare.toFixed(0)}°: 어깨 부담. 팔꿈치를 45~70° 정도로 모으기`));
        else if (flare < 30) issues.push(issue('info', `팔꿈치를 많이 붙임 (${flare.toFixed(0)}°): 바가 배 쪽으로 내려가는지 확인`));
        else issues.push(issue('good', `팔꿈치 각도 ${flare.toFixed(0)}° 적정`));
      }
    }
    if ((lift === 'bench' || lift === 'ohp') && r.conc) {
      const top = near(r.conc[1]).m;
      const diff = Math.abs(top.elbowExtL - top.elbowExtR);
      if (diff > 15) issues.push(issue('warn', `락아웃 시 좌우 팔꿈치 각 차이 ${diff.toFixed(0)}°: 한쪽 팔이 늦게 펴짐`));
    }
    // OHP: 옆으로 기울기
    if (lift === 'ohp') {
      const lean = Math.max(...win.map((m) => Math.abs(m.lateralLean - ref.lateralLean)));
      metrics.lateralLean = Math.round(lean);
      if (lean > T.lateralLeanWarn) issues.push(issue('warn', `몸통이 옆으로 ${lean.toFixed(0)}° 기울어짐: 둔근·복사근으로 골반 고정`));
    }
    return { rep: r.rep, issues, metrics };
  });

  return { reps: repOut, deltaAt, ref };
}
