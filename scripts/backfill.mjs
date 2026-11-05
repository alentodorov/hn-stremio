// Run the history backfill from this machine against the production D1 and Workers AI,
// using the same code as the Worker but without its time limit. The Worker's cron only reads
// new comments; all history comes from here.
//   node scripts/backfill.mjs            # until every backfill job reports done
//   node scripts/backfill.mjs recent     # stop once the RECENT_DAYS text window is done
// Needs a wrangler login (uses its OAuth token). Safe to stop and restart: cursors live in D1.
const BACKFILL_FROM = "2026-01-01"; // how far back the plain-text LLM pass goes
import { readFileSync } from "node:fs";
import { backfillLinks, backfillThreads, backfillText } from "../src/ingest.js";

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

async function api(path, body) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const j = res ? await res.json().catch(() => ({})) : {};
    if (res?.ok && j.success) return j.result;
    if (res?.status === 401 || res?.status === 403) token = refreshToken();
    // Rate limits and server errors get patient retries: a skipped LLM batch would lose its comments.
    const retryable = !res || res.status === 429 || res.status >= 500;
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
// No Worker limits here, so go wide: many LLM calls in flight and full 1000-comment pages per step.
const env = { ...cfg.vars, LLM_CONCURRENCY: "24", LOOKUP_CONCURRENCY: "8", TEXT_STEP_CALLS: "50", DB, AI };

const only = process.argv[2];
const b = { llm: Infinity, lookups: Infinity };
const started = Date.now();
const jobs = [
  ["imdb links", () => backfillLinks(env, b, "imdb")],
  ["wikipedia links", () => backfillLinks(env, b, "wiki")],
  [`text, last ${env.RECENT_DAYS} days`, () => backfillText(env, b, Number(env.RECENT_DAYS || 60))],
  ...(only === "recent" ? [] : [
    ["ask hn threads", () => backfillThreads(env, b)],
    [`text, back to ${BACKFILL_FROM}`, () => backfillText(env, b, Math.ceil((Date.now() - Date.parse(BACKFILL_FROM)) / 86400000))],
  ]),
];
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
