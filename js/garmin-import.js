// 가민 내보내기 파일 → 러닝 기록 (서버·비밀번호 없이 브라우저에서 처리)
// 지원: .fit (원본), .zip (가민 커넥트 '원본 내보내기'), .tcx, .gpx, .csv (활동 목록 내보내기)
// 결과 형식은 scripts/garmin_sync.py의 normalize()와 같다.

const FIT_EPOCH = 631065600; // 1989-12-31T00:00:00Z

function localParts(epochSec, offsetSec = null) {
  // offsetSec가 있으면 가민이 기록한 현지 시각 기준, 없으면 브라우저 시간대
  const d = offsetSec == null ? new Date(epochSec * 1000) : new Date((epochSec + offsetSec) * 1000);
  const get = offsetSec == null
    ? [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]
    : [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()];
  const p = (n) => String(n).padStart(2, '0');
  const date = `${get[0]}-${p(get[1])}-${p(get[2])}`;
  return { date, start: `${date} ${p(get[3])}:${p(get[4])}:${p(get[5])}` };
}

function run(fields) {
  return {
    id: null, name: '', date: '', start: '', sport: 'running',
    distanceKm: 0, durationSec: 0, avgHr: null, maxHr: null, cadence: null, elevGain: null,
    vo2max: null, aerobicTE: null, anaerobicTE: null, teLabel: null, trainingLoad: null,
    ...fields,
  };
}

// ---------- FIT ----------
const INVALID = { 1: 0xff, 2: 0xffff, 4: 0xffffffff };

/** FIT 바이너리에서 메시지들을 { global, fields: {num: value} } 목록으로 읽기 */
export function decodeFit(buffer) {
  const dv = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const headerSize = dv.getUint8(0);
  const dataSize = dv.getUint32(4, true);
  const sig = String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11));
  if (sig !== '.FIT') throw new Error('FIT 파일이 아닙니다.');
  const end = Math.min(dv.byteLength, headerSize + dataSize);
  const defs = {};
  const msgs = [];
  let pos = headerSize;
  while (pos < end) {
    const h = dv.getUint8(pos++);
    let local;
    let isDef = false;
    let devFlag = false;
    if (h & 0x80) local = (h >> 5) & 0x3; // 압축 타임스탬프 헤더 (데이터 메시지)
    else { local = h & 0x0f; isDef = !!(h & 0x40); devFlag = !!(h & 0x20); }
    if (isDef) {
      const little = dv.getUint8(pos + 1) === 0;
      const global = dv.getUint16(pos + 2, little);
      const n = dv.getUint8(pos + 4);
      pos += 5;
      const fields = [];
      for (let i = 0; i < n; i++) { fields.push({ num: dv.getUint8(pos), size: dv.getUint8(pos + 1), base: dv.getUint8(pos + 2) }); pos += 3; }
      let devSize = 0;
      if (devFlag) {
        const nd = dv.getUint8(pos++);
        for (let i = 0; i < nd; i++) { devSize += dv.getUint8(pos + 1); pos += 3; }
      }
      defs[local] = { global, little, fields, devSize };
      continue;
    }
    const def = defs[local];
    if (!def) throw new Error('FIT 해석 오류 (정의 없는 메시지)');
    const out = {};
    for (const f of def.fields) {
      const bt = f.base & 0x1f;
      const signed = bt === 1 || bt === 3 || bt === 5;
      let v = null;
      if (bt === 7) { // 문자열
        let s = '';
        for (let i = 0; i < f.size; i++) { const c = dv.getUint8(pos + i); if (!c) break; s += String.fromCharCode(c); }
        v = s;
      } else if (f.size === 1) v = signed ? dv.getInt8(pos) : dv.getUint8(pos);
      else if (f.size === 2) v = signed ? dv.getInt16(pos, def.little) : dv.getUint16(pos, def.little);
      else if (f.size === 4) v = bt === 8 ? dv.getFloat32(pos, def.little) : signed ? dv.getInt32(pos, def.little) : dv.getUint32(pos, def.little);
      if (typeof v === 'number' && !signed && bt !== 8 && v === INVALID[f.size]) v = null;
      if (typeof v === 'number' && signed && (v === 0x7f || v === 0x7fff || v === 0x7fffffff)) v = null;
      if ((bt === 10 || bt === 11 || bt === 12) && v === 0) v = null; // z 타입: 0이 무효값
      out[f.num] = v;
      pos += f.size;
    }
    pos += def.devSize;
    msgs.push({ global: def.global, fields: out });
  }
  return msgs;
}

export function parseFit(buffer, name = '') {
  const msgs = decodeFit(buffer);
  const sessions = msgs.filter((m) => m.global === 18).map((m) => m.fields);
  const activity = msgs.find((m) => m.global === 34)?.fields;
  const offset = activity && activity[5] != null && activity[253] != null ? activity[5] - activity[253] : null;
  return sessions
    .filter((s) => s[5] === 1 || s[5] == null) // sport 1 = running
    .map((s) => {
      const startEpoch = (s[2] ?? s[253]) + FIT_EPOCH;
      const { date, start } = localParts(startEpoch, offset);
      const cad = s[18] != null ? (s[18] + (s[41] ?? 0) / 128) * 2 : null; // 한쪽 발 기준 → 양발 spm
      return run({
        id: `fit${s[2] ?? s[253]}`,
        name: name.replace(/\.(fit|zip)$/i, ''),
        date, start,
        distanceKm: s[9] != null ? Math.round(s[9] / 100) / 1000 : 0,
        durationSec: Math.round((s[8] ?? s[7] ?? 0) / 1000),
        avgHr: s[16], maxHr: s[17],
        cadence: cad ? Math.round(cad) : null,
        elevGain: s[22],
        aerobicTE: s[24] != null ? s[24] / 10 : null,
        anaerobicTE: s[137] != null ? s[137] / 10 : null,
      });
    })
    .filter((r) => r.distanceKm > 0);
}

// ---------- ZIP (가민 원본 내보내기) ----------
async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzip(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('ZIP 파일을 읽을 수 없습니다.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    const lnl = dv.getUint16(off + 26, true);
    const lel = dv.getUint16(off + 28, true);
    const data = u8.subarray(off + 30 + lnl + lel, off + 30 + lnl + lel + csize);
    files.push({ name, data: method === 0 ? data : method === 8 ? await inflateRaw(data) : null });
  }
  return files.filter((f) => f.data);
}

// ---------- TCX / GPX (정규식 기반, DOM 불필요) ----------
const tag = (xml, t) => [...xml.matchAll(new RegExp(`<(?:\\w+:)?${t}[^>]*>([^<]*)</(?:\\w+:)?${t}>`, 'g'))].map((m) => m[1].trim());
const num = (s) => (s == null || s === '' ? null : Number(s));

function ascent(alts) {
  let up = 0;
  for (let i = 1; i < alts.length; i++) if (alts[i] > alts[i - 1]) up += alts[i] - alts[i - 1];
  return alts.length > 1 ? Math.round(up) : null;
}

function isoToLocal(iso) {
  return localParts(Date.parse(iso) / 1000);
}

export function parseTcx(xml, name = '') {
  const acts = [...xml.matchAll(/<Activity\s+Sport="([^"]*)"[\s\S]*?<\/Activity>/g)];
  return acts.filter((a) => /run/i.test(a[1])).map((a) => {
    const body = a[0];
    const laps = [...body.matchAll(/<Lap\b[\s\S]*?<\/Lap>/g)].map((m) => m[0]);
    let dur = 0;
    let distM = 0;
    let hrSum = 0;
    let hrT = 0;
    let maxHr = null;
    let cadSum = 0;
    let cadT = 0;
    for (const lap of laps) {
      const t = num(tag(lap, 'TotalTimeSeconds')[0]) || 0;
      dur += t;
      distM += num(lap.match(/<DistanceMeters>([^<]*)<\/DistanceMeters>/)?.[1]) || 0; // 랩 요약 값(트랙포인트보다 먼저 나옴)
      const avg = num(lap.match(/<AverageHeartRateBpm>\s*<Value>([^<]*)</)?.[1]);
      if (avg) { hrSum += avg * t; hrT += t; }
      const mx = num(lap.match(/<MaximumHeartRateBpm>\s*<Value>([^<]*)</)?.[1]);
      if (mx) maxHr = Math.max(maxHr || 0, mx);
      const cad = num(lap.match(/<(?:\w+:)?AvgRunCadence>([^<]*)</)?.[1]);
      if (cad) { cadSum += cad * t; cadT += t; }
    }
    const id = body.match(/<Id>([^<]*)<\/Id>/)?.[1];
    const { date, start } = isoToLocal(id);
    return run({
      id: `tcx${Date.parse(id) / 1000}`, name: name.replace(/\.tcx$/i, ''), date, start,
      distanceKm: Math.round(distM) / 1000, durationSec: Math.round(dur),
      avgHr: hrT ? Math.round(hrSum / hrT) : null, maxHr,
      cadence: cadT ? Math.round((cadSum / cadT) * 2) : null,
      elevGain: ascent(tag(body, 'AltitudeMeters').map(Number)),
    });
  }).filter((r) => r.distanceKm > 0);
}

export function parseGpx(xml, name = '') {
  const pts = [...xml.matchAll(/<trkpt\s+([^>]*)>([\s\S]*?)<\/trkpt>/g)].map((m) => ({
    lat: num(m[1].match(/lat="([^"]+)"/)?.[1]),
    lon: num(m[1].match(/lon="([^"]+)"/)?.[1]),
    t: Date.parse(m[2].match(/<time>([^<]*)<\/time>/)?.[1]),
    ele: num(m[2].match(/<ele>([^<]*)<\/ele>/)?.[1]),
    hr: num(m[2].match(/<(?:\w+:)?hr>([^<]*)</)?.[1]),
    cad: num(m[2].match(/<(?:\w+:)?cad>([^<]*)</)?.[1]),
  })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.t));
  if (pts.length < 2) return [];
  const type = xml.match(/<type>([^<]*)<\/type>/)?.[1] || 'running';
  if (!/run|달리기|러닝/i.test(type)) return [];
  let dist = 0;
  const R = 6371000;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    dist += 2 * R * Math.asin(Math.sqrt(h));
  }
  const hrs = pts.map((p) => p.hr).filter(Boolean);
  const cads = pts.map((p) => p.cad).filter(Boolean);
  const { date, start } = localParts(pts[0].t / 1000);
  return [run({
    id: `gpx${Math.round(pts[0].t / 1000)}`, name: name.replace(/\.gpx$/i, ''), date, start,
    distanceKm: Math.round(dist) / 1000,
    durationSec: Math.round((pts[pts.length - 1].t - pts[0].t) / 1000),
    avgHr: hrs.length ? Math.round(hrs.reduce((x, y) => x + y, 0) / hrs.length) : null,
    maxHr: hrs.length ? Math.max(...hrs) : null,
    cadence: cads.length ? Math.round((cads.reduce((x, y) => x + y, 0) / cads.length) * 2) : null,
    elevGain: ascent(pts.map((p) => p.ele).filter(Number.isFinite)),
  })];
}

// ---------- CSV (가민 커넥트 '활동' 목록 내보내기, 영문·한글) ----------
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}

const COLS = {
  type: /^(activity type|활동 유형|활동 종류|유형)$/i,
  date: /^(date|날짜|시작 시간)$/i,
  title: /^(title|제목|활동 이름)$/i,
  distance: /^(distance|거리)$/i,
  time: /^(time|시간|총 시간|elapsed time)$/i,
  movingTime: /^(moving time|이동 시간)$/i,
  avgHr: /^(avg hr|평균 심박수|평균 심박)$/i,
  maxHr: /^(max hr|최대 심박수|최대 심박)$/i,
  aerobicTE: /^(aerobic te|유산소 te|유산소 트레이닝 효과)$/i,
  cadence: /^(avg run cadence|평균 달리기 케이던스|평균 러닝 케이던스|평균 케이던스)$/i,
  ascent: /^(total ascent|총 상승|상승 고도|총 오르막)$/i,
};

const clean = (s) => (s == null ? '' : s.replace(/^﻿/, '').trim());
const toNum = (s) => {
  const v = clean(s).replace(/,/g, '');
  return v === '' || v === '--' ? null : Number(v);
};
const toSec = (s) => {
  const v = clean(s);
  if (!v || v === '--') return null;
  const parts = v.split(':').map(Number);
  return parts.some(Number.isNaN) ? null : Math.round(parts.reduce((a, n) => a * 60 + n, 0));
};

export function parseCsv(text) {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return [];
  const head = rows[0].map(clean);
  const col = Object.fromEntries(Object.entries(COLS).map(([k, re]) => [k, head.findIndex((h) => re.test(h))]));
  if (col.distance < 0 || (col.time < 0 && col.movingTime < 0) || col.date < 0) {
    throw new Error('가민 활동 CSV 형식을 알 수 없습니다. 가민 커넥트 활동 목록의 "CSV 내보내기" 파일을 사용하세요.');
  }
  const get = (r, k) => (col[k] >= 0 ? r[col[k]] : undefined);
  return rows.slice(1).filter((r) => {
    const t = clean(get(r, 'type'));
    return !t || /run|달리기|러닝|트레드밀|트레일/i.test(t);
  }).map((r) => {
    const startRaw = clean(get(r, 'date')).replace('T', ' ');
    const dur = toSec(get(r, 'movingTime')) || toSec(get(r, 'time'));
    return run({
      id: `csv${startRaw.replace(/\D/g, '')}`,
      name: clean(get(r, 'title')),
      date: startRaw.slice(0, 10),
      start: startRaw.length >= 16 ? startRaw.slice(0, 19) : `${startRaw.slice(0, 10)} 00:00:00`,
      distanceKm: toNum(get(r, 'distance')) || 0,
      durationSec: dur || 0,
      avgHr: toNum(get(r, 'avgHr')),
      maxHr: toNum(get(r, 'maxHr')),
      cadence: toNum(get(r, 'cadence')),
      elevGain: toNum(get(r, 'ascent')),
      aerobicTE: toNum(get(r, 'aerobicTE')),
    });
  }).filter((x) => x.distanceKm > 0 && x.durationSec > 0 && /^\d{4}-\d{2}-\d{2}$/.test(x.date));
}

/** 파일 하나(또는 ZIP 안의 여러 파일)를 러닝 기록 목록으로 */
export async function importGarminFile(name, buffer) {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'zip') {
    const out = [];
    for (const f of await unzip(buffer)) out.push(...await importGarminFile(f.name, f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength)));
    return out;
  }
  if (ext === 'fit') return parseFit(buffer, name);
  const text = new TextDecoder().decode(buffer);
  if (ext === 'tcx') return parseTcx(text, name);
  if (ext === 'gpx') return parseGpx(text, name);
  if (ext === 'csv') return parseCsv(text);
  return [];
}

// 같은 활동이 여러 경로(CSV, FIT, 자동 동기화)로 들어와도 한 번만 반영
export function isSameRun(a, b) {
  return a.date === b.date
    && Math.abs(Number(a.distanceKm) - Number(b.distanceKm)) <= Math.max(0.15, Number(a.distanceKm) * 0.03)
    && Math.abs(Number(a.durationSec) - Number(b.durationSec)) <= 90;
}
