import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatten, unflatten, stampChanges, merge, encrypt } from '../js/sync.js';
import { decrypt } from '../js/garmin.js';
import { defaultState } from '../js/storage.js';

// 기기 하나를 흉내: 상태 + 마지막 동기화 시각표
function device(state, stamps) { return { state, stamps }; }
function sync(dev, remote, now) {
  const recs = flatten(dev.state);
  const { stamps } = stampChanges(recs, dev.stamps || {}, now, !dev.stamps);
  const m = merge({ records: recs, stamps }, remote);
  return { dev: device(unflatten(m.records, dev.state), m.stamps), remote: m };
}
const empty = { records: {}, stamps: {} };
const S = () => defaultState();

test('레코드로 쪼갰다 합쳐도 같은 상태', () => {
  const s = { ...S(), formLogs: [{ id: 'b', date: '2026-11-02', score: 80 }, { id: 'a', date: '2026-11-01' }], done: { x: true }, checkins: { '2026-11-01': { sleep: 3 } } };
  s.coach = { deloadWeeks: [3], deloadNotes: { 3: ['hrv'] } };
  s.garmin = { ...s.garmin, passphrase: 'secret', data: { big: 1 } };
  const f = flatten(s);
  assert.ok(!Object.keys(f).some((k) => k.startsWith('garmin')), '가민·비밀번호는 동기화 안 함');
  const back = unflatten(f, s);
  assert.deepEqual(back.formLogs.map((l) => l.id), ['a', 'b']);
  assert.deepEqual(back.coach, s.coach);
  assert.deepEqual(back.done, s.done);
  assert.equal(back.garmin.passphrase, 'secret');
});

test('PC 기록 + 폰 기록이 서로 합쳐지고, 새 폰의 기본 설정이 PC 설정을 덮어쓰지 않음', () => {
  const pcState = { ...S(), settings: { ...S().settings, squat1rm: 180 }, formLogs: [{ id: 'f1', date: '2026-11-20', lift: 'squat' }] };
  let pc = device(pcState);
  let r1 = sync(pc, empty, 1000);
  pc = r1.dev;
  // 폰: 처음 연결, 기본 설정 + 폰에서 한 러닝 1개
  let phone = device({ ...S(), runLogs: [{ id: 'r1', date: '2026-11-21' }] });
  const r2 = sync(phone, r1.remote, 2000);
  phone = r2.dev;
  assert.equal(phone.state.settings.squat1rm, 180, '이미 동기화된 PC 설정 우선');
  assert.equal(phone.state.formLogs.length, 1);
  assert.equal(phone.state.runLogs.length, 1);
  const r3 = sync(pc, r2.remote, 3000);
  assert.equal(r3.dev.state.runLogs.length, 1, 'PC에도 폰 러닝 반영');
});

test('나중에 고친 쪽이 이기고, 삭제도 전파됨', () => {
  let a = device({ ...S(), formLogs: [{ id: 'f1', date: '2026-11-20' }, { id: 'f2', date: '2026-11-21' }] });
  let r = sync(a, empty, 1000); a = r.dev;
  let b = device(S()); r = sync(b, r.remote, 1100); b = r.dev;
  // b에서 1RM 수정 + f1 삭제
  b.state.settings = { ...b.state.settings, bench1rm: 110 };
  b.state.formLogs = b.state.formLogs.filter((l) => l.id !== 'f1');
  r = sync(b, r.remote, 2000); b = r.dev;
  // a에서 그보다 이전에 다른 기록 추가 (오프라인), 이후 동기화
  a.state.checkins = { '2026-11-22': { sleep: 4 } };
  r = sync(a, r.remote, 3000); a = r.dev;
  assert.equal(a.state.settings.bench1rm, 110);
  assert.deepEqual(a.state.formLogs.map((l) => l.id), ['f2']);
  assert.ok(a.state.checkins['2026-11-22']);
  // 같은 설정을 양쪽에서 고치면 늦게 고친 쪽
  a.state.settings = { ...a.state.settings, ohp1rm: 70 };
  b.state.settings = { ...b.state.settings, ohp1rm: 65 };
  const ra = sync(a, r.remote, 4000);
  const rb = sync(b, ra.remote, 5000);
  assert.equal(rb.dev.state.settings.ohp1rm, 65);
});

test('암호화 → 같은 비밀번호로만 복호화', async () => {
  const doc = { records: { settings: { a: 1 } }, stamps: { settings: { t: 1 } } };
  const enc = await encrypt(doc, 'pw');
  assert.deepEqual(await decrypt(enc, 'pw'), doc);
  await assert.rejects(decrypt(enc, 'nope'));
});

test('옛 설정(최소 원판 항목 없음)이 동기화돼 와도 무게는 5kg 단위', async () => {
  const { prescribe, phaseAt } = await import('../js/coach.js');
  const old = { squat1rm: 152, bench1rm: 97, deadlift1rm: 187, ohp1rm: 63, startDate: '2026-11-02' }; // minPlate 없음
  for (const lift of ['squat', 'bench', 'deadlift', 'ohp']) {
    const r = prescribe(lift, { state: { formLogs: [], coach: {} }, settings: old, phase: phaseAt(0, {}), date: '2026-12-01' });
    assert.equal(r.kg % 5, 0, `${lift} ${r.kg}`);
  }
});
