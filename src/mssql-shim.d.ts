// The "mssql" package ships no TypeScript type declarations and no @types/mssql
// is installed in this project. Treat it as untyped rather than adding a new
// dependency just for types — usage here is a handful of simple calls.
declare module "mssql" {
  const sql: any;
  export default sql;
}

// The "hdb" (SAP HANA) package ships no TypeScript type declarations either.
declare module "hdb" {
  const hdb: any;
  export default hdb;
}
