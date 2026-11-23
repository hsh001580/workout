// 로컬 저장소(브라우저 localStorage) 기반 상태 관리
const KEY = 'workout-app-v1';

export function todayISO(d = new Date()) {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 10);
}

// 이번 주 월요일을 기본 시작일로 사용
function thisMonday() {
  const d = new Date();
  const day = (d.getDay() + 6) % 7; // 월=0
  d.setDate(d.getDate() - day);
  return todayISO(d);
}

export function defaultState() {
  return {
    settings: {
      squat1rm: 140,
      bench1rm: 100,
      deadlift1rm: 180,
      tmPercent: 90, // 트레이닝 맥스 = 1RM의 %
      days: 5, // 주당 훈련일 4/5/6
      weeklyKm: 20,
      fiveK: '25:00',
      hrMax: 190,
      hrRest: 60,
      startDate: thisMonday(),
    },
    formLogs: [],
    runLogs: [],
    done: {},
  };
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const base = defaultState();
    return {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}) },
    };
  } catch {
    return defaultState();
  }
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
