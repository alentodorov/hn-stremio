// A minimal D1-compatible wrapper around node:sqlite, for running the ingest pipeline locally.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function localD1(path, schemaPath = new URL("../schema.sql", import.meta.url)) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 10000");
  db.exec(readFileSync(schemaPath, "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    batch: async (stmts) => {
      db.exec("BEGIN");
      try {
        for (const s of stmts) await s.run();
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
