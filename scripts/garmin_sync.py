#!/usr/bin/env python3
"""가민 커넥트의 훈련·회복·신체 데이터를 가져와 암호화된 JSON(data/garmin.enc.json)으로 저장.

가져오는 데이터
  활동     모든 활동 (러닝은 runs, 나머지는 activities). 근력 운동은 세트·반복·무게까지
  회복     수면(점수·단계·수면 중 HRV·SpO2·호흡), HRV 상태, 바디 배터리, 스트레스, 안정시 심박,
           트레이닝 레디니스, 걸음·강도 분, 칼로리
  부하     트레이닝 상태, 급성/만성 부하·ACWR, 4주 부하 균형
  능력     VO2max 추이, 레이스 예측, 젖산 역치, 지구력·언덕 점수, 피트니스 나이, 심박존, 근력 1RM 추정
  신체     체중·체지방·근육량·BMI

처음에는 활동 SYNC_DAYS(기본 180)일, 건강 지표 WELLNESS_DAYS(기본 90)일을 가져오고,
이후에는 이전 파일을 복호화해 최근 며칠만 갱신한다 (요청 수 최소화). 항목별 실패는 건너뛴다.

환경변수
  GARMIN_EMAIL, GARMIN_PASSWORD  가민 계정 (GitHub Secrets)
  GARMIN_TOKENS                  (선택) 2단계 인증 계정용 토큰 JSON. `--export-tokens`로 생성
  DATA_PASSPHRASE                앱에서 입력할 복호화 비밀번호 (GitHub Secrets)
  GARMIN_TOKEN_DIR               토큰 캐시 폴더 (기본 ~/.garminconnect)

사용
  python scripts/garmin_sync.py                    # 동기화
  python scripts/garmin_sync.py --mock sample.json # 가민 대신 샘플 활동 목록으로 테스트
  python scripts/garmin_sync.py --export-tokens    # (내 PC에서) 2단계 인증 후 토큰 JSON 출력
"""
import base64
import datetime as dt
import hashlib
import json
import os
import sys
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

ITERATIONS = 200_000
OUT = Path(os.environ.get("OUT", "data/garmin.enc.json"))
TOKEN_DIR = os.path.expanduser(os.environ.get("GARMIN_TOKEN_DIR", "~/.garminconnect"))
DAYS = int(os.environ.get("SYNC_DAYS", "180"))
WELLNESS_DAYS = int(os.environ.get("WELLNESS_DAYS", "90"))
SLEEP_DETAIL_DAYS = 30  # 수면 상세는 하루 단위 요청이라 기간 제한
REFRESH_DAYS = 3  # 증분 동기화 시 다시 가져올 최근 일수
MAX_SET_FETCH = 40  # 한 번에 세트를 조회할 근력 활동 수


def login(prompt_mfa=None):
    from garminconnect import Garmin

    g = Garmin(os.environ.get("GARMIN_EMAIL"), os.environ.get("GARMIN_PASSWORD"), prompt_mfa=prompt_mfa)
    token_json = os.environ.get("GARMIN_TOKENS", "").strip()
    if not Path(TOKEN_DIR).exists() and token_json:
        g.login(token_json)
        Path(TOKEN_DIR).mkdir(parents=True, exist_ok=True)
        g.client.dump(TOKEN_DIR)
    else:
        g.login(TOKEN_DIR)
    return g


def safe(fn, *args, **kw):
    try:
        return fn(*args, **kw)
    except Exception as e:  # 항목별 실패는 건너뛰고 계속
        print(f"warn: {getattr(fn, '__name__', fn)} 실패: {str(e)[:200]}", file=sys.stderr)
        return None


# ---------- 응답 형식이 바뀌어도 값을 찾아내는 도우미 ----------
def find(obj, *keys, default=None):
    """중첩된 dict/list에서 keys 중 처음 나오는 값(None 아님)을 찾는다."""
    stack = [obj]
    while stack:
        cur = stack.pop(0)
        if isinstance(cur, dict):
            for k in keys:
                if cur.get(k) is not None:
                    return cur[k]
            stack.extend(v for v in cur.values() if isinstance(v, (dict, list)))
        elif isinstance(cur, list):
            stack.extend(v for v in cur if isinstance(v, (dict, list)))
    return default


def dated(obj, date_keys=("calendarDate", "date", "summaryDate")):
    """중첩 구조에서 날짜 키를 가진 dict들을 모두 찾아 {날짜: dict} (같은 날짜는 뒤의 것 우선)."""
    out = {}
    stack = [obj]
    while stack:
        cur = stack.pop(0)
        if isinstance(cur, dict):
            d = next((cur[k] for k in date_keys if isinstance(cur.get(k), str) and len(cur[k]) >= 10), None)
            if d:
                out[d[:10]] = cur
            stack.extend(v for v in cur.values() if isinstance(v, (dict, list)))
        elif isinstance(cur, list):
            stack.extend(v for v in cur if isinstance(v, (dict, list)))
    return out


def num(v, scale=1, nd=1):
    try:
        return round(float(v) * scale, nd) if v is not None else None
    except (TypeError, ValueError):
        return None


def clean(d):
    return {k: v for k, v in d.items() if v is not None and v != ""}


# ---------- 활동 ----------
def is_run(act):
    key = ((act.get("activityType") or {}).get("typeKey") or "").lower()
    return "run" in key


def normalize(act):
    start = act.get("startTimeLocal") or act.get("startTimeGMT") or ""
    return {
        "id": act.get("activityId"),
        "name": act.get("activityName") or "",
        "date": start[:10],
        "start": start,
        "sport": (act.get("activityType") or {}).get("typeKey"),
        "distanceKm": round((act.get("distance") or 0) / 1000, 3),
        "durationSec": round(act.get("movingDuration") or act.get("duration") or 0),
        "avgHr": act.get("averageHR"),
        "maxHr": act.get("maxHR"),
        "cadence": act.get("averageRunningCadenceInStepsPerMinute"),
        "elevGain": act.get("elevationGain"),
        "vo2max": act.get("vO2MaxValue"),
        "aerobicTE": act.get("aerobicTrainingEffect"),
        "anaerobicTE": act.get("anaerobicTrainingEffect"),
        "teLabel": act.get("trainingEffectLabel"),
        "trainingLoad": act.get("activityTrainingLoad"),
        "calories": act.get("calories"),
    }


def exercise_sets(raw):
    """근력 운동 세트 → [{exercise, reps, kg}] (휴식 세트 제외). 무게는 g 단위로 오면 kg로 변환."""
    sets = []
    for s in (raw or {}).get("exerciseSets") or []:
        if (s.get("setType") or "").upper() not in ("ACTIVE", ""):
            continue
        ex = (s.get("exercises") or [{}])[0]
        w = s.get("weight")
        kg = None
        if w is not None:
            kg = w / 1000 if w > 1000 else w
        sets.append(clean({
            "exercise": ex.get("name") or ex.get("category"),
            "category": ex.get("category"),
            "reps": s.get("repetitionCount"),
            "kg": round(kg, 1) if kg is not None else None,
            "sec": num(s.get("duration"), 1, 0),
        }))
    return sets


# ---------- 하루 지표 ----------
def merge_daily(daily, date, values):
    vals = clean(values)
    if vals:
        daily.setdefault(date, {}).update(vals)


def sleep_from(raw):
    dto = (raw or {}).get("dailySleepDTO") or {}
    scores = dto.get("sleepScores") or {}
    return {
        "sleepScore": find(scores.get("overall") or {}, "value"),
        "sleepQuality": find(scores.get("overall") or {}, "qualifierKey"),
        "sleepHours": num(dto.get("sleepTimeSeconds"), 1 / 3600, 2),
        "deepMin": num(dto.get("deepSleepSeconds"), 1 / 60, 0),
        "remMin": num(dto.get("remSleepSeconds"), 1 / 60, 0),
        "lightMin": num(dto.get("lightSleepSeconds"), 1 / 60, 0),
        "awakeMin": num(dto.get("awakeSleepSeconds"), 1 / 60, 0),
        "sleepHrv": num(dto.get("avgSleepHRV") or (raw or {}).get("avgOvernightHrv")),
        "spo2": num(dto.get("avgSpO2")),
        "respiration": num(dto.get("avgRespirationValue")),
        "sleepStress": num(dto.get("avgSleepStress") or (raw or {}).get("avgSleepStress")),
        "bbChange": (raw or {}).get("bodyBatteryChange"),
    }


def fetch(g, prev=None):
    prev = prev or {}
    today = dt.date.today()
    iso = lambda d: d.isoformat()
    last = prev.get("syncedThrough")
    incremental = bool(last)
    since = dt.date.fromisoformat(last) - dt.timedelta(days=REFRESH_DAYS) if incremental else None
    act_start = since or today - dt.timedelta(days=DAYS)
    well_start = since or today - dt.timedelta(days=WELLNESS_DAYS)

    # 1) 활동 (모든 종류)
    acts = safe(g.get_activities_by_date, iso(act_start), iso(today)) or []
    runs = {r["id"]: r for r in prev.get("runs", [])}
    others = {a["id"]: a for a in prev.get("activities", [])}
    fetched_sets = 0
    for a in acts:
        n = normalize(a)
        if is_run(a):
            runs[n["id"]] = n
        else:
            old = others.get(n["id"], {})
            if old.get("sets"):
                n["sets"] = old["sets"]
            elif "strength" in (n["sport"] or "") and fetched_sets < MAX_SET_FETCH:
                fetched_sets += 1
                n["sets"] = exercise_sets(safe(g.get_activity_exercise_sets, n["id"]))
            others[n["id"]] = clean(n)

    # 2) 하루 지표
    daily = dict(prev.get("daily", {}))
    summ = safe(g.get_daily_summaries, iso(well_start), iso(today))
    for d, s in dated(summ).items():
        merge_daily(daily, d, {
            "steps": s.get("totalSteps"),
            "restingHr": s.get("restingHeartRate"),
            "stressAvg": s.get("averageStressLevel"),
            "bbHigh": s.get("bodyBatteryHighestValue"),
            "bbLow": s.get("bodyBatteryLowestValue"),
            "bbCharged": s.get("bodyBatteryChargedValue"),
            "bbDrained": s.get("bodyBatteryDrainedValue"),
            "bbWake": s.get("bodyBatteryAtWakeTime"),
            "intensityMin": (s.get("moderateIntensityMinutes") or 0) + 2 * (s.get("vigorousIntensityMinutes") or 0) if s.get("moderateIntensityMinutes") is not None else None,
            "activeKcal": s.get("activeKilocalories"),
            "spo2": s.get("averageSpo2"),
            "respiration": s.get("avgWakingRespirationValue"),
        })
    if not summ:  # 범위 요약이 막힌 경우 최근 7일만 하루씩
        for i in range(7):
            d = iso(today - dt.timedelta(days=i))
            s = safe(g.get_user_summary, d) or {}
            merge_daily(daily, d, {"restingHr": s.get("restingHeartRate"), "stressAvg": s.get("averageStressLevel"),
                                   "bbHigh": s.get("bodyBatteryHighestValue"), "bbLow": s.get("bodyBatteryLowestValue"),
                                   "steps": s.get("totalSteps")})

    # 수면 상세 (하루 단위)
    sleep_days = REFRESH_DAYS + 1 if incremental else SLEEP_DETAIL_DAYS
    for i in range(sleep_days):
        d = iso(today - dt.timedelta(days=i))
        raw = safe(g.get_sleep_data, d)
        if raw:
            merge_daily(daily, d, sleep_from(raw))

    # HRV
    hrv = safe(g.get_hrv_data_range, iso(well_start), iso(today))
    for d, h in dated(hrv).items():
        merge_daily(daily, d, {"hrv": h.get("lastNightAvg"), "hrvWeekly": h.get("weeklyAvg"), "hrvStatus": h.get("status"),
                               "hrvBalancedLow": find(h, "balancedLow"), "hrvBalancedHigh": find(h, "balancedUpper")})

    # 트레이닝 레디니스 (하루에 여러 번 계산될 수 있어 가장 늦은 값)
    tr = safe(g.get_training_readiness_range, iso(well_start), iso(today)) or []
    best = {}
    for e in tr if isinstance(tr, list) else []:
        d = (e.get("calendarDate") or "")[:10]
        if d and (d not in best or (e.get("timestamp") or "") >= (best[d].get("timestamp") or "")):
            best[d] = e
    for d, e in best.items():
        merge_daily(daily, d, {"readiness": e.get("score"), "readinessLevel": e.get("level"),
                               "readinessFeedback": e.get("feedbackShort"), "recoveryHours": num(e.get("recoveryTime"), 1 / 60, 0)})

    # 체성분
    comp = safe(g.get_body_composition, iso(well_start), iso(today))
    for d, w in dated(comp).items():
        if w.get("weight") is None:
            continue
        weight = w["weight"] / 1000 if w["weight"] > 1000 else w["weight"]
        muscle = w.get("muscleMass")
        merge_daily(daily, d, {"weightKg": round(weight, 1), "bodyFat": num(w.get("bodyFat")), "bmi": num(w.get("bmi")),
                               "muscleKg": round(muscle / 1000 if muscle and muscle > 1000 else muscle, 1) if muscle else None})

    # VO2max 추이
    mm = safe(g.get_max_metrics_range, iso(well_start), iso(today))
    for d, m in dated(mm).items():
        v = find(m, "vo2MaxPreciseValue", "vo2MaxValue")
        if v:
            merge_daily(daily, d, {"vo2max": num(v)})

    # 3) 현재 상태·능력 (매번 최신값)
    profile = dict(prev.get("profile", {}))
    ts = safe(g.get_training_status, iso(today))
    if ts:
        profile.update(clean({
            "trainingStatus": find(ts, "trainingStatusFeedbackPhrase", "trainingStatus"),
            "acuteLoad": find(ts, "dailyTrainingLoadAcute"),
            "chronicLoad": find(ts, "dailyTrainingLoadChronic"),
            "acwr": num(find(ts, "dailyAcuteChronicWorkloadRatio", "acwrPercent"), 1, 2),
            "acwrStatus": find(ts, "acwrStatus"),
            "loadBalance": find(ts, "trainingBalanceFeedbackPhrase"),
            "vo2max": num(find(ts, "vo2MaxPreciseValue", "vo2MaxValue")),
        }))
    rp = safe(g.get_race_predictions)
    if rp:
        profile["racePredictions"] = clean({k: find(rp, k) for k in ("time5K", "time10K", "timeHalfMarathon", "timeMarathon")})
    lt = safe(g.get_lactate_threshold)
    if lt:
        speed = find(lt, "speed")
        profile.update(clean({"ltHr": find(lt, "heartRate"),
                              # 가민 젖산 역치 속도: m/s(또는 0.1 단위)로 올 수 있음 → 초/km
                              "ltPaceSec": round(1000 / (speed * 10 if speed and speed < 1 else speed)) if speed else None}))
    es = safe(g.get_endurance_score, iso(today - dt.timedelta(days=28)), iso(today))
    if es:
        profile["enduranceScore"] = find(es, "overallScore")
        profile["enduranceClass"] = find(es, "classification")
    hs = safe(g.get_hill_score, iso(today - dt.timedelta(days=28)), iso(today))
    if hs:
        profile["hillScore"] = find(hs, "overallScore")
    fa = safe(g.get_fitnessage_data, iso(today))
    if fa:
        profile.update(clean({"fitnessAge": num(find(fa, "fitnessAge")), "age": find(fa, "chronologicalAge")}))
    zones = safe(g.get_heart_rate_zones)
    if zones:
        profile.update(clean({"hrMax": find(zones, "maxHeartRateUsed"), "hrRest": find(zones, "restingHeartRateUsed"),
                              "ltHrZones": find(zones, "lactateThresholdHeartRateUsed")}))
    orm = safe(g.get_one_rep_max)
    if orm:
        items = orm if isinstance(orm, list) else find(orm, "oneRepMaxList", "exercises", default=[]) or []
        profile["oneRepMax"] = [clean({"exercise": find(x, "exerciseType", "exerciseName", "category"),
                                       "kg": num((lambda v: v / 1000 if v and v > 1000 else v)(find(x, "oneRepMax", "value", "weight")))})
                                for x in items if isinstance(x, dict)][:20]
    rhr = [v.get("restingHr") for d, v in sorted(daily.items())[-7:] if v.get("restingHr")]
    vo2 = profile.get("vo2max") or next((v["vo2max"] for d, v in sorted(daily.items(), reverse=True) if v.get("vo2max")), None) \
        or next((r["vo2max"] for r in sorted(runs.values(), key=lambda r: r["start"], reverse=True) if r.get("vo2max")), None)

    # 오래된 하루 지표는 1년까지만 보관
    cutoff = iso(today - dt.timedelta(days=365))
    daily = {d: v for d, v in daily.items() if d >= cutoff}
    return {
        "runs": sorted(runs.values(), key=lambda r: r["start"]),
        "activities": sorted(others.values(), key=lambda a: a.get("start", "")),
        "daily": dict(sorted(daily.items())),
        "profile": clean(profile),
        "restingHr": round(sum(rhr) / len(rhr)) if rhr else prev.get("restingHr"),
        "vo2max": vo2,
        "syncedThrough": iso(today),
    }


# ---------- 암호화 ----------
def _key(passphrase, salt, iterations=ITERATIONS):
    return PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations).derive(passphrase.encode())


def encrypt(obj, passphrase):
    salt = os.urandom(16)
    iv = os.urandom(12)
    ct = AESGCM(_key(passphrase, salt)).encrypt(iv, json.dumps(obj, ensure_ascii=False).encode(), None)
    b64 = lambda b: base64.b64encode(b).decode()
    return {"v": 1, "kdf": "PBKDF2-SHA256", "iter": ITERATIONS, "salt": b64(salt), "iv": b64(iv), "ct": b64(ct)}


def decrypt(payload, passphrase):
    b = lambda s: base64.b64decode(s)
    key = _key(passphrase, b(payload["salt"]), payload.get("iter", ITERATIONS))
    return json.loads(AESGCM(key).decrypt(b(payload["iv"]), b(payload["ct"]), None))


def content_hash(data):
    stable = {k: v for k, v in data.items() if k != "syncedThrough"}
    return hashlib.sha256(json.dumps(stable, sort_keys=True).encode()).hexdigest()[:16]


def load_previous(passphrase):
    if not OUT.exists():
        return None
    try:
        return decrypt(json.loads(OUT.read_text()), passphrase)
    except Exception as e:
        print(f"이전 데이터를 읽지 못해 전체를 다시 가져옵니다: {e}", file=sys.stderr)
        return None


def main():
    args = sys.argv[1:]
    if "--export-tokens" in args:
        g = login(prompt_mfa=lambda: input("가민 2단계 인증 코드: "))
        print(g.client.dumps())
        return

    passphrase = os.environ.get("DATA_PASSPHRASE")
    has_login = (os.environ.get("GARMIN_EMAIL") and os.environ.get("GARMIN_PASSWORD")) or os.environ.get("GARMIN_TOKENS")
    if not passphrase or ("--mock" not in args and not has_login):
        # 비밀값을 아직 등록하지 않은 경우: 실패 알림이 반복되지 않도록 건너뛰고 정상 종료
        print("가민 비밀값(GARMIN_EMAIL/GARMIN_PASSWORD, DATA_PASSPHRASE)이 없어 동기화를 건너뜁니다. "
              "앱의 '가민 파일 가져오기'를 쓰거나 README의 설정 방법을 따라 비밀값을 등록하세요.")
        return

    if "--mock" in args:
        acts = json.loads(Path(args[args.index("--mock") + 1]).read_text())
        data = {"runs": sorted([normalize(a) for a in acts if is_run(a)], key=lambda r: r["start"]), "restingHr": 55, "vo2max": 50}
    else:
        data = fetch(login(), load_previous(passphrase))

    # 내용이 같으면 파일을 바꾸지 않음 (불필요한 커밋 방지)
    h = content_hash(data)
    if OUT.exists():
        try:
            if json.loads(OUT.read_text()).get("hash") == h:
                print("변경 없음")
                return
        except Exception:
            pass

    payload = {**data, "updated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
    out = encrypt(payload, passphrase)
    out["hash"] = h
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out))
    print(f"러닝 {len(data['runs'])}개, 기타 활동 {len(data.get('activities', []))}개, "
          f"하루 지표 {len(data.get('daily', {}))}일 저장 → {OUT}")


if __name__ == "__main__":
    main()
