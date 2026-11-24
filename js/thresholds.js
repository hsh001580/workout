// 자세 판정 기준값과 코칭 스타일 프리셋
// 각 값은 '경고(warn)'와 '감점(bad)' 경계. 사용자 기준으로 덮어쓸 수 있다.

export const THRESHOLD_META = {
  // 측면(시상면)
  squatDepthWarn: { label: '스쿼트 깊이 경고 (깊이비, 0=패러렐)', group: '측면' },
  torsoHighWarn: { label: '하이바 스쿼트 상체각 경고 (°)', group: '측면' },
  torsoHighBad: { label: '하이바 스쿼트 상체각 감점 (°)', group: '측면' },
  torsoLowWarn: { label: '로우바 스쿼트 상체각 경고 (°)', group: '측면' },
  torsoLowBad: { label: '로우바 스쿼트 상체각 감점 (°)', group: '측면' },
  dlBackShiftConv: { label: '컨벤셔널 데드 초반 등 각도 무너짐 (°)', group: '측면' },
  dlBackShiftSumo: { label: '스모 데드 초반 등 각도 무너짐 (°)', group: '측면' },
  downwardTol: { label: '상승 중 하강 판정 (반복 폭 대비)', group: '규정' },
  benchElbowAbove: { label: '벤치 팔꿈치 깊이: 어깨보다 높은 허용치 (몸통 대비)', group: '규정' },
  consistencyPct: { label: '회차 간 편차 경고 (%)', group: '일관성' },
  hipShootDeg: { label: '엉덩이 먼저 뜨기: 상체 증가 (°)', group: '측면' },
  benchLockout: { label: '벤치 락아웃 최소 팔꿈치 각 (°)', group: '측면' },
  benchPauseRequired: { label: '벤치 퍼즈 필수 (1=예, 0=아니오)', group: '측면' },
  ohpLaybackWarn: { label: 'OHP 상체 젖힘 경고 (°)', group: '측면' },
  ohpLaybackBad: { label: 'OHP 상체 젖힘 감점 (°)', group: '측면' },
  lockoutAngle: { label: '데드/OHP 락아웃 최소 각 (°)', group: '측면' },
  // 바벨
  midfootWarnCm: { label: '바-미드풋 편차 경고 (cm)', group: '바벨' },
  midfootBadCm: { label: '바-미드풋 편차 감점 (cm)', group: '바벨' },
  hipMomentRisePct: { label: '상승 중 고관절 모멘트암 증가 경고 (%)', group: '바벨' },
  velocityLossWarn: { label: '세트 내 속도 손실 경고 (%)', group: '바벨' },
  // 정면/3D
  valgusWarn: { label: '무릎 밸거스 경고 (° FPPA 변화)', group: '정면·3D' },
  valgusBad: { label: '무릎 밸거스 감점 (°)', group: '정면·3D' },
  kneeToeWarn: { label: '무릎-발끝 방향 차이 경고 (°)', group: '정면·3D' },
  hipShiftWarnCm: { label: '힙 시프트 경고 (cm)', group: '정면·3D' },
  hipShiftBadCm: { label: '힙 시프트 감점 (cm)', group: '정면·3D' },
  pelvisTiltCm: { label: '골반 좌우 높이차 경고 (cm)', group: '정면·3D' },
  trunkRotWarn: { label: '몸통 회전 경고 (°)', group: '정면·3D' },
  depthAsymWarn: { label: '좌우 무릎 굴곡 차이 경고 (°)', group: '정면·3D' },
  heelLiftCm: { label: '뒤꿈치 들림 경고 (cm)', group: '정면·3D' },
  barTiltCm: { label: '바벨 좌우 높이차 경고 (cm)', group: '정면·3D' },
  elbowFlareMax: { label: '벤치 팔꿈치 벌어짐 최대 (°)', group: '정면·3D' },
  lateralLeanWarn: { label: 'OHP 몸통 옆 기울기 경고 (°)', group: '정면·3D' },
  // 브레이싱
  trunkShrinkPct: { label: '몸통 길이 감소 경고 (%)', group: '브레이싱' },
  rebraceSec: { label: '반복 사이 재브레이싱 최소 시간 (초)', group: '브레이싱' },
  torsoJerkDeg: { label: '상체 순간 무너짐 (°/0.2초)', group: '브레이싱' },
  kneeDipDeg: { label: 'OHP 무릎 반동 (시작 대비 굽힘 °)', group: '측면' },
};

const BASE = {
  squatDepthWarn: -0.12,
  // 스쿼트 상체각: 바 위치(스타일)별. 로우바는 원래 더 숙여짐 (연구: 로우바 > 하이바 > SSB)
  torsoHighWarn: 45,
  torsoHighBad: 55,
  torsoLowWarn: 58,
  torsoLowBad: 68,
  torsoLeanWarn: 52, // 스타일 미확인
  torsoLeanBad: 62,
  dlBackShiftConv: 12,
  dlBackShiftSumo: 8,
  downwardTol: 0.06,
  benchElbowAbove: 0.12,
  consistencyPct: 8,
  hipShootDeg: 10,
  benchLockout: 155,
  benchPauseRequired: 0,
  ohpLaybackWarn: 12,
  ohpLaybackBad: 20,
  lockoutAngle: 160,
  midfootWarnCm: 5,
  midfootBadCm: 8,
  hipMomentRisePct: 15,
  velocityLossWarn: 25,
  // 무릎 밸거스: 고중량 상승 구간에서 흔하고 건강한 리프터의 부상 위험과의 연관 근거가 약해 완화 (통증 시 별도 처리)
  valgusWarn: 12,
  valgusBad: 20,
  kneeToeWarn: 15,
  hipShiftWarnCm: 3,
  hipShiftBadCm: 5,
  pelvisTiltCm: 3,
  trunkRotWarn: 10,
  depthAsymWarn: 10,
  heelLiftCm: 1.5,
  barTiltCm: 3,
  elbowFlareMax: 80,
  lateralLeanWarn: 6,
  trunkShrinkPct: 6,
  rebraceSec: 0.4,
  kneeDipDeg: 10,
  torsoJerkDeg: 6,
};

export const PRESETS = {
  balanced: { name: '현역 기준 (기본)', desc: 'IPF 규정 판정 + 효율·일관성 중심. 무릎 밸거스는 큰 경우만 지적', values: {} },
  meet: {
    name: '대회 직전 (엄격)',
    desc: '심판 기준에 여유 없이: 깊이 여유 없음, 벤치 퍼즈 필수, 락아웃 엄격',
    values: { squatDepthWarn: 0, benchPauseRequired: 1, benchLockout: 165, lockoutAngle: 168, midfootWarnCm: 4, midfootBadCm: 7, benchElbowAbove: 0.08 },
  },
  kneeStrict: {
    name: '무릎 보수적 (재활·통증 이력)',
    desc: '무릎 통증·불안정 이력이 있을 때: 밸거스와 무릎-발끝 정렬을 엄격하게',
    values: { valgusWarn: 8, valgusBad: 15, kneeToeWarn: 12 },
  },
  tolerant: {
    name: '관대한 무릎 기준',
    desc: '상승 중 무릎 움직임을 더 넓게 허용',
    values: { valgusWarn: 15, valgusBad: 25, kneeToeWarn: 20 },
  },
};

export function getThresholds(settings = {}) {
  const preset = PRESETS[settings.formPreset] || PRESETS.balanced;
  return { ...BASE, ...preset.values, ...(settings.customThresholds || {}) };
}

export const DEFAULT_THRESHOLDS = BASE;
