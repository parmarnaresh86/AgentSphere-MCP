// Quotes a column/table identifier for the active DB dialect — HANA needs
// double quotes, MSSQL (via square-bracket table refs) doesn't. Shared by
// every DB-Direct agent (Production, MRP, Pricing, Procurement) that builds
// raw SQL against live-resolved column names.
export function qcol(name, isHana) {
  return isHana ? `"${name}"` : name;
}
