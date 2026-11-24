import { load, save, todayISO, uid, defaultState } from './storage.js';
import { buildWeek, weekIndex, sessionFor, fmtPace, fmtDuration, parseTime } from './program.js';
import { CHECKLIST, checklistScore, LIFT_LABEL } from './form-analysis.js';
import { evaluateForm, VIEWS } from './form-eval.js';
import { getThresholds, PRESETS, THRESHOLD_META } from './thresholds.js';
import { estimate1RM } from './bar-analysis.js';
import { evaluateRun, runStats, RUN_TYPES } from './run-analysis.js';
import { fetchGarmin, toRunLog } from './garmin.js';
import { importGarminFile, isSameRun } from './garmin-import.js';
import { liftE1rm, fatigueSignals, phaseAt, prescribe, LIFT_KO, garminCheckin, readinessOf } from './coach.js';

const state = load();
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const scoreClass = (s) => (s >= 85 ? 's-good' : s >= 65 ? 's-warn' : 's-bad');
const persist = () => save(state);
const gdata = () => state.garmin.data || { daily: {}, activities: [], profile: {} };
const stats = (date = new Date()) => {
  const s = runStats(state.runLogs, date, state.garmin.vo2max);
  const p = gdata().profile;
  // 가민 레이스 예측이 있으면 훈련 페이스 기준으로 사용 (VO2max 환산보다 개인화됨)
  if (s && p?.racePredictions?.time5K) { s.fiveKSec = p.racePredictions.time5K; s.vo2Source = '가민 레이스 예측'; }
  return s;
};
// 코칭 엔진 컨텍스트: 기록·자세·컨디션·러닝 부하로 처방을 만든다
const hardRunOn = (iso) => state.runLogs.some((r) => r.date === iso && ((r.result?.zone ?? 0) >= 4 || (r.result?.load ?? 0) > 150));
const coachCtx = () => ({ state, runAcwr: gdata().profile?.acwr ?? stats()?.acwr ?? null, hardRunOn });
const fmtDate = (d) => `${d.getMonth() + 1}/${d.getDate()}`;

function fbList(items) {
  return `<ul class="fb">${items.map((i) => `<li class="${i.level}">${esc(i.text)}</li>`).join('')}</ul>`;
}

// ---------- 탭 ----------
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  if (name === 'today') renderToday();
  if (name === 'program') renderWeek();
  if (name === 'run') renderGarminRuns();
  if (name === 'history') renderHistory();
  if (name === 'settings') fillSettings();
  window.scrollTo(0, 0);
}
function rerenderActive() {
  const active = document.querySelector('.tabs button.active')?.dataset.tab;
  if (active && active !== 'settings' && active !== 'form') showTab(active);
}

// ---------- 프로그램 ----------
let viewWeek = weekIndex(state.settings.startDate);
$('#prevWeek').addEventListener('click', () => { viewWeek = Math.max(0, viewWeek - 1); renderWeek(); });
$('#nextWeek').addEventListener('click', () => { viewWeek += 1; renderWeek(); });

function itemHTML(it, idKey) {
  const done = idKey && state.done[idKey];
  return `<div class="item ${it.type}">
    <div class="t">${esc(it.title)}</div>
    <div class="d">${esc(it.detail)}</div>
    ${it.pace ? `<div class="p">${esc(it.pace)}</div>` : ''}
    ${it.note ? `<div class="n">${esc(it.note)}</div>` : ''}
    ${it.e1rm ? `<div class="n">추정 1RM ${it.e1rm}kg 기준</div>` : ''}
    ${it.reasons?.length ? `<details class="why"><summary>왜 이렇게 처방했나요?</summary><ul>${it.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></details>` : ''}
    ${idKey ? `<label class="inline done-toggle"><input type="checkbox" data-done="${idKey}" ${done ? 'checked' : ''}/> 완료</label>` : ''}
  </div>`;
}

function bindDone(root) {
  root.querySelectorAll('[data-done]').forEach((c) => c.addEventListener('change', () => {
    if (c.checked) state.done[c.dataset.done] = true; else delete state.done[c.dataset.done];
    persist();
  }));
}

function runBasisText(w) {
  const s = w.stats;
  if (!s) return `러닝 기준: 설정값 (주 ${state.settings.weeklyKm}km, 5K ${esc(state.settings.fiveK)}) · 가민 연동 시 자동 조정`;
  return `가민 기준: 최근 4주 평균 ${s.avg4}km · 지난주 ${s.lastWeek}km → 이번 주 ${w.weeklyKm}km`
    + (s.vo2Source === '가민 레이스 예측' ? ` · 가민 5K 예측 ${fmtDuration(s.fiveKSec)} 기준 페이스${s.vo2 ? ` · VO2max ${s.vo2.toFixed(1)}` : ''}`
      : s.vo2 ? ` · ${esc(s.vo2Source)} ${s.vo2.toFixed(1)} (5K 환산 ${fmtDuration(s.fiveKSec)})` : '')
    + (s.acwr && s.acwr > 1.3 ? ' · 최근 부하 급증으로 거리 동결' : '');
}

function renderWeek() {
  const weekStart = new Date(state.settings.startDate + 'T00:00:00');
  weekStart.setDate(weekStart.getDate() + viewWeek * 7);
  const w = buildWeek(state.settings, viewWeek, stats(weekStart), coachCtx());
  $('#weekTitle').textContent = `${viewWeek + 1}주차 (${fmtDate(w.days[0].date)}~${fmtDate(w.days[6].date)})`;
  const e1 = (l) => Math.round(liftE1rm(l, state.formLogs, state.settings).e1rm);
  const note = state.coach?.deloadNotes?.[viewWeek];
  $('#weekMeta').innerHTML = `<b>${esc(w.wave.name)}</b> · 추정 1RM 스쿼트 ${e1('squat')} / 벤치 ${e1('bench')} / 데드 ${e1('deadlift')} / OHP ${e1('ohp')}kg`
    + `${note ? `<br>⚠ 자동 디로드 이유: ${esc(note.join(', '))}` : ''}<br>${runBasisText(w)}`;
  const today = todayISO();
  $('#weekGrid').innerHTML = w.days.map((d) => {
    const iso = todayISO(d.date);
    return `<div class="day ${d.rest ? 'rest' : ''} ${iso === today ? 'today' : ''}">
      <header><b>${d.name} <span class="muted">${fmtDate(d.date)}</span></b>
        <span class="badge rot-${d.rotation.key}">${esc(d.rotation.title)}</span></header>
      ${d.rest ? '<div class="muted">완전 휴식 · 가벼운 걷기·모빌리티</div>' : d.items.map((it, i) => itemHTML(it, `${iso}-${it.type}-${it.lift || it.runType || i}`)).join('')}
    </div>`;
  }).join('');
  bindDone($('#weekGrid'));
}

// ---------- 오늘 ----------
function renderToday() {
  const today = todayISO();
  const now = new Date();
  const s = sessionFor(state.settings, now, stats(), coachCtx());
  const wIdx = weekIndex(state.settings.startDate);
  const w = buildWeek(state.settings, wIdx, stats(), coachCtx());
  const lifts = s.items.filter((i) => i.type === 'lift');
  const runs = s.items.filter((i) => i.type === 'run');
  const formToday = state.formLogs.filter((l) => l.date === today);
  const runToday = state.runLogs.filter((l) => l.date === today);

  let todo = '';
  if (lifts.length) {
    const pending = lifts.filter((l) => !formToday.some((f) => f.lift === l.lift));
    todo += pending.length
      ? `<li class="warn">${pending.map((l) => esc(LIFT_LABEL[l.lift])).join(', ')} 탑세트 기록·자세 평가가 남았습니다. 기록해야 다음 세션이 설계됩니다. <button class="link" data-go="form" data-lift="${pending[0].lift}">기록하러 가기 →</button></li>`
      : '<li class="good">오늘 메인 리프트 기록 완료 → 다음 세션에 반영됩니다</li>';
  }
  if (runs.length) {
    if (runToday.length) todo += '<li class="good">오늘 러닝 평가 완료</li>';
    else if (state.garmin.passphrase) todo += '<li class="info">러닝 후 가민에 저장되면 자동으로 가져와 평가합니다 (최대 3시간 소요, 설정에서 즉시 불러오기 가능).</li>';
    else todo += '<li class="warn">러닝 후 가민 파일을 가져오면 자동 평가되고 다음 주 러닝 계획에 반영됩니다. <button class="link" data-go="settings">가져오기 →</button></li>';
  }

  const manualCk = state.checkins?.[today];
  const gToday = gdata().daily[today];
  const ck = manualCk || garminCheckin(gToday);
  const sel = (name, label, hint) => `<label>${label} <select data-ck-field="${name}">${[1, 2, 3, 4, 5].map((v) => `<option value="${v}" ${(ck?.[name] ?? 3) == v ? 'selected' : ''}>${v}</option>`).join('')}</select><span class="muted">${hint}</span></label>`;
  const fat = fatigueSignals(state, today, stats()?.acwr);
  const ready = ck ? ((Number(ck.sleep) + Number(ck.energy) + (6 - Number(ck.soreness))) / 3).toFixed(1) : null;
  const checkinBody = `
      <div class="grid2">
        ${sel('sleep', '수면', '1 나쁨 · 5 아주 좋음')}
        ${sel('energy', '에너지', '1 지침 · 5 넘침')}
        ${sel('soreness', '근육통', '1 없음 · 5 심함')}
        <label>통증 부위 <select data-ck-field="pain">${['', '허리', '무릎', '고관절', '어깨', '팔꿈치', '손목'].map((v) => `<option value="${v}" ${(ck?.pain ?? '') === v ? 'selected' : ''}>${v || '없음'}</option>`).join('')}</select></label>
      </div>
      <button id="saveCheckin">${ck ? '컨디션 수정' : '컨디션 기록'}</button>`;
  const fatigueHTML = fat.score ? `<ul class="fb">${fat.signals.map((x) => `<li class="warn">피로 신호: ${esc(x)}</li>`).join('')}${fat.deload ? '<li class="bad">피로가 누적되어 디로드가 자동 배치됩니다 (주간 프로그램 확인)</li>' : ''}</ul>` : '';
  const checkinCard = ck
    ? `<details class="card"><summary><b>오늘 컨디션</b>${ck.source === 'garmin' ? ' <span class="badge s-good">가민 자동</span>' : ''} 준비도 ${ready}/5 · 수면 ${ck.sleep} · 에너지 ${ck.energy} · 근육통 ${ck.soreness}${ck.pain ? ` · ${esc(ck.pain)} 통증` : ''} <span class="muted">(눌러서 ${ck.source === 'garmin' ? '근육통·통증 직접 입력' : '수정'})</span></summary>${checkinBody}</details>${garminCard(gToday)}${fatigueHTML ? `<div class="card">${fatigueHTML}</div>` : ''}`
    : `<div class="card"><h2>오늘 컨디션</h2><p class="muted">훈련 전에 기록하면 오늘 처방(강도·세트 수)이 자동 조정됩니다. 가민 수면·레디니스가 동기화되면 자동으로 채워집니다.</p>${checkinBody}${fatigueHTML}</div>`;
  $('#tab-today').innerHTML = `
    ${ck ? '' : checkinCard}
    <div class="card">
      <h2>${esc(s.name)}요일 · ${esc(s.rotation.title)}</h2>
      <p class="muted">${today} · ${wIdx + 1}주차 · ${esc(w.wave.name)}</p>
      ${s.rest ? '<p>오늘은 완전 휴식일입니다. 수면, 단백질, 가벼운 모빌리티에 집중하세요.</p>' : s.items.map((it, i) => itemHTML(it, `${today}-${it.type}-${it.lift || it.runType || i}`)).join('')}
    </div>
    ${ck ? checkinCard : ''}
    ${todo ? `<div class="card"><h2>오늘 할 일</h2><ul class="fb">${todo}</ul></div>` : ''}
    ${formToday.length || runToday.length ? `<div class="card"><h2>오늘의 평가</h2>
      ${formToday.map((f) => `<div>${esc(LIFT_LABEL[f.lift])} ${f.weight ? esc(f.weight) + 'kg' : ''} <span class="badge ${scoreClass(f.score)}">${f.score}</span></div>`).join('')}
      ${runToday.map((r) => `<div>${esc(RUN_TYPES[r.type])} ${esc(r.distanceKm)}km <span class="badge ${scoreClass(r.result.score)}">${r.result.score}</span></div>`).join('')}
    </div>` : ''}
  `;
  bindDone($('#tab-today'));
  $('#saveCheckin').addEventListener('click', () => {
    const c = {};
    document.querySelectorAll('[data-ck-field]').forEach((el) => { c[el.dataset.ckField] = el.dataset.ckField === 'pain' ? el.value : Number(el.value); });
    state.checkins = state.checkins || {};
    state.checkins[today] = c;
    applyAutoDeload();
    persist();
    renderToday();
  });
  $('#tab-today').querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.lift) { $('#formLift').value = b.dataset.lift; prefillForm(); }
    showTab(b.dataset.go);
  }));
}

// ---------- 자세 평가 ----------
const T = () => getThresholds(state.settings);

function renderChecklist() {
  const lift = $('#formLift').value;
  $('#formChecklist').innerHTML = CHECKLIST[lift].map((c, i) => `<label><input type="checkbox" data-ck="${i}" /> ${esc(c)}</label>`).join('');
}
// 오늘 처방된 무게/반복을 기본값으로
function prefillForm() {
  renderChecklist();
  const lift = $('#formLift').value;
  const it = sessionFor(state.settings, new Date(), stats(), coachCtx()).items.find((i) => i.type === 'lift' && i.lift === lift && !i.variation);
  if (it) { $('#formReps').value = it.reps; $('#formWeight').value = it.kg; }
}
function updateGuide() {
  const v = $('#formView').value;
  const benchNote = $('#formLift').value === 'bench' && v === 'oblique' ? ' (벤치: 머리 쪽 위 대각선)' : '';
  $('#viewGuide').textContent = `📷 ${VIEWS[v].guide}${benchNote}`;
}
$('#formLift').addEventListener('change', () => { prefillForm(); updateGuide(); });
$('#formView').addEventListener('change', () => { state.settings.formView = $('#formView').value; persist(); updateGuide(); });

let videoFile = null;
let plate = null;
let plateClicks = [];

function drawPlateMarks() {
  const v = $('#formVideoEl');
  const c = $('#formCanvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  const w = Math.max(3, c.width / 200);
  ctx.strokeStyle = '#facc15';
  ctx.fillStyle = '#facc15';
  ctx.lineWidth = w;
  if (plateClicks[0]) { ctx.beginPath(); ctx.arc(plateClicks[0].x, plateClicks[0].y, w * 2, 0, Math.PI * 2); ctx.fill(); }
  if (plate) { ctx.beginPath(); ctx.arc(plate.cx, plate.cy, plate.rPx, 0, Math.PI * 2); ctx.stroke(); }
  $('#plateState').textContent = plate ? `✓ 원판 지정됨 (반지름 ${Math.round(plate.rPx)}px)` : plateClicks.length ? '② 원판 위쪽 가장자리를 탭하세요' : '① 원판 중심을 탭하세요';
}
function resetPlate() {
  plate = null;
  plateClicks = [];
  $('#videoWrap').classList.add('picking');
  drawPlateMarks();
}
$('#plateReset').addEventListener('click', resetPlate);
$('#formCanvas').addEventListener('click', (e) => {
  if (!$('#videoWrap').classList.contains('picking')) return;
  const v = $('#formVideoEl');
  const rect = e.target.getBoundingClientRect();
  const pt = { x: ((e.clientX - rect.left) / rect.width) * v.videoWidth, y: ((e.clientY - rect.top) / rect.height) * v.videoHeight };
  plateClicks.push(pt);
  if (plateClicks.length === 2) {
    const [c, edge] = plateClicks;
    const r = Math.abs(edge.y - c.y) || Math.hypot(edge.x - c.x, edge.y - c.y); // 대각선 촬영 시 세로 반지름이 실제 반지름
    if (r > 5) {
      plate = { cx: c.x, cy: c.y, rPx: r };
      $('#videoWrap').classList.remove('picking');
    } else plateClicks = [];
  }
  drawPlateMarks();
});

$('#formVideo').addEventListener('change', async (e) => {
  videoFile = e.target.files[0] || null;
  plate = null;
  plateClicks = [];
  if (!videoFile) { $('#videoWrap').classList.add('hidden'); $('#plateStep').classList.add('hidden'); return; }
  const { loadVideo } = await import('./pose.js');
  try {
    await loadVideo($('#formVideoEl'), videoFile);
    $('#videoWrap').classList.remove('hidden');
    $('#plateStep').classList.remove('hidden');
    resetPlate();
  } catch (err) {
    alert(err.message);
    videoFile = null;
  }
});

function setProgress(p, text) {
  const el = $('#formProgress');
  el.classList.remove('hidden');
  el.querySelector('div').style.width = `${Math.round(p * 100)}%`;
  el.querySelector('span').textContent = text;
}

const METRIC = {
  depth: ['깊이비', ''], torso: ['상체각', '°'], knee: ['무릎각', '°'], elbow: ['팔꿈치각', '°'], pause: ['정지', '초'],
  kneeStart: ['시작 무릎각', '°'], hipStart: ['시작 고관절각', '°'], hipTop: ['락아웃 고관절각', '°'], layback: ['상체 젖힘', '°'],
  mcv: ['평균 속도', 'm/s'], peak: ['최고 속도', 'm/s'], midfootCm: ['미드풋 편차', 'cm'], hipMA: ['고관절 모멘트암', 'cm'],
  kneeMA: ['무릎 모멘트암', 'cm'], hipMARise: ['고관절 MA 증가', '%'], lockoutOffsetCm: ['락아웃 바-어깨', 'cm'], travelCm: ['바 수평 이동', 'cm'],
  braceSec: ['반복 전 정지', '초'], trunkShrink: ['몸통 단축', '%'], torsoJerk: ['상체 급변', '°'],
  valgusL: ['왼무릎 밸거스', '°'], valgusR: ['오른무릎 밸거스', '°'], kneeToe: ['무릎-발끝 차', '°'], heelCm: ['뒤꿈치 들림', 'cm'],
  flexAsym: ['좌우 굴곡차', '°'], hipShiftCm: ['힙 시프트(+오른쪽)', 'cm'], pelvisTiltCm: ['골반 높이차', 'cm'], trunkRot: ['몸통 회전', '°'],
  barTiltCm: ['바 기울기', 'cm'], flare: ['팔꿈치 벌어짐', '°'], lateralLean: ['옆 기울기', '°'],
};
const metricHTML = (m) => Object.entries(m).filter(([, v]) => v != null && Number.isFinite(v))
  .map(([k, v]) => `<span>${METRIC[k]?.[0] || k} <b>${v}${METRIC[k]?.[1] ?? ''}</b></span>`).join('');

let lastExtract = null; // 마지막 포즈 추출 결과 (구간을 바꿔 다시 분석할 때 재사용)

function runVideoEval(win) {
  const e = lastExtract;
  return evaluateForm({
    frames: e.frames, lift: e.lift, view: e.view, aspect: e.aspect, T: T(),
    bar: e.bar ? { track: e.bar, scale: e.scale } : null,
    expectedReps: Number($('#formReps').value) || 0, window: win,
  });
}

async function drawWorst(video) {
  if (!video?.ok || !lastExtract) return;
  const pose = await import('./pose.js');
  const { frames, lift } = lastExtract;
  const worst = video.reps.reduce((a, r) => (r.score < a.score ? r : a), video.reps[0]);
  const kt = video.pts[worst.keyFrame].t;
  const raw = frames.reduce((a, f) => (Math.abs(f.t - kt) < Math.abs(a.t - kt) ? f : a), frames[0]);
  const label = `${worst.rep}회차 ${lift === 'deadlift' || lift === 'ohp' ? '시작 자세' : '최저점'}`;
  await pose.drawKeyFrame($('#formVideoEl'), $('#formCanvas'), raw, label, video.barResult?.series);
}

// 움직임 타임라인: 아래로 갈수록 하단 자세. 회색 = 준비 구간(제외), 색 띠 = 인식된 회차
function timelineHTML(video) {
  const tl = video.timeline;
  const W = 600;
  const H = 150;
  const T0 = tl.t[0];
  const T1 = tl.t[tl.t.length - 1] || T0 + 1;
  const x = (t) => ((t - T0) / (T1 - T0)) * W;
  const y = (v) => 30 + ((Math.min(1.2, Math.max(-0.2, v)) + 0.2) / 1.4) * (H - 62);
  let shade = '';
  let i = 0;
  while (i < tl.t.length) {
    if (tl.active && !tl.active[i]) {
      const a = i;
      while (i < tl.t.length && !tl.active[i]) i++;
      shade += `<rect x="${x(tl.t[a])}" y="0" width="${Math.max(2, x(tl.t[i - 1]) - x(tl.t[a]))}" height="${H - 26}" fill="var(--line)" opacity="0.8"/>`;
    } else i++;
  }
  const reps = (video.reps || []).map((r) => {
    const a = r.conc?.[0] ?? r.ecc?.[0];
    const b = r.conc?.[1] ?? r.ecc?.[1];
    if (a == null || b == null) return '';
    return `<rect x="${x(a)}" y="0" width="${Math.max(2, x(b) - x(a))}" height="${H - 26}" fill="var(--good-bg)"/><text x="${(x(a) + x(b)) / 2}" y="24" text-anchor="middle" font-weight="700">${r.rep}</text>`;
  }).join('');
  const path = tl.t.map((t, k) => `${k ? 'L' : 'M'}${x(t).toFixed(1)},${y(tl.n[k]).toFixed(1)}`).join('');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => { const t = T0 + f * (T1 - T0); return `<text x="${x(t)}" y="${H - 4}" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}">${t.toFixed(1)}s</text>`; }).join('');
  const w = video.window || {};
  return `<h3>타임라인 · 인식 ${video.reps?.length ?? 0}회</h3>
    <svg class="chart timeline" viewBox="0 0 ${W} ${H}" role="img">${shade}${reps}<path d="${path}" fill="none" stroke="var(--primary)" stroke-width="2"/>${ticks}</svg>
    <div class="legend"><span><i style="background:var(--good-bg)"></i>인식된 회차</span><span><i style="background:var(--line)"></i>준비 구간 (제외)</span><span>선이 아래로 = 하단 자세</span></div>
    <div class="row tl-controls">
      <label>시작(초) <input type="number" id="tlStart" step="0.1" value="${(w.manual ? w.t0 : T0).toFixed(1)}"/></label>
      <label>끝(초) <input type="number" id="tlEnd" step="0.1" value="${(w.manual ? w.t1 : T1).toFixed(1)}"/></label>
      <button id="tlApply">이 구간으로 다시 분석</button>
    </div>
    <p class="muted">반복 수 칸에 실제 반복 수를 넣으면 그 수에 맞춰 인식 민감도를 자동 조정합니다.</p>`;
}

function bindTimeline(video, c) {
  $('#tlApply')?.addEventListener('click', async () => {
    if (!lastExtract) return;
    const t0 = Number($('#tlStart').value);
    const t1 = Number($('#tlEnd').value);
    if (!(t1 > t0)) { alert('끝 시점이 시작보다 뒤여야 합니다.'); return; }
    const v = runVideoEval({ t0, t1 });
    await drawWorst(v);
    finishEval(v, c);
  });
}

$('#formAnalyze').addEventListener('click', async () => {
  const btn = $('#formAnalyze');
  const lift = $('#formLift').value;
  const view = $('#formView').value;
  const checks = [...document.querySelectorAll('[data-ck]')];
  const checked = checks.filter((c) => c.checked).length;
  const rpe = Number($('#formRpe').value) || null;
  const pain = $('#formPain').checked;
  const selfScore = checklistScore(checked, checks.length, rpe, pain);

  let video = null;
  if (videoFile) {
    btn.disabled = true;
    try {
      const pose = await import('./pose.js');
      const v = $('#formVideoEl');
      const aspect = v.videoWidth / v.videoHeight;
      const { frames, bar } = await pose.extractFrames(v, setProgress, { plate });
      const scale = plate ? (Number($('#plateDiam').value || 45) / 200) / (plate.rPx / v.videoHeight) : 0;
      lastExtract = { frames, bar, aspect, scale, lift, view };
      video = runVideoEval(null);
      await drawWorst(video);
    } catch (err) {
      video = { ok: false, error: `영상 분석 실패: ${err.message}. 인터넷 연결을 확인하거나 체크리스트로만 평가하세요.` };
    } finally {
      btn.disabled = false;
    }
  }

  finishEval(video, { lift, view, checks, rpe, pain, selfScore });
});

// 분석 결과 → 기록 저장 + 화면 (구간을 바꿔 다시 분석하면 같은 기록을 교체)
function finishEval(video, c) {
  const { lift, view, checks, rpe, pain, selfScore } = c;
  const score = video?.ok ? Math.round(video.score * 0.7 + selfScore * 0.3) : selfScore;
  const missed = checks.filter((c) => !c.checked).map((c) => CHECKLIST[lift][Number(c.dataset.ck)]);
  const tips = [];
  if (pain) tips.push({ level: 'bad', text: '통증 발생: 다음 세션은 무게를 10~20% 줄이고, 통증이 지속되면 전문가 상담' });
  if (rpe >= 9.5) tips.push({ level: 'warn', text: `RPE ${rpe}: 처방보다 힘듦. 다음 세션 무게를 2.5~5kg 낮추세요.` });
  else if (rpe && rpe <= 7) tips.push({ level: 'good', text: `RPE ${rpe}: 여유 있음. 다음 주기 증량 순조로움.` });
  if (rpe && video?.ok && video.stats.rir != null) {
    const vRpe = 10 - video.stats.rir;
    if (Math.abs(vRpe - rpe) >= 1.5) tips.push({ level: 'info', text: `체감 RPE ${rpe} vs 속도 기반 추정 RPE ${vRpe.toFixed(1)}: 차이가 큽니다. 기록이 쌓이면 개인 속도 기준이 정확해집니다.` });
  }
  missed.forEach((m) => tips.push({ level: 'warn', text: `다음 세트 집중 큐: ${m}` }));

  const rx = sessionFor(state.settings, new Date(), stats(), coachCtx()).items.find((i) => i.type === 'lift' && i.lift === lift && !i.variation);
  const issueCount = {};
  if (video?.ok) {
    [...video.summary, ...video.reps.flatMap((r) => r.issues)].forEach((i) => {
      if (i.level === 'good' || (i.level === 'info' && !i.text.startsWith('스티킹 포인트'))) return;
      const k = i.text;
      issueCount[k] = issueCount[k] || { level: i.level, text: i.text, n: 0 };
      issueCount[k].n++;
    });
  }
  const isVariation = $('#formVariation').checked;
  const log = {
    id: uid(), date: todayISO(), lift, view, variation: isVariation,
    target: rx && !isVariation ? { kg: rx.kg, reps: rx.reps, rpe: rx.rpe } : null,
    issues: Object.values(issueCount),
    weight: $('#formWeight').value, reps: $('#formReps').value, rpe, pain,
    note: $('#formNote').value.trim(),
    score, selfScore, videoScore: video?.ok ? video.score : null,
    stats: video?.ok ? video.stats : null,
    mcvs: video?.ok ? video.reps.map((r) => (r.mcv ? +r.mcv.toFixed(3) : null)) : null,
    videoSummary: video?.ok ? [...video.summary, ...video.reps.flatMap((r) => r.issues.filter((i) => i.level === 'bad'))].slice(0, 6) : [],
    tips,
  };
  if (c.replaceId) state.formLogs = state.formLogs.filter((l) => l.id !== c.replaceId);
  state.formLogs.push(log);
  applyAutoDeload();
  persist();
  const next = isVariation ? null : nextSessionPreview(lift);

  const diag = video?.ok ? video.reps.flatMap((r) => r.issues.filter((i) => i.text.startsWith('스티킹 포인트')).map((i) => `${r.rep}회차 · ${i.text}`)) : [];
  $('#formResult').innerHTML = `<div class="card">
    <div class="score"><div class="num ${scoreClass(score)}">${score}</div>
      <div><h2>${esc(LIFT_LABEL[lift])} ${log.weight ? esc(log.weight) + 'kg' : ''} ${log.reps ? '× ' + esc(log.reps) : ''}</h2>
      <div class="muted">${video?.ok ? `${esc(VIEWS[view].name)} · 영상 ${video.score}점 (70%) + 체크리스트 ${selfScore}점 (30%)` : `체크리스트 ${selfScore}점`}</div></div></div>
    ${video && !video.ok ? fbList([{ level: 'warn', text: video.error }]) : ''}
    ${diag.length ? `<h3>힘이 새는 지점</h3>${diag.map((d) => `<div class="diag">${esc(d)}</div>`).join('')}` : ''}
    ${video?.timeline ? timelineHTML(video) : ''}
    ${video?.ok ? `<h3>세트 요약</h3>${fbList(video.summary.length ? video.summary : [{ level: 'info', text: `${video.reps.length}회 반복 인식` }])}
      ${!plate ? '<p class="muted">원판을 지정하면 바벨 속도·스티킹 포인트·모멘트암도 분석합니다.</p>' : ''}
      <h3>반복별 분석</h3><p class="muted">가장 낮은 점수의 반복만 펼쳐 둡니다. 눌러서 다른 반복을 확인하세요.</p>
      <div class="reps">${video.reps.map((r) => `<details class="rep" ${r.score === Math.min(...video.reps.map((x) => x.score)) ? 'open' : ''}>
        <summary><h4><span>${r.rep}회차${r.mcv ? ` · ${r.mcv.toFixed(2)}m/s` : ''}</span><span class="badge ${scoreClass(r.score)}">${r.score}</span></h4></summary>
        <div class="kv">${metricHTML(r.metrics)}${r.ascent != null ? `<span>상승 시간 <b>${r.ascent.toFixed(2)}초</b></span>` : ''}</div>
        ${fbList(r.issues.filter((i) => !i.text.startsWith('스티킹 포인트')))}</details>`).join('')}</div>` : ''}
    ${tips.length ? `<h3>코칭</h3>${fbList(tips)}` : ''}
    ${next ? `<h3>다음 ${esc(LIFT_KO[lift])} 세션 설계 (${esc(next.date)})</h3>${itemHTML(next.item)}${next.variation ? itemHTML(next.variation) : ''}` : ''}
  </div>`;
  $('#formResult').scrollIntoView({ behavior: 'smooth' });
  if (video?.timeline) bindTimeline(video, { ...c, replaceId: log.id });
}


// ---------- 러닝 평가 ----------
function nextDay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + 1);
  return d;
}

// 계획(처방) 대비 평가. 계획된 러닝이 있으면 그 종류 기준, 없으면 자동 분류 기준
function evaluateLog(run) {
  const date = new Date(run.date + 'T12:00:00');
  const st = stats(date);
  const planned = sessionFor(state.settings, date, st, coachCtx()).items.find((i) => i.type === 'run');
  const detected = run.type;
  const evalRun = { ...run, type: planned && run.source === 'garmin' ? planned.runType : run.type };
  const history = state.runLogs.filter((r) => r.date < run.date || (r.date === run.date && r.id !== run.id && r.result));
  // 가민 VO2max/최근 기록이 있으면 그 기준 페이스로 평가
  const settings = st?.fiveKSec ? { ...state.settings, fiveK: st.fiveKSec } : state.settings;
  const result = evaluateRun(evalRun, settings, history, sessionFor(state.settings, nextDay(run.date), st, coachCtx()));
  if (!result.ok) return result;
  if (run.source === 'garmin') {
    if (planned) {
      if (planned.runType !== detected && !(planned.runType === 'easy' && detected === 'long')) {
        result.items.unshift({ level: 'warn', text: `계획은 ${planned.title}(${planned.km}km)였는데 ${RUN_TYPES[detected]} 강도로 달렸습니다.` });
        result.score = Math.max(0, result.score - 5);
      } else {
        result.items.unshift({ level: 'good', text: `계획한 ${planned.title}을(를) 수행 (${run.distanceKm}km / 계획 ${planned.km}km)` });
      }
      const diff = Number(run.distanceKm) - planned.km;
      if (Math.abs(diff) > Math.max(2, planned.km * 0.25)) result.items.push({ level: 'warn', text: `계획 거리와 ${diff > 0 ? '+' : ''}${diff.toFixed(1)}km 차이: 다음 주 거리 계산에 반영됩니다.` });
    } else {
      result.items.unshift({ level: 'info', text: '계획에 없던 러닝입니다. 주간 거리에 포함됩니다.' });
    }
    const g = run.garmin || {};
    if (g.aerobicTE) result.items.push({ level: 'info', text: `가민 트레이닝 효과: 유산소 ${g.aerobicTE.toFixed(1)} / 무산소 ${(g.anaerobicTE || 0).toFixed(1)}${g.teLabel ? ' · ' + g.teLabel : ''}` });
  }
  result.planned = planned ? { title: planned.title, km: planned.km, runType: planned.runType } : null;
  return result;
}

function storeResult(run, result) {
  run.result = {
    score: result.score, load: result.load, zone: result.zone, efficiency: result.efficiency,
    pace: result.pace, vdot: result.vdot, acwr: result.acwr, items: result.items, planned: result.planned,
  };
}

function runCard(r, open = false) {
  const res = r.result;
  return `<details class="card run-card" ${open ? 'open' : ''}>
    <summary><div class="score"><div class="num ${scoreClass(res.score)}">${res.score}</div>
      <div><b>${esc(RUN_TYPES[r.type])} ${Number(r.distanceKm).toFixed(1)}km</b>
      <div class="muted">${esc(r.date)} · ${fmtPace(res.pace)}/km · ${res.zone ? 'Z' + res.zone : '심박 없음'}${r.source === 'garmin' ? ' · 가민' : ''}</div>
      ${res.planned ? `<div class="muted">계획: ${esc(res.planned.title)} ${res.planned.km}km</div>` : ''}</div></div></summary>
    <div class="stats">
      <div class="stat"><div class="l">시간</div><div class="v">${fmtDuration(parseTime(r.duration))}</div></div>
      <div class="stat"><div class="l">평균 심박</div><div class="v">${r.avgHr || '-'}</div></div>
      <div class="stat"><div class="l">케이던스</div><div class="v">${r.cadence || '-'}</div></div>
      <div class="stat"><div class="l">훈련 부하</div><div class="v">${res.load}</div></div>
      <div class="stat"><div class="l">ACWR</div><div class="v">${res.acwr ? res.acwr.toFixed(2) : '-'}</div></div>
    </div>
    ${fbList(res.items)}
  </details>`;
}

function renderGarminRuns() {
  const g = state.garmin;
  const runs = [...state.runLogs].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);
  const st = stats();
  $('#garminRuns').innerHTML = `
    <div class="card">
      <div class="row between"><h2>러닝 평가</h2>${g.passphrase ? '<button id="garminRefresh">가민 새로고침</button>' : ''}</div>
      ${g.passphrase
        ? `<p class="muted">가민 동기화 ${g.updated ? new Date(g.updated).toLocaleString('ko-KR') : '-'} · 확인 ${g.lastSync ? new Date(g.lastSync).toLocaleString('ko-KR') : '-'}</p>`
        : '<p class="muted">설정 탭에서 가민 연동을 켜면 러닝이 자동으로 들어와 평가됩니다.</p>'}
      ${st ? `<div class="stats">
        <div class="stat"><div class="l">최근 4주 평균</div><div class="v">${st.avg4}km</div></div>
        <div class="stat"><div class="l">지난 7일</div><div class="v">${st.lastWeek}km</div></div>
        <div class="stat"><div class="l">VO2max</div><div class="v">${st.vo2 ? st.vo2.toFixed(1) : '-'}</div></div>
        <div class="stat"><div class="l">5K 환산</div><div class="v">${st.fiveKSec ? fmtDuration(st.fiveKSec) : '-'}</div></div>
      </div>` : ''}
    </div>
    ${runs.length ? runs.map((r, i) => runCard(r, i === 0)).join('') : '<div class="card muted">아직 러닝 기록이 없습니다.</div>'}`;
  $('#garminRefresh')?.addEventListener('click', () => syncGarmin(true));
}

$('#runType').innerHTML = Object.entries(RUN_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
$('#runDate').value = todayISO();

$('#runEval').addEventListener('click', () => {
  const run = {
    id: uid(), source: 'manual',
    date: $('#runDate').value || todayISO(),
    type: $('#runType').value,
    distanceKm: $('#runKm').value,
    duration: $('#runTime').value,
    avgHr: $('#runHr').value,
    cadence: $('#runCad').value,
    elevGain: $('#runElev').value,
    rpe: $('#runRpe').value,
    note: $('#runNote').value.trim(),
  };
  const result = evaluateLog(run);
  if (!result.ok) { $('#runResult').innerHTML = `<div class="card">${fbList([{ level: 'bad', text: result.error }])}</div>`; return; }
  storeResult(run, result);
  state.runLogs.push(run);
  persist();
  $('#runResult').innerHTML = runCard(run, true);
  $('#runResult').scrollIntoView({ behavior: 'smooth' });
});

// ---------- 가민 동기화 / 파일 가져오기 ----------
// 새 러닝만 평가해 추가 (같은 활동이 다른 경로로 이미 있으면 건너뜀). 추가된 개수 반환
function ingestRuns(runs) {
  let added = 0;
  const valid = runs.filter((r) => r.distanceKm > 0.5 && r.durationSec > 0).sort((a, b) => a.start.localeCompare(b.start));
  for (const gr of valid) {
    const log = toRunLog(gr, state.settings);
    if (state.runLogs.some((r) => r.id === log.id || isSameRun(r, { ...log, durationSec: gr.durationSec, distanceKm: gr.distanceKm }) || (r.source !== 'manual' && isSameRun({ ...r, durationSec: parseTime(r.duration) }, { date: gr.date, distanceKm: gr.distanceKm, durationSec: gr.durationSec })))) continue;
    const result = evaluateLog(log);
    if (!result.ok) continue;
    storeResult(log, result);
    state.runLogs.push(log);
    state.runLogs.sort((a, b) => a.date.localeCompare(b.date));
    added++;
  }
  const observedMax = Math.max(0, ...runs.map((r) => r.maxHr || 0));
  if (observedMax > state.settings.hrMax && observedMax < 225) state.settings.hrMax = observedMax;
  applyAutoDeload();
  persist();
  return added;
}

$('#garminFiles').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  const status = $('#garminImportStatus');
  status.textContent = '가민 파일 읽는 중…';
  const runs = [];
  const errors = [];
  for (const f of files) {
    try { runs.push(...await importGarminFile(f.name, await f.arrayBuffer())); } catch (err) { errors.push(`${f.name}: ${err.message}`); }
  }
  const added = ingestRuns(runs);
  status.textContent = `러닝 ${runs.length}개 읽음 → 새로 추가 ${added}개${runs.length - added ? ` (중복 ${runs.length - added}개 제외)` : ''}${errors.length ? ` · 실패: ${errors.join(' / ')}` : ''}`;
  e.target.value = '';
  renderE1rmTable();
});

// ---------- 다음 세션 설계 / 자동 디로드 ----------
// 오늘 가민 회복 지표 카드
const STATUS_KO = { BALANCED: '균형', UNBALANCED: '불균형', LOW: '낮음', POOR: '나쁨', HIGH: '높음', MODERATE: '보통', PRIME: '최상', GOOD: '좋음', FAIR: '보통', EXCELLENT: '최상' };
function garminCard(day) {
  if (!day) return '';
  const st = (l, v) => (v == null ? '' : `<div class="stat"><div class="l">${l}</div><div class="v">${v}</div></div>`);
  return `<div class="card"><h2>가민 회복 지표</h2><div class="stats">
    ${st('수면', day.sleepScore != null ? `${day.sleepScore}점${day.sleepHours ? ` · ${day.sleepHours}h` : ''}` : day.sleepHours ? `${day.sleepHours}h` : null)}
    ${st('HRV', day.hrv != null ? `${day.hrv}ms${day.hrvStatus ? ` · ${STATUS_KO[day.hrvStatus] || day.hrvStatus}` : ''}` : null)}
    ${st('트레이닝 레디니스', day.readiness != null ? `${day.readiness}${day.readinessLevel ? ` · ${STATUS_KO[day.readinessLevel] || day.readinessLevel}` : ''}` : null)}
    ${st('바디 배터리', day.bbHigh != null ? `${day.bbLow ?? '-'}~${day.bbHigh}` : null)}
    ${st('안정시 심박', day.restingHr)}
    ${st('스트레스', day.stressAvg)}
    ${st('회복 필요', day.recoveryHours != null ? `${day.recoveryHours}h` : null)}
  </div>${day.readinessFeedback ? `<p class="muted">${esc(day.readinessFeedback)}</p>` : ''}</div>`;
}

function nextSessionPreview(lift) {
  const d = new Date();
  for (let k = 1; k <= 10; k++) {
    d.setDate(d.getDate() + 1);
    const s = sessionFor(state.settings, d, stats(), coachCtx());
    const item = s.items.find((i) => i.type === 'lift' && i.lift === lift && !i.variation);
    if (item) return { date: todayISO(d), item, variation: s.items.find((i) => i.lift === lift && i.variation) };
  }
  return null;
}

// 피로 신호가 쌓이면 디로드를 앞당김 (최근 3주 안에 디로드가 없을 때만)
function applyAutoDeload() {
  const today = todayISO();
  const w = weekIndex(state.settings.startDate);
  state.coach = state.coach || {};
  state.coach.deloadWeeks = state.coach.deloadWeeks || [];
  state.coach.deloadNotes = state.coach.deloadNotes || {};
  const f = fatigueSignals(state, today, stats()?.acwr);
  if (!f.deload) return;
  const target = f.score >= 3 ? w : w + 1;
  for (let k = target - 3; k <= target; k++) if (phaseAt(k, state.coach)?.deload) return;
  state.coach.deloadWeeks.push(target);
  state.coach.deloadNotes[target] = f.signals;
}

function renderE1rmTable() {
  const el = $('#e1rmTable');
  if (!el) return;
  el.innerHTML = Object.keys(LIFT_KO).map((l) => {
    const e = liftE1rm(l, state.formLogs, state.settings);
    return `<div class="stat"><div class="l">${esc(LIFT_KO[l])}</div><div class="v">${Math.round(e.e1rm)}kg</div><div class="l">${esc(e.source)}</div></div>`;
  }).join('');
}

async function syncGarmin(manual = false) {
  const g = state.garmin;
  const status = $('#garminStatus');
  if (!g.passphrase) return;
  try {
    status.textContent = '가민 데이터 불러오는 중…';
    const data = await fetchGarmin(g.url, g.passphrase);
    g.lastSync = new Date().toISOString();
    g.updated = data.updated;
    if (data.vo2max) g.vo2max = data.vo2max;
    g.data = { daily: data.daily || {}, activities: data.activities || [], profile: data.profile || {} };
    if (g.data.profile.hrMax) state.settings.hrMax = g.data.profile.hrMax;
    if (data.restingHr) { g.restingHr = data.restingHr; state.settings.hrRest = data.restingHr; }
    const observedMax = Math.max(0, ...data.runs.map((r) => r.maxHr || 0));
    if (observedMax > state.settings.hrMax && observedMax < 225) state.settings.hrMax = observedMax;

    const fresh = ingestRuns(data.runs);
    status.textContent = `완료: 새 러닝 ${fresh} · 전체 ${data.runs.length}개 (가민 동기화 ${new Date(data.updated).toLocaleString('ko-KR')})`;
    if (fresh || manual) rerenderActive();
  } catch (err) {
    status.textContent = `가민 불러오기 실패: ${err.message}`;
    if (manual) alert(status.textContent);
  }
}

// ---------- 기록 ----------
function avg(arr) { return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : '-'; }

// 간단한 꺾은선 차트 (세션 순서가 x축)
function lineChart(labels, series, unit = '') {
  const W = 600;
  const H = 170;
  const pad = { l: 40, r: 10, t: 10, b: 24 };
  const all = series.flatMap((s) => s.values).filter(Number.isFinite);
  if (!all.length || labels.length < 2) return '<p class="muted">기록이 2개 이상 쌓이면 그래프가 표시됩니다.</p>';
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const span = hi - lo;
  lo -= span * 0.1; hi += span * 0.1;
  const x = (i) => pad.l + (i * (W - pad.l - pad.r)) / (labels.length - 1);
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const ticks = [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1];
  const fmt = (v) => (Math.abs(hi - lo) < 5 ? v.toFixed(2) : Math.round(v));
  const grid = ticks.map((t) => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${fmt(t)}</text>`).join('');
  const xl = `<text x="${x(0)}" y="${H - 6}">${esc(labels[0])}</text><text x="${x(labels.length - 1)}" y="${H - 6}" text-anchor="end">${esc(labels[labels.length - 1])}</text>`;
  const lines = series.map((s) => {
    const pts = s.values.map((v, i) => (Number.isFinite(v) ? [x(i), y(v)] : null));
    let d = '';
    let pen = false;
    pts.forEach((p) => { if (!p) { pen = false; return; } d += `${pen ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`; pen = true; });
    const dots = pts.filter(Boolean).map((p) => `<circle class="dot" cx="${p[0]}" cy="${p[1]}" r="3.5" fill="${s.color}"/>`).join('');
    return `<path class="line" d="${d}" stroke="${s.color}"/>${dots}`;
  }).join('');
  const legend = `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}${unit ? ` (${unit})` : ''}</span>`).join('')}</div>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${grid}${xl}${lines}</svg>${legend}`;
}

const SPORT_KO = { strength_training: '근력 운동', cycling: '사이클', indoor_cycling: '실내 사이클', walking: '걷기', hiking: '하이킹', lap_swimming: '수영', open_water_swimming: '수영', yoga: '요가', hiit: 'HIIT', cardio: '유산소', elliptical: '일립티컬', indoor_rowing: '로잉', stair_climbing: '계단' };
const STATUS_PHRASE = (p) => (p || '').replace(/_\d+$/, '').replace(/_/g, ' ').toLowerCase();

function garminHistoryCard() {
  const { daily, activities, profile: p } = gdata();
  const dates = Object.keys(daily).sort().slice(-30);
  if (!dates.length && !activities.length && !Object.keys(p).length) {
    return '<div class="card"><h2>가민 데이터</h2><p class="muted">설정 탭에서 가민 자동 연동을 켜면 수면·HRV·레디니스·체성분·모든 활동이 여기에 표시됩니다.</p></div>';
  }
  const st = (l, v) => (v == null || v === '' ? '' : `<div class="stat"><div class="l">${l}</div><div class="v">${v}</div></div>`);
  const rp = p.racePredictions || {};
  const lastWeight = [...Object.keys(daily)].sort().reverse().map((d) => daily[d]).find((x) => x.weightKg);
  const labels = dates.map((d) => d.slice(5));
  const series = (k) => dates.map((d) => (daily[d][k] != null ? Number(daily[d][k]) : NaN));
  const wDates = Object.keys(daily).sort().filter((d) => daily[d].weightKg).slice(-30);
  const setsText = (sets) => {
    const by = {};
    for (const x of sets || []) { const k = (x.category || x.exercise || '').replace(/_/g, ' ').toLowerCase(); (by[k] = by[k] || []).push(`${x.reps ?? '-'}${x.kg ? `×${x.kg}kg` : ''}`); }
    return Object.entries(by).map(([k, v]) => `${k}: ${v.join(', ')}`).join(' / ');
  };
  const recentActs = [...activities].sort((a, b) => (b.start || '').localeCompare(a.start || '')).slice(0, 15);
  return `<div class="card"><h2>가민 데이터</h2>
    <h3>능력·상태</h3><div class="stats">
      ${st('VO2max', p.vo2max)}
      ${st('트레이닝 상태', p.trainingStatus ? esc(STATUS_PHRASE(p.trainingStatus)) : null)}
      ${st('급성/만성 부하', p.acuteLoad != null ? `${p.acuteLoad}/${p.chronicLoad ?? '-'}${p.acwr ? ` (${p.acwr})` : ''}` : null)}
      ${st('5K 예측', rp.time5K ? fmtDuration(rp.time5K) : null)}
      ${st('10K 예측', rp.time10K ? fmtDuration(rp.time10K) : null)}
      ${st('하프 예측', rp.timeHalfMarathon ? fmtDuration(rp.timeHalfMarathon) : null)}
      ${st('풀 예측', rp.timeMarathon ? fmtDuration(rp.timeMarathon) : null)}
      ${st('젖산 역치', p.ltHr ? `${p.ltHr}bpm${p.ltPaceSec ? ` · ${fmtPace(p.ltPaceSec)}/km` : ''}` : null)}
      ${st('지구력 점수', p.enduranceScore)}
      ${st('언덕 점수', p.hillScore)}
      ${st('피트니스 나이', p.fitnessAge != null ? `${Math.round(p.fitnessAge)}세${p.age ? ` (실제 ${p.age})` : ''}` : null)}
      ${st('체중', lastWeight ? `${lastWeight.weightKg}kg${lastWeight.bodyFat ? ` · 체지방 ${lastWeight.bodyFat}%` : ''}` : null)}
      ${(p.oneRepMax || []).filter((x) => x.kg).slice(0, 4).map((x) => st(`가민 1RM · ${esc(String(x.exercise).replace(/_/g, ' ').toLowerCase())}`, `${x.kg}kg`)).join('')}
    </div>
    ${dates.length ? `<h3>회복 (최근 30일)</h3>${lineChart(labels, [
      { name: '수면 점수', color: 'var(--run)', values: series('sleepScore') },
      { name: '트레이닝 레디니스', color: 'var(--lift)', values: series('readiness') },
    ])}
    ${lineChart(labels, [
      { name: 'HRV (ms)', color: 'var(--hyp)', values: series('hrv') },
      { name: '안정시 심박 (bpm)', color: 'var(--run)', values: series('restingHr') },
    ])}` : ''}
    ${wDates.length >= 2 ? `<h3>체중</h3>${lineChart(wDates.map((d) => d.slice(5)), [{ name: '체중', color: 'var(--lift)', values: wDates.map((d) => daily[d].weightKg) }], 'kg')}` : ''}
    ${recentActs.length ? `<h3>러닝 외 활동</h3><div class="table-wrap"><table>
      <tr><th>날짜</th><th>종류</th><th>시간</th><th>심박</th><th>세트</th></tr>
      ${recentActs.map((a) => `<tr><td>${esc((a.date || '').slice(5))}</td><td>${esc(SPORT_KO[a.sport] || (a.sport || '').replace(/_/g, ' '))}</td><td>${a.durationSec ? fmtDuration(a.durationSec) : '-'}</td><td>${a.avgHr ?? '-'}</td><td class="muted">${esc(setsText(a.sets)) || '-'}</td></tr>`).join('')}
    </table></div>` : ''}
  </div>`;
}

let historyLift = 'squat';
function renderHistory() {
  const forms = [...state.formLogs].sort((a, b) => b.date.localeCompare(a.date));
  const runs = [...state.runLogs].sort((a, b) => b.date.localeCompare(a.date));
  const byLift = (l) => state.formLogs.filter((f) => f.lift === l).slice(-5).map((f) => f.score);
  const lf = state.formLogs.filter((f) => f.lift === historyLift);
  const labels = lf.map((f) => f.date.slice(5));
  const e1rm = estimate1RM(lf.filter((f) => f.stats?.bestMcv && f.weight).map((f) => ({ kg: Number(f.weight), mcv: f.stats.bestMcv })), historyLift);
  const C = { a: 'var(--lift)', b: 'var(--hyp)', c: 'var(--run)' };

  $('#tab-history').innerHTML = `
    <div class="card"><h2>최근 추세</h2><div class="stats">
      ${['squat', 'bench', 'deadlift', 'ohp'].map((l) => `<div class="stat"><div class="l">${LIFT_LABEL[l]} 최근 5회</div><div class="v">${avg(byLift(l))}</div></div>`).join('')}
      <div class="stat"><div class="l">러닝 최근 5회</div><div class="v">${avg(state.runLogs.slice(-5).map((r) => r.result.score))}</div></div>
    </div></div>
    ${garminHistoryCard()}
    <div class="card">
      <div class="row between"><h2>종목별 추이</h2>
        <select id="historyLift">${['squat', 'bench', 'deadlift', 'ohp'].map((l) => `<option value="${l}" ${l === historyLift ? 'selected' : ''}>${LIFT_LABEL[l]}</option>`).join('')}</select></div>
      ${e1rm ? `<p><b>속도 기반 추정 1RM: ${e1rm}kg</b> <span class="muted">(무게별 최고 속도로 계산한 하중-속도 관계, 참고용)</span></p>` : '<p class="muted">원판을 지정해 서로 다른 무게로 2번 이상 기록하면 속도 기반 1RM을 추정합니다.</p>'}
      <h3>자세 점수</h3>${lineChart(labels, [{ name: '점수', color: C.a, values: lf.map((f) => f.score) }])}
      <h3>좌우 움직임 (대각선·정면 촬영)</h3>${lineChart(labels, [
        { name: '최대 무릎 밸거스', color: C.b, values: lf.map((f) => f.stats?.valgus ?? NaN) },
        { name: '힙 시프트', color: C.c, values: lf.map((f) => (f.stats?.hipShiftCm != null ? Math.abs(f.stats.hipShiftCm) : NaN)) },
      ])}<p class="muted">밸거스는 °, 힙 시프트는 cm</p>
      <h3>바벨 속도</h3>${lineChart(labels, [
        { name: '최고 평균속도', color: C.a, values: lf.map((f) => f.stats?.bestMcv ?? NaN) },
      ], 'm/s')}
    </div>
    <div class="card"><h2>자세 평가 기록</h2>${forms.length ? `<div class="table-wrap"><table>
      <tr><th>날짜</th><th>종목</th><th>각도</th><th>무게×반복</th><th>RPE</th><th>점수</th><th>주요 피드백</th><th></th></tr>
      ${forms.map((f) => `<tr><td>${esc(f.date)}</td><td>${esc(LIFT_LABEL[f.lift])}</td><td>${esc(VIEWS[f.view]?.name.split(' ')[0] || '-')}</td><td>${esc(f.weight || '-')}×${esc(f.reps || '-')}</td><td>${esc(f.rpe ?? '-')}</td>
        <td><span class="badge ${scoreClass(f.score)}">${f.score}</span></td>
        <td class="muted">${esc([...(f.videoSummary || []), ...(f.tips || [])].slice(0, 2).map((i) => i.text).join(' / ') || f.note || '')}</td>
        <td><button class="link" data-del-form="${f.id}">삭제</button></td></tr>`).join('')}
    </table></div>` : '<p class="muted">아직 기록이 없습니다.</p>'}</div>
    <div class="card"><h2>러닝 기록</h2>${runs.length ? `<div class="table-wrap"><table>
      <tr><th>날짜</th><th>종류</th><th>거리</th><th>페이스</th><th>심박존</th><th>부하</th><th>점수</th><th></th></tr>
      ${runs.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(RUN_TYPES[r.type])}${r.source === 'garmin' ? ' <span class="muted">G</span>' : ''}</td><td>${Number(r.distanceKm).toFixed(1)}km</td><td>${fmtPace(r.result.pace)}</td>
        <td>${r.result.zone ? 'Z' + r.result.zone : '-'}</td><td>${r.result.load}</td>
        <td><span class="badge ${scoreClass(r.result.score)}">${r.result.score}</span></td>
        <td>${r.source === 'garmin' ? '' : `<button class="link" data-del-run="${r.id}">삭제</button>`}</td></tr>`).join('')}
    </table></div>` : '<p class="muted">아직 기록이 없습니다.</p>'}</div>`;
  $('#historyLift').addEventListener('change', (e) => { historyLift = e.target.value; renderHistory(); });
  $('#tab-history').querySelectorAll('[data-del-form]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm('이 기록을 삭제할까요?')) return;
    state.formLogs = state.formLogs.filter((f) => f.id !== b.dataset.delForm); persist(); renderHistory();
  }));
  $('#tab-history').querySelectorAll('[data-del-run]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm('이 기록을 삭제할까요?')) return;
    state.runLogs = state.runLogs.filter((r) => r.id !== b.dataset.delRun); persist(); renderHistory();
  }));
}

// ---------- 자세 평가 기준 (프리셋) ----------
function renderPreset() {
  const sel = $('#formPreset');
  const cur = state.settings.formPreset || 'balanced';
  sel.innerHTML = Object.entries(PRESETS).map(([k, p]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  renderThresholdEditor(cur);
}
function renderThresholdEditor(presetKey) {
  $('#presetDesc').textContent = PRESETS[presetKey].desc;
  const base = getThresholds({ formPreset: presetKey });
  const custom = state.settings.customThresholds || {};
  let html = '';
  let group = '';
  for (const [k, meta] of Object.entries(THRESHOLD_META)) {
    if (meta.group !== group) { group = meta.group; html += `<h4>${esc(group)}</h4>`; }
    const v = custom[k] ?? base[k];
    html += `<label>${esc(meta.label)} <input type="number" step="any" data-th="${k}" value="${v}" class="${k in custom ? 'custom' : ''}"/></label>`;
  }
  $('#thresholdEditor').innerHTML = html;
}
$('#formPreset').addEventListener('change', (e) => renderThresholdEditor(e.target.value));
$('#resetThresholds').addEventListener('click', () => {
  state.settings.customThresholds = {};
  renderThresholdEditor($('#formPreset').value);
});
$('#savePreset').addEventListener('click', () => {
  const key = $('#formPreset').value;
  const base = getThresholds({ formPreset: key });
  const custom = {};
  document.querySelectorAll('[data-th]').forEach((i) => {
    const v = Number(i.value);
    if (i.value !== '' && Number.isFinite(v) && v !== base[i.dataset.th]) custom[i.dataset.th] = v;
  });
  state.settings.formPreset = key;
  state.settings.customThresholds = custom;
  persist();
  renderThresholdEditor(key);
  $('#presetMsg').textContent = `저장됨 (직접 수정 ${Object.keys(custom).length}개)`;
  setTimeout(() => { $('#presetMsg').textContent = ''; }, 2500);
});

// ---------- 설정 ----------
function fillSettings() {
  renderPreset();
  renderE1rmTable();
  const f = $('#settingsForm');
  for (const [k, v] of Object.entries(state.settings)) if (f.elements[k]) f.elements[k].value = v;
  $('#garminPass').value = state.garmin.passphrase;
  $('#garminUrl').value = state.garmin.url;
}
$('#saveSettings').addEventListener('click', () => {
  const f = $('#settingsForm');
  const numeric = ['squat1rm', 'bench1rm', 'deadlift1rm', 'ohp1rm', 'tmPercent', 'weeklyKm', 'hrMax', 'hrRest'];
  for (const k of Object.keys(state.settings)) {
    if (!f.elements[k]) continue;
    const v = f.elements[k].value;
    state.settings[k] = numeric.includes(k) ? Number(v) : v;
  }
  if (!Number.isFinite(parseTime(state.settings.fiveK))) state.settings.fiveK = '25:00';
  persist();
  viewWeek = weekIndex(state.settings.startDate);
  $('#settingsMsg').textContent = '저장되었습니다.';
  setTimeout(() => { $('#settingsMsg').textContent = ''; }, 2000);
});
$('#garminSync').addEventListener('click', async () => {
  state.garmin.passphrase = $('#garminPass').value;
  state.garmin.url = $('#garminUrl').value.trim() || 'data/garmin.enc.json';
  persist();
  await syncGarmin(true);
});
$('#exportData').addEventListener('click', () => {
  const copy = { ...state, garmin: { ...state.garmin, passphrase: '' } };
  const blob = new Blob([JSON.stringify(copy, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `workout-backup-${todayISO()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$('#importData').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.settings) throw new Error('형식 오류');
    const base = defaultState();
    const pass = state.garmin.passphrase;
    Object.assign(state, base, data, { settings: { ...base.settings, ...data.settings }, garmin: { ...base.garmin, ...(data.garmin || {}), passphrase: pass } });
    persist();
    alert('가져오기 완료');
    showTab('today');
  } catch {
    alert('백업 파일을 읽을 수 없습니다.');
  }
});
$('#resetData').addEventListener('click', () => {
  if (!confirm('모든 기록과 설정을 삭제할까요? 되돌릴 수 없습니다.')) return;
  Object.assign(state, defaultState());
  persist();
  showTab('settings');
});

// ---------- 초기화 ----------
let firstVisit = false;
try { firstVisit = !localStorage.getItem('workout-app-v1'); } catch { /* 저장소 사용 불가 */ }
$('#formView').value = state.settings.formView || 'side';
{
  // 세트 기록 탭은 오늘 처방된 첫 메인 리프트로 시작
  const first = sessionFor(state.settings, new Date(), stats(), coachCtx()).items.find((i) => i.type === 'lift' && !i.variation);
  if (first) $('#formLift').value = first.lift;
}
prefillForm();
updateGuide();
renderToday();
if (firstVisit) {
  persist();
  showTab('settings');
  $('#settingsMsg').textContent = '처음이시네요! 1RM과 심박 정보를 입력하고 저장한 뒤, 가민 연동을 설정하세요.';
} else {
  syncGarmin();
}
