import LANDING_HTML from "./landing.html";
import { budget, ingestNew, backfillLinks, backfillThreads, backfillText, OutOfBudget, getState } from "./ingest.js";

const PAGE_SIZE = 100;
const CATALOGS = [
  { type: "movie", id: "hn-top-movies", name: "Hacker News: All-Time Top", rank: "top" },
  { type: "series", id: "hn-top-series", name: "Hacker News: All-Time Top", rank: "top" },
  { type: "movie", id: "hn-recent-movies", name: "Hacker News: Talked About Now", rank: "recent" },
  { type: "series", id: "hn-recent-series", name: "Hacker News: Talked About Now", rank: "recent" },
];

const MANIFEST = {
  id: "ro.alen.hn-stremio",
  version: "1.0.0",
  name: "Hacker News Picks",
  description: "Movies and series that Hacker News commenters recommend: the all-time favorites and what people are talking about right now.",
  logo: "https://news.ycombinator.com/y18.svg",
  resources: ["catalog"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: CATALOGS.map(({ type, id, name }) => ({ type, id, name, extra: [{ name: "skip", isRequired: false }] })),
};

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
const json = (data, status = 200, maxAge = 0) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...(maxAge ? { "cache-control": `public, max-age=${maxAge}` } : {}) },
  });

// ---------- ranking ----------

// Rank by distinct commenters, so one person linking a title ten times counts once.
async function ranked(env, { type, rank }, skip) {
  const recentDays = Number(env.RECENT_DAYS || 60);
  const since = rank === "recent" ? Math.floor(Date.now() / 1000) - recentDays * 86400 : 0;
  const { results } = await env.DB.prepare(
    `SELECT t.imdb_id, t.name, t.year, t.poster, COUNT(DISTINCT m.author) AS people, MAX(m.created_at) AS last
       FROM mentions m JOIN titles t ON t.imdb_id = m.imdb_id
      WHERE t.type = ?1 AND m.created_at >= ?2
      GROUP BY t.imdb_id
      ORDER BY people DESC, last DESC
      LIMIT ?3 OFFSET ?4`,
  ).bind(type, since, PAGE_SIZE, skip).all();

  return results.map((r) => ({
    id: r.imdb_id,
    type,
    name: r.name,
    poster: r.poster,
    releaseInfo: r.year || undefined,
    description:
      rank === "recent"
        ? `Talked about by ${plural(r.people, "Hacker News commenter")} in the last ${recentDays} days.`
        : `Recommended by ${plural(r.people, "Hacker News commenter")}.`,
  }));
}
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function catalog(request, env, ctx, type, id, extra) {
  const def = CATALOGS.find((c) => c.type === type && c.id === id);
  if (!def) return json({ metas: [] });
  const skip = Math.max(0, Number(new URLSearchParams(extra || "").get("skip")) || 0);

  // Rankings only change when the cron runs, so serve them from the edge cache for a while.
  const cache = caches.default;
  const cacheKey = new Request(new URL(`/cache/v2/${type}/${id}/${skip}`, request.url));
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const res = json({ metas: await ranked(env, def, skip), cacheMaxAge: 3600, staleRevalidate: 86400 }, 200, 3600);
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function stats(env) {
  const counts = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM mentions) AS mentions, (SELECT COUNT(*) FROM titles) AS titles,
            (SELECT COUNT(*) FROM processed) AS comments_read,
            (SELECT MIN(created_at) FROM mentions) AS oldest`,
  ).first();
  const bySource = await env.DB.prepare("SELECT source, COUNT(*) AS n FROM mentions GROUP BY source").all();
  const keys = ["fwd_cursor", "links_imdb_before", "links_wiki_before", "text_before", "threads_done", "threads_list"];
  const state = {};
  for (const k of keys) state[k] = await getState(env, k);
  return json({
    ...counts,
    bySource: Object.fromEntries(bySource.results.map((r) => [r.source, r.n])),
    backfill: {
      newCommentsUpTo: iso(state.fwd_cursor),
      imdbLinksBackTo: state.links_imdb_before === 0 ? "done" : iso(state.links_imdb_before),
      wikipediaLinksBackTo: state.links_wiki_before === 0 ? "done" : iso(state.links_wiki_before),
      askHnThreads: `${state.threads_done?.length || 0} of ${state.threads_list?.length ?? "?"}`,
      plainTextBackTo: iso(state.text_before),
    },
  });
}
const iso = (t) => (t ? new Date(t * 1000).toISOString() : null);

// ---------- routes ----------

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Not found" }, 404);
  const parts = url.pathname.split("/").filter(Boolean);

  if (!parts.length) return new Response(LANDING_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  if (parts.length === 1 && parts[0] === "manifest.json") return json(MANIFEST, 200, 3600);
  if (parts.length === 1 && parts[0] === "stats.json") return stats(env);
  // /catalog/{type}/{id}.json or /catalog/{type}/{id}/{extra}.json
  if (parts[0] === "catalog" && (parts.length === 3 || parts.length === 4)) {
    const id = parts[2].replace(/\.json$/, "");
    const extra = parts[3] ? decodeURIComponent(parts[3].replace(/\.json$/, "")) : "";
    return catalog(request, env, ctx, parts[1], id, extra);
  }
  return json({ error: "Not found" }, 404);
}

// ---------- background ingest ----------

async function ingest(env) {
  const b = budget(env);
  const started = Date.now();
  const timeLeft = () => Date.now() - started < 8 * 60_000;
  try {
    const n = await ingestNew(env, b);
    console.log(`New comments checked: ${n}`);
    // Backfill history in order: link mentions (cheap, no LLM), plain text for the "Talked About Now"
    // window, Ask HN recommendation threads, then older plain text.
    const jobs = [
      () => backfillLinks(env, b, "imdb"),
      () => backfillLinks(env, b, "wiki"),
      () => backfillText(env, b, Number(env.RECENT_DAYS || 60)),
      () => backfillThreads(env, b),
      () => backfillText(env, b, Number(env.TEXT_BACKFILL_DAYS || 365)),
    ];
    for (const job of jobs) {
      while (timeLeft() && b.llm > 0 && b.lookups > 0) {
        if (!(await job())) break;
      }
    }
  } catch (err) {
    if (!(err instanceof OutOfBudget)) throw err;
  }
  console.log(`Ingest run done in ${Math.round((Date.now() - started) / 1000)}s, budget left`, b);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      console.error(err);
      return json({ error: err.message }, 500);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(ingest(env));
  },
};
