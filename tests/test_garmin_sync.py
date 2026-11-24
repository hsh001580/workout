"""garmin_sync.fetch() 테스트: 가짜 가민 클라이언트로 응답 형식별 추출·증분 동기화·실패 내성 확인.

실행: python -m unittest tests/test_garmin_sync.py   (cryptography 필요)
"""
import datetime as dt
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
import garmin_sync as gs  # noqa: E402

TODAY = dt.date.today()
D = lambda i: (TODAY - dt.timedelta(days=i)).isoformat()


class FakeGarmin:
    def __init__(self):
        self.calls = []

    def _c(self, name, *a):
        self.calls.append((name, a))

    def get_activities_by_date(self, s, e):
        self._c("acts", s, e)
        return [
            {"activityId": 1, "activityName": "Easy", "startTimeLocal": f"{D(2)} 07:00:00", "activityType": {"typeKey": "running"},
             "distance": 8000, "duration": 2900, "movingDuration": 2880, "averageHR": 142, "maxHR": 158, "trainingEffectLabel": "BASE"},
            {"activityId": 2, "activityName": "Gym", "startTimeLocal": f"{D(1)} 19:00:00", "activityType": {"typeKey": "strength_training"},
             "duration": 3600, "averageHR": 110, "calories": 300},
            {"activityId": 3, "activityName": "Ride", "startTimeLocal": f"{D(3)} 18:00:00", "activityType": {"typeKey": "cycling"},
             "distance": 20000, "duration": 3000, "averageHR": 130},
        ]

    def get_activity_exercise_sets(self, aid):
        self._c("sets", aid)
        return {"exerciseSets": [
            {"setType": "ACTIVE", "repetitionCount": 5, "weight": 100000.0, "exercises": [{"category": "BENCH_PRESS", "name": "BARBELL_BENCH_PRESS"}]},
            {"setType": "REST", "duration": 120},
            {"setType": "ACTIVE", "repetitionCount": 5, "weight": 102500.0, "exercises": [{"category": "BENCH_PRESS"}]},
        ]}

    def get_daily_summaries(self, s, e):
        return {"data": [{"calendarDate": D(i), "totalSteps": 8000 + i, "restingHeartRate": 50 + (i % 3), "averageStressLevel": 30,
                          "bodyBatteryHighestValue": 80, "bodyBatteryLowestValue": 20, "moderateIntensityMinutes": 20,
                          "vigorousIntensityMinutes": 10} for i in range(5)]}

    def get_sleep_data(self, d):
        return {"dailySleepDTO": {"calendarDate": d, "sleepTimeSeconds": 25200, "deepSleepSeconds": 5400, "remSleepSeconds": 6000,
                                  "avgSleepHRV": 55.0, "avgSpO2": 96.0, "sleepScores": {"overall": {"value": 82, "qualifierKey": "GOOD"}}},
                "bodyBatteryChange": 45}

    def get_hrv_data_range(self, s, e):
        return {"hrvSummaries": [{"calendarDate": D(i), "lastNightAvg": 60 - i, "weeklyAvg": 58, "status": "BALANCED",
                                  "baseline": {"balancedLow": 50, "balancedUpper": 66}} for i in range(5)]}

    def get_training_readiness_range(self, s, e):
        return [{"calendarDate": D(0), "timestamp": f"{D(0)}T05:00:00", "score": 40, "level": "LOW"},
                {"calendarDate": D(0), "timestamp": f"{D(0)}T07:00:00", "score": 72, "level": "HIGH", "recoveryTime": 600}]

    def get_body_composition(self, s, e):
        return {"dateWeightList": [{"calendarDate": D(1), "weight": 78450.0, "bodyFat": 16.2, "muscleMass": 36000.0, "bmi": 24.1}]}

    def get_max_metrics_range(self, s, e):
        return [{"calendarDate": D(4), "generic": {"vo2MaxPreciseValue": 51.3}}]

    def get_training_status(self, d):
        return {"mostRecentTrainingStatus": {"latestTrainingStatusData": {"123": {"trainingStatusFeedbackPhrase": "PRODUCTIVE_1",
                "acuteTrainingLoadDTO": {"dailyTrainingLoadAcute": 520, "dailyTrainingLoadChronic": 450, "dailyAcuteChronicWorkloadRatio": 1.16, "acwrStatus": "OPTIMAL"}}}},
                "mostRecentVO2Max": {"generic": {"vo2MaxPreciseValue": 51.5}}}

    def get_race_predictions(self):
        return {"time5K": 1250, "time10K": 2610, "timeHalfMarathon": 5800, "timeMarathon": 12300}

    def get_lactate_threshold(self):
        return {"speed_and_heart_rate": {"speed": 0.3333, "heartRate": 168}, "power": {}}

    def get_endurance_score(self, s, e):
        raise RuntimeError("403 not supported on this device")  # 실패해도 나머지는 계속

    def get_hill_score(self, s, e):
        return {"hillScoreDTOList": [{"overallScore": 55}]}

    def get_fitnessage_data(self, d):
        return {"chronologicalAge": 32, "fitnessAge": 28.4}

    def get_heart_rate_zones(self):
        return [{"sport": "DEFAULT", "maxHeartRateUsed": 192, "restingHeartRateUsed": 50, "lactateThresholdHeartRateUsed": 170}]

    def get_one_rep_max(self):
        return [{"exerciseType": "BENCH_PRESS", "oneRepMax": 115000.0}]


class FetchTest(unittest.TestCase):
    def test_full_fetch(self):
        g = FakeGarmin()
        data = gs.fetch(g)
        self.assertEqual([r["id"] for r in data["runs"]], [1])
        acts = {a["id"]: a for a in data["activities"]}
        self.assertEqual(set(acts), {2, 3})
        self.assertEqual(acts[2]["sets"], [
            {"exercise": "BARBELL_BENCH_PRESS", "category": "BENCH_PRESS", "reps": 5, "kg": 100.0},
            {"exercise": "BENCH_PRESS", "category": "BENCH_PRESS", "reps": 5, "kg": 102.5},
        ])
        today = data["daily"][D(0)]
        self.assertEqual(today["sleepScore"], 82)
        self.assertEqual(today["sleepHours"], 7.0)
        self.assertEqual(today["hrv"], 60)
        self.assertEqual(today["hrvStatus"], "BALANCED")
        self.assertEqual(today["readiness"], 72)  # 같은 날 가장 늦은 값
        self.assertEqual(today["intensityMin"], 40)
        self.assertEqual(data["daily"][D(1)]["weightKg"], 78.5)
        self.assertEqual(data["daily"][D(1)]["muscleKg"], 36.0)
        self.assertEqual(data["daily"][D(4)]["vo2max"], 51.3)
        p = data["profile"]
        self.assertEqual(p["trainingStatus"], "PRODUCTIVE_1")
        self.assertEqual(p["acwr"], 1.16)
        self.assertEqual(p["vo2max"], 51.5)
        self.assertEqual(p["racePredictions"]["time5K"], 1250)
        self.assertEqual(p["ltHr"], 168)
        self.assertEqual(p["ltPaceSec"], 300)  # 3.333 m/s = 5:00/km
        self.assertNotIn("enduranceScore", p)  # 실패한 항목은 빠짐
        self.assertEqual(p["hillScore"], 55)
        self.assertEqual(p["hrMax"], 192)
        self.assertEqual(p["oneRepMax"][0]["kg"], 115.0)
        self.assertEqual(data["vo2max"], 51.5)
        self.assertEqual(data["syncedThrough"], D(0))

    def test_incremental_keeps_history_and_sets(self):
        g = FakeGarmin()
        first = gs.fetch(g)
        first["daily"]["2000-01-01"] = {"steps": 1}  # 1년 넘은 기록은 정리
        first["daily"][D(40)] = {"sleepScore": 70}
        g2 = FakeGarmin()
        second = gs.fetch(g2, first)
        self.assertIn(D(40), second["daily"])
        self.assertNotIn("2000-01-01", second["daily"])
        self.assertFalse(any(c[0] == "sets" for c in g2.calls))  # 이미 가져온 세트는 다시 요청 안 함
        start = next(c[1][0] for c in g2.calls if c[0] == "acts")
        self.assertGreaterEqual(start, D(gs.REFRESH_DAYS))

    def test_encrypt_roundtrip_and_hash_ignores_sync_date(self):
        data = gs.fetch(FakeGarmin())
        self.assertEqual(gs.decrypt(gs.encrypt(data, "pw"), "pw"), data)
        self.assertEqual(gs.content_hash(data), gs.content_hash({**data, "syncedThrough": "1999-01-01"}))


if __name__ == "__main__":
    unittest.main()
