// Find the movies and series an HN comment talks about.
//  1. Links: IMDb title links give the id directly; Wikipedia film/TV links go through Wikidata (P345).
//  2. Plain text: an LLM reads batches of comments and lists the titles each one recommends.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m);

export function hrefs(html) {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => decode(m[1]));
}

export function toText(html) {
  return decode(html.replace(/<p>/g, "\n").replace(/<a [^>]*>(.*?)<\/a>/g, "$1").replace(/<[^>]+>/g, "")).trim();
}

const IMDB = /imdb\.com\/(?:[a-z]{2}\/)?title\/(tt\d{6,10})/gi;
// Only Wikipedia articles whose disambiguation says they are a film or show.
const WIKI = /\ben(?:\.m)?\.wikipedia\.org\/wiki\/([^\s?#"<>]+)/gi;
const WIKI_SCREEN = /_\((?:[^)]*_)?(film|TV_series|miniseries|TV_programme|TV_program|web_series|documentary|anime|TV_film)\)$/i;

export function linkCandidates(html) {
  const text = hrefs(html).join(" ") + " " + toText(html);
  const imdb = new Set([...text.matchAll(IMDB)].map((m) => m[1].toLowerCase()));
  const wiki = new Set();
  for (const m of text.matchAll(WIKI)) {
    let title;
    try {
      title = decodeURIComponent(m[1]).replace(/ /g, "_");
    } catch {
      continue;
    }
    if (WIKI_SCREEN.test(title)) wiki.add(title);
  }
  return { imdb: [...imdb], wiki: [...wiki] };
}

// Wikipedia article titles -> IMDb title ids, 50 at a time.
export async function wikiToImdb(titles) {
  const out = {};
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const wp = await fetchJson("https://en.wikipedia.org/w/api.php", {
      action: "query", prop: "pageprops", ppprop: "wikibase_item", redirects: "1", format: "json", titles: batch.join("|"),
    });
    // Map each requested title through normalization and redirects to its page.
    const alias = {};
    for (const { from, to } of [...(wp.query?.normalized || []), ...(wp.query?.redirects || [])]) alias[from] = to;
    const qidOf = {};
    for (const p of Object.values(wp.query?.pages || {})) if (p.pageprops?.wikibase_item) qidOf[p.title] = p.pageprops.wikibase_item;
    const want = {};
    for (const t of batch) {
      let name = t.replace(/_/g, " ");
      for (let hop = 0; hop < 3 && alias[name]; hop++) name = alias[name];
      if (qidOf[name]) want[t] = qidOf[name];
    }
    const qids = [...new Set(Object.values(want))];
    const wd = qids.length
      ? await fetchJson("https://www.wikidata.org/w/api.php", { action: "wbgetentities", ids: qids.join("|"), props: "claims", format: "json" })
      : {};
    for (const [t, q] of Object.entries(want)) {
      const imdb = wd.entities?.[q]?.claims?.P345?.[0]?.mainsnak?.datavalue?.value;
      out[t] = typeof imdb === "string" && imdb.startsWith("tt") ? imdb : "";
    }
    for (const t of batch) out[t] ??= "";
  }
  return out;
}

async function fetchJson(base, params) {
  const res = await fetch(`${base}?${new URLSearchParams(params)}`, {
    headers: { "user-agent": "hn-stremio/1.0 (https://github.com/alentodorov/hn-stremio)" },
  });
  if (!res.ok) throw new Error(`${new URL(base).host} ${res.status}`);
  return res.json();
}

// ---------- LLM extraction ----------

const SCHEMA = {
  type: "object",
  properties: {
    comments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          titles: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                year: { type: ["integer", "null"] },
                type: { type: "string", enum: ["movie", "series"] },
              },
              required: ["title", "year", "type"],
            },
          },
        },
        required: ["id", "titles"],
      },
    },
  },
  required: ["comments"],
};

const PROMPT = `You read Hacker News comments and list the movies and TV series each commenter recommends,
praises, or says is worth watching. Documentaries count (type "movie" for films, "series" for docuseries),
and so do anime and miniseries.

Skip: titles mentioned only negatively or in passing as a reference ("like in The Matrix"), books, games,
YouTube videos, podcasts, people, companies, and the story's own subject when the commenter is not recommending it.
Most comments recommend nothing; give them an empty list.

Use the commonly known English title and the original release year (null if unsure).
Reply with JSON only: {"comments": [{"id": <comment id>, "titles": [{"title", "year", "type"}]}]} with one entry per comment.`;

function parseJson(out) {
  let v = out?.choices?.[0]?.message?.content ?? out?.response ?? out;
  if (typeof v === "string") {
    const m = /\{[\s\S]*\}/.exec(v);
    v = JSON.parse(m ? m[0] : v);
  }
  return v;
}

// comments: [{id, html, storyTitle}] -> { [commentId]: [{title, year, type}] }
export async function llmTitles(env, comments) {
  const input = comments
    .map((c) => `### Comment ${c.id} (story: ${c.storyTitle || "?"})\n${toText(c.html).slice(0, 1500)}`)
    .join("\n\n");
  const messages = [
    { role: "system", content: PROMPT },
    { role: "user", content: input },
  ];
  let parsed;
  try {
    parsed = parseJson(await env.AI.run(env.MODEL, {
      messages, response_format: { type: "json_schema", json_schema: SCHEMA }, max_tokens: 4096, temperature: 0,
    }));
  } catch (err) {
    // JSON mode can fail with "JSON Mode couldn't be met"; retry once as plain text.
    console.warn("JSON mode failed, retrying as text:", err.message);
    parsed = parseJson(await env.AI.run(env.MODEL, { messages, max_tokens: 4096, temperature: 0 }));
  }
  const result = {};
  for (const c of parsed?.comments || []) {
    const titles = (Array.isArray(c.titles) ? c.titles : [])
      .filter((t) => t && typeof t.title === "string" && t.title.trim() && (t.type === "movie" || t.type === "series"))
      .map((t) => ({ title: t.title.trim(), year: Number(t.year) || null, type: t.type }));
    if (titles.length) result[Number(c.id)] = titles;
  }
  return result;
}
