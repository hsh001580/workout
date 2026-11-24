// 4일 로테이션 웨이트 + 가민 기록 기반 러닝 주간 프로그램
// 웨이트: A(오버헤드프레스+스쿼트) → B(벤치+데드리프트) → C(등+팔 + 오버헤드프레스 2회차) → D(휴식) 반복
// coach 컨텍스트가 있으면 코칭 엔진(coach.js)이 블록 단계·기록·자세·컨디션으로 처방을 만든다.
import { phaseAt, prescribe, accessoryScale, garminCheckin } from './coach.js';

export const DAY_NAMES = ['월', '화', '수', '목', '금', '토', '일'];

// 주차별 강도 (트레이닝 맥스 대비 %)
export const WAVE = [
  { name: '적응 주간', heavy: { sets: 5, reps: 5, pct: 75 }, backoff: { reps: 8, pct: 65 }, runMul: 1.0, quality: 'tempo' },
  { name: '누적 주간', heavy: { sets: 5, reps: 4, pct: 80 }, backoff: { reps: 7, pct: 68 }, runMul: 1.05, quality: 'interval' },
  { name: '강화 주간', heavy: { sets: 5, reps: 3, pct: 85 }, backoff: { reps: 6, pct: 72 }, runMul: 1.1, quality: 'cruise' },
  { name: '디로드 주간', heavy: { sets: 3, reps: 5, pct: 60 }, backoff: null, runMul: 0.7, quality: 'strides', deload: true },
];

export const LIFT_KO = { squat: '백 스쿼트', bench: '벤치프레스', deadlift: '데드리프트', ohp: '오버헤드 프레스' };

export const ROTATION = [
  { key: 'A', title: '오버헤드프레스 + 스쿼트', lifts: ['squat', 'ohp'], hyp: [['레그 프레스', 3, '10-12'], ['사이드 레터럴 레이즈', 3, '15']] },
  { key: 'B', title: '벤치 + 데드리프트', lifts: ['bench', 'deadlift'], hyp: [['인클라인 덤벨 프레스', 3, '8-12'], ['트라이셉스 푸시다운', 3, '12']] },
  {
    key: 'C', title: '등 + 팔 + 오버헤드프레스', lifts: [], secondary: ['ohp'], hyp: [
      ['풀업 / 랫풀다운', 4, '8-10'], ['바벨 로우', 3, '8'], ['시티드 케이블 로우', 3, '10-12'], ['페이스 풀', 3, '15'],
      ['바벨 컬', 3, '10'], ['해머 컬', 3, '12'], ['오버헤드 트라이셉스 익스텐션', 3, '12'], ['딥스 / 클로즈그립 벤치', 3, '10'],
    ],
  },
  { key: 'D', title: '웨이트 휴식', lifts: [], hyp: [] },
];

const RUN_WEIGHT = { easy: 1, quality: 1.25, long: 1.8 };

export function parseTime(str) {
  if (typeof str === 'number') return str;
  const parts = String(str || '').trim().split(':').map(Number);
  if (!parts.length || parts.some((n) => Number.isNaN(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export function fmtPace(secPerKm) {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return '-';
  let m = Math.floor(secPerKm / 60);
  let s = Math.round(secPerKm % 60);
  if (s === 60) { m += 1; s = 0; }
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return '-';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// 5K 기록(초 또는 'mm:ss') 기반 훈련 페이스 (초/km)
export function paces(fiveK) {
  const p = parseTime(fiveK) / 5;
  const base = Number.isFinite(p) && p > 0 ? p : 300;
  return {
    easy: [base * 1.22, base * 1.35],
    long: [base * 1.2, base * 1.32],
    threshold: base * 1.06,
    interval: base * 0.99,
    race5k: base,
  };
}

export function roundTo(kg, step = 2.5) {
  return Math.round(kg / step) * step;
}

function midnight(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function daysBetween(startDate, date) {
  return Math.round((midnight(date) - new Date(startDate + 'T00:00:00')) / 86400000);
}

export function weekIndex(startDate, date = new Date()) {
  return Math.max(0, Math.floor(daysBetween(startDate, date) / 7));
}

export function rotationOf(startDate, date) {
  const n = daysBetween(startDate, date);
  return ROTATION[((n % 4) + 4) % 4];
}

function buildRun(kind, km, wave, pc) {
  const pr = (r) => `${fmtPace(r[0])}~${fmtPace(r[1])}/km`;
  if (kind === 'easy') return { title: '이지 런', km, detail: `${km}km 편하게 (대화 가능한 강도, 심박 Z2)`, pace: pr(pc.easy), runType: 'easy' };
  if (kind === 'long') return { title: '롱 런', km, detail: `${km}km 꾸준히, 마지막 2km는 살짝 빠르게 가능`, pace: pr(pc.long), runType: 'long' };
  const main = Math.max(2, Math.round((km - 3.5) * 2) / 2);
  switch (wave.quality) {
    case 'tempo':
      return { title: '템포 런', km, detail: `워밍업 2km → 역치 페이스 ${main}km → 쿨다운 1.5km`, pace: `역치 ${fmtPace(pc.threshold)}/km`, runType: 'tempo' };
    case 'interval': {
      const n = Math.min(6, Math.max(3, Math.round(main)));
      return { title: '인터벌', km, detail: `워밍업 2km → 1km × ${n}회 (휴식 2분 조깅) → 쿨다운 1.5km`, pace: `인터벌 ${fmtPace(pc.interval)}/km`, runType: 'interval' };
    }
    case 'cruise': {
      const n = Math.min(4, Math.max(2, Math.round(main / 2)));
      return { title: '크루즈 인터벌', km, detail: `워밍업 2km → 2km × ${n}회 (휴식 1분) → 쿨다운 1.5km`, pace: `역치 ${fmtPace(pc.threshold)}/km`, runType: 'tempo' };
    }
    default:
      return { title: '이지 + 스트라이드', km, detail: `${km}km 이지 런 후 20초 스트라이드 6회`, pace: pr(pc.easy), runType: 'easy' };
  }
}

// 러닝 배치 규칙: 하체를 하는 A·B일에는 고강도 러닝 금지.
//  품질 런 → C(상체) > D(휴식) / 롱 런 → 주말 D > D > 주말 C > C / 이지 → D > C > A > B
const PREF = {
  quality: (r, wk) => ({ C: 3, D: 2 }[r] || 0),
  long: (r, wk) => ({ D: 4, C: 2 }[r] || 0) + (wk ? 1.5 : 0),
  easy: (r) => ({ D: 4, C: 3, A: 2, B: 1 }[r] || 0),
};

function placeRuns(days, kinds) {
  const used = new Set();
  const placed = [];
  for (const kind of kinds) {
    let best = -1;
    let bestScore = 0;
    days.forEach((d, i) => {
      if (used.has(i)) return;
      let s = PREF[kind](d.rotation.key, d.date.getDay() === 0 || d.date.getDay() === 6);
      // 품질 런 다음 날 롱 런, 롱 런 다음 날 품질 런 피하기
      if (kind !== 'easy' && placed.some((p) => p.kind !== 'easy' && Math.abs(p.i - i) === 1)) s -= 1.5;
      if (s > bestScore) { bestScore = s; best = i; }
    });
    if (best >= 0) { used.add(best); placed.push({ kind, i: best }); }
  }
  return placed;
}

const isoOf = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

// 코칭 처방 → 화면 항목
function rxItems(rx) {
  const items = [];
  let detail = '';
  if (rx.single) detail += `싱글 1회 @ ${rx.single.kg}kg (RPE ${rx.single.rpe}) → `;
  detail += `탑세트 ${rx.reps}회 @ ${rx.kg}kg (RPE ${rx.rpe})`;
  if (rx.backoff?.sets) detail += ` → 백오프 ${rx.backoff.sets}×${rx.backoff.reps} @ ${rx.backoff.kg}kg`;
  items.push({
    type: 'lift', lift: rx.lift, kind: 'heavy', title: rx.name, detail,
    kg: rx.kg, reps: rx.reps, rpe: rx.rpe, sets: 1 + (rx.backoff?.sets || 0),
    e1rm: Math.round(rx.e1rm), note: rx.cues.join(' / '), reasons: rx.reasons,
  });
  if (rx.variation) {
    const v = rx.variation;
    items.push({
      type: 'lift', lift: rx.lift, kind: 'variation', variation: true, title: v.name,
      detail: `${v.sets}×${v.reps}${v.kg ? ` @ ${v.kg}kg` : ''}`, kg: v.kg, reps: v.reps, rpe: 7,
      note: `약점 보완: ${v.why}`, reasons: [],
    });
  }
  return items;
}

/**
 * @param settings 앱 설정
 * @param weekIdx 시작일 기준 주차 (0부터)
 * @param stats run-analysis.runStats() 결과 (가민 기록 기반, 없으면 설정값 사용)
 * @param coach { state, runAcwr, hardRunOn(iso) } 코칭 엔진 컨텍스트 (없으면 고정 % 웨이브)
 */
export function buildWeek(settings, weekIdx = 0, stats = null, coach = null) {
  let wave = WAVE[weekIdx % 4];
  let phase = null;
  if (coach) {
    phase = phaseAt(weekIdx, coach.state.coach || {});
    const wi = Math.min(phase.wi, phase.runMul.length - 1);
    wave = {
      name: phase.forced ? '디로드 (피로 누적으로 자동 배치)' : `${phase.name} ${phase.wi + 1}주차`,
      runMul: phase.runMul[wi], quality: phase.quality[Math.min(phase.wi, phase.quality.length - 1)],
      deload: !!phase.deload, phase,
    };
  }
  const cycle = Math.floor(weekIdx / 4);
  const tmPct = (settings.tmPercent || 90) / 100;
  const inc = { squat: 5, bench: 2.5, deadlift: 5, ohp: 1.25 };
  const tm = {};
  for (const l of Object.keys(inc)) tm[l] = Number(settings[l + '1rm'] || 0) * tmPct + inc[l] * cycle;

  const fiveK = stats?.fiveKSec || settings.fiveK;
  const pc = paces(fiveK);
  const baseKm = stats?.baseKm || Number(settings.weeklyKm) || 20;
  const weeklyKm = Math.round(baseKm * wave.runMul * 2) / 2;

  const start = new Date(settings.startDate + 'T00:00:00');
  const days = DAY_NAMES.map((_, i) => {
    const date = new Date(start);
    date.setDate(start.getDate() + weekIdx * 7 + i);
    const name = DAY_NAMES[(date.getDay() + 6) % 7];
    const rotation = rotationOf(settings.startDate, date);
    const items = [];
    const extraAcc = [];
    if (coach) {
      const iso = isoOf(date);
      const prevDay = new Date(date);
      prevDay.setDate(date.getDate() - 1);
      // 직접 기록한 컨디션 우선, 없으면 가민 회복 지표(수면·레디니스·바디 배터리)로 자동 산출
      const checkin = coach.state.checkins?.[iso] || garminCheckin(coach.state.garmin?.data?.daily?.[iso]);
      const ctx = { state: coach.state, settings, phase, date: iso, checkin, hardRunYesterday: coach.hardRunOn?.(isoOf(prevDay)) };
      for (const lift of rotation.lifts) {
        const rx = prescribe(lift, ctx);
        items.push(...rxItems(rx));
        extraAcc.push(...rx.accessories);
      }
      for (const lift of rotation.secondary || []) {
        const rx = prescribe(lift, { ...ctx, secondary: true });
        if (rx) {
          items.push({ type: 'lift', lift, kind: 'variation', variation: true, title: `${rx.name} (${LIFT_KO[lift]} 2회차)`, detail: `${rx.sets}×${rx.reps}${rx.kg ? ` @ ${rx.kg}kg` : ''}`, kg: rx.kg, reps: rx.reps, rpe: 7, note: rx.cues.concat(rx.reasons).join(' / '), reasons: [] });
          extraAcc.push(...rx.accessories);
        }
      }
    } else {
      for (const lift of rotation.lifts) {
        const h = wave.heavy;
        const kg = roundTo((tm[lift] * h.pct) / 100, 2 * (Number(settings.minPlate) || 1.25));
        let detail = `${h.sets}세트 × ${h.reps}회 @ ${kg}kg (TM ${h.pct}%)`;
        if (wave.backoff) detail += ` + 백오프 1×${wave.backoff.reps} @ ${roundTo((tm[lift] * wave.backoff.pct) / 100, 2 * (Number(settings.minPlate) || 1.25))}kg`;
        items.push({
          type: 'lift', lift, kind: 'heavy',
          title: LIFT_KO[lift], detail, kg, sets: h.sets, reps: h.reps,
          note: wave.deload ? '디로드: 가볍게, 자세에 집중' : '탑세트 RPE 8 이하. 영상 촬영 후 자세 평가',
        });
      }
    }
    if (rotation.hyp.length || extraAcc.length) {
      const f = coach ? accessoryScale(phase, coach.state.checkins?.[isoOf(date)] || garminCheckin(coach.state.garmin?.data?.daily?.[isoOf(date)]), coach.runAcwr) : (wave.deload ? 0.67 : 1);
      const list = rotation.hyp.map(([n, sets, r]) => `${n} ${Math.max(1, Math.round(sets * f))}×${r}`);
      const uniq = [...new Set(extraAcc)];
      items.push({
        type: 'hyp',
        title: rotation.key === 'C' ? '등 + 팔 근비대' : '보조 근비대',
        detail: [...uniq.map((a) => `★${a}`), ...list].join(' · '),
        note: `세트당 RIR 1-2${uniq.length ? ' · ★ 약점 보완 운동 우선' : ''}${f < 0.95 ? ` · 볼륨 ${Math.round(f * 100)}%` : ''}`,
      });
    }
    return { dayIdx: i, name, date, rotation, items };
  });

  // 러닝 횟수: 주간 거리에 따라 3~5회
  const n = weeklyKm < 15 ? 3 : weeklyKm < 35 ? 4 : 5;
  const kinds = ['quality', 'long', ...Array(n - 2).fill('easy')];
  const placed = placeRuns(days, kinds);
  const totalW = placed.reduce((a, p) => a + RUN_WEIGHT[p.kind], 0);
  const kmOf = {};
  placed.forEach((p) => { kmOf[p.i] = Math.max(3, Math.round(((weeklyKm * RUN_WEIGHT[p.kind]) / totalW) * 2) / 2); });
  // 롱 런은 최근 최장 거리 + 2km 이내로 제한하고 남는 거리는 이지 런에 분배
  const longP = placed.find((p) => p.kind === 'long');
  if (longP && stats?.longest) {
    const cap = Math.max(6, Math.round((stats.longest + 2) * 2) / 2);
    if (kmOf[longP.i] > cap) {
      const extra = kmOf[longP.i] - cap;
      kmOf[longP.i] = cap;
      const easies = placed.filter((p) => p.kind === 'easy');
      easies.forEach((p) => { kmOf[p.i] = Math.round((kmOf[p.i] + extra / easies.length) * 2) / 2; });
    }
  }
  placed.forEach((p) => days[p.i].items.push({ type: 'run', ...buildRun(p.kind, kmOf[p.i], wave, pc) }));
  days.forEach((d) => { d.rest = d.items.length === 0; });

  return { weekIdx, wave, phase, cycle, tm, days, weeklyKm, fiveKSec: parseTime(fiveK), stats };
}

// 특정 날짜의 처방
export function sessionFor(settings, date, stats = null, coach = null) {
  const w = weekIndex(settings.startDate, date);
  const week = buildWeek(settings, w, stats, coach);
  const i = Math.min(6, Math.max(0, daysBetween(settings.startDate, date) - w * 7));
  return week.days[i];
}
