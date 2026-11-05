// Re-resolve every cached LLM title lookup with the current matcher and repair the mentions that
// an older matcher got wrong. Prints SQL to apply with `wrangler d1 execute hn-stremio --remote --file`.
//   wrangler d1 execute hn-stremio --remote --json --command "SELECT key, imdb_id FROM lookups WHERE key LIKE 'q:%'" > lookups.json
//   node scripts/rematch.mjs lookups.json > rematch.sql
import { readFileSync } from "node:fs";
import { search, byImdbId } from "../src/cinemeta.js";

const rows = JSON.parse(readFileSync(process.argv[2], "utf8"))[0].results;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = []; // { key, old, new }
for (const [i, r] of rows.entries()) {
  const m = r.key.match(/^q:(movie|series)\|(.*)\|(\d*)$/);
  if (!m) continue;
  const [, type, title, year] = m;
  let id;
  for (let attempt = 0; attempt < 4 && id === undefined; attempt++) {
    try { id = (await search({ title, year: Number(year) || null, type })) || ""; } catch { await sleep(5000); }
  }
  if (id === undefined) { console.error(`failed: ${r.key}`); continue; }
  results.push({ key: r.key, old: r.imdb_id, new: id });
  if ((i + 1) % 250 === 0) console.error(`${i + 1}/${rows.length}`);
  await sleep(200);
}

const out = [];
const newIds = new Set();
let changed = 0;
for (const x of results) {
  if (x.new === x.old) continue;
  changed++;
  out.push(`UPDATE lookups SET imdb_id = ${q(x.new)} WHERE key = ${q(x.key)};`);
  if (x.new) newIds.add(x.new);
}
// Mentions can only be moved when every key that produced an id agrees on where it goes now.
const byOld = new Map();
for (const x of results) if (x.old) (byOld.get(x.old) || byOld.set(x.old, []).get(x.old)).push(x);
let moved = 0, dropped = 0, ambiguous = 0;
for (const [old, xs] of byOld) {
  const targets = new Set(xs.map((x) => x.new));
  if (targets.has(old)) { if (targets.size > 1) ambiguous++; continue; }
  if (targets.size > 1) { ambiguous++; continue; }
  const to = [...targets][0];
  if (to) {
    moved++;
    out.push(`INSERT OR IGNORE INTO mentions (comment_id, imdb_id, author, created_at, story_id, source) SELECT comment_id, ${q(to)}, author, created_at, story_id, source FROM mentions WHERE imdb_id = ${q(old)} AND source = 'llm';`);
  } else {
    dropped++;
  }
  out.push(`DELETE FROM mentions WHERE imdb_id = ${q(old)} AND source = 'llm';`);
}
for (const id of newIds) {
  let t;
  for (let attempt = 0; attempt < 4 && t === undefined; attempt++) {
    try { t = await byImdbId(id); } catch { await sleep(5000); }
  }
  if (t) out.push(`INSERT OR IGNORE INTO titles (imdb_id, type, name, year, poster) VALUES (${q(t.imdb_id)}, ${q(t.type)}, ${q(t.name)}, ${q(t.year)}, ${q(t.poster)});`);
  await sleep(200);
}
console.error(`${results.length} lookups re-resolved: ${changed} changed; mentions moved for ${moved} ids, dropped for ${dropped}, left alone for ${ambiguous} ambiguous ids`);
console.log(out.join("\n"));
