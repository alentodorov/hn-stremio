# Hacker News Picks for Stremio

A Stremio addon, running as a Cloudflare Worker, that adds four rows of the movies and series Hacker News commenters recommend:

| Row | What's in it |
| --- | --- |
| Hacker News: All-Time Top (movies) | Movies mentioned by the most distinct HN commenters, 2007 to now |
| Hacker News: All-Time Top (series) | Same, for series |
| Hacker News: Talked About Now (movies) | Most-mentioned movies in the last 60 days |
| Hacker News: Talked About Now (series) | Same, for series |

No account or configuration needed. Install from **https://hn-stremio.alen.ro**.

Inspired by Andrej Karpathy's [HackerTube](https://hackertube.org), which mined about 40,000 HN comments for the YouTube videos people recommend. This does the same for films and TV.

## How it works

1. **Find mentions.** HN comments come from the [Algolia HN Search API](https://hn.algolia.com/api). Three sources:
   - IMDb title links (`imdb.com/title/tt…`) give the IMDb id directly.
   - Wikipedia links to film or TV articles (`…_(film)`, `…_(TV_series)`, `…_(miniseries)`, …) are mapped to IMDb ids through Wikidata (property P345).
   - Plain-text recommendations: comments containing words like *movie, film, documentary, series, season, anime, watched* are read in batches of 20 by Workers AI (`@cf/openai/gpt-oss-120b`, JSON mode), which lists the titles each commenter recommends or praises and skips passing references, books, games and YouTube videos. Titles are matched to Cinemeta by exact name, or close name plus year, so vague guesses are dropped.
2. **Resolve.** Every IMDb id is checked against IMDb's suggestion endpoint for its type (movie or series), name and year; posters come from Stremio's metahub. Episodes, shorts and other IMDb pages drop out here. (Cinemeta isn't used for this because it mistypes some ids: it lists Fight Club as a Korean TV show.)
3. **Rank.** Titles are ranked by the number of distinct commenters who mentioned them, so one person linking the same film ten times counts once. Ties go to the most recently mentioned.

Everything is stored in D1 (`schema.sql`). A cron every 15 minutes reads new comments, then spends the rest of its budget on the history backfill, in this order:

1. All-time IMDb links, then Wikipedia links (no LLM). Usually seeded from a local run instead, see below.
2. Plain-text comments from the last `RECENT_DAYS` (60), so the "Talked About Now" rows fill first (a few hours).
3. Ask HN recommendation threads ("best documentaries you've seen", "which movies did you watch multiple times", …), read in full by the LLM.
4. Older plain-text comments, back `TEXT_BACKFILL_DAYS` (default 365).

`/stats.json` shows the counts and how far each backfill has got.

## Develop and deploy

```bash
npm install
npm run db:init          # create the tables in D1 (safe to re-run)
npm run db:seed          # load the all-time link mentions from seed/links.sql
npm run deploy           # deploys to hn-stremio.alen.ro
npm run tail             # live logs
```

`seed/links.sql` holds every IMDb and Wikipedia link mention on HN up to 2026-11-05 (about 8,300 mentions of 4,300 titles), so the cron doesn't have to crawl them. To rebuild it: `npm run seed:build` (Node 22.5+, no LLM, about an hour).

Settings are `vars` in `wrangler.jsonc`: the model, per-run LLM and lookup budgets, how far back the plain-text pass goes, and the "Talked About Now" window.

### Cost

Link mentions cost nothing but requests. The LLM pass reads about 150 matching comments a day going forward, plus about 55,000 for a one-year backfill and a few thousand from Ask HN threads; at Workers AI's gpt-oss-120b prices that is roughly $10 once, then a few cents a day. Lower `TEXT_BACKFILL_DAYS` to spend less.

## Caveats

- "Mentioned" is not always "recommended": link mentions are counted without reading the sentiment. The LLM pass only counts positive recommendations.
- Comments that name a title in plain text outside the keyword list, or older than the plain-text backfill window, are only counted if they link to IMDb or Wikipedia.
