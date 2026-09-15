// Computes real statistics from actual query rows — total transactions,
// sum/avg/max/min (with which record hit them), and a simple trend direction
// when a date/month/year column is present. Used to build the chat "Insight"
// block from real numbers instead of letting the AI eyeball the table and
// describe it in free text (that's the one place a subtly wrong claim could
// slip through even though the table itself is always accurate).
const isStrictNumber = (v) => v !== null && v !== undefined && v !== "" && /^-?\d+(\.\d+)?$/.test(String(v).trim());
const isIdCol = (c) => /^(doc(num|entry|no|number)|order ?(no|num|number|id)|line ?num|whs ?code|item ?code|card ?code|customer ?code|invoice ?no|po ?no|grpo ?no)$/i.test(c.replace(/[_\s]/g, ""));

function detectColumns(rows) {
  const cols = Object.keys(rows[0]);
  const numCols = cols.filter((c) => !isIdCol(c) && rows.slice(0, 20).every((r) => r[c] == null || r[c] === "" || isStrictNumber(r[c])));
  const periodCol = cols.find((c) => /^(month|year|period|quarter|week)$/i.test(c) || /date$/i.test(c));
  const nonNumCols = cols.filter((c) => !numCols.includes(c));
  // Prefer a human-readable name/description over a code, and either over a
  // date column, as the "which record" label — a date tells you *when* the
  // max happened, not *who/what* drove it, and a code is less readable than
  // the matching name when both exist (e.g. Customer Code vs Customer Name).
  const labelCol = nonNumCols.find((c) => /name|description/i.test(c) && c !== periodCol)
    || nonNumCols.find((c) => /code|customer|item|vendor|card/i.test(c) && c !== periodCol)
    || nonNumCols.find((c) => c !== periodCol)
    || nonNumCols[0]
    || cols[0];
  return { cols, numCols, labelCol, periodCol };
}

export function computeSummaryStats(rows) {
  if (!rows || !rows.length) return null;
  const { numCols, labelCol, periodCol } = detectColumns(rows);
  const count = rows.length;
  if (!numCols.length) return { count };

  const primary = numCols[0];
  let sum = 0, max = -Infinity, min = Infinity, maxRow = null, minRow = null;
  for (const r of rows) {
    const v = parseFloat(r[primary]) || 0;
    sum += v;
    if (v > max) { max = v; maxRow = r; }
    if (v < min) { min = v; minRow = r; }
  }
  const avg = sum / count;

  // Trend: if there's a period column, compare the sum of the first half of
  // the *distinct sorted periods* against the second half — a simple, honest
  // direction indicator, not a forecast.
  let trend = null;
  if (periodCol) {
    const byPeriod = new Map();
    for (const r of rows) {
      const key = r[periodCol];
      byPeriod.set(key, (byPeriod.get(key) || 0) + (parseFloat(r[primary]) || 0));
    }
    const periods = [...byPeriod.keys()].sort((a, b) => (a > b ? 1 : a < b ? -1 : 0));
    if (periods.length >= 2) {
      const mid = Math.ceil(periods.length / 2);
      const firstHalf = periods.slice(0, mid).reduce((s, p) => s + byPeriod.get(p), 0);
      const secondHalf = periods.slice(mid).reduce((s, p) => s + byPeriod.get(p), 0);
      const pctChange = firstHalf !== 0 ? ((secondHalf - firstHalf) / Math.abs(firstHalf)) * 100 : null;
      trend = {
        direction: secondHalf > firstHalf ? "up" : secondHalf < firstHalf ? "down" : "flat",
        pctChange,
        periodCol,
        periodCount: periods.length,
      };
    }
  }

  return {
    count,
    primaryCol: primary,
    labelCol,
    sum, avg, max, min,
    maxLabel: maxRow ? maxRow[labelCol] : null,
    minLabel: minRow ? minRow[labelCol] : null,
    trend,
  };
}

const fmtNum = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });

export function buildProfessionalInsight(question, rows) {
  const stats = computeSummaryStats(rows);
  if (!stats) return `**No data found** for *"${question}"*.`;
  if (!stats.primaryCol) {
    return `📊 **Summary:** ${stats.count.toLocaleString()} record${stats.count === 1 ? "" : "s"} found for *"${question}"*.`;
  }

  const trendLine = stats.trend
    ? `| Trend (${stats.trend.periodCount} ${stats.trend.periodCol.toLowerCase()}s) | ${stats.trend.direction === "up" ? "📈 Rising" : stats.trend.direction === "down" ? "📉 Declining" : "➡️ Flat"}${stats.trend.pctChange != null ? ` (${stats.trend.pctChange >= 0 ? "+" : ""}${stats.trend.pctChange.toFixed(1)}%)` : ""} |\n`
    : "";

  return (
    `📊 **Data Summary — ${stats.count.toLocaleString()} transaction${stats.count === 1 ? "" : "s"}**\n\n` +
    `| Metric | Value |\n|---|---|\n` +
    `| Total ${stats.primaryCol} | **${fmtNum(stats.sum)}** |\n` +
    `| Average ${stats.primaryCol} | **${fmtNum(stats.avg)}** |\n` +
    `| Maximum | **${fmtNum(stats.max)}**${stats.maxLabel != null ? ` — ${stats.maxLabel}` : ""} |\n` +
    `| Minimum | **${fmtNum(stats.min)}**${stats.minLabel != null ? ` — ${stats.minLabel}` : ""} |\n` +
    trendLine
  );
}
