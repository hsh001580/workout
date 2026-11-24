import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { parseFit, parseTcx, parseGpx, parseCsv, importGarminFile, isSameRun } from '../js/garmin-import.js';

// ---- 최소 FIT 인코더 (session + activity 메시지) ----
function fitFile(session, activity) {
  const bytes = [];
  const u8 = (v) => bytes.push(v & 0xff);
  const u16 = (v) => { u8(v); u8(v >> 8); };
  const u32 = (v) => { u16(v & 0xffff); u16(v >>> 16); };
  const def = (local, global, fields) => { u8(0x40 | local); u8(0); u8(0); u16(global); u8(fields.length); fields.forEach(([n, size, base]) => { u8(n); u8(size); u8(base); }); };
  const data = (local, fields, vals) => { u8(local); fields.forEach(([n, size], i) => (size === 1 ? u8(vals[i]) : size === 2 ? u16(vals[i]) : u32(vals[i]))); };
  const SF = [[253, 4, 0x86], [2, 4, 0x86], [5, 1, 0x00], [7, 4, 0x86], [8, 4, 0x86], [9, 4, 0x86], [16, 1, 0x02], [17, 1, 0x02], [18, 1, 0x02], [22, 2, 0x84], [24, 1, 0x02], [137, 1, 0x02]];
  def(0, 18, SF);
  data(0, SF, session);
  const AF = [[253, 4, 0x86], [5, 4, 0x86]];
  def(1, 34, AF);
  data(1, AF, activity);
  const body = Uint8Array.from(bytes);
  const out = new Uint8Array(14 + body.length + 2);
  const dv = new DataView(out.buffer);
  out[0] = 14; out[1] = 0x20; dv.setUint16(2, 2132, true); dv.setUint32(4, body.length, true);
  out.set([46, 70, 73, 84], 8);
  out.set(body, 14);
  return out.buffer;
}

// 2026-11-20 07:00:00 KST = 2026-11-19T22:00:00Z
const startUtc = Date.UTC(2026, 10, 19, 22, 0, 0) / 1000 - 631065600;
const SESSION = [startUtc + 2900, startUtc, 1, 2900500, 2880000, 801230, 142, 158, 86, 35, 29, 3];
const ACT = [startUtc + 2900, startUtc + 2900 + 9 * 3600];

test('FIT: 세션 요약 읽기 (거리·시간·심박·케이던스·TE·현지 날짜)', () => {
  const [r] = parseFit(fitFile(SESSION, ACT), 'morning.fit');
  assert.equal(r.date, '2026-11-20');
  assert.equal(r.start, '2026-11-20 07:00:00');
  assert.equal(r.distanceKm, 8.012);
  assert.equal(r.durationSec, 2880);
  assert.equal(r.avgHr, 142);
  assert.equal(r.maxHr, 158);
  assert.equal(r.cadence, 172);
  assert.equal(r.elevGain, 35);
  assert.equal(r.aerobicTE, 2.9);
  assert.equal(r.anaerobicTE, 0.3);
});

test('FIT: 러닝이 아닌 세션(근력 운동)은 제외', () => {
  const s = [...SESSION];
  s[2] = 10; // training
  assert.equal(parseFit(fitFile(s, ACT)).length, 0);
});

function zipOf(name, data) {
  const comp = zlib.deflateRawSync(Buffer.from(data));
  const nameB = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.byteLength, 22); local.writeUInt16LE(nameB.length, 26);
  const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(8, 10); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.byteLength, 24); cen.writeUInt16LE(nameB.length, 28); cen.writeUInt32LE(0, 42);
  const cenOff = 30 + nameB.length + comp.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + nameB.length, 12); eocd.writeUInt32LE(cenOff, 16);
  const all = Buffer.concat([local, nameB, comp, cen, nameB, eocd]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}

test('ZIP(가민 원본 내보내기) 안의 FIT 읽기', async () => {
  const runs = await importGarminFile('21843_ACTIVITY.zip', zipOf('21843_ACTIVITY.fit', new Uint8Array(fitFile(SESSION, ACT))));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].distanceKm, 8.012);
});

test('TCX', () => {
  const xml = `<?xml version="1.0"?><TrainingCenterDatabase><Activities><Activity Sport="Running"><Id>2026-11-19T22:00:00Z</Id>
  <Lap StartTime="2026-11-19T22:00:00Z"><TotalTimeSeconds>1500</TotalTimeSeconds><DistanceMeters>5000</DistanceMeters><MaximumSpeed>4</MaximumSpeed>
  <AverageHeartRateBpm><Value>150</Value></AverageHeartRateBpm><MaximumHeartRateBpm><Value>165</Value></MaximumHeartRateBpm>
  <Track><Trackpoint><DistanceMeters>10</DistanceMeters><AltitudeMeters>10</AltitudeMeters></Trackpoint><Trackpoint><DistanceMeters>20</DistanceMeters><AltitudeMeters>15</AltitudeMeters></Trackpoint></Track>
  <Extensions><ns3:LX><ns3:AvgRunCadence>85</ns3:AvgRunCadence></ns3:LX></Extensions></Lap>
  <Lap><TotalTimeSeconds>500</TotalTimeSeconds><DistanceMeters>1500</DistanceMeters><AverageHeartRateBpm><Value>170</Value></AverageHeartRateBpm></Lap>
  </Activity></Activities></TrainingCenterDatabase>`;
  const [r] = parseTcx(xml);
  assert.equal(r.distanceKm, 6.5);
  assert.equal(r.durationSec, 2000);
  assert.equal(r.avgHr, 155);
  assert.equal(r.maxHr, 165);
  assert.equal(r.cadence, 170);
  assert.equal(r.elevGain, 5);
});

test('GPX (심박·케이던스 확장)', () => {
  const pt = (i) => `<trkpt lat="${37.5 + i * 0.001}" lon="127.0"><ele>${10 + i}</ele><time>2026-11-19T22:${String(i).padStart(2, '0')}:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${140 + i}</gpxtpx:hr><gpxtpx:cad>86</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions></trkpt>`;
  const xml = `<gpx><trk><type>running</type><trkseg>${Array.from({ length: 11 }, (_, i) => pt(i)).join('')}</trkseg></trk></gpx>`;
  const [r] = parseGpx(xml);
  assert.ok(Math.abs(r.distanceKm - 1.112) < 0.01, r.distanceKm);
  assert.equal(r.durationSec, 600);
  assert.equal(r.avgHr, 145);
  assert.equal(r.cadence, 172);
});

test('CSV: 영문 가민 활동 내보내기 (러닝만, 쉼표 숫자·-- 처리)', () => {
  const csv = '﻿Activity Type,Date,Favorite,Title,Distance,Calories,Time,Avg HR,Max HR,Aerobic TE,Avg Run Cadence,Total Ascent\n'
    + 'Running,2026-11-20 07:01:00,false,"Seoul Running",8.01,"1,234",00:48:00,142,158,2.9,172,35\n'
    + 'Strength Training,2026-11-20 19:00:00,false,Strength,0.00,300,01:00:00,110,140,1.5,--,--\n'
    + 'Treadmill Running,2026-11-22 07:00:00,false,Tempo,10.00,700,00:45:00,168,182,3.8,178,--\n';
  const runs = parseCsv(csv);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].durationSec, 2880);
  assert.equal(runs[0].avgHr, 142);
  assert.equal(runs[1].elevGain, null);
});

test('CSV: 한글 헤더', () => {
  const csv = '활동 유형,날짜,즐겨찾기,제목,거리,칼로리,시간,평균 심박수,최대 심박수,유산소 TE,평균 달리기 케이던스,총 상승\n'
    + '달리기,2026-11-20 07:01:00,false,서울 달리기,5.02,400,00:30:10,150,170,3.1,170,20\n';
  const [r] = parseCsv(csv);
  assert.equal(r.distanceKm, 5.02);
  assert.equal(r.durationSec, 1810);
  assert.equal(r.cadence, 170);
});

test('같은 활동 중복 판정', () => {
  assert.ok(isSameRun({ date: '2026-11-20', distanceKm: 8.01, durationSec: 2880 }, { date: '2026-11-20', distanceKm: 8.012, durationSec: 2900 }));
  assert.ok(!isSameRun({ date: '2026-11-20', distanceKm: 8.01, durationSec: 2880 }, { date: '2026-11-20', distanceKm: 5, durationSec: 1800 }));
});
