# web3 hack tracker

Pulls from DefiLlama, web3isgoinggreat, and Rekt.news every 30 minutes via GitHub Actions. Displays incidents sorted newest first with fuzzy deduplication across sources.

## setup

```bash
# 1. create repo on github (public, so Pages works on free tier)
gh repo create web3-hack-tracker --public --clone
cd web3-hack-tracker

# 2. copy these files in
cp /path/to/files/* .

# 3. run the fetcher once locally to generate initial data.json
npm install
node fetch.mjs

# 4. push everything
git add .
git commit -m "init"
git push

# 5. enable GitHub Pages
# repo Settings → Pages → Deploy from branch → main → / (root)

# 6. enable the workflow
# Actions tab → "refresh hack data" → Enable workflow
```

## how it works

- `fetch.mjs` — Node.js script that pulls all three sources, fuzzy-dedupes, writes `data.json`
- `.github/workflows/refresh.yml` — runs `fetch.mjs` every 30 min, commits updated `data.json`
- `index.html` — reads `data.json`, renders the list, auto-refreshes every 5 min in browser

## sources

| source | url | type |
|--------|-----|------|
| DefiLlama | `https://api.llama.fi/hacks` | JSON API |
| web3isgoinggreat | `https://www.web3isgoinggreat.com/feed.xml` | RSS |
| Rekt.news | `https://rekt.news/feed/` | RSS |

## adding sources

Add a new `fetchRSS(url, name)` call in `fetch.mjs` and include it in the `Promise.all` in `main()`.

## deduplication

Fuzzy match on normalized name (noise words stripped) + date window of ±3 days. Trigram similarity threshold of 60%. Best metadata record wins per cluster.
