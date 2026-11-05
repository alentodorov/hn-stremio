// Turn HN comments into title mentions stored in D1, and move the ingest cursors along.
import { commentsPage, recommendationThreads, threadComments } from "./hn.js";
import { linkCandidates, wikiToImdb, llmTitles } from "./extract.js";
import { byImdbId, search } from "./cinemeta.js";

const LINK_QUERIES = { imdb: "imdb.com/title", wiki: "wikipedia.org" };
// Comments containing any of these words go to the LLM.
const SCREEN_WORDS = "movie movies film films documentary documentaries series miniseries season episodes anime watched watching rewatch netflix hbo";
const LLM_BATCH = 20;

// ---------- small D1 helpers ----------

export async function getState(env, key, fallback = null) {
  const row = await env.DB.prepare("SELECT value FROM state WHERE key = ?").bind(key).first();
  return row ? JSON.parse(row.value) : fallback;
}
export function setState(env, key, value) {
  return env.DB.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, JSON.stringify(value)).run();
}

// Per-run limits so one cron invocation stays well inside the Workers subrequest and time limits.
export function budget(env) {
  return { llm: Number(env.LLM_CALLS_PER_RUN || 10), lookups: Number(env.LOOKUPS_PER_RUN || 300) };
}

// ---------- resolving ----------

const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// Run fn over items with at most `width` in flight, keeping result order.
export async function pool(items, width, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

// Cached lookups for many keys at once: key -> imdb id ('' = known miss); absent = never looked up.
async function cachedLookups(env, keys) {
  const out = new Map();
  for (const chunk of chunks([...new Set(keys)], 90)) {
    const { results } = await env.DB.prepare(`SELECT key, imdb_id FROM lookups WHERE key IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
    for (const r of results) out.set(r.key, r.imdb_id);
  }
  return out;
}
const saveLookup = (env, key, id) =>
  env.DB.prepare("INSERT OR REPLACE INTO lookups (key, imdb_id) VALUES (?, ?)").bind(key, id || "");

// Make sure each IMDb id has a titles row. Returns the ids that resolved to a movie or series.
async function ensureTitles(env, ids, b) {
  ids = [...ids];
  const ok = new Set();
  for (const chunk of chunks(ids, 90)) {
    const { results } = await env.DB.prepare(`SELECT imdb_id FROM titles WHERE imdb_id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
    for (const r of results) ok.add(r.imdb_id);
  }
  const unknown = ids.filter((id) => !ok.has(id));
  const known = await cachedLookups(env, unknown.map((id) => `id:${id}`));
  const missing = unknown.filter((id) => known.get(`id:${id}`) !== ""); // "" = known miss
  if (!missing.length) return ok;
  if (b.lookups <= 0) throw new OutOfBudget();
  // Look up a few at a time (Workers allow 6 open connections; the local backfill uses more).
  const width = Number(env.LOOKUP_CONCURRENCY || 6);
  const take = missing.slice(0, Math.max(width, Math.floor(b.lookups / 2)));
  b.lookups -= 2 * take.length;
  const found = await pool(take, width, (id) => byImdbId(id).catch(() => undefined));
  const stmts = [];
  for (const [j, t] of found.entries()) {
    if (t === undefined) continue; // network error: try again another time
    if (t) {
      stmts.push(env.DB.prepare("INSERT OR REPLACE INTO titles (imdb_id, type, name, year, poster) VALUES (?, ?, ?, ?, ?)").bind(t.imdb_id, t.type, t.name, t.year, t.poster));
      ok.add(take[j]);
    } else {
      stmts.push(saveLookup(env, `id:${take[j]}`, ""));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  if (take.length < missing.length) throw new OutOfBudget();
  return ok;
}

export class OutOfBudget extends Error {}

// ---------- the pipeline ----------

// Store mentions found in `comments`. With useLlm, plain-text titles are extracted too.
// Throws OutOfBudget if it had to stop; comments are processed oldest first and
// already-processed comments are skipped, so a stopped run resumes where it left off.
export async function processComments(env, comments, { useLlm, b }) {
  comments = [...comments].sort((x, y) => x.createdAt - y.createdAt || x.id - y.id);
  const already = new Set();
  for (const chunk of chunks(comments.map((c) => c.id), 90)) {
    const { results } = await env.DB.prepare(
      `SELECT comment_id FROM processed WHERE comment_id IN (${chunk.map(() => "?").join(",")})${useLlm ? " AND llm = 1" : ""}`,
    ).bind(...chunk).all();
    results.forEach((r) => already.add(r.comment_id));
  }
  const batches = chunks(comments.filter((c) => !already.has(c.id)), LLM_BATCH);

  // The LLM calls are the slow part, so run them for several batches at once, up to the budget.
  // A batch whose call fails is left unread (llm = 0) so a later pass picks it up again.
  const picksOf = new Map();
  if (useLlm) {
    const allowed = batches.slice(0, Math.min(batches.length, b.llm));
    b.llm -= allowed.length;
    await pool(allowed, Number(env.LLM_CONCURRENCY || 1), async (batch) => {
      try {
        picksOf.set(batch, await llmTitles(env, batch));
      } catch (err) {
        console.error("LLM extraction failed, leaving batch for later:", err.message);
        picksOf.set(batch, null);
      }
    });
  }

  const width = Number(env.LOOKUP_CONCURRENCY || 6);
  for (const batch of batches) {
    const found = new Map(batch.map((c) => [c.id, []])); // comment id -> [{imdb_id, source}]

    // Links
    const cands = new Map(batch.map((c) => [c.id, linkCandidates(c.html)]));
    for (const c of batch) for (const id of cands.get(c.id).imdb) found.get(c.id).push({ imdb_id: id, source: "imdb" });
    const wikiNeeded = [...new Set([...cands.values()].flatMap((l) => l.wiki))];
    if (wikiNeeded.length) {
      const wikiMap = await cachedLookups(env, wikiNeeded.map((w) => `wiki:${w}`));
      const unknown = wikiNeeded.filter((w) => !wikiMap.has(`wiki:${w}`));
      if (unknown.length) {
        if (b.lookups <= 0) throw new OutOfBudget();
        b.lookups -= 2 * Math.ceil(unknown.length / 50);
        const fresh = await wikiToImdb(unknown);
        const stmts = [];
        for (const [w, id] of Object.entries(fresh)) {
          wikiMap.set(`wiki:${w}`, id);
          stmts.push(saveLookup(env, `wiki:${w}`, id));
        }
        if (stmts.length) await env.DB.batch(stmts);
      }
      for (const c of batch) {
        for (const w of cands.get(c.id).wiki) {
          const id = wikiMap.get(`wiki:${w}`);
          if (id) found.get(c.id).push({ imdb_id: id, source: "wikipedia" });
        }
      }
    }

    // Plain text: match the LLM's titles to IMDb ids, through the lookup cache.
    const picks = useLlm ? picksOf.get(batch) : undefined;
    if (useLlm && picks === undefined) throw new OutOfBudget();
    const llmRead = useLlm && picks !== null;
    if (llmRead) {
      const wanted = [];
      for (const [cid, titles] of Object.entries(picks)) {
        if (!found.has(Number(cid))) continue;
        for (const t of titles) wanted.push({ cid: Number(cid), t, key: `q:${t.type}|${t.title.toLowerCase()}|${t.year || ""}` });
      }
      const cached = await cachedLookups(env, wanted.map((w) => w.key));
      const unknown = [...new Map(wanted.filter((w) => !cached.has(w.key)).map((w) => [w.key, w])).values()];
      if (unknown.length) {
        if (b.lookups <= 0) throw new OutOfBudget();
        b.lookups -= unknown.length;
        const ids = await pool(unknown, width, (w) => search(w.t).then((id) => id || "", () => undefined));
        const stmts = [];
        for (const [i, w] of unknown.entries()) {
          if (ids[i] === undefined) continue; // network error: try again another time
          cached.set(w.key, ids[i]);
          stmts.push(saveLookup(env, w.key, ids[i]));
        }
        if (stmts.length) await env.DB.batch(stmts);
      }
      for (const w of wanted) {
        const id = cached.get(w.key);
        if (id) found.get(w.cid).push({ imdb_id: id, source: "llm" });
      }
    }

    // Save
    const ids = new Set([...found.values()].flat().map((m) => m.imdb_id));
    const valid = await ensureTitles(env, ids, b);
    const stmts = [];
    for (const c of batch) {
      const seen = new Set();
      for (const m of found.get(c.id)) {
        if (!valid.has(m.imdb_id) || seen.has(m.imdb_id)) continue;
        seen.add(m.imdb_id);
        stmts.push(env.DB.prepare(
          "INSERT OR IGNORE INTO mentions (comment_id, imdb_id, author, created_at, story_id, source) VALUES (?, ?, ?, ?, ?, ?)",
        ).bind(c.id, m.imdb_id, c.author, c.createdAt, c.storyId, m.source));
      }
    }
    for (const c of batch) {
      stmts.push(env.DB.prepare("INSERT INTO processed (comment_id, llm) VALUES (?, ?) ON CONFLICT(comment_id) DO UPDATE SET llm = max(llm, excluded.llm)")
        .bind(c.id, llmRead ? 1 : 0));
    }
    await env.DB.batch(stmts);
  }
}

// ---------- jobs ----------

// New comments since the last run: links (no LLM) and screen-related words (LLM).
export async function ingestNew(env, b) {
  const now = Math.floor(Date.now() / 1000);
  const since = await getState(env, "fwd_cursor", now - 3600);
  const until = now - 60; // leave a minute for Algolia to index
  const all = new Map();
  for (const [query, anyWord] of [[LINK_QUERIES.imdb, false], [LINK_QUERIES.wiki, false], [SCREEN_WORDS, true]]) {
    let before = until;
    for (let page = 0; page < 5; page++) {
      const { hits, more } = await commentsPage({ query, anyWord, after: since, before });
      for (const h of hits) {
        const prev = all.get(h.id);
        all.set(h.id, { ...h, llm: anyWord || prev?.llm || false });
      }
      if (!more || !hits.length) break;
      before = hits.at(-1).createdAt;
    }
  }
  const list = [...all.values()];
  await processComments(env, list.filter((c) => !c.llm), { useLlm: false, b });
  await processComments(env, list.filter((c) => c.llm), { useLlm: true, b });
  await setState(env, "fwd_cursor", until);
  return list.length;
}

// All-time link mentions, walking back one page per call. Returns false when finished.
export async function backfillLinks(env, b, which) {
  const key = `links_${which}_before`;
  const before = await getState(env, key, Math.floor(Date.now() / 1000));
  if (before === 0) return false;
  const { hits } = await commentsPage({ query: LINK_QUERIES[which], before });
  if (!hits.length) {
    await setState(env, key, 0);
    return false;
  }
  await processComments(env, hits, { useLlm: false, b });
  await setState(env, key, hits.at(-1).createdAt);
  return true;
}

// Ask HN recommendation threads, LLM-read in full. Returns false when every thread is done.
export async function backfillThreads(env, b) {
  const done = await getState(env, "threads_done", []);
  let threads = await getState(env, "threads_list", null);
  if (!threads) {
    threads = await recommendationThreads();
    await setState(env, "threads_list", threads);
  }
  const next = threads.find((t) => !done.includes(t.id));
  if (!next) return false;
  const comments = await threadComments(next.id);
  // The LLM pass is idempotent per comment, so a partial run just resumes next time.
  await processComments(env, comments, { useLlm: true, b });
  done.push(next.id);
  await setState(env, "threads_done", done);
  console.log(`Thread done: ${next.title} (${comments.length} comments)`);
  return true;
}

// Older plain-text comments, back to `days` ago. Returns false when finished.
export async function backfillText(env, b, days) {
  const floor = Math.floor(Date.now() / 1000) - days * 86400;
  const fwd = await getState(env, "fwd_cursor", Math.floor(Date.now() / 1000));
  const before = await getState(env, "text_before", fwd);
  if (before <= floor) return false;
  // Small pages: each comment costs LLM time.
  const { hits } = await commentsPage({ query: SCREEN_WORDS, anyWord: true, after: floor, before });
  if (!hits.length) {
    await setState(env, "text_before", floor);
    return false;
  }
  // A bounded number of calls per step, so the caller gets to check the clock between steps.
  const calls = Math.min(b.llm, Number(env.TEXT_STEP_CALLS || 10));
  const take = hits.slice(0, calls * LLM_BATCH);
  // Cut on a timestamp boundary so the cursor never skips comments sharing a second.
  const cut = take.at(-1).createdAt;
  const chunk = hits.filter((h) => h.createdAt >= cut);
  await processComments(env, chunk, { useLlm: true, b: { ...b, llm: Infinity } });
  b.llm -= calls;
  await setState(env, "text_before", cut);
  return true;
}
