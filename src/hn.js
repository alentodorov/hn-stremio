// Hacker News data through the Algolia HN Search API (no key needed).
const ALGOLIA = "https://hn.algolia.com/api/v1";
const PAGE = 1000; // Algolia's max hits per request (and per query)

async function get(path, params) {
  const url = `${ALGOLIA}/${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (attempt >= 2 || res.status < 500) throw new Error(`Algolia ${res.status} for ${path}`);
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
}

// One page of comments matching `query`, newest first, with after < created_at_i < before.
// Walk further back by passing the oldest created_at_i you got as the next `before`.
export async function commentsPage({ query, anyWord = false, after = 0, before }) {
  const params = {
    query,
    tags: "comment",
    hitsPerPage: String(PAGE),
    typoTolerance: "false",
    restrictSearchableAttributes: "comment_text",
    numericFilters: `created_at_i>${after},created_at_i<${before}`,
    attributesToRetrieve: "objectID,author,comment_text,created_at_i,story_id,story_title,parent_id",
    attributesToHighlight: "",
  };
  if (anyWord) params.optionalWords = query; // match any of the words, not all of them
  const { hits = [], nbHits = 0 } = await get("search_by_date", params);
  return { hits: hits.map(toComment), more: nbHits > hits.length };
}

function toComment(h) {
  return {
    id: Number(h.objectID),
    author: h.author,
    html: h.comment_text || "",
    createdAt: h.created_at_i,
    storyId: h.story_id,
    storyTitle: h.story_title || "",
  };
}

// Ask HN threads that ask for movie, TV or documentary recommendations.
const THREAD_QUERIES = ["movies", "films", "tv shows", "tv series", "documentaries", "anime", "shows to watch", "netflix"];
const THREAD_TITLE = /\b(movies?|films?|tv|shows?|series|documentar(y|ies)|anime|watch)\b/i;
const ASKING = /\b(recommend|best|favou?rite|good|great|underrated|what|which|any)\b/i;

export async function recommendationThreads() {
  const seen = new Map();
  for (const query of THREAD_QUERIES) {
    const { hits = [] } = await get("search", {
      query,
      tags: "ask_hn",
      hitsPerPage: "100",
      numericFilters: "num_comments>=25",
      attributesToRetrieve: "objectID,title,num_comments,points,created_at_i",
      attributesToHighlight: "",
    });
    for (const h of hits) {
      if (THREAD_TITLE.test(h.title) && ASKING.test(h.title)) seen.set(Number(h.objectID), h);
    }
  }
  return [...seen.values()].map((h) => ({ id: Number(h.objectID), title: h.title, comments: h.num_comments }));
}

// Every comment in a thread, flattened.
export async function threadComments(storyId) {
  const root = await get(`items/${storyId}`, {});
  const out = [];
  const walk = (node) => {
    for (const c of node.children || []) {
      if (c.type === "comment" && c.text && c.author) {
        out.push({ id: c.id, author: c.author, html: c.text, createdAt: c.created_at_i, storyId, storyTitle: root.title || "" });
      }
      walk(c);
    }
  };
  walk(root);
  return out;
}
