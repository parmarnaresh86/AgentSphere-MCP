// ── Analytics card chart engine ──────────────────────────────────────────────
// Powers the "📈 Charts" tab of renderAnalyticsCard (index.html). Profiles the
// result rows (label column, numeric series, time-like or categorical), offers
// only the chart types that fit that shape (30+ in total, all native Chart.js
// 4 — no plugins), recommends the best few, and adds analytics components:
// KPI strip, average/trend overlays, data labels, sorting and PNG export.
//
// Globals used from index.html: _atblStore, window.Chart.
(function () {
  const PALETTE = ['#0070F3', '#00A28A', '#E9730C', '#8B37BF', '#CF4B00', '#0F5132', '#D63384', '#6F42C1', '#20C997', '#FFC107', '#6C757D', '#198754'];
  const POS = '#16A34A', NEG = '#DC2626', MUTED = '#9CA3AF';

  // ── Formatting — international units K / M / B (no INR Lakh / Crore).
  function fmtC(v) {
    const n = Number(v); if (!isFinite(n)) return '';
    const a = Math.abs(n), s = n < 0 ? '-' : '';
    if (a >= 1e9) return s + (a / 1e9).toFixed(2).replace(/\.?0+$/, '') + ' B';
    if (a >= 1e6) return s + (a / 1e6).toFixed(2).replace(/\.?0+$/, '') + ' M';
    if (a >= 1e3) return s + (a / 1e3).toFixed(1).replace(/\.0$/, '') + ' K';
    return s + (Number.isInteger(a) ? a : a.toFixed(2));
  }
  const fmtFull = v => Number(v).toLocaleString(window.APP_LOCALE || 'en-US', { maximumFractionDigits: 2 });
  const fmtPct = v => (v > 0 ? '+' : '') + Number(v).toFixed(1) + '%';
  const alpha = (hex, a) => hex + a;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── Data profiling ─────────────────────────────────────────────────────────
  const isNum = v => v !== null && v !== undefined && v !== '' && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(String(v).trim());
  const ID_COL = /^(docnum|docentry|linenum|lineno|id|basenum|baseentry)$/i;
  const LABEL_LIKE = /^(year|month|mon|monthno|quarter|qtr|week|day|period|fy|date)$/i;
  const MONTH_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

  function profile(rows) {
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const numeric = cols.filter(c => rows.some(r => isNum(r[c])) && rows.slice(0, 25).every(r => r[c] === null || r[c] === '' || isNum(r[c])));
    let labelCol = cols.find(c => !numeric.includes(c));
    if (!labelCol) labelCol = cols.find(c => LABEL_LIKE.test(c.replace(/[_\s]/g, ''))) || cols[0];
    const valCols = numeric.filter(c => c !== labelCol && !ID_COL.test(c.replace(/[_\s]/g, ''))).slice(0, 6);
    const labels = rows.map(r => String(r[labelCol] ?? ''));
    const series = valCols.map(c => ({ name: c, data: rows.map(r => parseFloat(r[c]) || 0) }));
    const timeLike = /month|date|year|period|week|quarter|qtr|day|\bfy\b/i.test(labelCol)
      || (labels.length > 0 && labels.slice(0, 6).every(l => MONTH_RE.test(l) || /^\d{4}([-/]\d{1,2})?([-/]\d{1,2})?/.test(l) || /^(q[1-4]|w\d+|fy)/i.test(l)));
    const allPos = series.length > 0 && series[0].data.every(v => v >= 0);
    return { cols, labelCol, valCols, labels, series, n: rows.length, s: series.length, timeLike, allPos };
  }

  // ── Chart catalog ──────────────────────────────────────────────────────────
  // needs(p) decides whether the type is offered for this data at all.
  const any = p => p.s >= 1 && p.n >= 1;
  const multi = p => p.s >= 2 && p.n >= 1;
  const series3 = p => p.s >= 1 && p.n >= 3;
  const share = p => p.s >= 1 && p.allPos && p.n >= 2 && p.n <= 30;
  const CATALOG = [
    // Comparison
    { id: 'bar',        label: 'Column',            icon: '📊', group: 'Comparison',   needs: any },
    { id: 'hbar',       label: 'Bar',               icon: '📶', group: 'Comparison',   needs: any },
    { id: 'stacked',    label: 'Stacked column',    icon: '🧱', group: 'Comparison',   needs: multi },
    { id: 'hstacked',   label: 'Stacked bar',       icon: '🧱', group: 'Comparison',   needs: multi },
    { id: 'stacked100', label: '100% stacked',      icon: '💯', group: 'Comparison',   needs: p => multi(p) && p.allPos },
    { id: 'lollipop',   label: 'Lollipop',          icon: '🍭', group: 'Comparison',   needs: any },
    { id: 'variance',   label: 'Variance A−B',      icon: '⚖️', group: 'Comparison',   needs: multi },
    { id: 'ranking',    label: 'Top-N ranking',     icon: '🏆', group: 'Comparison',   needs: p => any(p) && p.n >= 3 },
    // Trend
    { id: 'line',       label: 'Line',              icon: '📈', group: 'Trend',        needs: p => any(p) && p.n >= 2 },
    { id: 'smooth',     label: 'Smooth line',       icon: '〰️', group: 'Trend',        needs: p => any(p) && p.n >= 3 },
    { id: 'stepped',    label: 'Stepped line',      icon: '📉', group: 'Trend',        needs: p => any(p) && p.n >= 2 },
    { id: 'area',       label: 'Area',              icon: '⛰️', group: 'Trend',        needs: p => any(p) && p.n >= 2 },
    { id: 'stackedarea',label: 'Stacked area',      icon: '🏔️', group: 'Trend',        needs: p => multi(p) && p.n >= 2 },
    { id: 'cumulative', label: 'Running total',     icon: '➕', group: 'Trend',        needs: p => any(p) && p.n >= 2 },
    { id: 'movingavg',  label: 'Moving average',    icon: '🌊', group: 'Trend',        needs: p => any(p) && p.n >= 4 },
    { id: 'growth',     label: 'Growth %',          icon: '🚀', group: 'Trend',        needs: p => (multi(p) || p.n >= 3) },
    { id: 'trendline',  label: 'Trend line',        icon: '📐', group: 'Trend',        needs: series3 },
    // Composition
    { id: 'pie',        label: 'Pie',               icon: '🥧', group: 'Composition',  needs: share },
    { id: 'doughnut',   label: 'Doughnut',          icon: '🍩', group: 'Composition',  needs: share },
    { id: 'semi',       label: 'Semi-doughnut',     icon: '🌓', group: 'Composition',  needs: share },
    { id: 'polar',      label: 'Polar area',        icon: '🎯', group: 'Composition',  needs: share },
    { id: 'waterfall',  label: 'Waterfall',         icon: '💧', group: 'Composition',  needs: p => any(p) && p.n >= 2 && p.n <= 40 },
    { id: 'funnel',     label: 'Funnel',            icon: '🔻', group: 'Composition',  needs: p => share(p) && p.n <= 15 },
    { id: 'heatmap',    label: 'Heatmap table',     icon: '🟥', group: 'Composition',  needs: p => any(p) && p.n >= 2 },
    // Distribution & relationship
    { id: 'radar',      label: 'Radar',             icon: '🕸️', group: 'Distribution', needs: p => any(p) && p.n >= 3 && p.n <= 24 },
    { id: 'scatter',    label: 'Scatter',           icon: '⚬',  group: 'Distribution', needs: p => p.s >= 2 && p.n >= 3 },
    { id: 'bubble',     label: 'Bubble',            icon: '🫧', group: 'Distribution', needs: p => p.s >= 3 && p.n >= 3 },
    { id: 'histogram',  label: 'Histogram',         icon: '📦', group: 'Distribution', needs: p => any(p) && p.n >= 8 },
    { id: 'boxstats',   label: 'Min–Avg–Max',       icon: '📏', group: 'Distribution', needs: p => any(p) && p.n >= 3 },
    // Analytical
    { id: 'pareto',     label: 'Pareto 80/20',      icon: '🎚️', group: 'Analytical',   needs: p => any(p) && p.allPos && p.n >= 3 },
    { id: 'combo',      label: 'Column + line',     icon: '🔀', group: 'Analytical',   needs: multi },
    { id: 'dualaxis',   label: 'Dual axis',         icon: '↕️', group: 'Analytical',   needs: multi },
    { id: 'share',      label: 'Share % column',    icon: '🥇', group: 'Analytical',   needs: p => share(p) },
  ];
  const GROUPS = ['Comparison', 'Trend', 'Composition', 'Distribution', 'Analytical'];
  const byId = Object.fromEntries(CATALOG.map(c => [c.id, c]));
  const ALIASES = { column: 'bar', horizontalBar: 'hbar', 'horizontal-bar': 'hbar', stacked_bar: 'stacked', polarArea: 'polar' };

  function available(p) { return CATALOG.filter(c => c.needs(p)); }

  function recommend(p) {
    let ids;
    if (p.timeLike) ids = p.s >= 2 ? ['bar', 'line', 'variance', 'growth', 'combo'] : ['line', 'area', 'growth', 'trendline', 'bar'];
    else if (p.s >= 2) ids = ['bar', 'hbar', 'stacked', 'radar', 'scatter'];
    else if (p.allPos && p.n <= 8) ids = ['bar', 'doughnut', 'pareto', 'ranking', 'funnel'];
    else ids = ['ranking', 'bar', 'pareto', 'hbar', 'histogram'];
    return ids.filter(id => byId[id] && byId[id].needs(p)).slice(0, 4);
  }

  // ── Math helpers ───────────────────────────────────────────────────────────
  const sum = a => a.reduce((x, y) => x + y, 0);
  const avg = a => a.length ? sum(a) / a.length : 0;
  function regression(y) {
    const n = y.length, xs = y.map((_, i) => i), mx = avg(xs), my = avg(y);
    let num = 0, den = 0, ssTot = 0, ssRes = 0;
    xs.forEach((x, i) => { num += (x - mx) * (y[i] - my); den += (x - mx) ** 2; });
    const slope = den ? num / den : 0, icpt = my - slope * mx;
    const fit = xs.map(x => icpt + slope * x);
    y.forEach((v, i) => { ssTot += (v - my) ** 2; ssRes += (v - fit[i]) ** 2; });
    return { fit, slope, r2: ssTot ? 1 - ssRes / ssTot : 1 };
  }
  const movingAvg = (a, w) => a.map((_, i) => i < w - 1 ? null : avg(a.slice(i - w + 1, i + 1)));

  // ── Config building ────────────────────────────────────────────────────────
  function valueOf(ctx) {
    if (Array.isArray(ctx.raw)) return ctx.raw[1] - ctx.raw[0];
    if (ctx.raw && typeof ctx.raw === 'object') return ctx.raw.y;
    if (typeof ctx.parsed === 'number') return ctx.parsed;
    return ctx.chart.options.indexAxis === 'y' ? ctx.parsed.x : ctx.parsed.y;
  }

  function baseOptions({ horizontal = false, pct = false, legend = true } = {}) {
    const valAxis = { beginAtZero: true, ticks: { font: { size: 10 }, callback: v => pct ? v + '%' : fmtC(v) }, grid: { color: '#EEF0F3' } };
    const catAxis = { ticks: { font: { size: 10 }, maxRotation: 45, autoSkip: true, maxTicksLimit: 24 }, grid: { display: false } };
    return {
      responsive: true, maintainAspectRatio: false, indexAxis: horizontal ? 'y' : 'x',
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: legend, position: 'bottom', labels: { font: { size: 11 }, boxWidth: 12, padding: 10 } },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label ? ctx.dataset.label + ': ' : ''}${pct ? Number(valueOf(ctx)).toFixed(1) + '%' : fmtFull(valueOf(ctx))}` } },
      },
      scales: horizontal ? { x: valAxis, y: catAxis } : { x: catAxis, y: valAxis },
    };
  }

  const ds = (i, name, data, extra = {}) => ({
    label: name, data, backgroundColor: alpha(PALETTE[i % PALETTE.length], 'CC'), borderColor: PALETTE[i % PALETTE.length],
    borderWidth: 2, borderRadius: 4, ...extra,
  });

  // Keep composition charts readable: top 11 slices + "Others".
  function topSlices(labels, data, max = 12) {
    const pairs = labels.map((l, i) => [l, data[i]]).sort((a, b) => b[1] - a[1]);
    if (pairs.length <= max) return { labels: pairs.map(p => p[0]), data: pairs.map(p => p[1]) };
    const head = pairs.slice(0, max - 1), rest = sum(pairs.slice(max - 1).map(p => p[1]));
    return { labels: [...head.map(p => p[0]), 'Others'], data: [...head.map(p => p[1]), rest] };
  }

  function build(type, p) {
    const L = p.labels, S = p.series, s0 = S[0];
    const lineOpts = { fill: false, tension: 0, pointRadius: p.n > 40 ? 0 : 3, backgroundColor: undefined };
    switch (type) {
      case 'bar':
        return { type: 'bar', data: { labels: L, datasets: S.map((s, i) => ds(i, s.name, s.data)) }, options: baseOptions() };
      case 'hbar':
        return { type: 'bar', data: { labels: L, datasets: S.map((s, i) => ds(i, s.name, s.data)) }, options: baseOptions({ horizontal: true }) };
      case 'stacked':
      case 'hstacked': {
        const o = baseOptions({ horizontal: type === 'hstacked' });
        o.scales.x.stacked = o.scales.y.stacked = true;
        return { type: 'bar', data: { labels: L, datasets: S.map((s, i) => ds(i, s.name, s.data, { borderRadius: 0 })) }, options: o };
      }
      case 'stacked100': {
        const tot = L.map((_, j) => sum(S.map(s => s.data[j])) || 1);
        const o = baseOptions({ pct: true });
        o.scales.x.stacked = o.scales.y.stacked = true; o.scales.y.max = 100;
        return { type: 'bar', data: { labels: L, datasets: S.map((s, i) => ds(i, s.name, s.data.map((v, j) => +(v / tot[j] * 100).toFixed(2)), { borderRadius: 0 })) }, options: o, pct: true };
      }
      case 'lollipop':
        return { type: 'bar', data: { labels: L, datasets: [
          ds(0, s0.name, s0.data, { barThickness: 2, borderWidth: 0, backgroundColor: MUTED }),
          { type: 'line', label: s0.name, data: s0.data, showLine: false, pointRadius: 7, pointHoverRadius: 9, pointBackgroundColor: PALETTE[0], borderColor: PALETTE[0] },
        ] }, options: { ...baseOptions(), plugins: { ...baseOptions().plugins, legend: { display: false } } } };
      case 'variance': {
        const diff = s0.data.map((v, j) => v - S[1].data[j]);
        return { type: 'bar', data: { labels: L, datasets: [ds(0, `${s0.name} − ${S[1].name}`, diff, { backgroundColor: diff.map(v => alpha(v >= 0 ? POS : NEG, 'CC')), borderColor: diff.map(v => v >= 0 ? POS : NEG) })] }, options: baseOptions() };
      }
      case 'ranking': {
        const t = topSlices(L, s0.data, 15);
        const lbl = t.labels.map((l, i) => l === 'Others' ? l : `#${i + 1} ${l}`);
        return { type: 'bar', data: { labels: lbl, datasets: [ds(0, s0.name, t.data, { backgroundColor: t.data.map((_, i) => alpha(PALETTE[0], i < 3 ? 'FF' : '88')) })] }, options: { ...baseOptions({ horizontal: true, legend: false }) } };
      }
      case 'line':
      case 'smooth':
      case 'stepped':
        return { type: 'line', data: { labels: L, datasets: S.map((s, i) => ds(i, s.name, s.data, { ...lineOpts, tension: type === 'smooth' ? 0.4 : 0, stepped: type === 'stepped' })) }, options: baseOptions() };
      case 'area':
      case 'stackedarea': {
        const o = baseOptions();
        if (type === 'stackedarea') o.scales.y.stacked = true;
        return { type: 'line', data: { labels: L, datasets: S.map((s, i) => ds(i, s.name, s.data, { fill: type === 'stackedarea' ? (i === 0 ? 'origin' : '-1') : 'origin', tension: 0.3, pointRadius: p.n > 40 ? 0 : 2, backgroundColor: alpha(PALETTE[i % PALETTE.length], '33') })) }, options: o };
      }
      case 'cumulative':
        return { type: 'line', data: { labels: L, datasets: S.map((s, i) => { let run = 0; return ds(i, `${s.name} (running total)`, s.data.map(v => (run += v)), { fill: i === 0 ? 'origin' : false, tension: 0.25, backgroundColor: alpha(PALETTE[i % PALETTE.length], '22'), pointRadius: p.n > 40 ? 0 : 2 }); }) }, options: baseOptions() };
      case 'movingavg': {
        const w = p.n >= 24 ? 6 : 3;
        return { type: 'bar', data: { labels: L, datasets: [
          ds(0, s0.name, s0.data, { backgroundColor: alpha(PALETTE[0], '44'), borderWidth: 0 }),
          { type: 'line', label: `${w}-period moving average`, data: movingAvg(s0.data, w), borderColor: PALETTE[2], borderWidth: 2.5, pointRadius: 0, tension: 0.3, spanGaps: true },
        ] }, options: baseOptions() };
      }
      case 'growth': {
        let data, name;
        if (p.s >= 2) { data = s0.data.map((v, j) => S[1].data[j] ? +((v - S[1].data[j]) / Math.abs(S[1].data[j]) * 100).toFixed(2) : null); name = `${s0.name} vs ${S[1].name} (%)`; }
        else { data = s0.data.map((v, j) => j && s0.data[j - 1] ? +((v - s0.data[j - 1]) / Math.abs(s0.data[j - 1]) * 100).toFixed(2) : null); name = `${s0.name} — change vs previous (%)`; }
        return { type: 'bar', data: { labels: L, datasets: [ds(0, name, data, { backgroundColor: data.map(v => alpha((v ?? 0) >= 0 ? POS : NEG, 'CC')), borderColor: data.map(v => (v ?? 0) >= 0 ? POS : NEG) })] }, options: baseOptions({ pct: true }), pct: true };
      }
      case 'trendline': {
        const r = regression(s0.data);
        return { type: 'bar', data: { labels: L, datasets: [
          ds(0, s0.name, s0.data, { backgroundColor: alpha(PALETTE[0], '99') }),
          { type: 'line', label: `Trend (${r.slope >= 0 ? '▲' : '▼'} ${fmtC(Math.abs(r.slope))}/period · R² ${r.r2.toFixed(2)})`, data: r.fit, borderColor: PALETTE[2], borderDash: [6, 4], borderWidth: 2.5, pointRadius: 0, _overlay: true },
        ] }, options: baseOptions() };
      }
      case 'pie':
      case 'doughnut':
      case 'semi':
      case 'polar': {
        const t = topSlices(L, s0.data);
        const total = sum(t.data) || 1;
        const cfgType = type === 'semi' ? 'doughnut' : type === 'polar' ? 'polarArea' : type;
        const extra = type === 'semi' ? { circumference: 180, rotation: -90 } : {};
        return { type: cfgType, data: { labels: t.labels, datasets: [{ label: s0.name, data: t.data, backgroundColor: t.labels.map((_, i) => alpha(PALETTE[i % PALETTE.length], type === 'polar' ? '99' : 'DD')), borderColor: '#fff', borderWidth: 2, ...extra }] },
          options: { responsive: true, maintainAspectRatio: false, cutout: type === 'pie' || type === 'polar' ? undefined : '58%',
            plugins: { legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 12 } }, tooltip: { callbacks: { label: ctx => `${ctx.label}: ${fmtFull(ctx.parsed.r ?? ctx.parsed)} (${((ctx.parsed.r ?? ctx.parsed) / total * 100).toFixed(1)}%)` } } },
            scales: type === 'polar' ? { r: { ticks: { callback: v => fmtC(v), font: { size: 9 } } } } : {} }, share: total };
      }
      case 'waterfall': {
        let run = 0;
        const bars = s0.data.map(v => { const st = run; run += v; return [st, run]; });
        return { type: 'bar', data: { labels: [...L, 'Total'], datasets: [ds(0, s0.name, [...bars, [0, run]], {
          backgroundColor: [...s0.data.map(v => alpha(v >= 0 ? POS : NEG, 'CC')), alpha(PALETTE[0], 'DD')], borderColor: [...s0.data.map(v => v >= 0 ? POS : NEG), PALETTE[0]], borderRadius: 2 })] },
          options: { ...baseOptions({ legend: false }) } };
      }
      case 'funnel': {
        const t = topSlices(L, s0.data, 15), max = t.data[0] || 1;
        const o = baseOptions({ horizontal: true, legend: false });
        o.scales.x.display = false; o.scales.x.min = 0; o.scales.x.max = max;
        o.plugins.tooltip.callbacks.label = ctx => `${fmtFull(valueOf(ctx))} (${(valueOf(ctx) / max * 100).toFixed(1)}% of top)`;
        return { type: 'bar', data: { labels: t.labels, datasets: [ds(0, s0.name, t.data.map(v => [(max - v) / 2, (max + v) / 2]), { backgroundColor: t.labels.map((_, i) => alpha(PALETTE[i % PALETTE.length], 'CC')), barPercentage: 0.95, categoryPercentage: 1, borderRadius: 3 })] }, options: o };
      }
      case 'radar':
        return { type: 'radar', data: { labels: L, datasets: S.map((s, i) => ds(i, s.name, s.data, { backgroundColor: alpha(PALETTE[i % PALETTE.length], '33'), pointRadius: 3, borderRadius: 0 })) },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, boxWidth: 12 } }, tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${fmtFull(ctx.parsed.r)}` } } }, scales: { r: { ticks: { callback: v => fmtC(v), font: { size: 9 } }, pointLabels: { font: { size: 10 } } } } } };
      case 'scatter':
      case 'bubble': {
        const max3 = type === 'bubble' ? Math.max(...S[2].data.map(Math.abs), 1) : 1;
        const pts = L.map((l, j) => ({ x: s0.data[j], y: S[1].data[j], r: type === 'bubble' ? 4 + 20 * Math.abs(S[2].data[j]) / max3 : undefined, _l: l }));
        return { type, data: { datasets: [{ label: type === 'bubble' ? `${S[1].name} vs ${s0.name} (size: ${S[2].name})` : `${S[1].name} vs ${s0.name}`, data: pts, backgroundColor: alpha(PALETTE[0], '88'), borderColor: PALETTE[0], pointRadius: 5 }] },
          options: { responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: ctx => `${ctx.raw._l}: ${s0.name} ${fmtFull(ctx.raw.x)}, ${S[1].name} ${fmtFull(ctx.raw.y)}${type === 'bubble' ? `, ${S[2].name} ${fmtFull(S[2].data[ctx.dataIndex])}` : ''}` } } },
            scales: { x: { title: { display: true, text: s0.name, font: { size: 11 } }, ticks: { callback: v => fmtC(v), font: { size: 10 } } }, y: { title: { display: true, text: S[1].name, font: { size: 11 } }, ticks: { callback: v => fmtC(v), font: { size: 10 } } } } } };
      }
      case 'histogram': {
        const vals = s0.data, mn = Math.min(...vals), mx = Math.max(...vals);
        const bins = Math.min(12, Math.max(4, Math.ceil(Math.sqrt(vals.length)))), w = (mx - mn) / bins || 1;
        const counts = Array(bins).fill(0);
        vals.forEach(v => counts[Math.min(bins - 1, Math.floor((v - mn) / w))]++);
        const lbls = counts.map((_, i) => `${fmtC(mn + i * w)}–${fmtC(mn + (i + 1) * w)}`);
        const o = baseOptions({ legend: false });
        o.scales.y.ticks.callback = v => Number.isInteger(v) ? v : '';
        o.plugins.tooltip.callbacks.label = ctx => `${ctx.parsed.y} row(s)`;
        return { type: 'bar', data: { labels: lbls, datasets: [ds(0, `Rows by ${s0.name}`, counts, { barPercentage: 1, categoryPercentage: 1, borderRadius: 0 })] }, options: o, countAxis: true };
      }
      case 'boxstats': {
        const names = S.map(s => s.name);
        const o = baseOptions();
        o.plugins.tooltip.callbacks.label = ctx => `${ctx.dataset.label}: ${fmtFull(valueOf(ctx))}`;
        return { type: 'bar', data: { labels: names, datasets: [
          { label: 'Min → Max range', data: S.map(s => [Math.min(...s.data), Math.max(...s.data)]), backgroundColor: alpha(PALETTE[0], '33'), borderColor: PALETTE[0], borderWidth: 1, borderRadius: 4, barPercentage: 0.5 },
          { type: 'line', label: 'Average', data: S.map(s => avg(s.data)), showLine: false, pointStyle: 'rectRot', pointRadius: 8, backgroundColor: PALETTE[2], borderColor: PALETTE[2] },
        ] }, options: o };
      }
      case 'pareto': {
        const t = topSlices(L, s0.data, 25), total = sum(t.data) || 1;
        let run = 0; const cum = t.data.map(v => +((run += v) / total * 100).toFixed(1));
        const o = baseOptions();
        o.scales.y1 = { position: 'right', min: 0, max: 100, grid: { display: false }, ticks: { callback: v => v + '%', font: { size: 10 } } };
        o.plugins.tooltip.callbacks.label = ctx => ctx.dataset.yAxisID === 'y1' ? `Cumulative: ${ctx.parsed.y}%` : `${ctx.dataset.label}: ${fmtFull(ctx.parsed.y)}`;
        return { type: 'bar', data: { labels: t.labels, datasets: [
          ds(0, s0.name, t.data, { backgroundColor: cum.map(c => alpha(PALETTE[0], c <= 80 ? 'DD' : '55')) }),
          { type: 'line', label: 'Cumulative %', data: cum, yAxisID: 'y1', borderColor: PALETTE[2], pointRadius: 3, tension: 0.2 },
          { type: 'line', label: '80% line', data: t.labels.map(() => 80), yAxisID: 'y1', borderColor: MUTED, borderDash: [4, 4], pointRadius: 0, borderWidth: 1, _overlay: true },
        ] }, options: o };
      }
      case 'combo':
        return { type: 'bar', data: { labels: L, datasets: S.map((s, i) => i === 0 ? ds(0, s.name, s.data) : { type: 'line', label: s.name, data: s.data, borderColor: PALETTE[i % PALETTE.length], backgroundColor: PALETTE[i % PALETTE.length], tension: 0.3, pointRadius: 3, borderWidth: 2.5 }) }, options: baseOptions() };
      case 'dualaxis': {
        const o = baseOptions();
        o.scales.y.title = { display: true, text: s0.name, font: { size: 10 } };
        o.scales.y1 = { position: 'right', beginAtZero: true, grid: { display: false }, title: { display: true, text: S[1].name, font: { size: 10 } }, ticks: { callback: v => fmtC(v), font: { size: 10 } } };
        return { type: 'bar', data: { labels: L, datasets: [ds(0, s0.name, s0.data), { type: 'line', label: S[1].name, data: S[1].data, yAxisID: 'y1', borderColor: PALETTE[2], backgroundColor: PALETTE[2], tension: 0.3, pointRadius: 3, borderWidth: 2.5 }] }, options: o };
      }
      case 'share': {
        const total = sum(s0.data) || 1;
        const pct = s0.data.map(v => +(v / total * 100).toFixed(2));
        return { type: 'bar', data: { labels: L, datasets: [ds(0, `${s0.name} — share of total (%)`, pct)] }, options: baseOptions({ pct: true }), pct: true };
      }
    }
    return build('bar', p);
  }

  // Overlays (average line / trend line) only make sense on a plain
  // category x-axis with vertical values.
  const OVERLAY_OK = new Set(['bar', 'line', 'smooth', 'stepped', 'area', 'lollipop', 'combo', 'movingavg']);

  function addOverlays(cfg, type, p, opts) {
    if (!OVERLAY_OK.has(type) || !p.s) return;
    const s0 = p.series[0];
    if (opts.avg) {
      const a = avg(s0.data);
      cfg.data.datasets.push({ type: 'line', label: `Average ${fmtC(a)}`, data: p.labels.map(() => a), borderColor: '#6B7280', borderDash: [5, 5], borderWidth: 1.5, pointRadius: 0, _overlay: true });
    }
    if (opts.trend && p.n >= 3) {
      const r = regression(s0.data);
      cfg.data.datasets.push({ type: 'line', label: `Trend ${r.slope >= 0 ? '▲' : '▼'} (R² ${r.r2.toFixed(2)})`, data: r.fit, borderColor: '#DC2626', borderDash: [8, 4], borderWidth: 2, pointRadius: 0, _overlay: true });
    }
  }

  // Draws values on bars/points/slices when "Data labels" is on.
  const labelPlugin = {
    id: 'atblLabels',
    afterDatasetsDraw(chart, _args, o) {
      if (!o || !o.on) return;
      const { ctx } = chart;
      const isArc = ['pie', 'doughnut', 'polarArea'].includes(chart.config.type);
      ctx.save();
      ctx.font = '600 10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      chart.data.datasets.forEach((d, i) => {
        const meta = chart.getDatasetMeta(i);
        if (meta.hidden || d._overlay || meta.data.length > 40) return;
        meta.data.forEach((el, j) => {
          let v = d.data[j];
          if (v == null) return;
          if (Array.isArray(v)) v = v[1] - v[0]; else if (typeof v === 'object') v = v.y;
          const pos = el.tooltipPosition();
          let txt = o.pct ? Number(v).toFixed(1) + '%' : o.count ? String(v) : fmtC(v);
          if (isArc) { const tot = sum(d.data) || 1; if (v / tot < 0.04) return; txt = (v / tot * 100).toFixed(0) + '%'; ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; }
          else ctx.fillStyle = '#374151';
          ctx.fillText(txt, pos.x, isArc ? pos.y : pos.y - 4);
        });
      });
      ctx.restore();
    },
  };

  // ── Analytics components ───────────────────────────────────────────────────
  function heatmapHtml(p) {
    const maxes = p.series.map(s => Math.max(...s.data.map(Math.abs), 1));
    const head = `<tr><th>${esc(p.labelCol)}</th>${p.series.map(s => `<th>${esc(s.name)}</th>`).join('')}</tr>`;
    const body = p.labels.map((l, j) => `<tr><td class="hm-l">${esc(l)}</td>${p.series.map((s, i) => {
      const v = s.data[j], t = Math.abs(v) / maxes[i], base = v < 0 ? '220,38,38' : '0,112,243';
      return `<td style="background:rgba(${base},${(0.08 + t * 0.8).toFixed(2)});color:${t > 0.55 ? '#fff' : '#111827'}" title="${esc(fmtFull(v))}">${esc(fmtC(v))}</td>`;
    }).join('')}</tr>`).join('');
    return `<div class="atbl-heatmap"><table>${head}${body}</table></div>`;
  }

  // ── Public API (called from index.html) ────────────────────────────────────
  function getState(uid) {
    const st = _atblStore[uid];
    if (!st.chartOpts) st.chartOpts = { avg: false, trend: false, labels: false, sort: false };
    return st;
  }

  function rowsFor(st) {
    const rows = st.data.rows || [];
    if (!st.chartOpts.sort) return rows;
    const p = profile(rows);
    if (!p.s) return rows;
    const c = p.valCols[0];
    return [...rows].sort((a, b) => (parseFloat(b[c]) || 0) - (parseFloat(a[c]) || 0));
  }

  function defaultType(data) {
    const p = profile(data.rows || []);
    const want = ALIASES[data.chartType] || data.chartType;
    if (want && byId[want] && byId[want].needs(p)) return want;
    return recommend(p)[0] || 'bar';
  }

  window.atblChartToolbarHtml = function (uid, data) {
    const p = profile(data.rows || []);
    if (!p.s) return `<div class="atbl-no-chart">No numeric columns detected — cannot generate chart.</div>`;
    const avail = available(p), rec = recommend(p), active = defaultType(data);
    const chip = c => `<button class="atbl-ct-btn${c.id === active ? ' active' : ''}" data-type="${c.id}" onclick="atblChart('${uid}','${c.id}',this)">${c.icon} ${esc(c.label)}</button>`;
    const groups = GROUPS.map(g => {
      const items = avail.filter(c => c.group === g);
      return items.length ? `<div class="atbl-cg"><span class="atbl-cg-title">${g}</span>${items.map(chip).join('')}</div>` : '';
    }).join('');
    return `
      <div class="atbl-chart-types">
        <span class="atbl-chart-label">★ Recommended:</span>${rec.map(id => chip(byId[id])).join('')}
        <button class="atbl-more-btn" onclick="atblToggleGallery('${uid}',this)">All ${avail.length} charts ▾</button>
      </div>
      <div class="atbl-chart-gallery" id="${uid}_gallery" style="display:none">${groups}</div>
      <div class="atbl-chart-opts">
        <label><input type="checkbox" onchange="atblChartOpt('${uid}','avg',this.checked)"> Average line</label>
        <label><input type="checkbox" onchange="atblChartOpt('${uid}','trend',this.checked)"> Trend line</label>
        <label><input type="checkbox" onchange="atblChartOpt('${uid}','labels',this.checked)"> Data labels</label>
        <label><input type="checkbox" onchange="atblChartOpt('${uid}','sort',this.checked)"> Sort high → low</label>
        <span class="atbl-chart-meta">${esc(p.labelCol)} × ${p.valCols.map(esc).join(', ')} · ${p.timeLike ? 'time series' : 'categories'}</span>
        <button class="atbl-png-btn" onclick="atblChartPng('${uid}')">⬇ PNG</button>
      </div>`;
  };

  window.initAtblChart = function (uid, type) {
    const st = getState(uid);
    type = ALIASES[type] || type || st.chartType || defaultType(st.data);
    st.chartType = type;
    const rows = rowsFor(st);
    if (!rows.length) return;
    const p = profile(rows);

    const wrap = document.querySelector(`#${uid} .atbl-chart-canvas-wrap`);
    if (!wrap) return;
    if (st.chart) { st.chart.destroy(); st.chart = null; }
    if (!p.s) { wrap.innerHTML = '<div class="atbl-no-chart">No numeric columns detected — cannot generate chart.</div>'; return; }
    if (type === 'heatmap') {
      wrap.classList.add('is-html');
      wrap.innerHTML = heatmapHtml(p);
      wrap.querySelectorAll('td.hm-l').forEach(td => { td.style.cursor = 'pointer'; td.title = 'Drill down'; td.onclick = () => window.atblDrill(uid, td.textContent); });
      return;
    }
    wrap.classList.remove('is-html');
    if (!document.getElementById(`${uid}_canvas`)) wrap.innerHTML = `<canvas id="${uid}_canvas"></canvas>`;
    if (!window.Chart) return;

    const cfg = build(byId[type] && byId[type].needs(p) ? type : 'bar', p);
    addOverlays(cfg, type, p, st.chartOpts);
    cfg.options.plugins = { ...(cfg.options.plugins || {}), atblLabels: { on: st.chartOpts.labels, pct: !!cfg.pct, count: !!cfg.countAxis } };
    cfg.options.animation = { duration: 450 };
    // Drill-down: clicking a bar / slice / point asks about that item.
    // Charts whose bars aren't source rows (histogram, min–avg–max) are skipped.
    if (!['histogram', 'boxstats'].includes(type)) {
      cfg.options.onClick = (evt, els, chart) => {
        if (!els.length) return;
        const { index, datasetIndex } = els[0];
        const raw = chart.data.datasets[datasetIndex]?.data?.[index];
        const label = raw && raw._l != null ? raw._l : chart.data.labels?.[index];
        if (label != null) window.atblDrill(uid, String(label));
      };
      cfg.options.onHover = (evt, els) => { if (evt.native?.target) evt.native.target.style.cursor = els.length ? 'pointer' : 'default'; };
    }
    st.chart = new Chart(document.getElementById(`${uid}_canvas`), { type: cfg.type, data: cfg.data, options: cfg.options, plugins: [labelPlugin] });
  };

  // Builds a follow-up question for one clicked item and sends it.
  window.atblDrill = function (uid, label) {
    const st = _atblStore[uid];
    if (!st) return;
    label = String(label).replace(/^#\d+\s+/, '').trim();          // ranking chart labels: "#1 NAME"
    if (!label || /^(others|total|80% line)$/i.test(label)) return;
    const p = profile(st.data.rows || []);
    const title = st.data.question || 'this data';
    const q = `Show the details behind ${p.labelCol} "${label}" in "${title}"`;
    if (typeof isLoading !== 'undefined' && isLoading) return;
    inputEl.value = q;
    sendMessage();
  };

  // Table 🔍 cell: drill into the row's label (first text column).
  window.atblDrillRow = function (uid, index) {
    const st = _atblStore[uid];
    const row = st && (st.sortedRows || st.data.rows || [])[index];
    if (!row) return;
    const p = profile(st.data.rows || []);
    const textCols = Object.keys(row).filter(c => !isNum(row[c]) && row[c] != null && row[c] !== '');
    const col = textCols[0] || p.labelCol;
    const idCol = Object.keys(row).find(c => /^(docnum|invoice ?no|order ?no|doc ?no)$/i.test(c.replace(/[_\s]/g, '')));
    const label = idCol ? `${idCol} ${row[idCol]}` : `${col} "${row[col]}"`;
    const q = `Show the details behind ${label} in "${st.data.question || 'this data'}"`;
    if (typeof isLoading !== 'undefined' && isLoading) return;
    inputEl.value = q;
    sendMessage();
  };

  window.atblChart = function (uid, type, btn) {
    document.querySelectorAll(`#${uid} .atbl-ct-btn`).forEach(b => b.classList.toggle('active', b.dataset.type === type));
    window.initAtblChart(uid, type);
  };

  window.atblChartOpt = function (uid, key, on) {
    getState(uid).chartOpts[key] = on;
    window.initAtblChart(uid, _atblStore[uid].chartType);
  };

  window.atblToggleGallery = function (uid, btn) {
    const g = document.getElementById(`${uid}_gallery`);
    const open = g.style.display === 'none';
    g.style.display = open ? '' : 'none';
    btn.textContent = btn.textContent.replace(/[▾▴]$/, open ? '▴' : '▾');
  };

  window.atblChartPng = function (uid) {
    const st = _atblStore[uid];
    if (!st || !st.chart) return;
    const a = document.createElement('a');
    a.href = st.chart.toBase64Image('image/png', 1);
    a.download = `${(st.data.question || 'chart').replace(/[^\w]+/g, '_').slice(0, 60)}_${st.chartType}.png`;
    a.click();
  };

  window.ATBL_CHART_TYPES = CATALOG.map(c => c.id);
})();
