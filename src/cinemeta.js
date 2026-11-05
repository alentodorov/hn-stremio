// Title metadata: IMDb's suggestion endpoint for ids, Cinemeta (Stremio's catalog) for title search. No keys needed.
const CINEMETA = "https://v3-cinemeta.strem.io";

async function getJson(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

// IMDb id -> title, typed by IMDb's own suggestion endpoint. Cinemeta can't be used for this: its
// movie endpoint answers for series ids with an unrelated title, and its series endpoint has bogus
// entries for some movie ids (tt0137523, Fight Club, is a Korean TV show there).
const IMDB_TYPES = { movie: "movie", tvMovie: "movie", tvSpecial: "movie", video: "movie", tvSeries: "series", tvMiniSeries: "series" };

// Posters come from IMDb too: Stremio's metahub serves the wrong picture for some ids
// (tt0115398, Triumph of the Nerds, gets a Chinese cartoon) and nothing for others.
export const posterUrl = (hit, id) =>
  hit?.i?.imageUrl ? hit.i.imageUrl.replace(/\._V1_[^.]*\.(jpg|png)$/i, "._V1_SX300_.$1") : `https://images.metahub.space/poster/small/${id}/img`;

export async function byImdbId(id) {
  const res = await fetch(`https://v3.sg.media-imdb.com/suggestion/t/${id}.json`);
  if (!res.ok) throw new Error(`IMDb suggestion ${res.status}`);
  const hit = ((await res.json()).d || []).find((d) => d.id === id);
  const type = IMDB_TYPES[hit?.qid];
  if (!type) return null; // episodes, shorts, games, people, ...
  return { imdb_id: id, type, name: hit.l, year: hit.y ? String(hit.y) : null, poster: posterUrl(hit, id) };
}

const yearOf = (s) => {
  const m = /\d{4}/.exec(s || "");
  return m ? Number(m[0]) : null;
};
const norm = (s) => s.toLowerCase().replace(/&/g, "and").replace(/^the /, "").replace(/[^a-z0-9]+/g, " ").trim();

// Title (+ year) from the LLM -> IMDb id. Requires an exact name match or a close name plus matching year,
// so a vague or misspelled title is dropped instead of surfacing something unrelated. The caller then
// resolves the id with byImdbId, which supplies the type, name, year and poster.
export async function search({ title, year, type }) {
  const data = await getJson(`${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(title)}.json`);
  const metas = data?.metas || [];
  let best = null;
  let bestScore = 0;
  for (const m of metas.slice(0, 10)) {
    const y = yearOf(m.releaseInfo);
    let score = 0;
    if (norm(m.name) === norm(title)) score += 2;
    else if (norm(m.name).startsWith(norm(title)) || norm(title).startsWith(norm(m.name))) score += 1;
    if (year && y && Math.abs(y - year) <= 1) score += 2;
    else if (year && y) score -= 1;
    if (score > bestScore) [best, bestScore] = [m, score];
  }
  return bestScore >= 2 ? best.imdb_id || best.id : null;
}
