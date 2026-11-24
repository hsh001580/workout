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

// 정면·3D·바벨 판정의 범주
function catOf(text) {
  if (/무릎이 안쪽|무릎이 발끝|팔꿈치 벌어짐/.test(text)) return 'risk';
  if (/락아웃 시 좌우/.test(text)) return 'rule';
  return 'eff';
}

export function evaluateForm({ frames: allFrames, lift, view = 'side', aspect = 1, T = DEFAULT_THRESHOLDS, bar = null, expectedReps = 0, window = null, style = {} }) {
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
    sag = analyze(frames, lift, aspect, T, { ...opts, sagittal: view === 'side' });
  }
  if (!sag.ok) return { ...sag, window: win, timeline: sag.timeline };
  const { reps, summary } = sag;
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
    },
  };
}
