// 가민 동기화 데이터(암호화 JSON) 복호화 및 러닝 기록 변환
import { hrZone } from './run-analysis.js';

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function decrypt(payload, passphrase) {
  const subtle = globalThis.crypto.subtle;
  const base = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64(payload.salt), iterations: payload.iter },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  try {
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: b64(payload.iv) }, key, b64(payload.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error('비밀번호가 맞지 않습니다.');
  }
}

export async function fetchGarmin(url, passphrase) {
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (res.status === 404) throw new Error('아직 동기화된 데이터가 없습니다. GitHub Actions에서 "Garmin sync"를 실행하세요.');
  if (!res.ok) throw new Error(`데이터를 불러오지 못했습니다 (${res.status}).`);
  return decrypt(await res.json(), passphrase);
}

// 가민 Training Effect 라벨 → 러닝 종류
const LABEL_TYPE = {
  RECOVERY: 'easy',
  BASE: 'easy',
  TEMPO: 'tempo',
  LACTATE_THRESHOLD: 'tempo',
  THRESHOLD: 'tempo',
  VO2MAX: 'interval',
  ANAEROBIC_CAPACITY: 'interval',
  SPRINT: 'interval',
};

export function detectType(g, settings) {
  let type = LABEL_TYPE[String(g.teLabel || '').toUpperCase()];
  if (!type && g.avgHr) {
    const { zone } = hrZone(g.avgHr, settings.hrMax, settings.hrRest);
    type = zone >= 4 ? 'interval' : zone === 3 ? 'tempo' : 'easy';
  }
  type = type || 'easy';
  if (type === 'easy' && g.durationSec >= 75 * 60) type = 'long';
  return type;
}

export function toRunLog(g, settings) {
  return {
    id: 'g' + g.id,
    source: 'garmin',
    date: g.date,
    type: detectType(g, settings),
    distanceKm: g.distanceKm,
    duration: g.durationSec,
    avgHr: g.avgHr || '',
    cadence: g.cadence ? Math.round(g.cadence) : '',
    elevGain: g.elevGain ? Math.round(g.elevGain) : '',
    rpe: '',
    note: g.name || '',
    garmin: { vo2max: g.vo2max, aerobicTE: g.aerobicTE, anaerobicTE: g.anaerobicTE, teLabel: g.teLabel, maxHr: g.maxHr },
  };
}
