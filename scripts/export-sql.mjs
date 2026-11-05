// Dump the local SQLite data (not the schema) as INSERT statements for `wrangler d1 execute`.
// Usage: node scripts/export-sql.mjs data/local.sqlite > data/seed.sql
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.argv[2] || "data/local.sqlite", { readOnly: true });
const lit = (v) => (v === null ? "NULL" : typeof v === "number" || typeof v === "bigint" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
for (const table of ["titles", "mentions", "lookups", "processed", "state"]) {
  const rows = db.prepare(`SELECT * FROM ${table}`).all();
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const cols = Object.keys(chunk[0]);
    const values = chunk.map((r) => `(${cols.map((c) => lit(r[c])).join(",")})`).join(",\n");
    console.log(`INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES\n${values};`);
  }
}
