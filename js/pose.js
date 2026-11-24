// MediaPipe Pose Landmarker로 영상 프레임별 관절 좌표(2D + 3D) 추출 + 원판 추적 (브라우저 내 처리)
import { toGray, createTracker } from './bar-track.js';
import { backCurve } from './back-curve.js';

const VERSION = '0.10.14';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

let landmarkerPromise = null;
// MediaPipe VIDEO 모드는 같은 인스턴스에서 타임스탬프가 항상 증가해야 한다.
// 평가할 때마다 0부터 다시 세면 두 번째 평가부터 'timestamp mismatch'로 실패하므로 평가 간에 이어서 증가시킨다.
let lastTs = 0;

async function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const { FilesetResolver, PoseLandmarker } = await import(/* webpackIgnore: true */ CDN);
      const fileset = await FilesetResolver.forVisionTasks(`${CDN}/wasm`);
      const make = (delegate) => PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
        outputSegmentationMasks: true, // 등 윤곽선(척추 굽힘) 측정용
      });
      try {
        return await make('GPU');
      } catch {
        return await make('CPU');
      }
    })();
    landmarkerPromise.catch(() => { landmarkerPromise = null; });
  }
  return landmarkerPromise;
}

export function seek(video, t) {
  return new Promise((resolve) => {
    // 이미 그 위치면 'seeked' 이벤트가 오지 않는 브라우저가 있어 바로 끝냄
    if (Math.abs(video.currentTime - t) < 1e-3 && video.readyState >= 2) { resolve(); return; }
    let timer = null;
    const done = () => { clearTimeout(timer); video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    timer = setTimeout(done, 3000); // 이벤트가 끝내 안 오면 멈추지 않도록
    video.currentTime = t;
  });
}

export async function loadVideo(video, file) {
  if (video.src) URL.revokeObjectURL(video.src);
  video.src = URL.createObjectURL(file);
  await new Promise((resolve, reject) => {
    video.onloadeddata = resolve;
    video.onerror = () => reject(new Error('영상을 열 수 없습니다.'));
  });
  await seek(video, 0);
}

/**
 * @param plate { cx, cy, rPx } 첫 프레임에서 탭한 원판 중심·반지름 (영상 픽셀). 없으면 바벨 추적 안 함
 * @returns { frames: [{t, lm, world}], bar: [{t, x, y, lost}] | null }
 */
export async function extractFrames(video, onProgress, { fps = 15, plate = null } = {}) {
  onProgress?.(0, '포즈 인식 모델 불러오는 중…');
  const lm = await getLandmarker();
  const duration = Math.min(video.duration, 60);
  const frames = [];
  const step = 1 / fps;
  const H = video.videoHeight;

  // 원판 추적용 축소 캔버스 (원판 반지름이 약 28px이 되도록)
  let tracker = null;
  let ctx = null;
  let ds = 1;
  let cw = 0;
  let ch = 0;
  const bar = plate ? [] : null;
  if (plate) {
    ds = Math.min(1, 28 / plate.rPx);
    cw = Math.round(video.videoWidth * ds);
    ch = Math.round(H * ds);
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    ctx = c.getContext('2d', { willReadFrequently: true });
  }
  const grab = () => {
    ctx.drawImage(video, 0, 0, cw, ch);
    return toGray(ctx.getImageData(0, 0, cw, ch).data, cw, ch);
  };

  let ts = lastTs;
  for (let t = 0; t <= duration; t += step) {
    await seek(video, t);
    ts += step * 1000; // 단조 증가 타임스탬프
    lastTs = ts; // 중간에 실패해도 다음 평가가 이어서 증가하도록 매 프레임 기록
    const res = lm.detectForVideo(video, ts);
    const pose = res.landmarks?.[0];
    const world = res.worldLandmarks?.[0];
    if (pose) {
      frames.push({
        t,
        lm: pose.map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility })),
        world: world ? world.map((p) => ({ x: p.x, y: p.y, z: p.z })) : null,
        back: backFromMask(res.segmentationMasks?.[0], pose),
      });
    }
    res.segmentationMasks?.forEach((m) => m.close?.());
    if (plate) {
      const g = grab();
      if (!tracker) {
        tracker = createTracker(g, cw, ch, plate.cx * ds, plate.cy * ds, plate.rPx * ds);
        bar.push({ t, x: plate.cx / H, y: plate.cy / H, lost: false });
      } else {
        const r = tracker.update(g);
        bar.push({ t, x: r.x / ds / H, y: r.y / ds / H, lost: r.lost });
      }
    }
    onProgress?.(t / duration, `프레임 분석 중… ${Math.round((t / duration) * 100)}%`);
  }
  lastTs = ts;
  onProgress?.(1, '분석 완료');
  return { frames, bar };
}

// 실루엣 마스크에서 잘 보이는 쪽 엉덩이→어깨 기준 등 윤곽 굽힘
function backFromMask(mask, pose) {
  if (!mask) return null;
  try {
    const w = mask.width;
    const h = mask.height;
    const data = mask.getAsFloat32Array();
    const side = (pose[11].visibility + pose[23].visibility) >= (pose[12].visibility + pose[24].visibility) ? [11, 23, 27, 31] : [12, 24, 28, 32];
    const P = (i) => ({ x: pose[i].x * w, y: pose[i].y * h });
    const facing = Math.sign(pose[side[3]].x - pose[side[2]].x) || 1;
    const c = backCurve(data, w, h, P(side[1]), P(side[0]), facing);
    return c ? { lumbar: c.lumbar, thoracic: c.thoracic } : null;
  } catch {
    return null;
  }
}

const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28], [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32]];

// 분석된 프레임(초당 15장) 사이 시각의 관절 위치를 선형 보간
export function interpFrame(frames, t) {
  if (!frames?.length) return null;
  let lo = 0;
  let hi = frames.length - 1;
  if (t <= frames[0].t) return frames[0];
  if (t >= frames[hi].t) return frames[hi];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = frames[lo];
  const b = frames[hi];
  const k = (t - a.t) / (b.t - a.t || 1);
  if (b.t - a.t > 0.5) return k < 0.5 ? a : b; // 인식이 끊긴 구간은 보간하지 않음
  return {
    t,
    lm: a.lm.map((p, i) => ({ x: p.x + (b.lm[i].x - p.x) * k, y: p.y + (b.lm[i].y - p.y) * k, visibility: Math.min(p.visibility ?? 1, b.lm[i].visibility ?? 1) })),
  };
}

function jointAngle(a, b, c) {
  const v1 = [a.x - b.x, a.y - b.y];
  const v2 = [c.x - b.x, c.y - b.y];
  const d = Math.hypot(...v1) * Math.hypot(...v2);
  return d ? (Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / d))) * 180) / Math.PI : NaN;
}

/**
 * 캔버스에 골격 + 바벨 궤적 + 회차 표시 (탐색 없이 즉시)
 * @param opts { barPath, label, angles: true면 잘 보이는 쪽 무릎각·상체각 표시 }
 */
export function drawOverlay(canvas, video, frame, opts = {}) {
  if (!frame) return;
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  const P = (i) => ({ x: frame.lm[i].x * W, y: frame.lm[i].y * H, v: frame.lm[i].visibility ?? 1 });
  const w = Math.max(3, W / 150);
  ctx.lineCap = 'round';
  for (const [a, b] of BONES) {
    const pa = P(a);
    const pb = P(b);
    if (pa.v < 0.3 || pb.v < 0.3) continue;
    ctx.globalAlpha = Math.min(pa.v, pb.v) < 0.5 ? 0.35 : 0.95; // 가려진 관절은 흐리게
    ctx.lineWidth = w;
    ctx.strokeStyle = a % 2 === 1 && b % 2 === 1 ? '#22d3ee' : a % 2 === 0 && b % 2 === 0 ? '#f472b6' : '#e2e8f0';
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const i of [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    const q = P(i);
    if (q.v < 0.3) continue;
    ctx.fillStyle = q.v < 0.5 ? 'rgba(255,255,255,0.4)' : '#ffffff';
    ctx.beginPath();
    ctx.arc(q.x, q.y, w * 1.1, 0, Math.PI * 2);
    ctx.fill();
  }
  // 바벨 궤적: 전체는 흐리게, 현재 위치 강조 (정규화 좌표: 영상 높이 기준)
  const bp = opts.barPath;
  if (bp?.length) {
    ctx.lineWidth = w * 0.7;
    ctx.strokeStyle = 'rgba(250,204,21,0.45)';
    ctx.beginPath();
    bp.forEach((b, i) => { const x = b.x * H; const y = b.y * H; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke();
    const recent = bp.filter((b) => b.t <= frame.t && b.t >= frame.t - 1);
    if (recent.length > 1) {
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = w;
      ctx.beginPath();
      recent.forEach((b, i) => { const x = b.x * H; const y = b.y * H; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke();
    }
    const cur = bp.reduce((a, b) => (Math.abs(b.t - frame.t) < Math.abs(a.t - frame.t) ? b : a), bp[0]);
    ctx.fillStyle = '#facc15';
    ctx.beginPath();
    ctx.arc(cur.x * H, cur.y * H, w * 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // 잘 보이는 쪽 무릎각·고관절각
  const font = Math.round(W / 26);
  const tag = (txt, x, y) => {
    ctx.font = `bold ${font}px sans-serif`;
    const tw = ctx.measureText(txt).width;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x + w * 2, y - font, tw + font * 0.5, font * 1.3);
    ctx.fillStyle = '#fff';
    ctx.fillText(txt, x + w * 2 + font * 0.25, y);
  };
  if (opts.angles) {
    const side = P(23).v + P(25).v >= P(24).v + P(26).v ? [11, 23, 25, 27] : [12, 24, 26, 28];
    const [sh, hp, kn, an] = side.map(P);
    if (Math.min(hp.v, kn.v, an.v) > 0.5) tag(`무릎 ${Math.round(jointAngle(hp, kn, an))}°`, kn.x, kn.y);
    if (Math.min(sh.v, hp.v, kn.v) > 0.5) tag(`고관절 ${Math.round(jointAngle(sh, hp, kn))}°`, hp.x, hp.y);
  }
  if (opts.label) {
    ctx.font = `bold ${Math.round(W / 20)}px sans-serif`;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, W, W / 13);
    ctx.fillStyle = '#fff';
    ctx.fillText(opts.label, W / 40, W / 18);
  }
}

// 핵심 프레임으로 이동해 그리기
export async function drawKeyFrame(video, canvas, frame, label, barPath = null) {
  if (!frame) return;
  await seek(video, frame.t);
  drawOverlay(canvas, video, frame, { label, barPath, angles: true });
}
