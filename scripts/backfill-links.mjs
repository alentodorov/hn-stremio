// Backfill all-time IMDb and Wikipedia link mentions into a local SQLite file (no LLM needed).
// Usage: node scripts/backfill-links.mjs data/local.sqlite
// Then export with scripts/export-sql.mjs and load into D1 with wrangler.
import { localD1 } from "./local-db.mjs";
import { backfillLinks, OutOfBudget } from "../src/ingest.js";

const env = { DB: localD1(process.argv[2] || "data/local.sqlite"), LOOKUP_CONCURRENCY: "24" };
for (const which of ["imdb", "wiki"]) {
  let pages = 0;
  for (;;) {
    const b = { llm: 0, lookups: 1e9 };
    try {
      if (!(await backfillLinks(env, b, which))) break;
    } catch (e) {
      if (!(e instanceof OutOfBudget)) throw e;
    }
    const { n } = env.DB.raw.prepare("SELECT COUNT(*) n FROM mentions").get();
    console.log(`${which}: page ${++pages}, ${n} mentions so far`);
  }
}
