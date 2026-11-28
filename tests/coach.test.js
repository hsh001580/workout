import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pctOf, e1rmOf, loadFor, phaseAt, prescribe, liftE1rm, fatigueSignals, flagsOf } from '../js/coach.js';
import { buildWeek } from '../js/program.js';

const settings = { squat1rm: 140, bench1rm: 100, deadlift1rm: 180, ohp1rm: 60, weeklyKm: 20, fiveK: '25:00', startDate: '2026-11-23' };
const st = (over = {}) => ({ formLogs: [], runLogs: [], checkins: {}, coach: {}, ...over });
const P0 = phaseAt(0, {});

test('RPE 표: 100kg×5 @RPE8 → e1RM ≈123, 역산 일치', () => {
  assert.ok(Math.abs(pctOf(5, 8) - 0.811) < 1e-9);
  const e = e1rmOf(100, 5, 8);
  assert.ok(Math.abs(e - 123.3) < 0.1);
  assert.equal(loadFor(e, 5, 8), 100);
  assert.equal(pctOf(1, 10), 1);
});

test('블록 진행: 축적3 → 강화3 → 실현1 → 디로드1 → 새 블록, 강제 디로드 후 재시작', () => {
  const keys = Array.from({ length: 9 }, (_, w) => phaseAt(w, {}).key);
  assert.deepEqual(keys, ['acc', 'acc', 'acc', 'int', 'int', 'int', 'real', 'deload', 'acc']);
  const forced = { deloadWeeks: [4] };
  assert.equal(phaseAt(4, forced).key, 'deload');
  assert.ok(phaseAt(4, forced).forced);
  assert.equal(phaseAt(5, forced).key, 'acc');
  assert.equal(phaseAt(5, forced).wi, 0);
});

test('기록 없으면 설정 1RM 기준으로 처방', () => {
  const rx = prescribe('squat', { state: st(), settings, phase: P0, date: '2026-11-23' });
  assert.equal(rx.reps, 6);
  assert.equal(rx.rpe, 7);
  assert.equal(rx.kg, loadFor(140, 6, 7, 5)); // 기본 최소 원판 2.5kg → 5kg 단위
  assert.equal(rx.backoff.sets, 3);
});

const log = (o) => ({ id: Math.random().toString(36), lift: 'squat', date: '2026-11-20', weight: 110, reps: 6, rpe: 8, score: 90, issues: [], ...o });

test('지난 세션이 목표보다 힘들면 강도·볼륨↓', () => {
  const s = st({ formLogs: [log({ rpe: 9, target: { rpe: 8, reps: 6, kg: 110 } })] });
  const rx = prescribe('squat', { state: s, settings, phase: phaseAt(2, {}), date: '2026-11-24' });
  assert.equal(rx.rpe, 7.5);
  assert.equal(rx.backoff.sets, 3);
  assert.ok(rx.reasons.some((r) => r.includes('목표보다 힘들었음')));
});

test('쉬웠고 자세가 좋으면 백오프 1세트↑, 수행 기록으로 e1RM 갱신', () => {
  const s = st({ formLogs: [log({ weight: 120, rpe: 7, target: { rpe: 8 } })] });
  const rx = prescribe('squat', { state: s, settings, phase: phaseAt(2, {}), date: '2026-11-24' });
  assert.equal(rx.backoff.sets, 5);
  const e = liftE1rm('squat', s.formLogs, settings, '2026-11-24').e1rm;
  assert.ok(e > 140, `e1rm ${e}`);
});

test('자세 결함(무릎 밸거스) → 변형 운동·보조·큐 + 자세 점수 낮으면 RPE 상한', () => {
  const issues = [{ level: 'bad', text: '오른쪽 무릎이 안쪽으로 16° 모임: 발 삼각지지로', n: 3 }, { level: 'warn', text: '무릎이 발끝 방향보다 20° 안쪽을 향함' }];
  const s = st({ formLogs: [log({ score: 62, issues })] });
  const rx = prescribe('squat', { state: s, settings, phase: phaseAt(2, {}), date: '2026-11-24' });
  assert.ok(rx.rpe <= 7.5);
  assert.match(rx.variation.name, /템포 스쿼트/);
  assert.ok(rx.accessories.some((a) => a.includes('힙 어브덕션')));
  assert.ok(rx.cues.some((c) => c.includes('두 번째 발가락')));
});

test('스티킹 포인트 높이로 변형 선택 (벤치 상단 → 핀 프레스)', () => {
  assert.equal(flagsOf(['스티킹 포인트: 상승 64% 지점(가슴에서 조금 위)에서']).sticking, 64);
  const s = st({ formLogs: [log({ lift: 'bench', weight: 80, reps: 4, issues: [{ level: 'info', text: '스티킹 포인트: 상승 64% 지점에서 속도 0.15m/s로 급감' }] })] });
  const rx = prescribe('bench', { state: s, settings, phase: P0, date: '2026-11-24' });
  assert.match(rx.variation.name, /핀 프레스/);
});

test('통증 부위가 관련되면 대체 운동, 무게 20%↓', () => {
  const ctx = { state: st(), settings, phase: P0, date: '2026-11-24', checkin: { sleep: 4, energy: 4, soreness: 2, pain: '무릎' } };
  const rx = prescribe('squat', ctx);
  assert.match(rx.name, /박스 스쿼트/);
  assert.ok(rx.kg < loadFor(140, 6, 7));
  assert.ok(rx.rpe <= 7);
  assert.equal(prescribe('bench', ctx).name, '벤치프레스'); // 무릎 통증은 벤치와 무관
});

test('컨디션 낮으면 당일 강도·볼륨↓', () => {
  const rx = prescribe('squat', { state: st(), settings, phase: phaseAt(1, {}), date: '2026-11-24', checkin: { sleep: 1, energy: 2, soreness: 5 } });
  assert.equal(rx.rpe, 6.5);
  assert.ok(rx.reasons.some((r) => r.includes('컨디션 낮음')));
});

test('피로 신호 2개 이상이면 디로드 권장', () => {
  const s = st({ formLogs: [
    log({ date: '2026-11-20', rpe: 9.5, target: { rpe: 8 } }),
    log({ lift: 'bench', date: '2026-11-21', rpe: 9, target: { rpe: 8 }, pain: true }),
  ] });
  const f = fatigueSignals(s, '2026-11-24', 1.6);
  assert.ok(f.deload, JSON.stringify(f));
  assert.equal(fatigueSignals(st(), '2026-11-24').deload, false);
});

test('주간 프로그램(코칭): A일 스쿼트+OHP RPE 처방, C일 오버헤드프레스 2회차, 디로드 주 러닝 감소', () => {
  const coach = { state: st(), runAcwr: null, hardRunOn: () => false };
  const w = buildWeek(settings, 0, null, coach);
  const a = w.days[0];
  assert.equal(a.rotation.key, 'A');
  assert.ok(a.items.some((i) => i.lift === 'squat' && /RPE 7/.test(i.detail)));
  assert.ok(a.items.some((i) => i.lift === 'ohp'));
  const c = w.days[2];
  assert.equal(c.rotation.key, 'C');
  const ohp2 = c.items.find((i) => i.lift === 'ohp' && i.variation);
  assert.ok(ohp2 && /오버헤드 프레스 2회차/.test(ohp2.title), JSON.stringify(c.items.map((i) => i.title)));
  assert.ok(!c.items.some((i) => i.lift === 'bench'), 'C일에 벤치 없음');
  const dl = buildWeek(settings, 7, null, coach);
  assert.ok(dl.weeklyKm < w.weeklyKm);
  assert.match(dl.wave.name, /디로드/);
});

import { garminCheckin, garminFatigue, readinessOf } from '../js/coach.js';

test('가민 지표 → 자동 컨디션 (수면 점수·레디니스)', () => {
  const good = garminCheckin({ sleepScore: 88, readiness: 80 });
  assert.deepEqual([good.sleep, good.energy, good.soreness, good.source], [5, 5, 3, 'garmin']);
  const bad = garminCheckin({ sleepScore: 45, readiness: 20 });
  assert.ok(readinessOf(bad) < 2.5);
  assert.equal(garminCheckin({ sleepHours: 7.5, bbHigh: 70 }).energy, 4); // 레디니스 없으면 바디 배터리
  assert.equal(garminCheckin({ steps: 100 }), null);
});

test('가민 자동 컨디션이 처방에 반영됨', () => {
  const s = st({ garmin: { data: { daily: { '2026-11-24': { sleepScore: 40, readiness: 15 } } } } });
  const w = buildWeek(settings, 0, null, { state: s, runAcwr: null, hardRunOn: () => false });
  const bench = w.days[1].items.find((i) => i.lift === 'bench' && !i.variation);
  assert.ok(bench.reasons.some((r) => r.includes('컨디션')), JSON.stringify(bench.reasons));
});

test('가민 피로 신호: HRV 불균형, 레디니스 저하, 안정시 심박 상승, 트레이닝 상태', () => {
  const daily = {};
  for (let i = 1; i <= 30; i++) daily[`2026-10-${String(i).padStart(2, '0')}`] = { restingHr: 50 };
  Object.assign(daily, {
    '2026-11-20': { hrvStatus: 'UNBALANCED', restingHr: 50 },
    '2026-11-21': { hrvStatus: 'LOW', readiness: 30, restingHr: 56 },
    '2026-11-22': { hrvStatus: 'BALANCED', readiness: 20, restingHr: 57 },
    '2026-11-23': { hrvStatus: 'LOW', readiness: 50, restingHr: 52 },
    '2026-11-24': { hrvStatus: 'UNBALANCED', readiness: 25, restingHr: 56 },
  });
  const sig = garminFatigue(daily, { trainingStatus: 'OVERREACHING_1' }, '2026-11-24');
  assert.equal(sig.length, 4, JSON.stringify(sig));
  const f = fatigueSignals(st({ garmin: { data: { daily, profile: {} } } }), '2026-11-24');
  assert.ok(f.deload);
  assert.equal(garminFatigue({}, {}, '2026-11-24').length, 0);
});

test('데드리프트는 전용 저반복 체계: 세트당 3회 이하, 총 반복이 스쿼트보다 적음', async () => {
  const { prescribe, phaseAt } = await import('../js/coach.js');
  const state = { formLogs: [], coach: {} };
  for (let w = 0; w < 8; w++) {
    const phase = phaseAt(w, {});
    const ctx = { state, settings, phase, date: '2026-12-01' };
    const dl = prescribe('deadlift', ctx);
    const sq = prescribe('squat', ctx);
    assert.ok(dl.reps <= 3 && (dl.backoff?.reps ?? 0) <= 3 && (dl.backoff?.sets ?? 0) <= 4, `w${w} ${JSON.stringify([dl.reps, dl.backoff])}`);
    const tot = (r) => r.reps + (r.backoff?.sets || 0) * (r.backoff?.reps || 0);
    if (!phase.deload) assert.ok(tot(dl) < tot(sq), `w${w} dl ${tot(dl)} sq ${tot(sq)}`);
  }
});

test('오버헤드프레스는 탑세트를 더 무겁게 (같은 주차 스쿼트보다 1RM 대비 강도·RPE가 높거나 같음)', async () => {
  const { prescribe, phaseAt } = await import('../js/coach.js');
  const state = { formLogs: [], coach: {} };
  for (const w of [0, 3, 5]) {
    const phase = phaseAt(w, {});
    const ctx = { state, settings, phase, date: '2026-12-01' };
    const o = prescribe('ohp', ctx);
    const q = prescribe('squat', ctx);
    assert.ok(o.rpe >= q.rpe && o.reps <= q.reps, `w${w} ohp ${o.reps}@${o.rpe} sq ${q.reps}@${q.rpe}`);
    assert.ok(o.kg / settings.ohp1rm >= q.kg / settings.squat1rm - 0.02, `w${w} ${o.kg} ${q.kg}`);
  }
});

test('1.25kg 원판이 없으면 모든 바벨 무게가 5kg 단위, 백오프는 탑세트보다 가벼움', async () => {
  const { prescribe, phaseAt } = await import('../js/coach.js');
  const state = { formLogs: [], coach: {} };
  for (const minPlate of [2.5, 1.25]) {
    const unit = minPlate * 2;
    for (let w = 0; w < 8; w++) {
      const phase = phaseAt(w, {});
      for (const lift of ['squat', 'bench', 'deadlift', 'ohp']) {
        for (const secondary of [false, true]) {
          const r = prescribe(lift, { state, settings: { ...settings, minPlate }, phase, date: '2026-12-01', secondary });
          if (!r) continue;
          for (const kg of [r.kg, r.backoff?.kg, r.single?.kg, r.variation?.kg].filter((x) => x != null)) {
            assert.equal(Math.abs(kg / unit - Math.round(kg / unit)) < 1e-9, true, `${lift} w${w} ${kg}kg not multiple of ${unit}`);
          }
          if (r.backoff?.sets) assert.ok(r.backoff.kg < r.kg, `${lift} w${w} backoff ${r.backoff.kg} >= ${r.kg}`);
        }
      }
    }
  }
});

test('운동을 하루 쉬면(미루기) 그 세션이 다음 날로 넘어가고 이후 로테이션도 하루씩 밀림', async () => {
  const { rotationOf } = await import('../js/program.js');
  const start = '2026-11-23'; // 월 A, 화 B, 수 C, 목 D
  const keys = (skips) => [0, 1, 2, 3, 4, 5].map((i) => rotationOf(start, new Date(2026, 10, 23 + i), skips).key).join('');
  assert.equal(keys([]), 'ABCDAB');
  assert.equal(keys(['2026-11-24']), 'ASBCDA'); // 화요일 B 못 함 → 수요일 B
  assert.equal(keys(['2026-11-24', '2026-11-25']), 'ASSBCD');
  // 주간 프로그램에도 반영
  const coach = { state: { ...st(), coach: { deloadWeeks: [], deloadNotes: {}, skips: ['2026-11-24'] } }, runAcwr: null, hardRunOn: () => false };
  const w = buildWeek(settings, 0, null, coach);
  assert.equal(w.days[1].rotation.key, 'S');
  assert.ok(!w.days[1].items.some((i) => i.type === 'lift'));
  assert.ok(w.days[2].items.some((i) => i.lift === 'bench'));
});

test('웨이트를 미뤄도 러닝 날짜·종류는 그대로', () => {
  const base = { state: st(), runAcwr: null, hardRunOn: () => false };
  const skipped = { ...base, state: { ...st(), coach: { deloadWeeks: [], deloadNotes: {}, skips: ['2026-11-24'] } } };
  const runs = (w) => w.days.map((d) => d.items.filter((i) => i.type === 'run').map((i) => i.title).join('+')).join('|');
  assert.equal(runs(buildWeek(settings, 0, null, skipped)), runs(buildWeek(settings, 0, null, base)));
});

test('오버헤드프레스 최소 훈련 중량(60kg): 탑세트·백오프·싱글·2회차 모두 60kg 이상, 무거워진 만큼 반복 감소', async () => {
  const { prescribe, phaseAt } = await import('../js/coach.js');
  const state = { formLogs: [], coach: {} };
  const s = { ...settings, ohp1rm: 70, ohpMinKg: 60, minPlate: 2.5 };
  for (let w = 0; w < 8; w++) {
    const phase = phaseAt(w, {});
    const r = prescribe('ohp', { state, settings: s, phase, date: '2026-12-01' });
    const r2 = prescribe('ohp', { state, settings: s, phase, date: '2026-12-01', secondary: true });
    for (const kg of [r.kg, r.backoff?.kg, r.single?.kg, r2.kg].filter((x) => x != null)) assert.ok(kg >= 60, `w${w} ${kg}`);
  }
  const acc = prescribe('ohp', { state, settings: s, phase: phaseAt(0, {}), date: '2026-12-01' });
  assert.ok(acc.reps < 5 && acc.reasons.some((x) => /최소 훈련 중량 60kg/.test(x)));
  // 0이면 제한 없음
  const free = prescribe('ohp', { state, settings: { ...s, ohpMinKg: 0 }, phase: phaseAt(0, {}), date: '2026-12-01' });
  assert.ok(free.kg < 60);
});

test('오버헤드프레스 기준 무게(6회 60kg · 3회 70kg)를 따라 처방하고, 기록이 좋아지면 같이 오름', async () => {
  const { prescribe, phaseAt, anchorLoad } = await import('../js/coach.js');
  const an = { a6: 60, a3: 70 };
  assert.equal(Math.round(anchorLoad(an, 6, 8)), 60);
  assert.equal(Math.round(anchorLoad(an, 3, 8)), 70);
  const s = { ...settings, ohp1rm: 60, ohpMinKg: 60, ohpRef6: 60, ohpRef3: 70, minPlate: 2.5 };
  const rx = (logs, w) => prescribe('ohp', { state: { formLogs: logs, coach: {} }, settings: s, phase: phaseAt(w, {}), date: '2026-12-01' });
  const int3 = rx([], 3); // 강화 1주차: 3회
  assert.equal(int3.reps, 3);
  assert.equal(int3.kg, 70);
  assert.equal(rx([], 0).backoff.kg, 60); // 6회 백오프 = 60
  // 70kg 6회를 RPE 8로 3세션 연속 → 기준보다 강해짐 → 무게 상승
  const strong = ['2026-11-20', '2026-11-24', '2026-11-27'].map((date, i) => ({ id: 'o' + i, lift: 'ohp', date, weight: 70, reps: 6, rpe: 8, score: 90, issues: [] }));
  assert.ok(rx(strong, 3).kg > 70, `${rx(strong, 3).kg}`);
});
