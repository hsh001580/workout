// MediaPipe Pose Landmarker로 영상 프레임별 관절 좌표 추출 (브라우저 내 처리)
const VERSION = '0.10.14';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';

let landmarkerPromise = null;

async function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const { FilesetResolver, PoseLandmarker } = await import(/* webpackIgnore: true */ CDN);
      const fileset = await FilesetResolver.forVisionTasks(`${CDN}/wasm`);
      const make = (delegate) => PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
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

function seek(video, t) {
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
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
}

// fps: 분석 샘플링 속도. 최대 60초까지 분석
export async function extractFrames(video, onProgress, fps = 15) {
  onProgress?.(0, '포즈 인식 모델 불러오는 중…');
  const lm = await getLandmarker();
  const duration = Math.min(video.duration, 60);
  const frames = [];
  const step = 1 / fps;
  let ts = 0;
  for (let t = 0; t <= duration; t += step) {
    await seek(video, t);
    ts += step * 1000; // 단조 증가 타임스탬프
    const res = lm.detectForVideo(video, ts);
    const pose = res.landmarks?.[0];
    if (pose) frames.push({ t, lm: pose.map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility })) });
    onProgress?.(t / duration, `프레임 분석 중… ${Math.round((t / duration) * 100)}%`);
  }
  onProgress?.(1, '분석 완료');
  return frames;
}

const BONES = [['shoulder', 'elbow'], ['elbow', 'wrist'], ['shoulder', 'hip'], ['hip', 'knee'], ['knee', 'ankle'], ['ankle', 'toe']];

// 핵심 프레임에 측면 골격 그리기
export async function drawKeyFrame(video, canvas, pts, frameIdx, aspect, label) {
  const f = pts[frameIdx];
  if (!f) return;
  await seek(video, f.t);
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const X = (p) => (p.x / aspect) * canvas.width;
  const Y = (p) => p.y * canvas.height;
  const w = Math.max(3, canvas.width / 150);
  ctx.lineWidth = w;
  ctx.strokeStyle = '#22d3ee';
  for (const [a, b] of BONES) {
    ctx.beginPath();
    ctx.moveTo(X(f.p[a]), Y(f.p[a]));
    ctx.lineTo(X(f.p[b]), Y(f.p[b]));
    ctx.stroke();
  }
  ctx.fillStyle = '#f472b6';
  for (const p of Object.values(f.p)) {
    ctx.beginPath();
    ctx.arc(X(p), Y(p), w * 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  // 무릎 높이 기준선 (스쿼트 깊이 확인용)
  ctx.setLineDash([w * 2, w * 2]);
  ctx.strokeStyle = '#facc15';
  ctx.beginPath();
  ctx.moveTo(0, Y(f.p.knee));
  ctx.lineTo(canvas.width, Y(f.p.knee));
  ctx.stroke();
  ctx.setLineDash([]);
  if (label) {
    ctx.font = `${Math.round(canvas.width / 22)}px sans-serif`;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, canvas.width, canvas.width / 14);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, canvas.width / 40, canvas.width / 19);
  }
}
