// 코칭 엔진: 기록·자세 평가·느낌을 바탕으로 다음 세션을 설계 (순수 함수, DOM 없음)
//
// 원리
//  1) RPE 기반 자동조절: 수행 기록(무게·반복·RPE, 없으면 바벨 속도 RIR)으로 e1RM 추정 → 목표 반복·RPE로 무게 계산
//  2) 블록 주기화 8주: 축적 3주 → 강화 3주 → 실현 1주 → 디로드 1주. 피로 신호가 쌓이면 디로드를 앞당김
//  3) 세션 간 조정: 목표보다 힘들었으면 강도·볼륨↓, 쉬웠으면 볼륨↑, 자세가 무너지면 기술 우선(RPE 상한)
//  4) 자세 결함·스티킹 포인트 → 변형 운동·보조 운동·큐 처방, 통증 → 통증 없는 대체 운동
//  5) 컨디션 체크인(수면·에너지·근육통)과 러닝 부하로 당일 조정

export const LIFT_KO = { squat: '백 스쿼트', bench: '벤치프레스', deadlift: '데드리프트', ohp: '오버헤드 프레스' };

// ---------- RPE 표 (RTS 계열 근사): 유효 반복(반복 + 남은 반복) → 1RM 대비 비율 ----------
const PCT = [1, 1, 0.955, 0.922, 0.892, 0.863, 0.837, 0.811, 0.786, 0.762, 0.739, 0.707, 0.68, 0.653, 0.626, 0.599];

export function pctOf(reps, rpe) {
  const r = Math.min(15, Math.max(1, reps + (10 - rpe)));
  const lo = Math.floor(r);
  const hi = Math.min(15, lo + 1);
  return PCT[lo] + (PCT[hi] - PCT[lo]) * (r - lo);
}
export const e1rmOf = (kg, reps, rpe) => kg / pctOf(reps, rpe);
export const round25 = (kg) => Math.round(kg / 2.5) * 2.5;
// 가장 작은 원판(한쪽) × 2 = 바벨 무게 단위. 1.25kg 원판이 없으면 5kg 단위
// 설정이 없을 때(예전 백업·다른 기기에서 동기화된 옛 설정)도 기본값 2.5kg 원판 → 5kg 단위
export const plateStep = (settings) => 2 * (Number(settings?.minPlate) > 0 ? Number(settings.minPlate) : 2.5);
export const roundLoad = (kg, step = 2.5) => Math.round(kg / step) * step;
export const loadFor = (e1, reps, rpe, step = 2.5) => roundLoad(e1 * pctOf(reps, rpe), step);

// ---------- 블록 ----------
export const BLOCK = [
  { key: 'acc', name: '축적 (근비대·볼륨)', reps: [6, 6, 6], rpe: [7, 7.5, 8], back: [3, 4, 4], backReps: [6, 6, 6], drop: 0.1, hyp: 1.0, runMul: [1.0, 1.05, 1.1], quality: ['tempo', 'interval', 'tempo'] },
  { key: 'int', name: '강화 (근력)', reps: [4, 3, 3], rpe: [8, 8, 8.5], back: [3, 3, 2], backReps: [4, 3, 3], drop: 0.08, hyp: 0.8, runMul: [1.0, 1.05, 1.05], quality: ['cruise', 'interval', 'cruise'] },
  { key: 'real', name: '실현 (최대 근력)', reps: [2], rpe: [8.5], back: [2], backReps: [3], drop: 0.1, hyp: 0.6, runMul: [0.9], quality: ['strides'], single: true },
  { key: 'deload', name: '디로드 (회복)', reps: [5], rpe: [6], back: [1], backReps: [5], drop: 0.1, hyp: 0.5, runMul: [0.7], quality: ['strides'], deload: true },
];
// 데드리프트 전용 반복 체계: 바닥에서 시작해 반복 사이 탄성 도움이 없고 허리·전신 피로가 커서
// 현역 프로그램(RTS·Juggernaut 등)처럼 세트당 1~5회, 백오프도 적게. 볼륨은 변형 운동(RDL 등)으로 보충
export const LIFT_SCHEME = {
  deadlift: {
    acc: { reps: [5, 5, 4], back: [2, 3, 3], backReps: [4, 4, 3] },
    int: { reps: [3, 3, 2], back: [2, 2, 1], backReps: [3, 2, 2] },
    real: { reps: [2], back: [1], backReps: [2] },
    deload: { reps: [3], back: [1], backReps: [3] },
  },
  // 오버헤드프레스: 작은 근육군이라 고반복·낮은 RPE로는 자극이 부족 → 탑세트를 무겁게(RPE 8~9),
  // 볼륨은 백오프와 등+팔 날의 2회차(주 2회)로 확보. 백오프 감량도 작게(5%)
  ohp: {
    acc: { reps: [5, 5, 4], rpe: [8, 8, 8.5], back: [3, 3, 3], backReps: [6, 6, 5], drop: 0.05 },
    int: { reps: [3, 3, 2], rpe: [8.5, 8.5, 9], back: [3, 3, 2], backReps: [4, 3, 3], drop: 0.05 },
    real: { reps: [2], rpe: [9], back: [2], backReps: [3], drop: 0.07 },
  },
};
const LIFT_CAP = { deadlift: { reps: 5, backReps: 5, backSets: 3 } };

const BLOCK_WEEKS = BLOCK.flatMap((b, bi) => b.reps.map((_, wi) => ({ bi, wi })));

/** 주차(0부터)의 블록 단계. coachState.deloadWeeks에 있는 주는 강제 디로드, 디로드 다음 주부터 새 블록 */
export function phaseAt(weekIdx, coachState = {}) {
  const forced = new Set(coachState.deloadWeeks || []);
  let pos = 0;
  for (let w = 0; w <= weekIdx; w++) {
    if (w === weekIdx) {
      if (forced.has(w)) return { ...BLOCK[3], wi: 0, weekInBlock: pos, forced: true };
      const { bi, wi } = BLOCK_WEEKS[pos];
      return { ...BLOCK[bi], wi, weekInBlock: pos };
    }
    if (forced.has(w)) pos = 0;
    else pos = (pos + 1) % BLOCK_WEEKS.length;
  }
  return null;
}

// ---------- 자세 결함 코드 (평가 문구 → 코드) ----------
const FLAG_RULES = [
  ['depth', /깊이 미달|깊이 경계|깊이 부족|거의 패러렐/],
  ['downward', /상승 중 하강|당기는 중 하강|프레스 중 하강|히칭/],
  ['elbowDepth', /팔꿈치 깊이 (미달|경계)/],
  ['headLift', /머리 들림/],
  ['consistency', /깊이가 회차마다|상체각이 회차마다|시작 자세가 회차마다|등 각도 변화가 회차마다|젖힘이 회차마다/],
  ['hipShoot', /엉덩이가 먼저|엉덩이 먼저 뜸|고관절 모멘트암 \d+% 증가|상체가 0\.2초|기준보다 크게 숙여짐/],
  ['valgus', /무릎이 안쪽으로|무릎이 발끝 방향보다/],
  ['hipShift', /골반이 (왼|오른)쪽으로/],
  ['heel', /뒤꿈치 .*들림/],
  ['barPath', /미드풋|바 경로|바가 미드풋/],
  ['brace', /재브레이싱|복압이 풀린/],
  ['lumbar', /허리가 (조금 )?(둥글게 )?말림/],
  ['fatigue', /세트 후반에 자세 무너짐|끝까지 유지하기 어려운/],
  ['lockout', /락아웃 불완전|락아웃에서 바가 미드풋/],
  ['jcurve', /어깨 쪽으로 돌아오지 않고|락아웃 위치가 어깨 위가 아님|락아웃에서 바가 어깨 관절/],
  ['touchHigh', /터치 위치가 높음/],
  ['touchLow', /터치 위치가 낮음/],
  ['touchVar', /터치 위치가 회차마다/],
  ['buttLift', /엉덩이가 벤치에서 뜸/],
  ['shoulderLift', /어깨가 들림/],
  ['feet', /발이 움직임|발 위치 이동|발을 옮김/],
  ['descentFast', /하강이 너무 빠름/],
  ['layback', /젖힘|젖혀짐|과신전/],
  ['kneeDip', /무릎 반동/],
  ['pause', /정지 없음/],
  ['forearm', /전완|팔꿈치가 바 (아래|바로)/],
  ['flare', /팔꿈치 벌어짐/],
  ['barTilt', /바벨이 좌우로/],
  ['dlStart', /미드풋에서 멀리 떨어진 채 시작|미드풋보다 앞에서 시작|어깨가 바 뒤에|스모인데 무릎/],
];

export function flagsOf(texts = []) {
  const out = {};
  for (const t of texts) {
    for (const [code, re] of FLAG_RULES) if (re.test(t)) out[code] = (out[code] || 0) + 1;
    const m = t.match(/스티킹 포인트: 상승 (\d+)%/);
    if (m) out.sticking = Math.max(out.sticking || 0, Number(m[1]));
  }
  return out;
}

// 결함 → 변형 운동 (pct는 e1RM 대비), 보조 운동, 큐
const FIX = {
  squat: {
    lumbar: { v: ['퍼즈 스쿼트 (하단 2초)', 3, 3, 0.62], cue: '하단에서 골반이 말려 들어가지 않는 깊이까지, 벨트에 360° 복압을 유지', acc: ['데드버그 3×8/쪽', '버드독 3×8/쪽'] },
    downward: { v: ['퍼즈 스쿼트 (하단 2초)', 3, 3, 0.68], cue: '하단에서 한 번에 일어서기: 멈칫해도 다시 내려가지 않게 가속 유지 (실격 사유)' },
    feet: { cue: '셋업에서 발 위치를 정하고 반복 내내 발 전체로 지면 누르기' },
    consistency: { v: ['템포 스쿼트 (3초 하강)', 3, 4, 0.62], cue: '매 회차 같은 깊이·상체각: 하강 템포를 일정하게' },
    depth: { v: ['퍼즈 스쿼트 (하단 2초)', 3, 3, 0.68], cue: '하강 끝에서 고관절을 무릎 아래까지, 정지 중에도 복압 유지' },
    hipShoot: { v: ['템포 스쿼트 (3초 하강·1초 정지)', 3, 4, 0.63], cue: '올라올 때 가슴과 엉덩이를 같은 속도로, 등 상부로 바를 밀기', acc: ['프론트 스쿼트 또는 SSB 스쿼트 3×6'] },
    valgus: { v: ['템포 스쿼트 + 무릎 위 미니밴드', 3, 5, 0.6], cue: '발 삼각지지로 바닥을 벌리듯, 무릎은 두 번째 발가락 방향', acc: ['힙 어브덕션 3×15', '불가리안 스플릿 스쿼트 3×8/다리'] },
    hipShift: { v: ['불가리안 스플릿 스쿼트', 3, 8, 0], cue: '양발에 같은 압력, 하강 중 골반 수평 유지', acc: ['코펜하겐 플랭크 3×20초', '90/90 고관절 가동성 2분'] },
    heel: { v: ['힐 엘리베이티드 고블릿 스쿼트', 2, 10, 0], cue: '뒤꿈치로 지면 누르기, 발목 가동성 확보', acc: ['발목 무릎-벽 드릴 2×10/다리'] },
    barPath: { v: ['퍼즈 스쿼트 (하단 2초)', 3, 3, 0.65], cue: '바를 미드풋 위 수직으로, 발 전체로 지면 누르기' },
    brace: { v: ['퍼즈 스쿼트 (하단 2초)', 3, 3, 0.65], cue: '반복마다 숨을 다시 채우고 360° 복압, 갈비뼈 고정', acc: ['데드버그 3×8/쪽', '팔로프 프레스 3×12/쪽'] },
    stickLow: { v: ['핀 스쿼트 (스티킹 높이에서 시작)', 3, 3, 0.7], cue: '스티킹 구간에서 가속 의도 유지' },
  },
  deadlift: {
    lumbar: { v: ['루마니안 데드리프트 (허리 중립)', 3, 8, 0.5], cue: '바닥에서 떼기 전 슬랙 제거·복압, 허리 중립을 유지할 수 있는 무게로', acc: ['백 익스텐션 (허리 중립) 3×12'] },
    downward: { v: ['블록 풀 (무릎 높이)', 3, 3, 0.8], cue: '락아웃까지 한 번에: 허벅지에 바를 얹거나 다시 내렸다 올리지 않기 (실격 사유)', acc: ['힙 쓰러스트 3×8'] },
    feet: { cue: '셋업 후 발 고정' },
    consistency: { v: ['데드리프트 (매 회차 바닥에서 셋업 리셋)', 3, 2, 0.75], cue: '매 회차 같은 셋업 순서: 발 → 그립 → 슬랙 제거 → 숨 → 당기기' },
    hipShoot: { v: ['퍼즈 데드리프트 (무릎 아래 1초)', 3, 3, 0.65], cue: '다리로 바닥을 밀며 가슴과 엉덩이를 같이 올리기' },
    dlStart: { v: ['퍼즈 데드리프트 (무릎 아래 1초)', 3, 3, 0.65], cue: '정강이를 바에 붙이고, 엉덩이 높이는 어깨와 무릎 사이' },
    barPath: { v: ['퍼즈 데드리프트 (무릎 아래 1초)', 3, 3, 0.63], cue: '광배근으로 바를 몸에 붙이기 (겨드랑이 조이기)', acc: ['스트레이트암 풀다운 3×12'] },
    lockout: { v: ['블록 풀 (무릎 높이)', 3, 3, 0.8], cue: '둔근으로 골반을 밀어 마무리, 허리 젖히지 않기', acc: ['힙 쓰러스트 3×8'] },
    layback: { v: ['블록 풀 (무릎 높이)', 3, 3, 0.75], cue: '락아웃은 똑바로 서는 것까지, 뒤로 젖히지 않기' },
    brace: { v: ['루마니안 데드리프트', 3, 6, 0.55], cue: '슬랙 제거 후 숨 채우고 당기기', acc: ['데드버그 3×8/쪽'] },
    stickLow: { v: ['데피싯 데드리프트 (5cm)', 3, 4, 0.65], cue: '바닥에서 다리로 밀어 출발 속도 올리기' },
    stickHigh: { v: ['블록 풀 (무릎 높이)', 3, 3, 0.8], cue: '무릎 지나서 엉덩이를 앞으로' },
  },
  bench: {
    downward: { v: ['핀 프레스 (스티킹 높이)', 3, 3, 0.75], cue: '밀기 시작한 뒤 바가 다시 내려가지 않게 끝까지 가속 (실격 사유)' },
    elbowDepth: { v: ['퍼즈 벤치 (가슴 2초)', 3, 3, 0.7], cue: '바를 가슴(명치)까지 완전히 내려 팔꿈치가 어깨 높이 이하로 (2023 IPF 규정)' },
    headLift: { cue: '뒤통수로 벤치를 누른 채 프레스 (머리 들면 실격)' },
    buttLift: { v: ['피트업 벤치 (다리 들고)', 3, 6, 0.6], cue: '레그 드라이브는 발로 바닥을 머리 쪽으로 밀기, 엉덩이는 벤치에 붙인 채', acc: ['힙 브릿지 홀드 3×30초'] },
    shoulderLift: { v: ['스포토 프레스 (가슴 위 2cm 정지)', 3, 4, 0.65], cue: '견갑을 뒤로·아래로 고정하고 바를 구부리듯 쥐기, 락아웃에서 어깨를 내밀지 않기', acc: ['페이스 풀 3×15', '밴드 풀어파트 3×20'] },
    touchVar: { v: ['퍼즈 벤치 (가슴 2초)', 3, 3, 0.7], cue: '하강 중 견갑 고정 유지, 매 회차 같은 지점(명치)에 터치' },
    touchHigh: { v: ['퍼즈 벤치 (명치 터치 1초)', 3, 3, 0.7], cue: '바를 명치 부근으로 내리고 팔꿈치를 몸 쪽으로 살짝 모으기' },
    touchLow: { v: ['퍼즈 벤치 (가슴 1초)', 3, 3, 0.7], cue: '팔꿈치를 과하게 붙이지 말고 가슴 아래쪽에 터치' },
    descentFast: { v: ['템포 벤치 (3초 하강)', 3, 5, 0.65], cue: '하강은 통제하며 1~2초, 가슴에서 튕기지 않기' },
    jcurve: { v: ['템포 벤치 (3초 하강)', 3, 5, 0.62], cue: '가슴에서 밀어낼 때 바를 얼굴 방향으로 밀어 어깨 위에서 락아웃 (J 경로)' },
    feet: { cue: '셋업에서 발 위치를 정하고 반복 내내 고정' },
    pause: { v: ['퍼즈 벤치 (가슴 2초)', 3, 3, 0.72], cue: '가슴에서 완전히 멈춘 뒤 프레스' },
    lockout: { v: ['클로즈그립 벤치', 3, 5, 0.7], cue: '팔꿈치를 끝까지 펴며 어깨 위에서 마무리', acc: ['트라이셉스 푸시다운 +1세트'] },
    flare: { v: ['템포 벤치 (3초 하강)', 3, 5, 0.65], cue: '하강 시 팔꿈치 45~70°, 바는 명치 쪽으로' },
    forearm: { v: ['템포 벤치 (3초 하강)', 3, 5, 0.65], cue: '하단에서 전완 수직: 그립 너비를 1칸 조정해 보기' },
    barTilt: { v: ['덤벨 벤치프레스', 3, 8, 0], cue: '양손에 같은 힘, 약한 쪽에 집중' },
    stickLow: { v: ['스포토 프레스 (가슴 위 2cm 정지)', 3, 4, 0.68], cue: '가슴에서 폭발적으로 출발' },
    stickHigh: { v: ['핀 프레스 (스티킹 높이)', 3, 3, 0.75], cue: '중간 이후 삼두로 끝까지 밀기', acc: ['클로즈그립 벤치 3×6'] },
  },
  ohp: {
    layback: { v: ['Z 프레스 (바닥에 앉아서)', 3, 6, 0.55], cue: '둔근·복근 조여 갈비뼈를 내린 채 프레스', acc: ['데드버그 3×8/쪽'] },
    kneeDip: { v: ['시티드 바벨 프레스', 3, 6, 0.6], cue: '무릎을 잠그고 다리 반동 없이' },
    lockout: { v: ['핀 프레스 (이마 높이)', 3, 3, 0.75], cue: '머리를 바 아래로 밀어 넣으며 끝까지' },
    forearm: { v: ['퍼즈 프레스 (쇄골 1초)', 3, 4, 0.65], cue: '랙 자세에서 팔꿈치를 바 바로 아래나 살짝 앞으로' },
    barTilt: { v: ['덤벨 숄더 프레스', 3, 8, 0], cue: '양팔 같은 속도로' },
    stickLow: { v: ['퍼즈 프레스 (쇄골 1초)', 3, 4, 0.65], cue: '쇄골에서 폭발적으로 출발' },
    stickHigh: { v: ['핀 프레스 (이마 높이)', 3, 3, 0.75], cue: '이마를 지나면 머리를 바 아래로 넣으며 가속' },
  },
};

// 통증 시 대체
const PAIN_SWAP = {
  squat: ['박스 스쿼트 (통증 없는 깊이)', '레그 프레스'],
  bench: ['플로어 프레스', '덤벨 벤치프레스'],
  deadlift: ['트랩바 데드리프트', '랙 풀 (무릎 아래)'],
  ohp: ['랜드마인 프레스', '덤벨 숄더 프레스 (중립 그립)'],
};

// 기본 보조 변형 (결함이 없을 때, 등+팔 날 벤치 2회차)
// 등+팔 날 2회차 기본 처방 (약점 변형이 없을 때): [이름, 세트, 반복, e1RM 대비, 이유]
const DEFAULT_SECONDARY = {
  ohp: ['오버헤드 프레스 (볼륨)', 4, 6, 0.75, '오버헤드프레스 주 2회: 무거운 날 + 볼륨 날'],
  bench: ['퍼즈 벤치 (가슴 1초)', 3, 5, 0.7, '벤치 빈도 확보 (주 2회 이상)'],
};

function pickFix(lift, flags) {
  if (!flags) return null;
  const table = FIX[lift] || {};
  // 부하 위험(허리·어깨) → 통제(재하강·히칭) → 가동범위 순으로 먼저 고치고, 그다음 많이 나온 결함
  const PRIORITY = ['lumbar', 'buttLift', 'shoulderLift', 'touchHigh', 'layback', 'downward', 'elbowDepth', 'depth', 'headLift', 'feet', 'lockout'];
  const rank = (k) => { const i = PRIORITY.indexOf(k); return i < 0 ? 99 : i; };
  const ranked = Object.entries(flags).filter(([k]) => k !== 'sticking' && table[k]).sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1]);
  if (ranked.length) return { code: ranked[0][0], ...table[ranked[0][0]] };
  if (flags.sticking) {
    const k = flags.sticking >= 55 ? 'stickHigh' : 'stickLow';
    if (table[k]) return { code: k, ...table[k] };
  }
  return null;
}

// ---------- 기록 분석 ----------
const daysBetween = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);

export function logE1rm(log) {
  const kg = Number(log.weight);
  const reps = Number(log.reps);
  if (!(kg > 0) || !(reps >= 1 && reps <= 12) || log.variation) return null;
  let rpe = Number(log.rpe);
  if (!(rpe >= 5 && rpe <= 10)) rpe = log.stats?.rir != null ? 10 - Math.min(4, log.stats.rir) : log.target?.rpe;
  if (!rpe) return null;
  return e1rmOf(kg, reps, rpe);
}

// 기준 무게 (설정, 예: 오버헤드프레스 6회 60kg · 3회 70kg, RPE 8 기준)
// 표준 RPE 표 대신 내 반복-무게 관계를 그대로 따름: 두 점 사이·바깥은 반복 수에 대해 직선
export function anchorsOf(settings, lift) {
  const a6 = Number(settings?.[lift + 'Ref6']);
  const a3 = Number(settings?.[lift + 'Ref3']);
  return a6 > 0 && a3 > 0 && a3 > a6 ? { a6, a3 } : null;
}
const anchorAt = ({ a6, a3 }, reps) => a6 + ((6 - reps) * (a3 - a6)) / 3;
// 기준 무게가 뜻하는 e1RM (기록과 비교해 성장 배율 계산용)
export const anchorE1rm = (an) => (e1rmOf(an.a6, 6, 8) + e1rmOf(an.a3, 3, 8)) / 2;
/** 기준 무게 곡선에서 반복·RPE에 맞는 무게 (factor = 기록으로 추정한 성장 배율) */
export function anchorLoad(an, reps, rpe, factor = 1) {
  return anchorAt(an, reps) * (pctOf(reps, rpe) / pctOf(reps, 8)) * factor;
}

/** 리프트의 현재 e1RM: 최근 3세션 중앙값 (기록이 적으면 설정 1RM과 섞음). 통증 세션은 제외 */
export function liftE1rm(lift, logs, settings, beforeDate = '9999-12-31') {
  const an = anchorsOf(settings, lift);
  const prior = an ? anchorE1rm(an) : Number(settings[lift + '1rm']) || 0;
  const byDate = {};
  for (const l of logs) {
    if (l.lift !== lift || l.date >= beforeDate || l.pain) continue;
    const e = logE1rm(l);
    if (e) byDate[l.date] = Math.max(byDate[l.date] || 0, e);
  }
  const vals = Object.entries(byDate).sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v).slice(-3);
  if (!vals.length) return { e1rm: prior, source: '설정 1RM', n: 0 };
  if (vals.length < 3 && prior) {
    const all = [...vals, prior];
    return { e1rm: all.reduce((a, b) => a + b, 0) / all.length, source: `기록 ${vals.length}회 + 설정`, n: vals.length };
  }
  const s = [...vals].sort((a, b) => a - b);
  return { e1rm: s[Math.floor(s.length / 2)], source: `최근 ${vals.length}세션`, n: vals.length };
}

export function readinessOf(checkin) {
  if (!checkin) return null;
  const { sleep = 3, energy = 3, soreness = 3 } = checkin;
  return (Number(sleep) + Number(energy) + (6 - Number(soreness))) / 3;
}

/** 피로 신호 (최근 10일) → 2점 이상이면 디로드 권장 */
export function fatigueSignals(state, today, runAcwr = null) {
  const logs = state.formLogs.filter((l) => { const d = daysBetween(l.date, today); return d >= 0 && d <= 10; });
  const sig = [];
  const over = logs.filter((l) => l.target?.rpe && Number(l.rpe) - l.target.rpe >= 1).length;
  if (over >= 2) sig.push(`목표보다 RPE가 1 이상 높았던 세션 ${over}회`);
  const pains = logs.filter((l) => l.pain).length;
  if (pains >= 2) sig.push(`통증 보고 ${pains}회`);
  for (const lift of Object.keys(LIFT_KO)) {
    const ls = state.formLogs.filter((l) => l.lift === lift && !l.variation).sort((a, b) => a.date.localeCompare(b.date));
    const es = ls.map(logE1rm).filter(Boolean);
    if (es.length >= 3) {
      const last = es[es.length - 1];
      const best = Math.max(...es.slice(-5, -1));
      if (last < best * 0.95 && daysBetween(ls[ls.length - 1].date, today) <= 10) sig.push(`${LIFT_KO[lift]} 추정 1RM ${Math.round((1 - last / best) * 100)}% 하락`);
    }
  }
  const recent = [];
  for (let i = 0; i <= 4; i++) {
    const d = new Date(today + 'T12:00:00');
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const c = state.checkins?.[iso] || garminCheckin(state.garmin?.data?.daily?.[iso]);
    if (c) recent.push(readinessOf(c));
  }
  if (recent.length >= 2 && recent.reduce((a, b) => a + b, 0) / recent.length <= 2.3) sig.push('최근 컨디션 평균이 낮음');
  if (runAcwr && runAcwr > 1.5) sig.push(`러닝 부하 급증 (ACWR ${runAcwr.toFixed(2)})`);
  sig.push(...garminFatigue(state.garmin?.data?.daily, state.garmin?.data?.profile, today));
  return { score: sig.length, signals: sig, deload: sig.length >= 2 };
}

// 오늘 통증 부위가 이 리프트와 관련되는지
const PAIN_AREAS = { squat: ['무릎', '허리', '고관절'], deadlift: ['허리', '고관절', '무릎'], bench: ['어깨', '팔꿈치', '손목'], ohp: ['어깨', '팔꿈치', '허리'] };

/**
 * 리프트 처방
 * @param ctx { state, settings, phase, date(ISO), checkin, hardRunYesterday, secondary }
 */
export function prescribe(lift, ctx) {
  const { state, settings, phase, date } = ctx;
  const logs = state.formLogs || [];
  const reasons = [];
  const cues = [];
  const { e1rm, source } = liftE1rm(lift, logs, settings, date);
  const step = plateStep(settings);
  const rnd = (kg) => roundLoad(kg, step);
  // 기준 무게가 있으면 표준 % 대신 그 곡선으로 무게 결정. 기록이 쌓여 e1RM이 오르면 같은 비율로 상승
  const an = anchorsOf(settings, lift);
  const growth = an ? e1rm / anchorE1rm(an) : 1;
  // 기준 곡선은 경계값(예: 67.6kg)이 위로 반올림되면 목표보다 무거워지므로 살짝 아래로 치우쳐 반올림
  const loadAt = (r, p) => (an ? rnd(anchorLoad(an, r, p, growth) - step * 0.1) : rnd(e1rm * pctOf(r, p)));
  const wi = Math.min(phase.wi, phase.reps.length - 1);
  const sch = LIFT_SCHEME[lift]?.[phase.key];
  const at = (arr) => arr[Math.min(wi, arr.length - 1)];
  let reps = at(sch?.reps || phase.reps);
  let rpe = at(sch?.rpe || phase.rpe);
  let backSets = at(sch?.back || phase.back);
  let backReps = at(sch?.backReps || phase.backReps);
  let drop = sch?.drop ?? phase.drop;
  let name = LIFT_KO[lift];

  const prev = logs.filter((l) => l.lift === lift && l.date < date && !l.variation).sort((a, b) => b.date.localeCompare(a.date))[0];
  const prevFlags = prev ? flagsOf((prev.issues || prev.videoSummary || []).map((i) => i.text || i)) : null;

  if (!ctx.secondary && prev && !phase.deload) {
    // 1) 지난 세션 목표 대비 체감 강도
    const actual = Number(prev.rpe) || (prev.stats?.rir != null ? 10 - prev.stats.rir : null);
    const target = prev.target?.rpe || (actual ? 8 : null); // 처방 없이 기록한 세트는 RPE 8을 기준으로 비교
    if (target && actual) {
      const delta = actual - target;
      if (delta >= 1) { rpe -= 0.5; backSets = Math.max(1, backSets - 1); reasons.push(`지난 세션이 목표보다 힘들었음 (RPE ${actual} / 목표 ${target}) → 강도 0.5↓, 백오프 1세트↓`); }
      else if (delta <= -1 && (prev.score ?? 100) >= 80) { backSets += 1; reasons.push(`지난 세션이 목표보다 쉬웠고 자세도 좋음 (RPE ${actual} / 목표 ${target}) → 백오프 1세트↑ (무게는 추정 1RM 갱신으로 자동 상승)`); }
    }
    // 2) 세트 내 속도 손실이 크면 반복 수 줄이기
    if (prev.stats?.velocityLoss > 30) { backReps = Math.max(2, backReps - 1); reasons.push(`지난 세트 속도 손실 ${Math.round(prev.stats.velocityLoss)}% → 백오프 반복 1회↓ (피로 대비 근력 효과 유지)`); }
    // 3) 자세가 무너졌으면 기술 우선
    if ((prev.score ?? 100) < 70 || Object.keys(prevFlags || {}).some((k) => k !== 'sticking' && prevFlags[k] >= 2)) {
      if (rpe > 7.5) { rpe = 7.5; reasons.push(`지난 세션 자세 점수 ${prev.score ?? '-'}점 → 기술 우선: 탑세트 RPE 7.5 상한`); }
    }
  }

  // 3-1) 지난 세션 세트 후반에 자세가 무너졌으면: 세트당 반복↓, 세트 수↑ (같은 총량을 좋은 자세로)
  if (!ctx.secondary && prev?.stats?.breakdown && prevFlags?.fatigue && !phase.deload) {
    reps = Math.max(2, reps - 1);
    backReps = Math.max(2, backReps - 1);
    backSets += 1;
    reasons.push('지난 세션 세트 후반에 자세가 무너짐 → 세트당 반복 1회↓, 백오프 1세트↑ (같은 총량을 좋은 자세로)');
  }

  // 4) 오늘 컨디션
  const ready = readinessOf(ctx.checkin);
  if (ready != null && !phase.deload) {
    if (ready <= 2) { rpe -= 1; backSets = Math.max(1, backSets - 2); reasons.push(`오늘 컨디션 낮음 (${ready.toFixed(1)}/5) → 강도 1↓, 백오프 2세트↓`); }
    else if (ready < 3) { rpe -= 0.5; backSets = Math.max(1, backSets - 1); reasons.push(`오늘 컨디션 다소 낮음 (${ready.toFixed(1)}/5) → 강도 0.5↓, 백오프 1세트↓`); }
    else if (ready >= 4.3 && phase.key !== 'real') { reasons.push(`컨디션 좋음 (${ready.toFixed(1)}/5): 탑세트가 가벼우면 +2.5kg 한 세트 추가 가능`); }
  }
  // 5) 러닝 간섭
  if ((lift === 'squat' || lift === 'deadlift') && ctx.hardRunYesterday && !phase.deload) {
    backSets = Math.max(1, backSets - 1);
    reasons.push('어제 강한 러닝 → 하체 백오프 1세트↓');
  }

  // 6) 통증
  const painArea = ctx.checkin?.pain;
  let painSwap = null;
  if ((painArea && (PAIN_AREAS[lift] || []).includes(painArea)) || (prev?.pain && daysBetween(prev.date, date) <= 7)) {
    painSwap = PAIN_SWAP[lift][0];
    reasons.push(`${painArea ? painArea + ' 통증' : '지난 세션 통증'} → ${painSwap}로 대체, 무게 20%↓, RPE 7 상한`);
  }

  const cap = LIFT_CAP[lift];
  if (cap) { reps = Math.min(reps, cap.reps); backReps = Math.min(backReps, cap.backReps); backSets = Math.min(backSets, cap.backSets); }
  rpe = Math.max(5.5, Math.round(rpe * 2) / 2);
  let kg = loadAt(reps, rpe);
  if (painSwap) { name = painSwap; kg = rnd(kg * 0.8); rpe = Math.min(rpe, 7); }
  // 자세 유지 한계 강도: 자세가 무너진 세션(후반 무너짐·허리 말림 등)이 2회 이상이면 그 강도 아래로 탑세트 제한
  if (!ctx.secondary && !phase.deload && !painSwap) {
    const broke = logs
      .filter((l) => l.lift === lift && !l.variation && l.date < date && Number(l.weight) > 0 && l.stats?.breakdown)
      .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8)
      .map((l) => Number(l.weight) / liftE1rm(lift, logs, settings, l.date).e1rm)
      .filter((x) => Number.isFinite(x) && x > 0.4).sort((a, b) => a - b);
    if (broke.length >= 2) {
      const limit = broke[1]; // 한 번의 예외로 과하게 막지 않도록 두 번째로 낮은 강도
      if (kg / e1rm >= limit - 0.01) {
        kg = rnd(e1rm * (limit - 0.03));
        backSets += 1;
        reasons.push(`자세 유지 한계 강도 약 ${Math.round(limit * 100)}% (이 강도 이상에서 자세가 무너진 세션 ${broke.length}회) → 탑세트를 ${Math.round((limit - 0.03) * 100)}%로 제한, 백오프 1세트↑로 볼륨 확보. 자세가 유지되면 한계가 자동으로 올라감`);
      }
    }
  }
  if (cap) backSets = Math.min(backSets, cap.backSets);
  // 무게 단위가 크면(원판 부족) 감량분이 반올림으로 사라질 수 있어 최소 한 단위는 내림
  let backKg = an ? Math.min(loadAt(backReps, rpe - 1), kg - step) : Math.min(rnd(kg * (1 - drop)), kg - step);

  // 최소 훈련 중량 (설정, 예: 오버헤드프레스 60kg): 이보다 가볍게는 처방하지 않음.
  // 무게를 올린 만큼 반복 수를 줄여 목표 RPE를 유지
  const minKg = Number(settings[lift + 'MinKg']) || 0;
  const repsAt = (load, maxReps, r) => {
    let n = maxReps;
    while (n > 1 && (an ? anchorLoad(an, n, r, growth) : e1rm * pctOf(n, r)) < load * 0.985) n--;
    return n;
  };
  if (minKg > 0 && !painSwap) {
    if (kg < minKg) {
      const before = reps;
      kg = minKg;
      reps = repsAt(kg, reps, rpe);
      reasons.push(`최소 훈련 중량 ${minKg}kg 적용${reps < before ? ` → 목표 RPE 유지를 위해 ${before}회 → ${reps}회` : ''}`);
      if ((an ? anchorLoad(an, 1, rpe, growth) : e1rm * pctOf(1, rpe)) < minKg) reasons.push(`추정 1RM ${Math.round(e1rm)}kg 기준으로는 ${minKg}kg가 무거움: 실제 1RM이 더 높다면 설정 1RM을 올리거나 세트 기록에 무게·반복·RPE를 남겨 주세요`);
    }
    if (backKg < minKg) {
      backKg = minKg;
      backReps = repsAt(backKg, backReps, Math.min(10, rpe));
    }
  }

  // 7) 자세 결함·스티킹 포인트 → 변형 운동 / 큐 / 보조
  const fix = pickFix(lift, prevFlags);
  let variation = null;
  const accessories = [];
  if (fix) {
    cues.push(fix.cue);
    if (fix.acc) accessories.push(...fix.acc);
    if (fix.v) {
      const [vn, vs, vr, vp] = fix.v;
      variation = { name: vn, sets: phase.deload ? 1 : vs, reps: vr, kg: vp ? rnd(e1rm * vp) : null, why: `지난 세션 ${fixLabel(fix.code)}` };
    }
  }

  if (ctx.secondary) {
    // 등+팔 날의 2회차: 약점 변형이 있으면 그것, 없으면 기본 볼륨 처방
    const base = DEFAULT_SECONDARY[lift];
    const v = variation || (base ? { name: base[0], sets: base[1], reps: base[2], kg: an ? loadAt(base[2], 7) : rnd(e1rm * base[3]), why: base[4] } : null);
    if (!v) return null;
    if (phase.deload) { v.sets = Math.max(1, v.sets - 1); if (v.kg) v.kg = rnd(v.kg * 0.88); }
    if (minKg > 0 && v.kg != null && !variation && v.kg < minKg) {
      const before = v.reps;
      v.kg = minKg;
      v.reps = repsAt(minKg, v.reps, phase.deload ? 7 : 8);
      v.why += ` · 최소 훈련 중량 ${minKg}kg${v.reps < before ? ` (${before}회 → ${v.reps}회)` : ''}`;
    }
    return { lift, secondary: true, name: v.name, sets: v.sets, reps: v.reps, kg: v.kg, rpe: 7, e1rm, e1Source: source, reasons: [v.why], cues, accessories };
  }

  const single = phase.single && !painSwap ? { kg: Math.max(minKg, loadAt(1, 8.5)), rpe: 8.5 } : null;
  return {
    lift, name, reps, rpe, kg, e1rm, e1Source: source,
    single,
    backoff: { sets: backSets, reps: backReps, kg: backKg },
    variation: painSwap ? null : variation,
    reasons, cues, accessories,
  };
}

function fixLabel(code) {
  return {
    depth: '깊이 부족', hipShoot: '엉덩이가 먼저 뜸·상체 무너짐', valgus: '무릎 밸거스', hipShift: '힙 시프트', heel: '뒤꿈치 들림',
    barPath: '바 경로 이탈', brace: '브레이싱 약함', lockout: '락아웃 약함', layback: '과신전', kneeDip: '무릎 반동', pause: '퍼즈 미흡',
    forearm: '전완 정렬', flare: '팔꿈치 벌어짐', barTilt: '바벨 기울어짐', dlStart: '시작 자세', stickLow: '하단 스티킹', stickHigh: '상단 스티킹',
    jcurve: '바 경로(J 경로) 이탈', touchHigh: '터치 위치 높음', touchLow: '터치 위치 낮음', touchVar: '터치 위치 불일정',
    buttLift: '엉덩이 들림', shoulderLift: '견갑 풀림', feet: '발 움직임', descentFast: '하강 통제 부족',
    downward: '상승 중 하강·히칭', elbowDepth: '팔꿈치 깊이 부족', headLift: '머리 들림', consistency: '회차 간 동작 편차', lumbar: '허리 말림',
  }[code] || code;
}

/** 보조 운동 볼륨 조정: 블록 단계·컨디션·러닝 부하 */
export function accessoryScale(phase, checkin, runAcwr) {
  let f = phase.hyp;
  const r = readinessOf(checkin);
  if (r != null && r < 3) f *= 0.75;
  if (runAcwr && runAcwr > 1.4) f *= 0.85;
  return f;
}

// ---------- 가민 회복 데이터 ----------
const band = (v, cuts) => (v == null ? null : cuts.findIndex((c) => v < c) === -1 ? 5 : cuts.findIndex((c) => v < c) + 1);

/** 가민 하루 지표 → 컨디션 체크인 (직접 기록이 없을 때 사용). 근육통은 측정 불가라 보통(3) */
export function garminCheckin(day) {
  if (!day) return null;
  // 수면: 수면 점수 우선, 없으면 수면 시간
  const sleep = day.sleepScore != null ? band(day.sleepScore, [50, 65, 75, 85]) : band(day.sleepHours, [5, 6, 7, 8]);
  // 에너지: 트레이닝 레디니스 → 기상 바디 배터리 → 하루 최고 바디 배터리
  let energy = null;
  if (day.readiness != null) energy = band(day.readiness, [25, 45, 60, 75]);
  else if (day.bbWake != null || day.bbHigh != null) energy = band(day.bbWake ?? day.bbHigh, [30, 50, 65, 80]);
  if (sleep == null && energy == null) return null;
  return { sleep: sleep ?? 3, energy: energy ?? 3, soreness: 3, pain: '', source: 'garmin' };
}

/** 가민 지표 기반 피로 신호 (최근 며칠) */
export function garminFatigue(daily = {}, profile = {}, today) {
  const sig = [];
  const days = Object.keys(daily).filter((d) => d <= today).sort();
  const last = (n) => days.slice(-n).map((d) => daily[d]);
  const hrvBad = last(5).filter((x) => /LOW|UNBALANCED|POOR/i.test(x.hrvStatus || '')).length;
  if (hrvBad >= 3) sig.push(`HRV 낮음·불균형 ${hrvBad}일 (최근 5일)`);
  const lowReady = last(3).filter((x) => x.readiness != null && x.readiness < 35).length;
  if (lowReady >= 2) sig.push(`가민 트레이닝 레디니스 낮음 ${lowReady}일 (최근 3일)`);
  const base = days.slice(-33, -3).map((d) => daily[d].restingHr).filter(Number.isFinite).sort((a, b) => a - b);
  if (base.length >= 10) {
    const med = base[Math.floor(base.length / 2)];
    const high = last(3).filter((x) => x.restingHr >= med + 5).length;
    if (high >= 2) sig.push(`안정시 심박이 평소(${med})보다 5 이상 높음 ${high}일`);
  }
  if (/OVERREACHING|STRAINED|UNPRODUCTIVE/i.test(profile.trainingStatus || '')) sig.push(`가민 트레이닝 상태: ${profile.trainingStatus}`);
  return sig;
}
