// 러닝 후 평가: 강도 적합성, 페이스, 훈련 부하, 유산소 효율, 회복 조언
import { paces, parseTime, fmtPace, fmtDuration } from './program.js';

export const RUN_TYPES = {
  easy: '이지 런',
  long: '롱 런',
  tempo: '템포/역치',
  interval: '인터벌',
  race: '레이스/기록 측정',
};

// 심박 예비량(HRR) 기반 존
export function hrZone(avgHr, hrMax, hrRest) {
  const hrr = (avgHr - hrRest) / (hrMax - hrRest);
  const zone = hrr < 0.6 ? 1 : hrr < 0.7 ? 2 : hrr < 0.8 ? 3 : hrr < 0.9 ? 4 : 5;
  return { hrr, zone };
}

const EXPECTED_ZONE = { easy: [1, 2], long: [1, 2], tempo: [3, 4], interval: [3, 5], race: [4, 5] };

// Banister TRIMP
export function trimp(durationMin, hrr) {
  const x = Math.min(1, Math.max(0, hrr));
  return durationMin * x * 0.64 * Math.exp(1.92 * x);
}

// Daniels VDOT
export function vdot(distanceM, timeSec) {
  const t = timeSec / 60;
  const v = distanceM / t;
  const vo2 = -4.6 + 0.182258 * v + 0.000104 * v * v;
  const pct = 0.8 + 0.1894393 * Math.exp(-0.012778 * t) + 0.2989558 * Math.exp(-0.1932605 * t);
  return vo2 / pct;
}

// VDOT으로 특정 거리 예상 기록(초) 역산
export function predictTime(vd, distanceM) {
  let lo = 60;
  let hi = 60 * 60 * 6;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (vdot(distanceM, mid) > vd) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function item(level, text) {
  return { level, text };
}

/**
 * @param run {type, distanceKm, duration('h:mm:ss'|'mm:ss'), avgHr, cadence, rpe, elevGain, date}
 * @param settings 앱 설정
 * @param history 이전 러닝 기록 (평가 결과 포함)
 * @param nextSession 다음 날 프로그램 (program.sessionFor)
 */
export function evaluateRun(run, settings, history = [], nextSession = null) {
  const durationSec = parseTime(run.duration);
  const km = Number(run.distanceKm);
  if (!(km > 0) || !(durationSec > 0)) return { ok: false, error: '거리와 시간을 올바르게 입력해 주세요.' };

  const pace = durationSec / km;
  const pc = paces(settings.fiveK);
  const hrMax = Number(settings.hrMax);
  const hrRest = Number(settings.hrRest);
  const avgHr = Number(run.avgHr) || null;
  const rpe = Number(run.rpe) || null;
  const out = [];
  let score = 100;

  // 1) 강도 적합성 (심박 기준, 없으면 RPE 기준)
  let zone = null;
  let hrr = null;
  const [zLo, zHi] = EXPECTED_ZONE[run.type];
  if (avgHr) {
    ({ zone, hrr } = hrZone(avgHr, hrMax, hrRest));
    if (zone > zHi) {
      score -= run.type === 'easy' || run.type === 'long' ? 25 : 10;
      out.push(item('bad', `평균 심박 Z${zone}: ${RUN_TYPES[run.type]} 목표(Z${zLo}-${zHi})보다 강함. ${run.type === 'easy' || run.type === 'long' ? '이지 런이 너무 빠르면 회복과 근력 훈련을 방해합니다. 페이스를 늦추세요.' : '목표보다 과하게 달렸습니다.'}`));
    } else if (zone < zLo) {
      score -= 15;
      out.push(item('warn', `평균 심박 Z${zone}: 목표(Z${zLo}-${zHi})보다 약함. 품질 세션이라면 구간 페이스를 확인하세요.`));
    } else {
      out.push(item('good', `평균 심박 Z${zone}: ${RUN_TYPES[run.type]} 목표 강도에 맞음`));
    }
  } else if (rpe) {
    const ok = { easy: [2, 4], long: [3, 5], tempo: [6, 8], interval: [7, 9], race: [8, 10] }[run.type];
    if (rpe > ok[1]) { score -= 15; out.push(item('warn', `RPE ${rpe}: 목표(${ok[0]}-${ok[1]})보다 힘들게 달림`)); }
    else if (rpe < ok[0]) { score -= 10; out.push(item('warn', `RPE ${rpe}: 목표(${ok[0]}-${ok[1]})보다 쉬움`)); }
    else out.push(item('good', `RPE ${rpe}: 목표 강도에 맞음`));
  }

  // 2) 페이스 적합성
  if (run.type === 'easy' || run.type === 'long') {
    const [fast, slow] = pc[run.type];
    if (pace < fast - 5) { score -= 15; out.push(item('warn', `페이스 ${fmtPace(pace)}/km: 권장 이지 페이스(${fmtPace(fast)}~${fmtPace(slow)})보다 빠름`)); }
    else out.push(item('good', `페이스 ${fmtPace(pace)}/km: 이지 범위 내`));
  } else if (run.type === 'race') {
    out.push(item('info', `평균 페이스 ${fmtPace(pace)}/km`));
  } else {
    out.push(item('info', `전체 평균 페이스 ${fmtPace(pace)}/km (워밍업 포함). 목표 구간 페이스: ${run.type === 'tempo' ? '역치 ' + fmtPace(pc.threshold) : '인터벌 ' + fmtPace(pc.interval)}/km`));
  }

  // 3) RPE-심박 불일치 = 피로 신호
  if (zone && rpe && zone <= 2 && rpe >= 6) {
    score -= 10;
    out.push(item('warn', '심박은 낮은데 체감은 힘듦: 누적 피로·수면 부족 가능. 다음 헤비 리프팅 무게를 보수적으로'));
  }

  // 4) 케이던스
  const cad = Number(run.cadence) || null;
  if (cad) {
    if (cad < 160) { score -= 5; out.push(item('warn', `케이던스 ${cad}spm: 보폭을 줄이고 발걸음 수를 5~10% 늘려보세요 (착지 충격 감소)`)); }
    else out.push(item('good', `케이던스 ${cad}spm 양호`));
  }

  // 5) 훈련 부하
  const durMin = durationSec / 60;
  const load = hrr != null ? trimp(durMin, hrr) : rpe ? durMin * rpe * 0.5 : durMin * 3;
  const now = new Date(run.date + 'T12:00:00');
  const within = (d) => history.filter((h) => {
    const diff = (now - new Date(h.date + 'T12:00:00')) / 86400000;
    return diff >= 0 && diff < d;
  });
  const acute = within(7).reduce((a, h) => a + (h.result?.load || 0), 0) + load;
  const chronicRuns = within(28);
  let acwr = null;
  const oldest = history.length ? Math.min(...history.map((h) => new Date(h.date + 'T12:00:00'))) : now;
  if ((now - oldest) / 86400000 >= 14) {
    const chronic = (chronicRuns.reduce((a, h) => a + (h.result?.load || 0), 0) + load) / 4;
    acwr = chronic ? acute / chronic : null;
    if (acwr > 1.5) { score -= 10; out.push(item('bad', `급성/만성 부하비 ${acwr.toFixed(2)}: 부상 위험 구간. 이번 주 러닝 거리를 줄이세요.`)); }
    else if (acwr < 0.8) out.push(item('info', `급성/만성 부하비 ${acwr.toFixed(2)}: 부하가 낮음. 점진적으로 늘려도 됩니다.`));
    else out.push(item('good', `급성/만성 부하비 ${acwr.toFixed(2)}: 적정 범위`));
  } else {
    out.push(item('info', '부하비(ACWR)는 2주 이상 기록이 쌓이면 계산됩니다.'));
  }

  // 6) 유산소 효율 (심박당 이동거리) 추세: 이지/롱 런끼리 비교
  let efficiency = null;
  if (avgHr) {
    efficiency = (km * 1000) / (durMin * avgHr); // m/beat
    if (run.type === 'easy' || run.type === 'long') {
      const prev = history.filter((h) => (h.type === 'easy' || h.type === 'long') && h.result?.efficiency).slice(-5);
      if (prev.length >= 3) {
        const avg = prev.reduce((a, h) => a + h.result.efficiency, 0) / prev.length;
        const ch = ((efficiency - avg) / avg) * 100;
        if (ch > 3) out.push(item('good', `유산소 효율 ${ch.toFixed(1)}% 향상 (최근 이지 런 평균 대비)`));
        else if (ch < -5) out.push(item('warn', `유산소 효율 ${Math.abs(ch).toFixed(1)}% 저하: 더위·피로·탈수 여부 확인`));
        else out.push(item('info', '유산소 효율은 최근과 비슷합니다.'));
      }
    }
  }

  // 7) VDOT 추정 (레이스/기록 측정일 때)
  let vd = null;
  let predicted5k = null;
  if (run.type === 'race' && km >= 1.5) {
    vd = vdot(km * 1000, durationSec);
    predicted5k = predictTime(vd, 5000);
    out.push(item('info', `VDOT ${vd.toFixed(1)} · 예상 5K ${fmtDuration(predicted5k)} · 10K ${fmtDuration(predictTime(vd, 10000))} · 하프 ${fmtDuration(predictTime(vd, 21097))}`));
  }

  // 8) 다음 날 리프팅과의 간섭
  const hard = (zone && zone >= 4) || (rpe && rpe >= 8) || load > 150;
  if (nextSession && !nextSession.rest) {
    const heavyLower = nextSession.items.find((i) => i.type === 'lift' && i.kind === 'heavy' && (i.lift === 'squat' || i.lift === 'deadlift'));
    if (heavyLower && hard) out.push(item('warn', `내일 ${heavyLower.title}: 오늘 강도가 높았으니 단백질 1.6g/kg 이상, 수면 8시간, 웜업을 길게. 바 스피드가 느리면 탑세트를 -5% 하세요.`));
    else if (heavyLower) out.push(item('info', `내일 ${heavyLower.title}: 오늘은 가볍게 마무리했으니 계획대로 진행하세요.`));
  }
  if (Number(run.elevGain) > km * 25) out.push(item('info', `누적 상승 ${run.elevGain}m: 언덕이 많아 심박이 높게 나올 수 있습니다.`));

  return {
    ok: true,
    pace,
    zone,
    hrr,
    load: Math.round(load),
    acwr,
    efficiency,
    vdot: vd,
    predicted5k,
    score: Math.max(0, Math.min(100, Math.round(score))),
    items: out,
  };
}

// 최근 러닝 기록(가민)으로 다음 주 러닝 처방 기준 계산
export function runStats(runLogs, today = new Date(), garminVo2 = null) {
  const day0 = new Date(today);
  day0.setHours(12, 0, 0, 0);
  const ago = (r) => (day0 - new Date(r.date + 'T12:00:00')) / 86400000;
  const recent = runLogs.filter((r) => ago(r) >= 0 && ago(r) < 56);
  if (!recent.length) return null;

  // 최근 4주 (오늘 제외, 7일 단위)
  const weeks = [0, 1, 2, 3].map((w) => recent
    .filter((r) => ago(r) >= 1 + w * 7 && ago(r) < 1 + (w + 1) * 7)
    .reduce((a, r) => a + Number(r.distanceKm || 0), 0));
  const span = Math.max(...recent.map(ago));
  const nWeeks = Math.min(4, Math.max(1, Math.ceil(span / 7)));
  const avg4 = weeks.slice(0, nWeeks).reduce((a, b) => a + b, 0) / nWeeks;
  const lastWeek = weeks[0];
  const acwr = avg4 > 0 ? lastWeek / avg4 : null;

  // 점진적 증가: 4주 평균의 +8%, 단 지난주의 +15%를 넘지 않음. 부하가 급증했으면 유지
  let base = avg4 * 1.08;
  if (lastWeek > 0) base = Math.min(base, lastWeek * 1.15);
  if (acwr && acwr > 1.3) base = avg4;
  base = Math.max(10, Math.round(base * 2) / 2);

  // 체력 지표: 가민 VO2max 우선, 없으면 최근 강한 러닝의 VDOT 최댓값
  let vo2 = Number(garminVo2) || null;
  let source = vo2 ? '가민 VO2max' : null;
  if (!vo2) {
    const hard = recent.filter((r) => ['tempo', 'interval', 'race'].includes(r.type) && Number(r.distanceKm) >= 3);
    const best = Math.max(0, ...hard.map((r) => vdot(Number(r.distanceKm) * 1000, parseTime(r.duration))));
    if (best > 20) { vo2 = best; source = '최근 기록 VDOT'; }
  }
  const longest = Math.max(0, ...recent.filter((r) => ago(r) < 28).map((r) => Number(r.distanceKm)));

  return {
    baseKm: base,
    avg4: Math.round(avg4 * 10) / 10,
    lastWeek: Math.round(lastWeek * 10) / 10,
    acwr,
    vo2,
    vo2Source: source,
    fiveKSec: vo2 ? Math.round(predictTime(vo2, 5000)) : null,
    longest,
    count: recent.length,
  };
}
