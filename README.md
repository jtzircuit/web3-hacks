# web3 hack tracker

Live dashboard of web3 hacks and exploits, auto-updated every 30 minutes. Pulls from DefiLlama, web3isgoinggreat, and SlowMist with fuzzy deduplication across sources.

**[View it live →](https://jtzircuit.github.io/web3-hacks/)**

## setup

Fork this repo, then:

```bash
npm install
node fetch.mjs   # fetches data and embeds it into index.html
git add index.html
git commit -m "init: generate index.html with data"
git push
```

Then in your GitHub repo settings:
- **Pages** → Deploy from branch → `main` → `/ (root)`
- **Actions** tab → enable the "refresh hack data" workflow

That's it. The workflow runs every 30 minutes and auto-commits updated data.

## how it works

| file | role |
|------|------|
| `fetch.mjs` | Fetches all three sources, fuzzy-dedupes, injects data into `index.html` |
| `.github/workflows/refresh.yml` | Runs `fetch.mjs` every 30 min, commits `index.html` |
| `index.html` | Self-contained — data is embedded directly, opens without a server |

## sources

| source | type |
|--------|------|
| [DefiLlama](https://defillama.com/hacks) | JSON API |
| [web3isgoinggreat](https://web3isgoinggreat.com) | Atom RSS |
| [SlowMist](https://hacked.slowmist.io) | HTML scrape |

## adding a source

Add a fetch function in `fetch.mjs` and include it in the `Promise.all` in `main()`. For RSS feeds, reuse `fetchRSS(url, name)`.

## deduplication

Incidents are matched across sources by normalized name + ±3 day date window. Trigram similarity threshold of 60%. The record with the most populated fields wins per cluster; best link wins by quality score (web3isgoinggreat > SlowMist > other > DefiLlama generic page).
