// 파워리프팅 + 근비대 + 러닝 주간 프로그램 생성기 (4주 웨이브 주기)

export const DAY_NAMES = ['월', '화', '수', '목', '금', '토', '일'];

// 주차별 강도 (트레이닝 맥스 대비 %)
export const WAVE = [
  { name: '1주차 · 적응', heavy: { sets: 5, reps: 5, pct: 75 }, volume: { sets: 4, reps: 8, pct: 65 }, runMul: 1.0, quality: 'tempo' },
  { name: '2주차 · 누적', heavy: { sets: 5, reps: 4, pct: 80 }, volume: { sets: 4, reps: 7, pct: 68 }, runMul: 1.1, quality: 'interval' },
  { name: '3주차 · 강화', heavy: { sets: 5, reps: 3, pct: 85 }, volume: { sets: 3, reps: 6, pct: 72 }, runMul: 1.2, quality: 'cruise' },
  { name: '4주차 · 디로드', heavy: { sets: 3, reps: 5, pct: 60 }, volume: { sets: 2, reps: 8, pct: 55 }, runMul: 0.7, quality: 'strides', deload: true },
];

const LIFT_KO = { squat: '백 스쿼트', bench: '벤치프레스', deadlift: '데드리프트' };

const HYPERTROPHY = {
  legs: [
    ['레그 프레스', 3, '10-12'],
    ['루마니안 데드리프트', 3, '8-10'],
    ['레그 컬', 3, '12'],
    ['카프 레이즈', 3, '15'],
  ],
  push: [
    ['인클라인 덤벨 프레스', 3, '8-12'],
    ['덤벨 숄더 프레스', 3, '10'],
    ['케이블 플라이', 3, '12-15'],
    ['트라이셉스 푸시다운', 3, '12'],
  ],
  back: [
    ['풀업 / 랫풀다운', 4, '8-10'],
    ['바벨 로우', 3, '8'],
    ['시티드 케이블 로우', 3, '10-12'],
    ['페이스 풀', 3, '15'],
  ],
  arms: [
    ['사이드 레터럴 레이즈', 4, '15'],
    ['덤벨 컬', 3, '12'],
    ['오버헤드 트라이셉스 익스텐션', 3, '12'],
    ['리어 델트 플라이', 3, '15'],
  ],
};

const HYP_KO = { legs: '하체 근비대', push: '상체 밀기 근비대', back: '등 근비대', arms: '어깨·팔 근비대' };

// 주당 훈련일별 템플릿 (월~일). 무거운 하체 다음 날에는 고강도 러닝을 두지 않는다.
const TEMPLATES = {
  4: [
    [['lift', 'squat', 'heavy'], ['lift', 'bench', 'volume'], ['hyp', 'legs']],
    [['run', 'quality']],
    [],
    [['lift', 'deadlift', 'heavy'], ['lift', 'bench', 'heavy'], ['hyp', 'back']],
    [],
    [['run', 'long'], ['hyp', 'arms']],
    [],
  ],
  5: [
    [['lift', 'squat', 'heavy'], ['hyp', 'legs']],
    [['lift', 'bench', 'heavy'], ['hyp', 'push'], ['run', 'easy']],
    [['run', 'quality']],
    [['lift', 'deadlift', 'heavy'], ['hyp', 'back']],
    [],
    [['run', 'long'], ['lift', 'bench', 'volume'], ['hyp', 'arms']],
    [],
  ],
  6: [
    [['lift', 'squat', 'heavy'], ['hyp', 'legs']],
    [['lift', 'bench', 'heavy'], ['hyp', 'push'], ['run', 'easy']],
    [['run', 'quality'], ['hyp', 'arms']],
    [['lift', 'deadlift', 'heavy'], ['hyp', 'back']],
    [['lift', 'bench', 'volume'], ['lift', 'squat', 'volume'], ['run', 'easy']],
    [['run', 'long']],
    [],
  ],
};

const RUN_WEIGHT = { easy: 1, quality: 1.2, long: 1.6 };

export function parseTime(str) {
  if (typeof str === 'number') return str;
  const parts = String(str || '').trim().split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export function fmtPace(secPerKm) {
  if (!Number.isFinite(secPerKm) || secPerKm <= 0) return '-';
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return '-';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// 5K 기록 기반 훈련 페이스 (초/km)
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

export function weekIndex(startDate, date = new Date()) {
  const start = new Date(startDate + 'T00:00:00');
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const days = Math.floor((d - start) / 86400000);
  return Math.max(0, Math.floor(days / 7));
}

function buildRun(kind, km, wave, pc) {
  const pr = (r) => `${fmtPace(r[0])}~${fmtPace(r[1])}/km`;
  if (kind === 'easy') {
    return { title: '이지 런', km, detail: `${km}km 편하게 (대화 가능한 강도, 심박 Z2)`, pace: pr(pc.easy), runType: 'easy' };
  }
  if (kind === 'long') {
    return { title: '롱 런', km, detail: `${km}km 꾸준히, 마지막 2km는 살짝 빠르게 가능`, pace: pr(pc.long), runType: 'long' };
  }
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

export function buildWeek(settings, weekIdx = 0) {
  const wave = WAVE[weekIdx % 4];
  const cycle = Math.floor(weekIdx / 4);
  const tmPct = (settings.tmPercent || 90) / 100;
  // 주기(4주)마다 트레이닝 맥스 증가: 하체 +5kg, 벤치 +2.5kg
  const inc = { squat: 5, bench: 2.5, deadlift: 5 };
  const tm = {};
  for (const l of ['squat', 'bench', 'deadlift']) tm[l] = Number(settings[l + '1rm']) * tmPct + inc[l] * cycle;

  const template = TEMPLATES[settings.days] || TEMPLATES[5];
  const pc = paces(settings.fiveK);
  const weeklyKm = Number(settings.weeklyKm) * wave.runMul;
  let totalW = 0;
  template.forEach((day) => day.forEach((b) => { if (b[0] === 'run') totalW += RUN_WEIGHT[b[1]]; }));

  const days = template.map((blocks, i) => {
    const items = blocks.map((b) => {
      if (b[0] === 'lift') {
        const [, lift, kind] = b;
        const spec = wave[kind];
        const kg = roundTo((tm[lift] * spec.pct) / 100);
        return {
          type: 'lift', lift, kind,
          title: `${LIFT_KO[lift]} ${kind === 'heavy' ? '(헤비)' : '(볼륨)'}`,
          detail: `${spec.sets}세트 × ${spec.reps}회 @ ${kg}kg (TM ${spec.pct}%)`,
          note: kind === 'heavy' && !wave.deload ? '마지막 세트 RPE 8 이하 유지. 영상 촬영 후 자세 평가 권장' : '',
        };
      }
      if (b[0] === 'hyp') {
        const list = HYPERTROPHY[b[1]].map(([name, sets, reps]) => `${name} ${wave.deload ? Math.max(1, sets - 1) : sets}×${reps}`);
        return { type: 'hyp', title: HYP_KO[b[1]], detail: list.join(' · '), note: '세트당 RIR 1-2' };
      }
      const km = Math.max(3, Math.round(((weeklyKm * RUN_WEIGHT[b[1]]) / totalW) * 2) / 2);
      return { type: 'run', ...buildRun(b[1], km, wave, pc) };
    });
    return { dayIdx: i, name: DAY_NAMES[i], items, rest: items.length === 0 };
  });

  return { weekIdx, wave, cycle, tm, days, weeklyKm: Math.round(weeklyKm * 10) / 10 };
}

// 특정 날짜의 처방 (러닝 평가에서 다음 날 일정 확인용)
export function sessionFor(settings, date) {
  const w = weekIndex(settings.startDate, date);
  const week = buildWeek(settings, w);
  const dayIdx = (new Date(date).getDay() + 6) % 7;
  return week.days[dayIdx];
}
