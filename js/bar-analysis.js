// 바벨 궤적 분석: 속도(VBT), 스티킹 포인트, 모멘트암, 미드풋 정렬, 하중-속도 1RM 추정

// 종목별 1RM 시점의 평균 동심성 속도(MVT, m/s)와 RIR 1당 속도 차이(대략값, 문헌 평균)
export const VBT = {
  squat: { mvt: 0.3, perRir: 0.07 },
  bench: { mvt: 0.17, perRir: 0.055 },
  deadlift: { mvt: 0.17, perRir: 0.06 },
  ohp: { mvt: 0.19, perRir: 0.06 },
};

function issue(level, text) {
  return { level, text };
}

function smooth(arr, key, w = 2) {
  return arr.map((p, i) => {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(arr.length - 1, i + w); j++) {
      if (arr[j].lost) continue;
      s += arr[j][key];
      n++;
    }
    return n ? s / n : p[key];
  });
}

// bar: [{t, x, y, lost}] (x, y는 영상 높이 기준 정규화 좌표), scale: 정규화 1단위당 m
export function barSeries(bar, scale) {
  const xs = smooth(bar, 'x');
  const ys = smooth(bar, 'y');
  const out = bar.map((b, i) => ({ t: b.t, x: xs[i], y: ys[i], lost: b.lost }));
  for (let i = 0; i < out.length; i++) {
    const a = out[Math.max(0, i - 1)];
    const b = out[Math.min(out.length - 1, i + 1)];
    const dt = b.t - a.t || 1;
    out[i].vy = (-(b.y - a.y) * scale) / dt; // 위로 +
  }
  return out;
}

function nearest(series, t) {
  let best = 0;
  for (let i = 1; i < series.length; i++) if (Math.abs(series[i].t - t) < Math.abs(series[best].t - t)) best = i;
  return best;
}

// 동심성 구간 속도 분석
export function concentric(series, t0, t1, scale) {
  const i0 = nearest(series, t0);
  const i1 = nearest(series, t1);
  if (i1 <= i0 + 1) return null;
  const seg = series.slice(i0, i1 + 1);
  const rise = (seg[0].y - seg[seg.length - 1].y) * scale; // m
  const dur = seg[seg.length - 1].t - seg[0].t;
  if (rise <= 0.03 || dur <= 0) return null;
  const mcv = rise / dur;
  let peakI = 0;
  seg.forEach((p, i) => { if (p.vy > seg[peakI].vy) peakI = i; });
  const peak = seg[peakI].vy;

  // 스티킹 포인트: 초반 가속 이후 속도가 크게 떨어졌다가 다시 오르는 지점
  let sticking = null;
  let firstPeak = -1;
  for (let i = 1; i < seg.length - 1; i++) {
    if (seg[i].vy >= seg[i - 1].vy && seg[i].vy >= seg[i + 1].vy && seg[i].vy > 0.3 * peak) { firstPeak = i; break; }
  }
  if (firstPeak > 0) {
    let minI = -1;
    for (let i = firstPeak + 1; i < seg.length - 1; i++) {
      const h = (seg[0].y - seg[i].y) * scale / rise;
      if (h > 0.9) break;
      if (minI < 0 || seg[i].vy < seg[minI].vy) minI = i;
    }
    if (minI > 0) {
      const after = Math.max(...seg.slice(minI).map((p) => p.vy));
      const dip = seg[firstPeak].vy - seg[minI].vy;
      if (dip > 0.25 * seg[firstPeak].vy && after > seg[minI].vy + 0.05) {
        sticking = { t: seg[minI].t, heightPct: Math.round(((seg[0].y - seg[minI].y) * scale / rise) * 100), v: seg[minI].vy };
      }
    }
  }
  return { mcv, peak, rise, dur, sticking, i0, i1 };
}

export function rirFromVelocity(lift, v) {
  const p = VBT[lift];
  if (!p || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(6, (v - p.mvt) / p.perRir));
}

// 하중-속도 관계로 1RM 추정 (서로 다른 무게 2개 이상 필요)
export function estimate1RM(points, lift) {
  const pts = points.filter((p) => p.kg > 0 && p.mcv > 0);
  const kgs = pts.map((p) => p.kg);
  if (pts.length < 2 || Math.max(...kgs) < Math.min(...kgs) * 1.1) return null;
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p.mcv, 0) / n;
  const my = pts.reduce((a, p) => a + p.kg, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of pts) { sxy += (p.mcv - mx) * (p.kg - my); sxx += (p.mcv - mx) ** 2; }
  if (!sxx) return null;
  const slope = sxy / sxx;
  if (slope >= 0) return null; // 무거울수록 느려야 정상
  const kg = my + slope * (VBT[lift].mvt - mx);
  return kg > Math.max(...kgs) ? Math.round(kg * 2) / 2 : null;
}

const midfoot = (p) => (p.ankle.x + p.toe.x) / 2;

/**
 * 반복별 바벨 분석
 * @param reps form-analysis의 반복 결과 (conc: [t0, t1] 포함)
 * @param pts 측면 관절 좌표 (form-analysis extract 결과)
 * @param opts { lift, scale, sideView, T, frontalAt(t) }
 */
export function analyzeBar(series, reps, pts, opts) {
  const { lift, scale, sideView, T, frontalAt } = opts;
  const cm = (u) => u * scale * 100;
  const facing = pts.length ? Math.sign(pts[0].p.toe.x - pts[0].p.ankle.x) || 1 : 1;
  const repOut = reps.map((r) => {
    const out = { rep: r.rep, issues: [], metrics: {} };
    if (!r.conc) return out;
    const c = concentric(series, r.conc[0], r.conc[1], scale);
    if (!c) return out;
    out.mcv = c.mcv;
    out.metrics.mcv = +c.mcv.toFixed(2);
    out.metrics.peak = +c.peak.toFixed(2);
    out.sticking = c.sticking;

    if (sideView && pts.length) {
      // 모멘트암·미드풋 (측면에서만 유효)
      const ptAt = (t) => pts[nearest(pts, t)].p;
      const seg = series.slice(c.i0, c.i1 + 1);
      if (lift !== 'bench') {
        const devs = seg.map((b) => cm((b.x - midfoot(ptAt(b.t))) * facing));
        const maxDev = devs.reduce((a, d) => (Math.abs(d) > Math.abs(a) ? d : a), 0);
        out.metrics.midfootCm = +maxDev.toFixed(1);
        const dir = maxDev > 0 ? '발 앞쪽(앞꿈치)' : '발 뒤쪽(뒤꿈치)';
        if (Math.abs(maxDev) > T.midfootBadCm) out.issues.push(issue('bad', `바벨이 미드풋에서 ${Math.abs(maxDev).toFixed(1)}cm 벗어나 ${dir}으로 무게중심 이동: 발 전체로 지면을 누르며 바를 발 중앙 위로`));
        else if (Math.abs(maxDev) > T.midfootWarnCm) out.issues.push(issue('warn', `바벨이 미드풋에서 ${Math.abs(maxDev).toFixed(1)}cm 벗어남 (${dir})`));
        else out.issues.push(issue('good', `바벨이 미드풋 위 유지 (최대 ${Math.abs(maxDev).toFixed(1)}cm)`));

        const startP = ptAt(seg[0].t);
        const hipMA0 = Math.abs(cm(seg[0].x - startP.hip.x));
        const kneeMA0 = Math.abs(cm(seg[0].x - startP.knee.x));
        out.metrics.hipMA = +hipMA0.toFixed(1);
        out.metrics.kneeMA = +kneeMA0.toFixed(1);
        // 상승 초반 40% 구간에서 고관절 모멘트암이 커지면 가슴이 무너지는 것
        const k = Math.max(1, Math.round(seg.length * 0.4));
        const hipMAk = Math.max(...seg.slice(0, k + 1).map((b) => Math.abs(cm(b.x - ptAt(b.t).hip.x))));
        const rise = hipMA0 > 1 ? ((hipMAk - hipMA0) / hipMA0) * 100 : 0;
        out.metrics.hipMARise = Math.round(rise);
        if (lift !== 'ohp' && rise > T.hipMomentRisePct) out.issues.push(issue('warn', `상승 초반 고관절 모멘트암 ${Math.round(rise)}% 증가: 허리·고관절에 부하가 몰림. 가슴과 엉덩이를 같은 속도로 올리기`));
      } else {
        // 벤치: 락아웃에서 바가 어깨 관절 위에 오는지, 수평 이동량
        const topP = ptAt(seg[seg.length - 1].t);
        const overShoulder = cm(seg[seg.length - 1].x - topP.shoulder.x);
        const travel = cm(Math.max(...seg.map((b) => b.x)) - Math.min(...seg.map((b) => b.x)));
        out.metrics.lockoutOffsetCm = +overShoulder.toFixed(1);
        out.metrics.travelCm = +travel.toFixed(1);
        if (Math.abs(overShoulder) > 6) out.issues.push(issue('warn', `락아웃에서 바가 어깨 관절에서 ${Math.abs(overShoulder).toFixed(1)}cm 벗어남: 바를 어깨 위 수직으로 마무리`));
        else out.issues.push(issue('good', '락아웃에서 바가 어깨 위에 위치'));
      }
    }

    // 스티킹 포인트 원인 진단
    if (c.sticking) {
      const causes = [];
      if (sideView && pts.length) {
        const s0 = pts[nearest(pts, seg0t(series, c))].p;
        const ss = pts[nearest(pts, c.sticking.t)].p;
        const lean = (p) => (Math.atan2(Math.abs(p.shoulder.x - p.hip.x), Math.abs(p.hip.y - p.shoulder.y)) * 180) / Math.PI;
        const dLean = lean(ss) - lean(s0);
        if (lift !== 'bench' && dLean > 5) causes.push(`상체 ${dLean.toFixed(0)}° 숙여짐`);
        if (lift !== 'bench') {
          const hm0 = Math.abs(series[c.i0].x - s0.hip.x);
          const hms = Math.abs(series[nearest(series, c.sticking.t)].x - ss.hip.x);
          if (hm0 > 0 && hms / hm0 > 1.15) causes.push(`고관절 모멘트암 +${Math.round((hms / hm0 - 1) * 100)}%`);
        }
      }
      const f = frontalAt?.(c.sticking.t);
      if (f?.valgus > T.valgusWarn) causes.push(`무릎 안쪽으로 ${f.valgus.toFixed(0)}° 모임`);
      if (f?.hipShiftCm > T.hipShiftWarnCm) causes.push(`골반 ${f.hipShiftDir}으로 ${f.hipShiftCm.toFixed(1)}cm 이동`);
      const where = { squat: '무릎 높이 근처', deadlift: '무릎 근처', bench: '가슴에서 조금 위', ohp: '이마 높이 근처' }[lift] || '';
      out.issues.push(issue(causes.length ? 'bad' : 'info',
        `스티킹 포인트: 상승 ${c.sticking.heightPct}% 지점(${where})에서 속도 ${c.sticking.v.toFixed(2)}m/s로 급감`
        + (causes.length ? ` → 힘이 새는 원인: ${causes.join(', ')}` : '. 자세 붕괴 없이 근력 한계 구간: 해당 구간 보강(퍼즈·핀 운동) 권장')));
    }
    return out;
  });

  // 세트 요약: 속도 손실, RIR 추정
  const summary = [];
  const mcvs = repOut.map((r) => r.mcv).filter(Number.isFinite);
  let velocityLoss = null;
  let rir = null;
  if (mcvs.length) {
    const best = Math.max(...mcvs);
    const last = mcvs[mcvs.length - 1];
    rir = rirFromVelocity(lift, last);
    if (mcvs.length >= 2) {
      velocityLoss = ((best - last) / best) * 100;
      if (velocityLoss > T.velocityLossWarn) summary.push(issue('warn', `세트 내 속도 손실 ${velocityLoss.toFixed(0)}%: 피로 누적이 커서 근력보다 피로가 쌓이는 세트. 반복 수 줄이기 고려`));
      else summary.push(issue('good', `세트 내 속도 손실 ${velocityLoss.toFixed(0)}%`));
    }
    summary.push(issue('info', `마지막 반복 평균 속도 ${last.toFixed(2)}m/s → 추정 RIR ${rir.toFixed(1)} (RPE ${(10 - rir).toFixed(1)}). 개인차가 커서 참고용`));
  }
  return { reps: repOut, summary, velocityLoss, rir, bestMcv: mcvs.length ? Math.max(...mcvs) : null };
}

function seg0t(series, c) {
  return series[c.i0].t;
}
