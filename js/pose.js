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

// 핵심 프레임에 골격 + 바벨 궤적 그리기
export async function drawKeyFrame(video, canvas, frame, label, barPath = null) {
  if (!frame) return;
  await seek(video, frame.t);
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const X = (p) => p.x * canvas.width;
  const Y = (p) => p.y * canvas.height;
  const w = Math.max(3, canvas.width / 150);
  ctx.lineWidth = w;
  for (const [a, b] of BONES) {
    const pa = frame.lm[a];
    const pb = frame.lm[b];
    if ((pa.visibility ?? 1) < 0.3 || (pb.visibility ?? 1) < 0.3) continue;
    ctx.strokeStyle = a % 2 === 1 && b % 2 === 1 ? '#22d3ee' : a % 2 === 0 && b % 2 === 0 ? '#f472b6' : '#e2e8f0';
    ctx.beginPath();
    ctx.moveTo(X(pa), Y(pa));
    ctx.lineTo(X(pb), Y(pb));
    ctx.stroke();
  }
  // 바벨 궤적 (정규화 좌표: 영상 높이 기준)
  if (barPath?.length) {
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = w * 0.8;
    ctx.beginPath();
    barPath.forEach((b, i) => {
      const x = b.x * canvas.height;
      const y = b.y * canvas.height;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.stroke();
    const cur = barPath.reduce((a, b) => (Math.abs(b.t - frame.t) < Math.abs(a.t - frame.t) ? b : a), barPath[0]);
    ctx.fillStyle = '#facc15';
    ctx.beginPath();
    ctx.arc(cur.x * canvas.height, cur.y * canvas.height, w * 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  if (label) {
    ctx.font = `${Math.round(canvas.width / 22)}px sans-serif`;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, canvas.width, canvas.width / 14);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, canvas.width / 40, canvas.width / 19);
  }
}
