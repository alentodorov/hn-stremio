// Re-point every title's poster at IMDb's image (see posterUrl in src/cinemeta.js).
// Usage: node scripts/refresh-posters.mjs titles.json posters.sql
//   titles.json: `wrangler d1 execute hn-stremio --remote --json --command "SELECT imdb_id FROM titles"`
//   posters.sql: appended to as it goes, so a rerun resumes where it stopped. Then:
//   `wrangler d1 execute hn-stremio --remote --file posters.sql`
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { posterUrl } from "../src/cinemeta.js";

const [, , titlesFile, outFile] = process.argv;
const ids = JSON.parse(readFileSync(titlesFile, "utf8"))[0].results.map((r) => r.imdb_id);
const done = new Set(existsSync(outFile) ? [...readFileSync(outFile, "utf8").matchAll(/imdb_id = '(tt\d+)'/g)].map((m) => m[1]) : []);
const todo = ids.filter((id) => !done.has(id));
console.error(`${done.size} done, ${todo.length} to go`);
const q = (s) => `'${s.replace(/'/g, "''")}'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let missing = 0, failed = 0;
for (const [i, id] of todo.entries()) {
  let ok = false;
  for (let attempt = 0; attempt < 6 && !ok; attempt++) {
    try {
      const res = await fetch(`https://v3.sg.media-imdb.com/suggestion/t/${id}.json`);
      if (res.status === 429 || res.status >= 500) { await sleep(3000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error(String(res.status));
      const hit = ((await res.json()).d || []).find((d) => d.id === id);
      if (!hit?.i?.imageUrl) missing++;
      appendFileSync(outFile, `UPDATE titles SET poster = ${q(posterUrl(hit, id))} WHERE imdb_id = ${q(id)};\n`);
      ok = true;
    } catch (e) {
      await sleep(1000 * (attempt + 1));
    }
  }
  if (!ok) { failed++; console.error(`failed: ${id}`); }
  if ((i + 1) % 250 === 0) console.error(`${i + 1}/${todo.length}`);
  await sleep(150);
}
console.error(`done: ${todo.length - failed} written, ${failed} failed, ${missing} without an IMDb image (kept metahub)`);
