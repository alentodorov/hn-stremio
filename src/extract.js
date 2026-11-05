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
                type: { type: "string", enum: ["movie", "series", "book", "game", "podcast", "video", "music", "other"] },
                quote: { type: "string" },
                recommends: { type: "boolean" },
              },
              required: ["title", "year", "type", "quote", "recommends"],
            },
          },
        },
        required: ["id", "titles"],
      },
    },
  },
  required: ["comments"],
};

const PROMPT = `You read Hacker News comments and pick out the movies and TV series that the commenter personally
likes: they recommend it, say they liked, loved or enjoyed it, call it great, fun, brilliant, a favorite or worth
watching, or suggest it to someone asking what to watch. Documentaries, docuseries, anime and miniseries count.

The opinion must be the commenter's own view of the work itself. A title does NOT count when it is only used to
make a point: an analogy or comparison ("like in The Matrix", "straight out of Black Mirror"), a plot detail, a
quote, a character, a joke, a neutral mention of having seen it or of its existence, a negative or mixed opinion,
or a remark about its box office, popularity, budget, awards or influence ("made strong returns", "did well").
The story's own subject doesn't count unless the commenter praises it. Books, games, YouTube videos, lectures,
podcasts, songs, people and companies are never titles.

Most comments have nothing: give them an empty list. When in doubt, leave it out.

For each title give:
- "title": the commonly known English title, as named in the comment. Skip it if the comment does not name it
  ("the documentary about that", "his short film").
- "year": the original release year. You know this for almost every real film and show; null only if you don't.
- "type": what it actually is: "movie", "series", "book", "game", "podcast", "video", "music" or "other".
- "quote": the exact words from the comment, copied verbatim, that show the commenter likes or recommends it.
- "recommends": true only if the quote shows the commenter personally likes it or recommends it; false otherwise.

Reply with JSON only: {"comments": [{"id": <comment id>, "titles": [{"title", "year", "type", "quote", "recommends"}]}]}
with one entry per comment.`;

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
    // More room this time: a reasoning model may spend tokens thinking before the JSON.
    parsed = parseJson(await env.AI.run(env.MODEL, { messages, max_tokens: 8192, temperature: 0 }));
  }
  const text = Object.fromEntries(comments.map((c) => [c.id, squash(toText(c.html))]));
  const result = {};
  for (const c of parsed?.comments || []) {
    const body = text[Number(c.id)];
    if (!body) continue;
    const titles = (Array.isArray(c.titles) ? c.titles : [])
      .filter((t) => t && t.recommends === true && typeof t.title === "string" && (t.type === "movie" || t.type === "series"))
      .filter((t) => !NOT_A_TITLE.test(t.title.trim()))
      .filter((t) => t.year) // no year: the model isn't sure the title exists, and a bare name matches too loosely
      // The quote must really be in the comment: this drops titles the model made up or took from the story title.
      .filter((t) => typeof t.quote === "string" && squash(t.quote).length >= 8 && body.includes(squash(t.quote)))
      .map((t) => ({ title: t.title.trim(), year: Number(t.year) || null, type: t.type }));
    if (titles.length) result[Number(c.id)] = titles;
  }
  return result;
}

const NOT_A_TITLE = /^(none|null|n\/a|unknown|untitled|-+|(the |this |that |a )?(documentary|docuseries|film|movie|short( film)?|series|show|episode|video|anime|miniseries))$/i;
const squash = (s) => s.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();
