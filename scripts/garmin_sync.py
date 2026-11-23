#!/usr/bin/env python3
"""가민 커넥트에서 러닝 기록을 가져와 암호화된 JSON(data/garmin.enc.json)으로 저장.

환경변수
  GARMIN_EMAIL, GARMIN_PASSWORD  가민 계정 (GitHub Secrets)
  GARMIN_TOKENS                  (선택) 2단계 인증 계정용 토큰 JSON. `--export-tokens`로 생성
  DATA_PASSPHRASE                앱에서 입력할 복호화 비밀번호 (GitHub Secrets)
  GARMIN_TOKEN_DIR               토큰 캐시 폴더 (기본 ~/.garminconnect)
  SYNC_DAYS                      가져올 기간 (기본 180일)

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


def safe(fn, *args):
    try:
        return fn(*args)
    except Exception as e:  # 부가 지표는 실패해도 동기화 계속
        print(f"warn: {getattr(fn, '__name__', fn)} 실패: {e}", file=sys.stderr)
        return None


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
    }


def fetch(g):
    today = dt.date.today()
    start = today - dt.timedelta(days=DAYS)
    acts = g.get_activities_by_date(start.isoformat(), today.isoformat()) or []
    runs = [normalize(a) for a in acts if is_run(a)]

    resting = []
    for i in range(7):
        s = safe(g.get_user_summary, (today - dt.timedelta(days=i)).isoformat()) or {}
        if s.get("restingHeartRate"):
            resting.append(s["restingHeartRate"])

    vo2 = None
    mm = safe(g.get_max_metrics, today.isoformat())
    if isinstance(mm, list) and mm:
        mm = mm[0]
    if isinstance(mm, dict):
        vo2 = (mm.get("generic") or {}).get("vo2MaxPreciseValue") or (mm.get("generic") or {}).get("vo2MaxValue")
    if not vo2:
        vo2 = next((r["vo2max"] for r in sorted(runs, key=lambda r: r["start"], reverse=True) if r.get("vo2max")), None)

    return {
        "runs": sorted(runs, key=lambda r: r["start"]),
        "restingHr": round(sum(resting) / len(resting)) if resting else None,
        "vo2max": vo2,
    }


def encrypt(obj, passphrase):
    salt = os.urandom(16)
    iv = os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERATIONS).derive(passphrase.encode())
    ct = AESGCM(key).encrypt(iv, json.dumps(obj, ensure_ascii=False).encode(), None)
    b64 = lambda b: base64.b64encode(b).decode()
    return {"v": 1, "kdf": "PBKDF2-SHA256", "iter": ITERATIONS, "salt": b64(salt), "iv": b64(iv), "ct": b64(ct)}


def content_hash(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()[:16]


def main():
    args = sys.argv[1:]
    if "--export-tokens" in args:
        g = login(prompt_mfa=lambda: input("가민 2단계 인증 코드: "))
        print(g.client.dumps())
        return

    passphrase = os.environ.get("DATA_PASSPHRASE")
    if not passphrase:
        sys.exit("DATA_PASSPHRASE가 설정되지 않았습니다.")

    if "--mock" in args:
        acts = json.loads(Path(args[args.index("--mock") + 1]).read_text())
        data = {"runs": sorted([normalize(a) for a in acts if is_run(a)], key=lambda r: r["start"]), "restingHr": 55, "vo2max": 50}
    else:
        data = fetch(login())

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
    print(f"러닝 {len(data['runs'])}개 저장 → {OUT}")


if __name__ == "__main__":
    main()
