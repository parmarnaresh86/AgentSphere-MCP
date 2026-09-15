// Real .xlsx generation for chat-triggered "export to Excel" requests —
// shared by chat-server.mjs (DB Direct / GPT / Claude pre-intercept) and
// analytics-v2.mjs (V2 engine) so both produce a real, downloadable file
// instead of the AI describing a link that doesn't exist.
import ExcelJS from "exceljs";
import { ChartJSNodeCanvas } from "chartjs-node-canvas";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EXPORTS_DIR = path.join(__dirname, "..", "exports");
if (!existsSync(EXPORTS_DIR)) mkdirSync(EXPORTS_DIR, { recursive: true });

export function isExcelExportRequest(question) {
  return /\b(excel|xlsx|spreadsheet)\b/i.test(question || "") || /export\s+".+?"\s+as a report/i.test(question || "");
}

// "multiple tabs", "multi chart" etc. — a request for a structured, multi-view
// report rather than a single flat table dumped to one sheet.
export function isMultiTabReportRequest(question) {
  const q = question || "";
  if (!isExcelExportRequest(q)) return false;
  return /\b(multiple tabs?|multi[- ]?tab|separate tabs?|multi[- ]?charts?|multiple charts?)\b/i.test(q)
    || /\btabs?\b/i.test(q)
    || (/\btrend\b/i.test(q) && /\b(item|product)[- ]?wise\b/i.test(q));
}

const TAB_COLORS = ["FF0070F3", "FF00A28A", "FFE9730C", "FF8B37BF", "FFCF4B00"];
const _chartCanvas = new ChartJSNodeCanvas({ width: 640, height: 340, backgroundColour: "white" });
const _isStrictNumber = (v) => v !== null && v !== undefined && v !== "" && /^-?\d+(\.\d+)?$/.test(String(v).trim());

function detectChartColumns(rows) {
  if (!rows.length) return null;
  const cols = Object.keys(rows[0]);
  const numCols = cols.filter((c) => rows.slice(0, 10).every((r) => r[c] == null || r[c] === "" || _isStrictNumber(r[c])));
  const labelCol = cols.find((c) => !numCols.includes(c)) || cols[0];
  if (!numCols.length) return null;
  return { labelCol, valueCol: numCols[0] };
}

async function renderChartImage(rows, chartType) {
  const detected = detectChartColumns(rows);
  if (!detected) return null;
  const { labelCol, valueCol } = detected;
  const limited = rows.slice(0, 30); // cap so bars/labels stay legible
  const labels = limited.map((r) => String(r[labelCol] ?? ""));
  const data = limited.map((r) => parseFloat(r[valueCol]) || 0);
  const palette = ["#0070F3", "#00A28A", "#E9730C", "#8B37BF", "#CF4B00"];
  const type = chartType === "line" ? "line" : chartType === "pie" ? "pie" : "bar";
  const cfg = {
    type,
    data: {
      labels,
      datasets: [{
        label: valueCol,
        data,
        backgroundColor: type === "pie" ? labels.map((_, i) => palette[i % palette.length]) : palette[0] + "CC",
        borderColor: palette[0],
        borderWidth: 2,
        fill: type === "line" ? false : true,
      }],
    },
    options: {
      plugins: { legend: { display: type === "pie" }, title: { display: true, text: `${valueCol} by ${labelCol}` } },
      scales: type === "pie" ? {} : { x: { ticks: { maxRotation: 45, autoSkip: true } } },
    },
  };
  return _chartCanvas.renderToBuffer(cfg);
}

// Professional finishing touches applied to every sheet: thousands-separator
// number formatting on numeric columns, and a bold TOTAL row with real SUM
// formulas (not just a static number) so it recalculates if the user edits
// the sheet in Excel.
// Year/Month/Quarter/Week/DocNum etc. are numeric but dimensional, not
// additive — summing "Year" produces a meaningless number. Only genuinely
// summable measures (amounts, quantities, counts) belong in the TOTAL row.
const _isDimensionalCol = (c) => /^(year|month|quarter|week|day)$/i.test(c) || /date$/i.test(c) || _isIdColName(c);
const _isIdColName = (c) => /^(doc(num|entry|no|number)|order ?(no|num|number|id)|line ?num|whs ?code|item ?code|card ?code|customer ?code|invoice ?no|po ?no|grpo ?no)$/i.test(c.replace(/[_\s]/g, ""));

function applyNumberFormatAndTotals(ws, rows, cols) {
  const allNumIdxs = cols.map((c, i) => (rows.slice(0, 10).every((r) => r[c] == null || r[c] === "" || _isStrictNumber(r[c])) ? i : -1)).filter((i) => i >= 0);
  const summableIdxs = allNumIdxs.filter((i) => !_isDimensionalCol(cols[i]));
  for (const idx of allNumIdxs) ws.getColumn(idx + 1).numFmt = summableIdxs.includes(idx) ? "#,##0.00" : "0";
  if (!summableIdxs.length) return;

  const totalRowNum = rows.length + 2;
  const totalRow = ws.getRow(totalRowNum);
  totalRow.getCell(1).value = "TOTAL";
  totalRow.font = { bold: true };
  totalRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };
  for (const idx of summableIdxs) {
    const colLetter = ws.getColumn(idx + 1).letter;
    const cell = totalRow.getCell(idx + 1);
    cell.value = { formula: `SUM(${colLetter}2:${colLetter}${rows.length + 1})` };
    cell.numFmt = "#,##0.00";
  }
}

// tabs: [{ name, rows, chartType: 'bar'|'line'|'pie'|'none' }]
export async function generateMultiTabExcelReport(question, tabs) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Henny AI Solution";
  wb.created = new Date();

  const usedNames = new Set();
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const rows = tab.rows || [];
    let baseName = (tab.name || `Tab${i + 1}`).trim().slice(0, 28) || `Tab${i + 1}`;
    let name = baseName, n = 2;
    while (usedNames.has(name.toLowerCase())) name = `${baseName} ${n++}`;
    usedNames.add(name.toLowerCase());

    const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    const headerColor = TAB_COLORS[i % TAB_COLORS.length];

    if (!rows.length) {
      ws.getCell("A1").value = "No data returned for this view.";
      continue;
    }

    const cols = Object.keys(rows[0]);
    ws.columns = cols.map((c) => ({ header: c, key: c, width: Math.min(Math.max(c.length + 2, 12), 40) }));
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: headerColor } };
    ws.getRow(1).alignment = { vertical: "middle" };
    rows.forEach((r) => ws.addRow(r));
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };

    // Banded rows for readability
    for (let r = 2; r <= rows.length + 1; r++) {
      if (r % 2 === 0) ws.getRow(r).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F7FB" } };
    }

    applyNumberFormatAndTotals(ws, rows, cols);

    // Heat-map color scale on the first numeric column — a lightweight
    // native-Excel "visual" independent of the embedded chart image below.
    const numColIdx = cols.findIndex((c) => rows.slice(0, 10).every((r) => r[c] == null || r[c] === "" || _isStrictNumber(r[c])));
    if (numColIdx >= 0) {
      const colLetter = ws.getColumn(numColIdx + 1).letter;
      ws.addConditionalFormatting({
        ref: `${colLetter}2:${colLetter}${rows.length + 1}`,
        rules: [{
          type: "colorScale",
          cfvo: [{ type: "min" }, { type: "percentile", value: 50 }, { type: "max" }],
          color: [{ argb: "FFF8696B" }, { argb: "FFFFEB84" }, { argb: "FF63BE7B" }],
        }],
      });
    }

    if (tab.chartType && tab.chartType !== "none") {
      try {
        const imgBuf = await renderChartImage(rows, tab.chartType);
        if (imgBuf) {
          const imgId = wb.addImage({ buffer: imgBuf, extension: "png" });
          ws.addImage(imgId, { tl: { col: cols.length + 2, row: 1 }, ext: { width: 560, height: 300 } });
        }
      } catch (e) {
        console.warn(`[Excel Report] chart render failed for tab "${name}": ${e.message}`);
      }
    }
  }

  const safeName = (question || "report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "report";
  const filename = `${safeName}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.xlsx`;
  await wb.xlsx.writeFile(path.join(EXPORTS_DIR, filename));
  return `/exports/${filename}`;
}

export async function generateExcelExport(question, rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Henny AI Solution";
  wb.created = new Date();
  const ws = wb.addWorksheet("Data");
  if (rows.length) {
    const cols = Object.keys(rows[0]);
    ws.columns = cols.map(c => ({ header: c, key: c, width: Math.min(Math.max(c.length, 12), 40) }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDBEAFE" } };
    rows.forEach(r => ws.addRow(r));
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    applyNumberFormatAndTotals(ws, rows, cols);
  }
  const safeName = (question || "export").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "export";
  const filename = `${safeName}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.xlsx`;
  await wb.xlsx.writeFile(path.join(EXPORTS_DIR, filename));
  return `/exports/${filename}`;
}
