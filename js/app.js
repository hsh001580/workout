import { load, save, todayISO, uid, defaultState } from './storage.js';
import { buildWeek, weekIndex, sessionFor, fmtPace, fmtDuration, parseTime } from './program.js';
import { analyze, CHECKLIST, checklistScore, LIFT_LABEL } from './form-analysis.js';
import { evaluateRun, runStats, RUN_TYPES } from './run-analysis.js';
import { fetchGarmin, toRunLog } from './garmin.js';

const state = load();
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const scoreClass = (s) => (s >= 85 ? 's-good' : s >= 65 ? 's-warn' : 's-bad');
const persist = () => save(state);
const stats = (date = new Date()) => runStats(state.runLogs, date, state.garmin.vo2max);
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
    + (s.vo2 ? ` · ${esc(s.vo2Source)} ${s.vo2.toFixed(1)} (5K 환산 ${fmtDuration(s.fiveKSec)})` : '')
    + (s.acwr && s.acwr > 1.3 ? ' · 최근 부하 급증으로 거리 동결' : '');
}

function renderWeek() {
  const weekStart = new Date(state.settings.startDate + 'T00:00:00');
  weekStart.setDate(weekStart.getDate() + viewWeek * 7);
  const w = buildWeek(state.settings, viewWeek, stats(weekStart));
  $('#weekTitle').textContent = `${viewWeek + 1}주차 (${fmtDate(w.days[0].date)}~${fmtDate(w.days[6].date)})`;
  $('#weekMeta').innerHTML = `${esc(w.wave.name)} · TM 스쿼트 ${Math.round(w.tm.squat)} / 벤치 ${Math.round(w.tm.bench)} / 데드 ${Math.round(w.tm.deadlift)} / OHP ${Math.round(w.tm.ohp)}kg${w.wave.deload ? ' · <b>회복에 집중</b>' : ''}<br>${runBasisText(w)}`;
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
  const s = sessionFor(state.settings, now, stats());
  const wIdx = weekIndex(state.settings.startDate);
  const w = buildWeek(state.settings, wIdx, stats());
  const lifts = s.items.filter((i) => i.type === 'lift');
  const runs = s.items.filter((i) => i.type === 'run');
  const formToday = state.formLogs.filter((l) => l.date === today);
  const runToday = state.runLogs.filter((l) => l.date === today);

  let todo = '';
  if (lifts.length) {
    const pending = lifts.filter((l) => !formToday.some((f) => f.lift === l.lift));
    todo += pending.length
      ? `<li class="warn">${pending.map((l) => esc(LIFT_LABEL[l.lift])).join(', ')} 자세 평가가 남았습니다. <button class="link" data-go="form" data-lift="${pending[0].lift}">평가하러 가기 →</button></li>`
      : '<li class="good">오늘 메인 리프트 자세 평가 완료</li>';
  }
  if (runs.length) {
    if (runToday.length) todo += '<li class="good">오늘 러닝 평가 완료</li>';
    else if (state.garmin.passphrase) todo += '<li class="info">러닝 후 가민에 저장되면 자동으로 가져와 평가합니다 (최대 3시간 소요, 설정에서 즉시 불러오기 가능).</li>';
    else todo += '<li class="warn">가민 연동을 설정하면 러닝이 자동 평가됩니다. <button class="link" data-go="settings">설정하기 →</button></li>';
  }

  $('#tab-today').innerHTML = `
    <div class="card">
      <h2>${esc(s.name)}요일 · ${esc(s.rotation.title)}</h2>
      <p class="muted">${today} · ${wIdx + 1}주차 · ${esc(w.wave.name)}</p>
      ${s.rest ? '<p>오늘은 완전 휴식일입니다. 수면, 단백질, 가벼운 모빌리티에 집중하세요.</p>' : s.items.map((it, i) => itemHTML(it, `${today}-${it.type}-${it.lift || it.runType || i}`)).join('')}
    </div>
    ${todo ? `<div class="card"><h2>오늘 할 일</h2><ul class="fb">${todo}</ul></div>` : ''}
    ${formToday.length || runToday.length ? `<div class="card"><h2>오늘의 평가</h2>
      ${formToday.map((f) => `<div>${esc(LIFT_LABEL[f.lift])} ${f.weight ? esc(f.weight) + 'kg' : ''} <span class="badge ${scoreClass(f.score)}">${f.score}</span></div>`).join('')}
      ${runToday.map((r) => `<div>${esc(RUN_TYPES[r.type])} ${esc(r.distanceKm)}km <span class="badge ${scoreClass(r.result.score)}">${r.result.score}</span></div>`).join('')}
    </div>` : ''}
  `;
  bindDone($('#tab-today'));
  $('#tab-today').querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.lift) { $('#formLift').value = b.dataset.lift; prefillForm(); }
    showTab(b.dataset.go);
  }));
}

// ---------- 자세 평가 ----------
function renderChecklist() {
  const lift = $('#formLift').value;
  $('#formChecklist').innerHTML = CHECKLIST[lift].map((c, i) => `<label><input type="checkbox" data-ck="${i}" /> ${esc(c)}</label>`).join('');
}
// 오늘 처방된 무게/반복을 기본값으로
function prefillForm() {
  renderChecklist();
  const lift = $('#formLift').value;
  const it = sessionFor(state.settings, new Date(), stats()).items.find((i) => i.type === 'lift' && i.lift === lift);
  if (it) { $('#formReps').value = it.reps; $('#formWeight').value = it.kg; }
}
$('#formLift').addEventListener('change', prefillForm);

let videoFile = null;
$('#formVideo').addEventListener('change', async (e) => {
  videoFile = e.target.files[0] || null;
  const canvas = $('#formCanvas');
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  if (!videoFile) { $('#videoWrap').classList.add('hidden'); return; }
  const { loadVideo } = await import('./pose.js');
  try {
    await loadVideo($('#formVideoEl'), videoFile);
    $('#videoWrap').classList.remove('hidden');
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

const METRIC_KO = { depth: '깊이비', torso: '상체각', knee: '무릎각', elbow: '팔꿈치각', pause: '정지', kneeStart: '시작 무릎각', hipStart: '시작 고관절각', hipTop: '락아웃 고관절각', layback: '상체 젖힘' };
const METRIC_UNIT = { depth: '', pause: '초' };

$('#formAnalyze').addEventListener('click', async () => {
  const btn = $('#formAnalyze');
  const lift = $('#formLift').value;
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
      const frames = await pose.extractFrames(v, setProgress);
      video = analyze(frames, lift, aspect);
      if (video.ok) {
        const worst = video.reps.reduce((a, r) => (r.score < a.score ? r : a), video.reps[0]);
        await pose.drawKeyFrame(v, $('#formCanvas'), video.pts, worst.keyFrame, aspect, `${worst.rep}회차 ${lift === 'deadlift' ? '시작 자세' : lift === 'ohp' ? '시작 자세' : '최저점'}`);
      }
    } catch (err) {
      video = { ok: false, error: `영상 분석 실패: ${err.message}. 인터넷 연결을 확인하거나 체크리스트로만 평가하세요.` };
    } finally {
      btn.disabled = false;
    }
  }

  const score = video?.ok ? Math.round(video.score * 0.7 + selfScore * 0.3) : selfScore;
  const missed = checks.filter((c) => !c.checked).map((c) => CHECKLIST[lift][Number(c.dataset.ck)]);
  const tips = [];
  if (pain) tips.push({ level: 'bad', text: '통증 발생: 다음 세션은 무게를 10~20% 줄이고, 통증이 지속되면 전문가 상담' });
  if (rpe >= 9.5) tips.push({ level: 'warn', text: `RPE ${rpe}: 처방보다 힘듦. 다음 세션 무게를 2.5~5kg 낮추세요.` });
  else if (rpe && rpe <= 7) tips.push({ level: 'good', text: `RPE ${rpe}: 여유 있음. 다음 주기 증량 순조로움.` });
  missed.forEach((m) => tips.push({ level: 'warn', text: `다음 세트 집중 큐: ${m}` }));

  const log = {
    id: uid(), date: todayISO(), lift,
    weight: $('#formWeight').value, reps: $('#formReps').value, rpe, pain,
    note: $('#formNote').value.trim(),
    score, selfScore, videoScore: video?.ok ? video.score : null,
    videoSummary: video?.ok ? [...video.summary, ...video.reps.flatMap((r) => r.issues.filter((i) => i.level === 'bad'))].slice(0, 5) : [],
    tips,
  };
  state.formLogs.push(log);
  persist();

  $('#formResult').innerHTML = `<div class="card">
    <div class="score"><div class="num ${scoreClass(score)}">${score}</div>
      <div><h2>${esc(LIFT_LABEL[lift])} ${log.weight ? esc(log.weight) + 'kg' : ''} ${log.reps ? '× ' + esc(log.reps) : ''}</h2>
      <div class="muted">${video?.ok ? `영상 ${video.score}점 (70%) + 체크리스트 ${selfScore}점 (30%)` : `체크리스트 ${selfScore}점`}</div></div></div>
    ${video && !video.ok ? fbList([{ level: 'warn', text: video.error }]) : ''}
    ${video?.ok ? `<h3>세트 요약</h3>${fbList(video.summary.length ? video.summary : [{ level: 'info', text: `${video.reps.length}회 반복 인식` }])}
      <h3>반복별 분석</h3><div class="reps">${video.reps.map((r) => `<div class="rep">
        <h4><span>${r.rep}회차</span><span class="badge ${scoreClass(r.score)}">${r.score}</span></h4>
        <div class="kv">${Object.entries(r.metrics).map(([k, v]) => `<span>${METRIC_KO[k] || k} <b>${v}${METRIC_UNIT[k] ?? '°'}</b></span>`).join('')}
        ${r.ascent != null ? `<span>상승 <b>${r.ascent.toFixed(2)}초</b></span>` : ''}</div>
        ${fbList(r.issues)}</div>`).join('')}</div>` : ''}
    ${tips.length ? `<h3>코칭</h3>${fbList(tips)}` : ''}
  </div>`;
  $('#formResult').scrollIntoView({ behavior: 'smooth' });
});

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
  const planned = sessionFor(state.settings, date, st).items.find((i) => i.type === 'run');
  const detected = run.type;
  const evalRun = { ...run, type: planned && run.source === 'garmin' ? planned.runType : run.type };
  const history = state.runLogs.filter((r) => r.date < run.date || (r.date === run.date && r.id !== run.id && r.result));
  // 가민 VO2max/최근 기록이 있으면 그 기준 페이스로 평가
  const settings = st?.fiveKSec ? { ...state.settings, fiveK: st.fiveKSec } : state.settings;
  const result = evaluateRun(evalRun, settings, history, sessionFor(state.settings, nextDay(run.date), st));
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

// ---------- 가민 동기화 ----------
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
    if (data.restingHr) { g.restingHr = data.restingHr; state.settings.hrRest = data.restingHr; }
    const observedMax = Math.max(0, ...data.runs.map((r) => r.maxHr || 0));
    if (observedMax > state.settings.hrMax && observedMax < 225) state.settings.hrMax = observedMax;

    const have = new Set(state.runLogs.map((r) => r.id));
    const fresh = data.runs.filter((r) => !have.has('g' + r.id) && r.distanceKm > 0.5 && r.durationSec > 0);
    for (const gr of fresh.sort((a, b) => a.start.localeCompare(b.start))) {
      const log = toRunLog(gr, state.settings);
      const result = evaluateLog(log);
      if (!result.ok) continue;
      storeResult(log, result);
      state.runLogs.push(log);
    }
    state.runLogs.sort((a, b) => a.date.localeCompare(b.date));
    persist();
    status.textContent = `완료: 새 러닝 ${fresh.length}개 · 전체 ${data.runs.length}개 (가민 동기화 ${new Date(data.updated).toLocaleString('ko-KR')})`;
    if (fresh.length || manual) rerenderActive();
  } catch (err) {
    status.textContent = `가민 불러오기 실패: ${err.message}`;
    if (manual) alert(status.textContent);
  }
}

// ---------- 기록 ----------
function avg(arr) { return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : '-'; }

function renderHistory() {
  const forms = [...state.formLogs].sort((a, b) => b.date.localeCompare(a.date));
  const runs = [...state.runLogs].sort((a, b) => b.date.localeCompare(a.date));
  const byLift = (l) => state.formLogs.filter((f) => f.lift === l).slice(-5).map((f) => f.score);
  $('#tab-history').innerHTML = `
    <div class="card"><h2>최근 추세</h2><div class="stats">
      ${['squat', 'bench', 'deadlift', 'ohp'].map((l) => `<div class="stat"><div class="l">${LIFT_LABEL[l]} 최근 5회</div><div class="v">${avg(byLift(l))}</div></div>`).join('')}
      <div class="stat"><div class="l">러닝 최근 5회</div><div class="v">${avg(state.runLogs.slice(-5).map((r) => r.result.score))}</div></div>
    </div></div>
    <div class="card"><h2>자세 평가 기록</h2>${forms.length ? `<div class="table-wrap"><table>
      <tr><th>날짜</th><th>종목</th><th>무게×반복</th><th>RPE</th><th>점수</th><th>주요 피드백</th><th></th></tr>
      ${forms.map((f) => `<tr><td>${esc(f.date)}</td><td>${esc(LIFT_LABEL[f.lift])}</td><td>${esc(f.weight || '-')}×${esc(f.reps || '-')}</td><td>${esc(f.rpe ?? '-')}</td>
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
  $('#tab-history').querySelectorAll('[data-del-form]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm('이 기록을 삭제할까요?')) return;
    state.formLogs = state.formLogs.filter((f) => f.id !== b.dataset.delForm); persist(); renderHistory();
  }));
  $('#tab-history').querySelectorAll('[data-del-run]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm('이 기록을 삭제할까요?')) return;
    state.runLogs = state.runLogs.filter((r) => r.id !== b.dataset.delRun); persist(); renderHistory();
  }));
}

// ---------- 설정 ----------
function fillSettings() {
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
prefillForm();
renderToday();
if (firstVisit) {
  persist();
  showTab('settings');
  $('#settingsMsg').textContent = '처음이시네요! 1RM과 심박 정보를 입력하고 저장한 뒤, 가민 연동을 설정하세요.';
} else {
  syncGarmin();
}
