// Run the history backfill from this machine against the production D1 and Workers AI,
// using the same code as the Worker but without its time limit. The Worker's cron only reads
// new comments; all history comes from here.
//   node scripts/backfill.mjs            # until every backfill job reports done
//   node scripts/backfill.mjs recent     # stop once the RECENT_SINCE text window is done
// Needs a wrangler login (uses its OAuth token). Safe to stop and restart: cursors live in D1.
const BACKFILL_FROM = "2026-01-01"; // how far back the plain-text LLM pass goes
const SHARDS = 6;                   // date ranges of the history read side by side
const THREADS_AT_ONCE = 4;          // Ask HN threads read side by side
import { readFileSync } from "node:fs";
import { backfillLinks, backfillText, backfillTextRange, processComments, pool, getState, setState } from "../src/ingest.js";
import { recommendationThreads, threadComments } from "../src/hn.js";

// wrangler.jsonc has // comments; strip them (outside strings) before parsing.
const stripComments = (src) => {
  let out = "", inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) { out += c; if (c === "\\") out += src[++i]; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; out += "\n"; continue; }
    out += c;
  }
  return out;
};
const cfg = JSON.parse(stripComments(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")));
const account = cfg.account_id;
const dbId = cfg.d1_databases[0].database_id;
// Wrangler's OAuth token expires hourly; running any wrangler command refreshes the file.
import { execFileSync } from "node:child_process";
const tokenFile = `${process.env.HOME}/Library/Preferences/.wrangler/config/default.toml`;
const readToken = () => readFileSync(tokenFile, "utf8").match(/oauth_token = "([^"]+)"/)[1];
const refreshToken = () => { execFileSync("npx", ["wrangler", "whoami"], { stdio: "ignore" }); return readToken(); };
let token = readToken();
const API = `https://api.cloudflare.com/client/v4/accounts/${account}`;

let throttled = 0;
async function api(path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const j = res ? await res.json().catch(() => ({})) : {};
    if (res?.ok && j.success) return j.result;
    if (res?.status === 401 || res?.status === 403) token = refreshToken();
    // Rate limits and server errors get patient retries: a skipped LLM batch would lose its comments.
    const retryable = !res || res.status === 429 || res.status >= 500;
    if (res?.status === 429 && ++throttled % 20 === 1) console.error(`throttled by ${path.split("/")[1]} (${throttled} so far)`);
    if (attempt >= (retryable ? 8 : 3)) throw new Error(`${path}: ${res?.status} ${JSON.stringify(j.errors || "").slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, (retryable ? 3000 : 1500) * (attempt + 1)));
  }
}

// Minimal D1 binding over the REST API.
const lit = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
class Stmt {
  constructor(sql) { this.sql = sql; this.params = []; }
  bind(...p) { this.params = p; return this; }
  async all() { const r = await api(`/d1/database/${dbId}/query`, { sql: this.sql, params: this.params }); return { results: r[0].results }; }
  async first() { return (await this.all()).results[0] ?? null; }
  async run() { await this.all(); return {}; }
  inline() { let i = 0; return this.sql.replace(/\?\d?/g, () => lit(this.params[i++])); }
}
const DB = {
  prepare: (sql) => new Stmt(sql),
  // One round trip: the statements are inlined as literals (only our own INSERTs come through here).
  batch: async (stmts) => { for (let i = 0; i < stmts.length; i += 100) await api(`/d1/database/${dbId}/query`, { sql: stmts.slice(i, i + 100).map((s) => s.inline()).join(";\n") }); return []; },
};
const AI = { run: (model, input) => api(`/ai/run/${model}`, input) };
// No Worker limits here, so go wide: full 1000-comment pages per step, many LLM calls in flight per
// shard. Lookups stay narrow per shard because IMDb and Cinemeta throttle quickly.
const env = { ...cfg.vars, LLM_CONCURRENCY: "12", LOOKUP_CONCURRENCY: "3", TEXT_STEP_CALLS: "50", DB, AI };

const only = process.argv[2];
const b = { llm: Infinity, lookups: Infinity };
const started = Date.now();
const jobs = [
  ["imdb links", () => backfillLinks(env, b, "imdb")],
  ["wikipedia links", () => backfillLinks(env, b, "wiki")],
  [`text, since ${env.RECENT_SINCE}`, () => backfillText(env, b, Math.ceil((Date.now() - Date.parse(env.RECENT_SINCE)) / 86400000))],
  ...(only === "recent" ? [] : [
    ["ask hn threads", threadsSideBySide],
    [`text, back to ${BACKFILL_FROM}`, shardedText],
  ]),
  ["unread comments", sweepUnread],
];

// Every Ask HN recommendation thread, a few at a time. Runs once and returns false.
async function threadsSideBySide() {
  let threads = await getState(env, "threads_list", null);
  if (!threads) {
    threads = await recommendationThreads();
    await setState(env, "threads_list", threads);
  }
  const done = await getState(env, "threads_done", []);
  const todo = threads.filter((t) => !done.includes(t.id));
  await pool(todo, THREADS_AT_ONCE, async (t) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const comments = await threadComments(t.id);
        await processComments(env, comments, { useLlm: true, b });
        done.push(t.id);
        await setState(env, "threads_done", done);
        console.log(`Thread done (${done.length}/${threads.length}): ${t.title} (${comments.length} comments)`);
        return;
      } catch (err) {
        console.error(`thread ${t.id} failed: ${err.message}; retrying in 20s`);
        await new Promise((r) => setTimeout(r, 20000));
      }
    }
  });
  return false;
}

// The history before the RECENT_SINCE window, split into SHARDS date ranges read side by side,
// each with its own cursor in D1. Runs once and returns false.
async function shardedText() {
  const to = await getState(env, "text_before", null); // where the RECENT_SINCE pass stopped
  if (!to) throw new Error("run the recent window first");
  const from = Math.floor(Date.parse(BACKFILL_FROM) / 1000);
  const span = (to - from) / SHARDS;
  const shards = Array.from({ length: SHARDS }, (_, i) => ({
    i, key: `text_before:${i}`, floor: Math.floor(from + i * span), start: Math.floor(from + (i + 1) * span),
  }));
  await Promise.all(shards.map(async (sh) => {
    for (let step = 1; ; step++) {
      let more;
      try {
        more = await backfillTextRange(env, b, sh);
      } catch (err) {
        console.error(`shard ${sh.i} step ${step} failed: ${err.message}; retrying in 20s`);
        await new Promise((r) => setTimeout(r, 20000));
        continue;
      }
      if (!more) break;
      const at = new Date((await getState(env, sh.key)) * 1000).toISOString().slice(0, 16);
      console.log(`shard ${sh.i}: step ${step}, cursor ${at} (floor ${new Date(sh.floor * 1000).toISOString().slice(0, 10)}), ${Math.round((Date.now() - started) / 60000)} min`);
    }
    console.log(`shard ${sh.i} done`);
  }));
  return false;
}

// Comments an earlier pass left unread (a failed LLM call, or a link-only read): fetch them by id and read them.
async function sweepUnread() {
  const { results } = await DB.prepare("SELECT comment_id FROM processed WHERE llm = 0 ORDER BY comment_id LIMIT 400").all();
  if (!results.length) return false;
  const comments = (await pool(results, 8, async (r) => {
    const res = await fetch(`https://hn.algolia.com/api/v1/items/${r.comment_id}`);
    const c = res.ok ? await res.json() : null;
    return c?.text ? { id: c.id, author: c.author, html: c.text, createdAt: c.created_at_i, storyId: c.story_id, storyTitle: "" } : null;
  })).filter(Boolean);
  await processComments(env, comments, { useLlm: true, b });
  // Whatever is still unread now (deleted comments, a second failure) is marked read so this can't loop.
  await DB.batch(results.map((r) => DB.prepare("UPDATE processed SET llm = 1 WHERE comment_id = ?").bind(r.comment_id)));
  console.log(`unread comments: re-read ${comments.length} of ${results.length}`);
  return results.length === 400;
}
const cursor = async () => { const r = await DB.prepare("SELECT value FROM state WHERE key='text_before'").first(); return r ? new Date(JSON.parse(r.value) * 1000).toISOString().slice(0, 16) : "-"; };
for (const [name, job] of jobs) {
  console.log(`== ${name}`);
  for (let step = 1; ; step++) {
    let more;
    try { more = await job(); } catch (err) { console.error(`step ${step} failed: ${err.message}; retrying in 20s`); await new Promise((r) => setTimeout(r, 20000)); continue; }
    if (!more) break;
    console.log(`${name}: step ${step}, cursor ${await cursor()}, ${Math.round((Date.now() - started) / 60000)} min`);
  }
}
console.log(`all done in ${Math.round((Date.now() - started) / 60000)} min`);
