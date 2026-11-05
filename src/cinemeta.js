// Title metadata from IMDb's suggestion endpoint: ids, type, name, year, poster, and title search. No keys needed.

// A throttled or failing upstream throws, so the caller retries later instead of caching a miss.
async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { redirect: "follow" });
    if (res.ok) return res.json().catch(() => null);
    if (res.status !== 429 && res.status < 500) return null;
    if (attempt >= 3) throw new Error(`${new URL(url).host} ${res.status}`);
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
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
  const data = await getJson(`https://v3.sg.media-imdb.com/suggestion/t/${id}.json`);
  if (!data) throw new Error("IMDb suggestion failed");
  const hit = (data.d || []).find((d) => d.id === id);
  const type = IMDB_TYPES[hit?.qid];
  if (!type) return null; // episodes, shorts, games, people, ...
  return { imdb_id: id, type, name: hit.l, year: hit.y ? String(hit.y) : null, poster: posterUrl(hit, id) };
}

const norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, "and").replace(/^the /, "").replace(/[^a-z0-9]+/g, " ").trim();
const tight = (s) => norm(s).replace(/ /g, "");

// Title (+ year) from the LLM -> IMDb id, through IMDb's own search, which knows aliases (Se7en,
// WarGames, Lola rennt) and franchise prefixes (Lower Decks). A candidate must be the right type and
// either match by name, or be among IMDb's first three results with the right year. The year ranks
// same-named titles and vetoes loose matches; an exact name with the wrong year still passes, because
// the model's year is often off for recent releases.
export async function search({ title, year, type }) {
  const slug = norm(title).replace(/ /g, "_");
  if (!slug) return null;
  const data = await getJson(`https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(slug)}.json`);
  const hits = (data?.d || []).filter((h) => IMDB_TYPES[h.qid] === type);
  const q = norm(title);
  let best = null;
  let bestScore = 0;
  // Name points dominate: an exact name with the wrong year (6 - 1) still beats a contained name
  // with the right year (2 + 2), which beats a top-three result with the right year (1 + 2).
  // Without a year from the model, only an exact name is trusted.
  hits.forEach((h, i) => {
    const name = norm(h.l);
    let score = 0;
    if (name === q || tight(h.l) === tight(title)) score = 6;
    else if (!year) return;
    else if (` ${name} `.includes(` ${q} `)) score = 2;
    else if (i < 3) score = 1;
    if (!score) return;
    if (year && h.y && Math.abs(h.y - year) <= 1) score += 2;
    else if (year && h.y) score -= 1;
    if (score > bestScore) [best, bestScore] = [h, score];
  });
  return bestScore >= 2 ? best.id : null;
}
