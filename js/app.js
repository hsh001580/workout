import { load, save, todayISO, uid, defaultState } from './storage.js';
import { buildWeek, weekIndex, sessionFor, fmtPace, fmtDuration, parseTime } from './program.js';
import { analyze, CHECKLIST, checklistScore, LIFT_LABEL } from './form-analysis.js';
import { evaluateRun, RUN_TYPES } from './run-analysis.js';

const state = load();
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const scoreClass = (s) => (s >= 85 ? 's-good' : s >= 65 ? 's-warn' : 's-bad');
const persist = () => save(state);

// ---------- 탭 ----------
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  if (name === 'today') renderToday();
  if (name === 'program') renderWeek();
  if (name === 'history') renderHistory();
  if (name === 'settings') fillSettings();
  window.scrollTo(0, 0);
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

function dateOf(weekIdx, dayIdx) {
  const d = new Date(state.settings.startDate + 'T00:00:00');
  d.setDate(d.getDate() + weekIdx * 7 + dayIdx);
  return d;
}

function renderWeek() {
  const w = buildWeek(state.settings, viewWeek);
  const start = dateOf(viewWeek, 0);
  const end = dateOf(viewWeek, 6);
  const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  $('#weekTitle').textContent = `${viewWeek + 1}주차 (${fmt(start)}~${fmt(end)})`;
  $('#weekMeta').innerHTML = `${esc(w.wave.name)} · 러닝 ${w.weeklyKm}km · TM 스쿼트 ${Math.round(w.tm.squat)} / 벤치 ${Math.round(w.tm.bench)} / 데드 ${Math.round(w.tm.deadlift)}kg${w.wave.deload ? ' · <b>디로드 주간: 회복에 집중</b>' : ''}`;
  const today = todayISO();
  $('#weekGrid').innerHTML = w.days.map((d) => {
    const iso = todayISO(dateOf(viewWeek, d.dayIdx));
    return `<div class="day ${d.rest ? 'rest' : ''} ${iso === today ? 'today' : ''}">
      <header><b>${d.name} <span class="muted">${fmt(dateOf(viewWeek, d.dayIdx))}</span></b>${iso === today ? '<span class="badge s-good">오늘</span>' : ''}</header>
      ${d.rest ? '<div class="muted">휴식 · 가벼운 걷기·모빌리티</div>' : d.items.map((it, i) => itemHTML(it, `${iso}-${i}`)).join('')}
    </div>`;
  }).join('');
  bindDone($('#weekGrid'));
}

// ---------- 오늘 ----------
function renderToday() {
  const today = todayISO();
  const s = sessionFor(state.settings, new Date());
  const wIdx = weekIndex(state.settings.startDate);
  const w = buildWeek(state.settings, wIdx);
  const lifts = s.items.filter((i) => i.type === 'lift');
  const runs = s.items.filter((i) => i.type === 'run');
  const formToday = state.formLogs.filter((l) => l.date === today);
  const runToday = state.runLogs.filter((l) => l.date === today);

  let todo = '';
  if (lifts.length) {
    const pending = lifts.filter((l) => !formToday.some((f) => f.lift === l.lift));
    todo += pending.length
      ? `<li class="warn">오늘 ${pending.map((l) => esc(LIFT_LABEL[l.lift])).join(', ')} 자세 평가가 남았습니다. <button class="link" data-go="form" data-lift="${pending[0].lift}">평가하러 가기 →</button></li>`
      : '<li class="good">오늘 메인 리프트 자세 평가 완료</li>';
  }
  if (runs.length) {
    todo += runToday.length
      ? '<li class="good">오늘 러닝 평가 완료</li>'
      : `<li class="warn">러닝 후 평가를 기록하세요. <button class="link" data-go="run" data-runtype="${runs[0].runType}">평가하러 가기 →</button></li>`;
  }

  $('#tab-today').innerHTML = `
    <div class="card">
      <h2>${esc(s.name)}요일 · ${esc(w.wave.name)}</h2>
      <p class="muted">${today} · ${wIdx + 1}주차</p>
      ${s.rest ? '<p>오늘은 휴식일입니다. 수면, 단백질, 가벼운 모빌리티에 집중하세요.</p>' : s.items.map((it, i) => itemHTML(it, `${today}-${i}`)).join('')}
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
    if (b.dataset.runtype) $('#runType').value = b.dataset.runtype;
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
  const s = sessionFor(state.settings, new Date());
  const it = s.items.find((i) => i.type === 'lift' && i.lift === lift);
  if (it) {
    const m = it.detail.match(/(\d+)세트 × (\d+)회 @ ([\d.]+)kg/);
    if (m) { $('#formReps').value = m[2]; $('#formWeight').value = m[3]; }
  }
}
$('#formLift').addEventListener('change', prefillForm);

let videoFile = null;
$('#formVideo').addEventListener('change', async (e) => {
  videoFile = e.target.files[0] || null;
  const wrap = $('#videoWrap');
  const canvas = $('#formCanvas');
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  if (!videoFile) { wrap.classList.add('hidden'); return; }
  const { loadVideo } = await import('./pose.js');
  try {
    await loadVideo($('#formVideoEl'), videoFile);
    wrap.classList.remove('hidden');
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

function fbList(items) {
  return `<ul class="fb">${items.map((i) => `<li class="${i.level}">${esc(i.text)}</li>`).join('')}</ul>`;
}

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
        await pose.drawKeyFrame(v, $('#formCanvas'), video.pts, worst.keyFrame, aspect, `${worst.rep}회차 ${lift === 'deadlift' ? '시작 자세' : '최저점'}`);
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
  if (rpe >= 9.5) tips.push({ level: 'warn', text: `RPE ${rpe}: 처방보다 힘듦. 다음 헤비 세션 무게를 2.5~5kg 낮추세요.` });
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
        <div class="kv">${Object.entries(r.metrics).map(([k, v]) => `<span>${METRIC_KO[k] || k} <b>${v}${k === 'depth' ? '' : k === 'pause' ? '초' : '°'}</b></span>`).join('')}
        ${r.ascent != null ? `<span>상승 <b>${r.ascent.toFixed(2)}초</b></span>` : ''}</div>
        ${fbList(r.issues)}</div>`).join('')}</div>` : ''}
    ${tips.length ? `<h3>코칭</h3>${fbList(tips)}` : ''}
  </div>`;
  $('#formResult').scrollIntoView({ behavior: 'smooth' });
});

const METRIC_KO = { depth: '깊이비', torso: '상체각', knee: '무릎각', elbow: '팔꿈치각', pause: '정지', kneeStart: '시작 무릎각', hipStart: '시작 고관절각', hipTop: '락아웃 고관절각' };

// ---------- 러닝 평가 ----------
$('#runType').innerHTML = Object.entries(RUN_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
$('#runDate').value = todayISO();
function prefillRun() {
  const s = sessionFor(state.settings, new Date($('#runDate').value + 'T12:00:00'));
  const r = s.items.find((i) => i.type === 'run');
  if (r) $('#runType').value = r.runType;
}
$('#runDate').addEventListener('change', prefillRun);

$('#runEval').addEventListener('click', () => {
  const run = {
    id: uid(),
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
  const next = new Date(run.date + 'T12:00:00');
  next.setDate(next.getDate() + 1);
  const history = state.runLogs.filter((r) => r.date <= run.date);
  const result = evaluateRun(run, state.settings, history, sessionFor(state.settings, next));
  if (!result.ok) { $('#runResult').innerHTML = `<div class="card">${fbList([{ level: 'bad', text: result.error }])}</div>`; return; }
  run.result = { score: result.score, load: result.load, zone: result.zone, efficiency: result.efficiency, pace: result.pace, vdot: result.vdot, items: result.items };
  state.runLogs.push(run);
  persist();

  const update5k = result.predicted5k && result.predicted5k < parseTime(state.settings.fiveK) - 3;
  $('#runResult').innerHTML = `<div class="card">
    <div class="score"><div class="num ${scoreClass(result.score)}">${result.score}</div>
      <div><h2>${esc(RUN_TYPES[run.type])} ${esc(run.distanceKm)}km</h2><div class="muted">${esc(run.date)}</div></div></div>
    <div class="stats">
      <div class="stat"><div class="l">평균 페이스</div><div class="v">${fmtPace(result.pace)}/km</div></div>
      <div class="stat"><div class="l">시간</div><div class="v">${fmtDuration(parseTime(run.duration))}</div></div>
      <div class="stat"><div class="l">심박 존</div><div class="v">${result.zone ? 'Z' + result.zone : '-'}</div></div>
      <div class="stat"><div class="l">훈련 부하</div><div class="v">${result.load}</div></div>
      <div class="stat"><div class="l">ACWR</div><div class="v">${result.acwr ? result.acwr.toFixed(2) : '-'}</div></div>
      ${result.vdot ? `<div class="stat"><div class="l">VDOT</div><div class="v">${result.vdot.toFixed(1)}</div></div>` : ''}
    </div>
    ${fbList(result.items)}
    ${update5k ? `<button id="apply5k">5K 기록을 ${fmtDuration(result.predicted5k)}로 업데이트 (훈련 페이스 갱신)</button>` : ''}
  </div>`;
  if (update5k) {
    $('#apply5k').addEventListener('click', (e) => {
      state.settings.fiveK = fmtDuration(Math.round(result.predicted5k));
      persist();
      e.target.textContent = '업데이트 완료';
      e.target.disabled = true;
    });
  }
  $('#runResult').scrollIntoView({ behavior: 'smooth' });
});

// ---------- 기록 ----------
function avg(arr) { return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : '-'; }

function renderHistory() {
  const forms = [...state.formLogs].sort((a, b) => b.date.localeCompare(a.date));
  const runs = [...state.runLogs].sort((a, b) => b.date.localeCompare(a.date));
  const byLift = (l) => state.formLogs.filter((f) => f.lift === l).slice(-5).map((f) => f.score);
  $('#tab-history').innerHTML = `
    <div class="card"><h2>최근 추세</h2><div class="stats">
      ${['squat', 'bench', 'deadlift'].map((l) => `<div class="stat"><div class="l">${LIFT_LABEL[l]} 최근 5회 평균</div><div class="v">${avg(byLift(l))}</div></div>`).join('')}
      <div class="stat"><div class="l">러닝 최근 5회 평균</div><div class="v">${avg(state.runLogs.slice(-5).map((r) => r.result.score))}</div></div>
      <div class="stat"><div class="l">최근 7일 러닝 거리</div><div class="v">${state.runLogs.filter((r) => (Date.now() - new Date(r.date)) / 86400000 < 7).reduce((a, r) => a + Number(r.distanceKm), 0).toFixed(1)}km</div></div>
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
      ${runs.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(RUN_TYPES[r.type])}</td><td>${esc(r.distanceKm)}km</td><td>${fmtPace(r.result.pace)}</td>
        <td>${r.result.zone ? 'Z' + r.result.zone : '-'}</td><td>${r.result.load}</td>
        <td><span class="badge ${scoreClass(r.result.score)}">${r.result.score}</span></td>
        <td><button class="link" data-del-run="${r.id}">삭제</button></td></tr>`).join('')}
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
}
$('#saveSettings').addEventListener('click', () => {
  const f = $('#settingsForm');
  const numeric = ['squat1rm', 'bench1rm', 'deadlift1rm', 'tmPercent', 'days', 'weeklyKm', 'hrMax', 'hrRest'];
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
$('#exportData').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
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
    Object.assign(state, defaultState(), data, { settings: { ...defaultState().settings, ...data.settings } });
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
prefillForm();
prefillRun();
renderToday();
let firstVisit = false;
try { firstVisit = !localStorage.getItem('workout-app-v1'); } catch { /* 저장소 사용 불가 */ }
if (firstVisit) {
  persist();
  showTab('settings');
  $('#settingsMsg').textContent = '처음이시네요! 1RM과 러닝 정보를 입력하고 저장하세요.';
}
