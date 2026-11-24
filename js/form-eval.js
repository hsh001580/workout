// 촬영 각도별 분석을 하나로 합치는 진입점 (DOM 없이 동작)
import { analyze, finalize } from './form-analysis.js';
import { toBodyFrames, sagittalFrames, analyzeFrontal } from './form-3d.js';
import { barSeries, analyzeBar } from './bar-analysis.js';
import { DEFAULT_THRESHOLDS } from './thresholds.js';
import { findActiveWindow } from './set-window.js';

// 대각선(전방·후방)은 3D 추정 경로를 쓴다
export const is3dView = (v) => v === 'oblique' || v === 'obliqueFront';

export const VIEWS = {
  side: { name: '측면 (90°)', guide: '정측면, 엉덩이 높이. 깊이·상체각·바 경로·모멘트암을 가장 정확히 봅니다.' },
  oblique: { name: '후방 대각선 (45°)', guide: '뒤쪽 45°, 엉덩이 높이에 고정. 3D 추정으로 측면 항목과 무릎·골반 좌우 움직임을 함께 봅니다. 골반·허리 라인이 잘 보입니다. 벤치는 머리 쪽 위 대각선에서 촬영.' },
  obliqueFront: { name: '전방 대각선 (45°)', guide: '앞쪽 45°, 엉덩이 높이에 고정. 3D 추정으로 측면 항목과 좌우 움직임을 함께 봅니다. 무릎과 발끝이 잘 보여 무릎 밸거스·무릎-발끝 정렬 판정에 가장 유리합니다. 벤치는 발 쪽 대각선 위에서 촬영.' },
  front: { name: '정면·후면', guide: '정면 또는 정후면. 무릎 밸거스·힙 시프트·바벨 기울기 등 좌우 움직임만 정밀하게 봅니다.' },
};

/**
 * @param frames [{t, lm, world}]
 * @param bar { track: [{t, x, y, lost}], scale } | null  (x, y는 영상 높이 기준 정규화, scale은 1단위당 m)
 */
/**
 * @param expectedReps 입력한 반복 수 (검출 민감도 자동 조정 힌트)
 * @param window { t0, t1 } 직접 지정한 분석 구간 (있으면 자동 준비 구간 판단 대신 사용)
 */
// 스타일 자동 판단
//  데드리프트 스모: 양 발목 너비 / 양 고관절 너비 > 1.7 (대각선·정면에서만 판단 가능)
//  스쿼트 하이바/로우바: 서 있을 때 바(원판 중심)가 어깨 관절보다 몸통 길이의 6% 이상 위면 하이바 (원판 추적 시)
export function detectStyle(frames, lift, view, bar, aspect = 1) {
  const med = (a) => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : NaN; };
  if (lift === 'deadlift' && view !== 'side') {
    const r = med(frames.map((f) => {
      const P = view === 'front' ? f.lm : f.world;
      if (!P) return NaN;
      const w = (a, b) => (view === 'front' ? Math.abs(P[a].x - P[b].x) * aspect : Math.hypot(P[a].x - P[b].x, P[a].z - P[b].z));
      return w(27, 28) / (w(23, 24) || NaN);
    }));
    if (Number.isFinite(r)) return { deadlift: r > 1.7 ? 'sumo' : 'conventional', how: `발 너비/골반 너비 ${r.toFixed(1)}` };
  }
  if (lift === 'squat' && view === 'side' && bar?.length) {
    const r = med(frames.slice(0, 20).map((f) => {
      const b = bar.reduce((a, x) => (Math.abs(x.t - f.t) < Math.abs(a.t - f.t) ? x : a), bar[0]);
      const sh = [f.lm[11], f.lm[12]].filter((q) => (q.visibility ?? 1) > 0.5);
      const hp = [f.lm[23], f.lm[24]].filter((q) => (q.visibility ?? 1) > 0.5);
      if (!sh.length || !hp.length) return NaN;
      const shY = sh.reduce((a, q) => a + q.y, 0) / sh.length;
      const hpY = hp.reduce((a, q) => a + q.y, 0) / hp.length;
      return (shY - b.y) / Math.abs(hpY - shY);
    }));
    if (Number.isFinite(r)) return { squat: r > 0.06 ? 'highbar' : 'lowbar', how: `바 위치 어깨 대비 ${(r * 100).toFixed(0)}%` };
  }
  return {};
}

const STYLE_KO = { highbar: '하이바', lowbar: '로우바', conventional: '컨벤셔널', sumo: '스모' };

// 대각선: 카메라에 가까운 쪽 다리의 화면 좌표로 깊이 (카메라가 엉덩이 높이에 수평이면 높이 차이는 원근 영향이 작음)
// 3D 추정 깊이는 앞뒤 방향 오차가 커서 실제보다 얕게 나오는 경우가 확인됨
function nearSideDepth(frames, t, aspect) {
  const f = frames.reduce((a, x) => (x.lm && Math.abs(x.t - t) < Math.abs(a.t - t) ? x : a), frames[0]);
  if (!f?.lm) return null;
  const dz = f.lm[23].z - f.lm[24].z;
  const [hip, knee] = dz < 0 ? [23, 25] : [24, 26];
  const P = (i) => ({ x: f.lm[i].x * aspect, y: f.lm[i].y });
  const thigh = Math.hypot(P(hip).x - P(knee).x, P(hip).y - P(knee).y);
  return thigh > 0 ? (P(hip).y - P(knee).y) / thigh : null;
}
// 대각선에서 앞뒤 기울기 기반 판정은 원근으로 각도가 작게 보여 참고 정보로
const OBLIQUE_SAGITTAL = /상체가 .*숙여짐|상체각 |엉덩이가 먼저 뜸|미드풋에서 벗어남|0\.2초 사이|등 각도가 무너짐|다리에서 멀어짐|앞뒤로 흔들림/;

// 정면·3D·바벨 판정의 범주
function catOf(text) {
  if (/무릎이 안쪽|무릎이 발끝|팔꿈치 벌어짐/.test(text)) return 'risk';
  if (/락아웃 시 좌우/.test(text)) return 'rule';
  return 'eff';
}

// 평가 목적 '지속 성장'(기본): 대회 전용 판정(머리 들림·정지 신호 등)을 빼고 '규정'을 '가동범위·통제'로 바꿔 읽는다
const MEET_ONLY = /머리 들림|가슴에서 정지|터치앤고|대회 퍼즈/;
function forLongevity(i) {
  if (MEET_ONLY.test(i.text)) return null;
  let cat = i.cat;
  let level = i.level;
  if (cat === 'rule') {
    if (/발 위치 이동|발을 옮김|발 위치 이동/.test(i.text)) cat = 'eff';
    else if (/엉덩이가 벤치에서 뜸|어깨가 들림/.test(i.text)) { cat = 'risk'; level = level === 'bad' ? 'warn' : level; }
    else cat = 'rom';
  }
  const text = i.text
    .replace('규정 깊이 통과', '깊이 충분').replace('팔꿈치 깊이 규정 통과', '팔꿈치 깊이 충분 (가슴까지)')
    .replace(/\s*\((대회 |2026 IPF |)실격( 가능)?\)/g, '').replace(/\s*\(2023 IPF 규정\)/g, '').replace(/\s*\(실격 사유\)/g, '')
    .replace('(대회 실격)', '').replace('심판 시야에 따라 실패 가능, ', '');
  return { ...i, cat, level, text };
}

// 세트 후반에 자세가 무너지는가: 첫 회차 대비 마지막 두 회차 중 나쁜 쪽 (지속 가능 강도의 핵심 신호)
const DRIFT = {
  squat: [['leanUp', 6, '올라올 때 엉덩이 먼저 뜸', '°'], ['torso', 6, '하단 상체각', '°'], ['lumbarFlex', 2, '허리 말림', '%'], ['valgusR', 6, '오른 무릎 밸거스', '°'], ['valgusL', 6, '왼 무릎 밸거스', '°'], ['depth', -0.1, '깊이', '']],
  deadlift: [['backShift', 6, '바닥에서 뗄 때 등 각도 무너짐', '°'], ['lumbarFlex', 2, '허리 말림', '%'], ['kneeGap', 0.1, '바-다리 거리', ''], ['midfootCm', 3, '바-미드풋 편차', 'cm']],
  bench: [['shoulderLift', 6, '어깨 들림', '%'], ['buttLift', 4, '엉덩이 들림', '%'], ['touch', 0.08, '터치 위치 변화', ''], ['descentSec', -0.4, '하강 시간', '초']],
  ohp: [['layback', 5, '상체 젖힘', '°'], ['kneeDip', 5, '무릎 반동', '°'], ['lumbarFlex', -2, '허리 젖힘', '%']],
};
const OBLIQUE_UNRELIABLE = ['leanUp', 'torso', 'backShift', 'kneeGap', 'midfootCm', 'layback'];
export function fatigueDrift(reps, lift, oblique = false) {
  if (reps.length < 3) return [];
  const first = reps[0].metrics;
  const tail = reps.slice(-2).map((r) => r.metrics);
  const out = [];
  for (const [k, lim, label, unit] of (DRIFT[lift] || []).filter(([k]) => !(oblique && OBLIQUE_UNRELIABLE.includes(k)))) {
    if (!Number.isFinite(first[k])) continue;
    const vals = tail.map((m) => m[k]).filter(Number.isFinite);
    if (!vals.length) continue;
    const worse = lim > 0 ? Math.max(...vals) : Math.min(...vals);
    const d = Math.abs(lim) < 1 && k === 'touch' ? Math.abs(worse - first[k]) : worse - first[k];
    if ((lim > 0 && d > lim) || (lim < 0 && d < lim)) {
      const fmt = (v) => (unit === '' ? v.toFixed(2) : `${Math.round(v * 10) / 10}${unit}`);
      out.push({ level: 'warn', cat: 'fatigue', text: `세트 후반에 자세 무너짐: ${label} ${fmt(first[k])} → ${fmt(worse)} (1회차 → 후반)` });
    }
  }
  if (out.length >= 2) out.unshift({ level: 'bad', cat: 'fatigue', text: `이 무게·반복 수는 지금 자세를 끝까지 유지하기 어려운 수준 (${out.length}개 지표가 후반에 무너짐): 세트당 반복을 줄이거나 무게를 낮추면 같은 자세로 오래 성장 가능` });
  return out;
}

export function evaluateForm({ frames: allFrames, lift, view = 'side', aspect = 1, T = DEFAULT_THRESHOLDS, bar = null, expectedReps = 0, window = null, style = {}, purpose = 'longevity' }) {
  let win;
  let frames = allFrames;
  if (window) {
    frames = allFrames.filter((f) => f.t >= window.t0 && f.t <= window.t1);
    win = { t0: window.t0, t1: window.t1, excluded: [], trimmed: false, manual: true, activeAt: () => true };
  } else {
    // 언랙·워크아웃·랙·손 놓기 구간 자동 판단 (반복을 찾은 뒤 그 구간의 반복만 제외)
    win = findActiveWindow(allFrames, lift, aspect);
  }
  const opts = { expectedReps, active: win.activeAt };
  // 스타일: 설정값 우선, '자동'이면 영상으로 판단
  const auto = detectStyle(frames, lift, view, bar?.track, aspect);
  const chosen = {
    squat: style.squat && style.squat !== 'auto' ? style.squat : auto.squat || null,
    deadlift: style.deadlift && style.deadlift !== 'auto' ? style.deadlift : auto.deadlift || null,
  };
  T = { ...T, _style: chosen };
  let sag;
  if (is3dView(view)) {
    if (!frames.some((f) => f.world)) return { ok: false, error: '3D 좌표를 얻지 못했습니다. 측면 모드로 분석해 주세요.' };
    sag = analyze(sagittalFrames(frames), lift, 1, { ...T, _oblique: true }, opts);
  } else {
    sag = analyze(frames, lift, aspect, view === 'side' ? T : { ...T, _noSpine: true }, { ...opts, sagittal: view === 'side' });
  }
  if (!sag.ok) return { ...sag, window: win, timeline: sag.timeline };
  const { reps, summary } = sag;
  if (is3dView(view)) {
    for (const r of reps) {
      r.issues = r.issues.map((i) => (OBLIQUE_SAGITTAL.test(i.text) && (i.level === 'warn' || i.level === 'bad')
        ? { ...i, level: 'info', text: `${i.text} (대각선 추정, 측면 촬영에서 정확)` } : i));
      if (lift === 'squat' && r.ecc !== undefined) {
        const bt = sag.pts[r.keyFrame]?.t;
        const d2 = bt != null ? nearSideDepth(frames, bt, aspect) : null;
        if (d2 != null) {
          r.metrics.depth = +d2.toFixed(2);
          const depthIdx = r.issues.findIndex((i) => /깊이/.test(i.text) && i.cat === 'rule');
          const note = ' (가까운 쪽 다리 화면 기준)';
          const ni = d2 >= Math.max(0, T.squatDepthWarn) ? { level: 'good', text: `규정 깊이 통과 (고관절이 무릎보다 아래)${note}`, cat: 'rule' }
            : d2 > T.squatDepthWarn - 0.08 ? { level: 'warn', text: `깊이 경계: 심판 시야에 따라 실패 가능, 1~3cm 더 앉기${note}`, cat: 'rule' }
              : { level: 'bad', text: `깊이 미달 (실격): 고관절을 무릎 높이 아래까지${note}`, cat: 'rule' };
          if (depthIdx >= 0) r.issues[depthIdx] = ni; else r.issues.unshift(ni);
        }
      }
    }
  }
  if (win.trimmed) {
    const f = (x) => x.toFixed(1);
    summary.unshift({ level: 'info', text: `언랙·랙 등 준비 구간 자동 제외: ${win.excluded.map(([a, b]) => `${f(a)}~${f(b)}초`).join(', ')}. 틀렸다면 아래 타임라인에서 구간을 직접 지정하세요.` });
  }
  if (expectedReps && reps.length !== Number(expectedReps)) {
    summary.unshift({ level: 'warn', text: `입력한 반복 수는 ${expectedReps}회인데 ${reps.length}회를 인식했습니다. 타임라인에서 구간을 조정해 다시 분석해 보세요.` });
  }
  const topTimes = sag.events.filter((e) => e.type === 'top').map((e) => sag.pts[e.i].t);

  let frontal = null;
  if (view !== 'side') {
    const bodies = toBodyFrames(frames, is3dView(view) ? '3d' : 'front', aspect);
    frontal = analyzeFrontal(bodies, reps, topTimes, lift, T);
    if (frontal?.hidden.length) summary.push({ level: 'info', text: `가려져서 판정하지 못한 항목: ${frontal.hidden.join(', ')}. 해당 관절이 보이는 각도에서 촬영하면 평가됩니다.` });
    frontal?.reps.forEach((fr, i) => {
      reps[i].issues.push(...fr.issues.map((x) => ({ ...x, cat: x.cat || catOf(x.text) })));
      Object.assign(reps[i].metrics, fr.metrics);
    });
  }

  let barResult = null;
  if (bar?.track?.length && bar.scale > 0) {
    const series = barSeries(bar.track, bar.scale);
    barResult = analyzeBar(series, reps, view === 'side' ? sag.pts : [], {
      lift, scale: bar.scale, sideView: view === 'side', T, frontalAt: frontal?.deltaAt,
    });
    barResult.reps.forEach((br, i) => {
      reps[i].issues.push(...br.issues);
      Object.assign(reps[i].metrics, br.metrics);
      reps[i].mcv = br.mcv;
      reps[i].sticking = br.sticking;
    });
    summary.push(...barResult.summary);
    barResult.series = series;
  }

  // 세트 후반 무너짐 (바벨·정면 지표까지 합친 뒤)
  const drift = fatigueDrift(reps, lift, is3dView(view));
  summary.push(...drift);
  if (purpose !== 'meet') {
    reps.forEach((r) => { r.issues = r.issues.map(forLongevity).filter(Boolean); });
    const kept = summary.map(forLongevity).filter(Boolean);
    summary.length = 0;
    summary.push(...kept);
  }
  const styleName = lift === 'squat' ? chosen.squat : lift === 'deadlift' ? chosen.deadlift : null;
  if (lift === 'squat' || lift === 'deadlift') {
    const src = (style[lift] && style[lift] !== 'auto') ? '설정' : auto[lift] ? `자동 판단: ${auto.how}` : '미지정 (설정에서 고르면 기준이 정확해짐)';
    summary.unshift({ level: 'info', text: `스타일: ${STYLE_KO[styleName] || '미지정'} (${src})`, cat: 'eff' });
  }
  const score = finalize(reps, summary);
  const pick = (k, f = Math.max) => {
    const v = reps.map((r) => r.metrics[k]).filter(Number.isFinite);
    return v.length ? f(...v) : null;
  };
  return {
    ok: true,
    view,
    lift,
    style: chosen,
    purpose,
    window: win,
    timeline: sag.timeline,
    reps,
    summary,
    score,
    pts: sag.pts,
    barResult,
    stats: {
      bestMcv: barResult?.bestMcv ?? null,
      velocityLoss: barResult?.velocityLoss ?? null,
      rir: barResult?.rir ?? null,
      valgus: (() => { const a = pick('valgusL'); const b = pick('valgusR'); return a == null && b == null ? null : Math.max(a ?? -99, b ?? -99); })(),
      hipShiftCm: (() => { const v = reps.map((r) => r.metrics.hipShiftCm).filter(Number.isFinite); return v.length ? v.reduce((a, x) => (Math.abs(x) > Math.abs(a) ? x : a), 0) : null; })(),
      midfootCm: (() => { const v = reps.map((r) => r.metrics.midfootCm).filter(Number.isFinite); return v.length ? Math.max(...v.map(Math.abs)) : null; })(),
      lumbarFlex: (() => { const v = reps.map((r) => r.metrics.lumbarFlex).filter(Number.isFinite); return v.length ? Math.max(...v) : null; })(),
      // 자세 무너짐: 후반 무너짐 2개 이상 또는 부하 위험 감점 (코칭에서 '자세 유지 한계 강도' 계산에 사용)
      breakdown: drift.some((i) => i.level === 'bad') || reps.some((r) => r.issues.some((i) => i.cat === 'risk' && i.level === 'bad')),
    },
  };
}
