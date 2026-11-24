// 촬영 각도별 분석을 하나로 합치는 진입점 (DOM 없이 동작)
import { analyze, finalize } from './form-analysis.js';
import { toBodyFrames, sagittalFrames, analyzeFrontal } from './form-3d.js';
import { barSeries, analyzeBar } from './bar-analysis.js';
import { DEFAULT_THRESHOLDS } from './thresholds.js';
import { findActiveWindow } from './set-window.js';

export const VIEWS = {
  side: { name: '측면 (90°)', guide: '정측면, 엉덩이 높이. 깊이·상체각·바 경로·모멘트암을 가장 정확히 봅니다.' },
  oblique: { name: '후방 대각선 (45°)', guide: '뒤쪽 45°, 엉덩이 높이에 고정. 3D 추정으로 측면 항목과 무릎·골반 좌우 움직임을 함께 봅니다. 벤치는 머리 쪽 위 대각선에서 촬영.' },
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
export function evaluateForm({ frames: allFrames, lift, view = 'side', aspect = 1, T = DEFAULT_THRESHOLDS, bar = null, expectedReps = 0, window = null }) {
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
  let sag;
  if (view === 'oblique') {
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
    const bodies = toBodyFrames(frames, view === 'oblique' ? '3d' : 'front', aspect);
    frontal = analyzeFrontal(bodies, reps, topTimes, lift, T);
    if (frontal?.hidden.length) summary.push({ level: 'info', text: `가려져서 판정하지 못한 항목: ${frontal.hidden.join(', ')}. 해당 관절이 보이는 각도에서 촬영하면 평가됩니다.` });
    frontal?.reps.forEach((fr, i) => {
      reps[i].issues.push(...fr.issues);
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

  const score = finalize(reps, summary);
  const pick = (k, f = Math.max) => {
    const v = reps.map((r) => r.metrics[k]).filter(Number.isFinite);
    return v.length ? f(...v) : null;
  };
  return {
    ok: true,
    view,
    lift,
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
