// Title metadata from Cinemeta, Stremio's own catalog (no API key needed).
const CINEMETA = "https://v3-cinemeta.strem.io";

async function getJson(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

const toTitle = (m, type) => ({
  imdb_id: m.imdb_id || m.id,
  type,
  name: m.name,
  year: m.releaseInfo || (m.year ? String(m.year) : null),
  poster: m.poster || `https://images.metahub.space/poster/small/${m.imdb_id || m.id}/img`,
});

// IMDb id -> title. The movie endpoint answers for series ids too, so ask the series endpoint first.
export async function byImdbId(id) {
  const series = await getJson(`${CINEMETA}/meta/series/${id}.json`);
  if (series?.meta?.name) return toTitle(series.meta, "series");
  const movie = await getJson(`${CINEMETA}/meta/movie/${id}.json`);
  if (movie?.meta?.name && movie.meta.type === "movie") return toTitle(movie.meta, "movie");
  return null; // episodes, video games, unreleased titles, ...
}

const yearOf = (s) => {
  const m = /\d{4}/.exec(s || "");
  return m ? Number(m[0]) : null;
};
const norm = (s) => s.toLowerCase().replace(/&/g, "and").replace(/^the /, "").replace(/[^a-z0-9]+/g, " ").trim();

// Title (+ year) from the LLM -> title. Requires an exact name match or a close name plus matching year,
// so a vague or misspelled title is dropped instead of surfacing something unrelated.
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
  return bestScore >= 2 ? toTitle(best, type) : null;
}
