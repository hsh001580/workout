// 언랙·워크아웃·랙·손 놓기 같은 준비 구간을 자동으로 찾아 분석 구간에서 제외
//
// 분석 구간 = (1) 발이 고정되어 있고 (2) 바를 쥔 자세인 프레임이 이어진 구간 중 움직임이 가장 많은 구간
//  - 발 고정: 발목 속도 < 0.25 다리길이/초 (걷기 = 워크아웃/워크인 제외)
//  - 바를 쥔 자세 (종목별):
//      OHP    손목이 어깨보다 팔 길이의 0.35배 이상 내려가지 않음 (랙에 건 뒤 팔 내림 제외)
//      스쿼트  손목이 어깨 근처 (바를 등에 멘 상태)
//      벤치   손목이 어깨보다 위 + 바가 얼굴 쪽으로 많이 넘어가지 않음 (랙 위치 제외)
//      데드   항상 (랙 없음, 걷기만 제외)

const IDS = { nose: [0], shoulder: [11, 12], elbow: [13, 14], wrist: [15, 16], hip: [23, 24], knee: [25, 26], ankle: [27, 28] };
const FOOT_SPEED = 0.25; // 다리 길이/초
const GAP_FILL = 1.0; // 초: 이보다 짧은 끊김(발목 인식 순간 튐 등)은 이어 붙임
const MIN_SEG = 1.0; // 초: 이보다 짧은 구간은 버림
const PAD = 0.25; // 초: 구간 앞뒤 여유

const median = (a) => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : NaN; };

function point(f, name, aspect, minVis = 0.3) {
  const ps = IDS[name].map((i) => f.lm[i]).filter((p) => p && (p.visibility ?? 1) >= minVis);
  if (!ps.length) return null;
  return { x: (ps.reduce((a, p) => a + p.x, 0) / ps.length) * aspect, y: ps.reduce((a, p) => a + p.y, 0) / ps.length };
}

const d = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y) : NaN);

function toSegments(times, flags) {
  const segs = [];
  let start = null;
  flags.forEach((on, i) => {
    if (on && start == null) start = i;
    if ((!on || i === flags.length - 1) && start != null) {
      const end = on ? i : i - 1;
      segs.push([start, end]);
      start = null;
    }
  });
  // 짧은 끊김 메우기
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && times[s[0]] - times[last[1]] <= GAP_FILL) last[1] = s[1];
    else merged.push([...s]);
  }
  return merged.filter(([a, b]) => times[b] - times[a] >= MIN_SEG);
}

/**
 * @returns { t0, t1, excluded: [[a, b], ...], trimmed, activeAt(t), segments }
 */
export function findActiveWindow(frames, lift, aspect = 1) {
  const fr = frames.filter((f) => f.lm);
  const all = { t0: fr[0]?.t ?? 0, t1: fr[fr.length - 1]?.t ?? 0, excluded: [], trimmed: false, activeAt: () => true };
  if (fr.length < 10) return all;
  const P = fr.map((f) => Object.fromEntries(Object.keys(IDS).map((k) => [k, point(f, k, aspect)])));
  const times = fr.map((f) => f.t);
  const leg = median(P.map((p) => d(p.hip, p.ankle)));
  const arm = median(P.map((p) => d(p.shoulder, p.elbow) + d(p.elbow, p.wrist)));
  if (!Number.isFinite(leg) || leg <= 0) return all;

  // (1) 발 고정: ±0.2초 사이 발목 이동 속도 (각 발목 중 빠른 쪽)
  const ankleSpeed = fr.map((f, i) => {
    let j0 = i;
    let j1 = i;
    while (j0 > 0 && times[i] - times[j0 - 1] <= 0.2) j0--;
    while (j1 < fr.length - 1 && times[j1 + 1] - times[i] <= 0.2) j1++;
    const dt = times[j1] - times[j0];
    if (dt <= 0) return 0;
    return Math.max(...[27, 28].map((k) => {
      const a = fr[j0].lm[k];
      const b = fr[j1].lm[k];
      if (!a || !b || (a.visibility ?? 1) < 0.3 || (b.visibility ?? 1) < 0.3) return 0;
      return Math.hypot((b.x - a.x) * aspect, b.y - a.y) / leg / dt;
    }));
  });
  // 원판에 발목이 가려지거나 깊이 앉을 때 생기는 순간 튐 제거 (5프레임 중앙값)
  const speedF = ankleSpeed.map((_, i) => {
    const w = ankleSpeed.slice(Math.max(0, i - 2), i + 3).sort((a, b) => a - b);
    return w[Math.floor(w.length / 2)];
  });
  // 벤치는 누운 자세라 다리 길이가 화면에서 짧게 잡히고 발목이 원판·벤치에 가려 떨림이 커서
  // 걷기 판정이 세트 중에도 켜짐 (실영상: 발목 신뢰도 0.7, 다리 길이 0.24 → 속도 0.3~0.7).
  // 서 있는 동안은 손목이 어깨보다 아래라 '바를 쥔 자세' 검사만으로 걷는 구간이 빠지므로 생략
  const still = lift === 'bench' ? speedF.map(() => true) : speedF.map((v) => v < FOOT_SPEED);

  // (2) 바를 쥔 자세
  // 머리 방향은 엉덩이 기준 (어깨 기준은 거리가 짧아 부호가 흔들림). 발·머리 쪽에서 몸통 방향으로 찍어
  // 머리-엉덩이 수평 거리가 짧으면 바의 얼굴 쪽 위치를 판단할 수 없으므로 그 검사는 생략
  const hx = median(P.map((p) => (p.nose && p.hip ? p.nose.x - p.hip.x : NaN)));
  const hd = median(P.map((p) => (p.nose && p.hip ? Math.hypot(p.nose.x - p.hip.x, p.nose.y - p.hip.y) : NaN)));
  const headDir = Math.sign(hx) || 1;
  const canJudgeRack = Number.isFinite(hx) && Math.abs(hx) > 0.6 * hd;
  const holding = P.map((p) => {
    if (lift === 'deadlift' || !Number.isFinite(arm) || !p.wrist || !p.shoulder) return true;
    const below = (p.wrist.y - p.shoulder.y) / arm; // +면 손목이 어깨보다 아래
    if (lift === 'ohp') return below < 0.35;
    if (lift === 'squat') return Math.abs(below) < 0.5;
    // bench: 손목이 어깨보다 위, 바가 얼굴 쪽(랙 위치)으로 많이 넘어가지 않음
    const overFace = ((p.wrist.x - p.shoulder.x) * headDir) / arm;
    return below < -0.05 && (!canJudgeRack || overFace < 0.35);
  });

  const active = still.map((s, i) => s && holding[i]);
  const segs = toSegments(times, active);
  if (!segs.length) return all;

  // 움직임(관절 높이 변화량 합)이 가장 큰 구간 = 실제 세트
  const sig = P.map((p) => {
    const a = lift === 'squat' ? p.hip : lift === 'deadlift' ? p.shoulder : p.wrist;
    return a ? a.y / leg : NaN;
  });
  const activity = ([a, b]) => {
    let s = 0;
    for (let i = a + 1; i <= b; i++) if (Number.isFinite(sig[i]) && Number.isFinite(sig[i - 1])) s += Math.abs(sig[i] - sig[i - 1]);
    return s;
  };
  // 움직임이 있는 구간은 모두 분석 대상 (가장 큰 구간 하나만 고르면 쪼개진 세트에서 회차가 빠짐)
  const maxAct = Math.max(...segs.map(activity));
  const keep = segs.filter((sg) => activity(sg) >= maxAct * 0.15).map(([a, b]) => [Math.max(all.t0, times[a] - PAD), Math.min(all.t1, times[b] + PAD)]);
  const t0 = keep[0][0];
  const t1 = keep[keep.length - 1][1];
  const excluded = [];
  let cur = all.t0;
  for (const [a, b] of keep) { if (a - cur > 0.5) excluded.push([cur, a]); cur = Math.max(cur, b); }
  if (all.t1 - cur > 0.5) excluded.push([cur, all.t1]);
  const activeAt = (t) => keep.some(([a, b]) => t >= a && t <= b);
  return { t0, t1, excluded, trimmed: excluded.length > 0, activeAt, segments: keep };
}
