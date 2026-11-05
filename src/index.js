import LANDING_HTML from "./landing.html";
import { budget, ingestNew, OutOfBudget, getState } from "./ingest.js";

const PAGE_SIZE = 100;
const CATALOGS = [
  { type: "movie", id: "hn-top-movies", name: "Movies: All-Time Top", rank: "top" },
  { type: "series", id: "hn-top-series", name: "Series: All-Time Top", rank: "top" },
  { type: "movie", id: "hn-recent-movies", name: "Movies: Recommended This Year", rank: "recent" },
  { type: "series", id: "hn-recent-series", name: "Series: Recommended This Year", rank: "recent" },
];

const MANIFEST = {
  id: "ro.alen.hn-stremio",
  version: "1.2.0",
  name: "Hacker News Picks",
  description: "Movies and series that HN recommends: the all-time favorites and this year's picks.",
  logo: "https://news.ycombinator.com/y18.svg",
  resources: ["catalog"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: CATALOGS.map(({ type, id, name }) => ({ type, id, name, extra: [{ name: "skip", isRequired: false }] })),
};

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };

// ---------- analytics ----------

// One anonymous PostHog event per request, sent after the response. No person profiles: the
// distinct id is a daily hash of ip + user agent, enough to count distinct clients.
async function track(env, request, event, properties) {
  if (!env.POSTHOG_TOKEN) return;
  const ip = request.headers.get("cf-connecting-ip") || "";
  const ua = request.headers.get("user-agent") || "";
  const day = new Date().toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ip}|${ua}|${day}`));
  const distinct_id = [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
  await fetch(`${env.POSTHOG_HOST || "https://eu.i.posthog.com"}/i/v0/e/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: env.POSTHOG_TOKEN,
      event,
      distinct_id,
      properties: {
        ...properties,
        $process_person_profile: false,
        $lib: "hn-stremio-worker",
        $current_url: request.url,
        client: /stremio/i.test(ua) ? "stremio" : /mozilla/i.test(ua) ? "browser" : "other",
        country: request.cf?.country || null,
      },
    }),
  }).catch(() => {});
}
const json = (data, status = 200, maxAge = 0) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS, ...(maxAge ? { "cache-control": `public, max-age=${maxAge}` } : {}) },
  });

// ---------- ranking ----------

// Rank by distinct commenters, so one person linking a title ten times counts once.
async function ranked(env, { type, rank }, skip) {
  const since = rank === "recent" ? Math.floor(Date.parse(env.RECENT_SINCE || "2026-01-01") / 1000) : 0;
  const year = new Date(since * 1000).getUTCFullYear();
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
        ? `Recommended by ${plural(r.people, "Hacker News commenter")} in ${year}.`
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
  const cacheKey = new Request(new URL(`/cache/v7/${type}/${id}/${skip}`, request.url));
  const hit = await cache.match(cacheKey);
  ctx.waitUntil(track(env, request, "catalog", { catalog: id, type, skip, cached: !!hit }));
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

  if (!parts.length) {
    const html = LANDING_HTML.replace("__POSTHOG_TOKEN__", env.POSTHOG_TOKEN || "").replace("__POSTHOG_HOST__", env.POSTHOG_HOST || "");
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (parts.length === 1 && parts[0] === "manifest.json") {
    ctx.waitUntil(track(env, request, "manifest", {}));
    return json(MANIFEST, 200, 3600);
  }
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

// The daily cron only reads new comments. History is backfilled from a laptop with scripts/backfill.mjs.
async function ingest(env) {
  const b = budget(env);
  const started = Date.now();
  try {
    const n = await ingestNew(env, b);
    console.log(`New comments checked: ${n}`);
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
