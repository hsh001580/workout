// 기기 간 동기화: 기록을 비밀번호로 암호화해 GitHub 비공개 Gist 하나에 저장
//
// 병합 방식: 상태를 작은 레코드(설정, 세트 기록 1개, 러닝 1개, 체크인 1일 …)로 쪼개
// 레코드마다 마지막 수정 시각을 기록하고, 두 기기 중 더 늦게 고친 쪽을 채택 (삭제도 시각과 함께 남김).
// 처음 연결하는 기기의 기존 데이터는 시각 0으로 표시 → 이미 동기화된 데이터가 우선, 새 레코드는 합쳐짐
import { decrypt } from './garmin.js';

const API = 'https://api.github.com';
const FILE = 'workout-sync.json';
const DESC = 'workout-app-sync (암호화된 운동 기록)';
const ITER = 200000;
const LOG_ARRAYS = ['formLogs', 'runLogs'];
const MAPS = ['done', 'checkins'];
const SKIP = new Set(['garmin']); // 가민 데이터는 각 기기가 직접 받음 (용량 크고 비밀번호 포함)

// ---------- 순수 함수 (테스트 대상) ----------

export function hashOf(v) {
  const s = JSON.stringify(v) ?? '';
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + s.length.toString(36);
}

export function flatten(state) {
  const r = {};
  for (const [k, v] of Object.entries(state)) {
    if (SKIP.has(k) || v === undefined) continue;
    if (LOG_ARRAYS.includes(k) && Array.isArray(v)) v.forEach((x) => { if (x?.id) r[`${k}/${x.id}`] = x; });
    else if (MAPS.includes(k) && v && typeof v === 'object') Object.entries(v).forEach(([kk, vv]) => { r[`${k}/${kk}`] = vv; });
    else if (k === 'coach' && v && typeof v === 'object') {
      Object.entries(v).forEach(([kk, vv]) => {
        if (kk === 'deloadNotes' && vv && typeof vv === 'object') Object.entries(vv).forEach(([w, n]) => { r[`coachNotes/${w}`] = n; });
        else r[`coach/${kk}`] = vv;
      });
    } else r[k] = v;
  }
  return r;
}

const byDateId = (a, b) => (a.date || '').localeCompare(b.date || '') || String(a.id).localeCompare(String(b.id));

// 레코드 → 상태 (가민 등 동기화하지 않는 항목은 기존 값 유지)
export function unflatten(records, base) {
  const out = { ...base };
  LOG_ARRAYS.forEach((k) => { out[k] = []; });
  MAPS.forEach((k) => { out[k] = {}; });
  out.coach = { deloadNotes: {} };
  for (const [key, v] of Object.entries(records)) {
    const i = key.indexOf('/');
    const top = i < 0 ? key : key.slice(0, i);
    const sub = i < 0 ? null : key.slice(i + 1);
    if (LOG_ARRAYS.includes(top)) out[top].push(v);
    else if (MAPS.includes(top)) out[top][sub] = v;
    else if (top === 'coachNotes') out.coach.deloadNotes[sub] = v;
    else if (top === 'coach') out.coach[sub] = v;
    else if (!SKIP.has(top)) out[top] = v;
  }
  LOG_ARRAYS.forEach((k) => out[k].sort(byDateId));
  return out;
}

// 지난 동기화 이후 바뀐 레코드에 시각 기록. first: 처음 연결하는 기기(기존 데이터는 시각 0)
export function stampChanges(records, stamps, now, first = false) {
  const next = { ...stamps };
  let changed = false;
  for (const [k, v] of Object.entries(records)) {
    const h = hashOf(v);
    const s = next[k];
    if (!s || s.del || s.h !== h) { next[k] = { t: first && !s ? 0 : now, h }; changed = true; }
  }
  for (const [k, s] of Object.entries(next)) {
    if (!s.del && !(k in records)) { next[k] = { t: now, del: true }; changed = true; }
  }
  return { stamps: next, changed };
}

// 레코드별로 더 늦게 고친 쪽 채택 (같으면 원격 우선)
export function merge(local, remote) {
  const records = {};
  const stamps = {};
  const keys = new Set([...Object.keys(local.stamps), ...Object.keys(remote.stamps || {})]);
  for (const k of keys) {
    const a = local.stamps[k];
    const b = remote.stamps?.[k];
    const useRemote = b && (!a || b.t >= a.t);
    const s = useRemote ? b : a;
    const src = useRemote ? remote.records || {} : local.records;
    if (s.del) { stamps[k] = { t: s.t, del: true }; continue; }
    if (!(k in src)) continue; // 손상된 항목은 건너뜀
    records[k] = src[k];
    stamps[k] = { t: s.t, h: hashOf(src[k]) };
  }
  return { records, stamps };
}

// ---------- 암호화 ----------

const toB64 = (u8) => btoa(String.fromCharCode(...u8));

export async function encrypt(obj, passphrase) {
  const subtle = globalThis.crypto.subtle;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  let bin = '';
  for (let i = 0; i < ct.length; i += 0x8000) bin += String.fromCharCode(...ct.subarray(i, i + 0x8000));
  return { v: 1, iter: ITER, salt: toB64(salt), iv: toB64(iv), ct: btoa(bin) };
}

// ---------- GitHub Gist ----------

async function gh(token, path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    cache: 'no-store',
  });
  if (res.status === 401) throw new Error('GitHub 토큰이 올바르지 않거나 만료되었습니다.');
  if (res.status === 403 || res.status === 404) throw new Error('토큰에 gist 권한이 없습니다. gist 권한으로 토큰을 다시 만들어 주세요.');
  if (!res.ok) throw new Error(`GitHub 오류 (${res.status})`);
  return res.json();
}

async function findGist(token) {
  for (let page = 1; page <= 10; page++) {
    const list = await gh(token, `/gists?per_page=100&page=${page}`);
    const hit = list.find((g) => g.files?.[FILE]);
    if (hit) return hit.id;
    if (list.length < 100) return null;
  }
  return null;
}

async function readGist(token, id) {
  const g = await gh(token, `/gists/${id}`);
  const f = g.files?.[FILE];
  if (!f) return null;
  const text = f.truncated ? await (await fetch(f.raw_url, { cache: 'no-store' })).text() : f.content;
  return JSON.parse(text);
}

const body = (payload) => JSON.stringify({ description: DESC, files: { [FILE]: { content: JSON.stringify(payload) } } });

// ---------- 동기화 한 번 ----------

const KEY = 'workout-sync-v1';
export function loadSyncConf() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
export function saveSyncConf(c) {
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch { /* 저장소 사용 불가 */ }
}

/**
 * 원격과 병합하고 결과를 올림. 상태가 바뀌면 { state } 반환
 * @param conf { token, pass, gistId?, stamps? }
 */
export async function syncOnce(state, conf, now = Date.now()) {
  if (!conf.token || !conf.pass) throw new Error('토큰과 동기화 비밀번호를 입력하세요.');
  const first = !conf.stamps;
  const localRecords = flatten(state);
  const { stamps } = stampChanges(localRecords, conf.stamps || {}, now, first);
  const local = { records: localRecords, stamps };

  let gistId = conf.gistId || (await findGist(conf.token));
  let remote = { records: {}, stamps: {} };
  if (gistId) {
    const payload = await readGist(conf.token, gistId);
    if (payload) remote = await decrypt(payload, conf.pass).catch(() => { throw new Error('동기화 비밀번호가 다른 기기와 다릅니다.'); });
  }
  const merged = merge(local, remote);
  const remoteSame = JSON.stringify(merged.stamps) === JSON.stringify(remote.stamps);
  if (!remoteSame || !gistId) {
    const payload = await encrypt({ ...merged, updated: new Date(now).toISOString() }, conf.pass);
    if (gistId) await gh(conf.token, `/gists/${gistId}`, { method: 'PATCH', body: body(payload) });
    else gistId = (await gh(conf.token, '/gists', { method: 'POST', body: JSON.stringify({ ...JSON.parse(body(payload)), public: false }) })).id;
  }
  const localChanged = Object.keys(merged.records).length !== Object.keys(localRecords).length
    || Object.entries(merged.records).some(([k, v]) => !(k in localRecords) || hashOf(localRecords[k]) !== hashOf(v));
  const next = { ...conf, gistId, stamps: merged.stamps, lastSync: new Date(now).toISOString() };
  return { conf: next, state: localChanged ? unflatten(merged.records, state) : null, pushed: !remoteSame };
}
