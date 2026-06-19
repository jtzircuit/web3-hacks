import { writeFileSync } from "fs";
import { parseStringPromise } from "xml2js";

const HACK_WORDS = ["hack","exploit","breach","drain","steal","stolen","attack","scam","phish","rug","compromis","vulnerab","theft","loss"];
const NOISE_WORDS = /\b(protocol|finance|labs|lab|dao|network|exchange|bridge|defi|crypto|token|hack|exploit|breach|attack|the|a|an|of|on|in|at|by)\b/g;
const NOISE_CHARS = /[^a-z0-9]/g;
const CUTOFF = "2026-01-01";

function normalizeName(name) {
  return name.toLowerCase().replace(NOISE_WORDS, "").replace(NOISE_CHARS, "").trim();
}

function dateToDay(dateStr) {
  if (!dateStr) return null;
  return Math.floor(new Date(dateStr + "T00:00:00Z").getTime() / 86400000);
}

function isFuzzyDupe(a, b) {
  const na = normalizeName(a.name);
  const nb = normalizeName(b.name);
  if (!na || !nb || na.length < 3 || nb.length < 3) return false;
  const da = dateToDay(a.date);
  const db = dateToDay(b.date);
  if (da == null || db == null || Math.abs(da - db) > 3) return false;
  if (na === nb) return true;
  const shorter = na.length <= nb.length ? na : nb;
  const longer  = na.length <= nb.length ? nb : na;
  if (shorter.length >= 4 && longer.includes(shorter)) return true;
  const setA = new Set((na.match(/.{3}/g) || []));
  let common = 0;
  for (const tri of (nb.match(/.{3}/g) || [])) { if (setA.has(tri)) common++; }
  const denom = (na.length - 2) + (nb.length - 2);
  return denom > 0 && (2 * common) / denom > 0.6;
}

function mergeAndDedupe(all) {
  const clusters = [];
  for (const inc of all.filter(i => i.name && i.date)) {
    let placed = false;
    for (const cluster of clusters) {
      if (isFuzzyDupe(inc, cluster[0])) { cluster.push(inc); placed = true; break; }
    }
    if (!placed) clusters.push([inc]);
  }

  return clusters.map(cluster => {
    const scored = cluster.map(i => ({
      inc: i,
      score: (i.amount != null ? 3 : 0) + (i.chain && i.chain !== "—" ? 2 : 0) +
             (i.vector && i.vector !== "—" ? 2 : 0) + (i.link ? 1 : 0) +
             (i.source === "DefiLlama" ? 1 : 0)
    }));
    const best = scored.reduce((mx, s) => s.score > mx.score ? s : mx, scored[0]).inc;
    const merged = { ...best };
    for (const i of cluster) {
      if (merged.amount == null && i.amount != null) merged.amount = i.amount;
      if ((!merged.chain || merged.chain === "—") && i.chain && i.chain !== "—") merged.chain = i.chain;
      if ((!merged.vector || merged.vector === "—") && i.vector && i.vector !== "—") merged.vector = i.vector;
      if (!merged.link && i.link) merged.link = i.link;
    }
    const allSources = [...new Set(cluster.map(i => i.source))];
    merged.source = allSources.join(" · ");
    return merged;
  }).sort((a, b) => (b.date || "") > (a.date || "") ? 1 : -1);
}

async function fetchDefiLlama() {
  console.log("Fetching DefiLlama...");
  try {
    const r = await fetch("https://api.llama.fi/hacks", { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const rows = Array.isArray(data) ? data : (data.hacks || []);
    console.log(`  DefiLlama raw rows: ${rows.length}`);
    const out = rows.map(h => {
      let dateStr = null;
      try {
        const raw = h.date;
        const d = typeof raw === "number" ? new Date(raw * 1000) : new Date(raw);
        if (!isNaN(d)) dateStr = d.toISOString().slice(0, 10);
      } catch(e) {}
      const rawAmt = h.amount ?? h.fundsLost ?? h.lostUsd ?? null;
      let amount = rawAmt != null ? (rawAmt > 1e6 ? rawAmt / 1e6 : rawAmt) : null;
      return {
        name: h.name || h.protocol || "Unknown",
        date: dateStr,
        amount,
        chain: Array.isArray(h.chain) ? h.chain.join("/") : (h.chain || "—"),
        vector: h.category || h.technique || h.type || "—",
        source: "DefiLlama",
        link: h.url || h.link || "https://defillama.com/hacks",
      };
    }).filter(i => i.date && i.date >= CUTOFF);
    console.log(`  DefiLlama filtered (>= ${CUTOFF}): ${out.length}`);
    return out;
  } catch(e) {
    console.error("  DefiLlama failed:", e.message);
    return [];
  }
}

async function fetchRSS(url, sourceName) {
  console.log(`Fetching ${sourceName}...`);
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "web3-hack-tracker/1.0" }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    const parsed = await parseStringPromise(text, { explicitArray: false });

    const channel = parsed?.rss?.channel || parsed?.feed;
    const rawItems = channel?.item || channel?.entry || [];
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];
    console.log(`  ${sourceName} raw items: ${items.length}`);

    const out = items.map(item => {
      const title = (item.title?._ || item.title || "").trim();
      const pubRaw = item.pubDate || item.published || item.updated || "";
      const link = item.link?.href || item.link || item.guid?._ || item.guid || "";
      let dateStr = null;
      try { const d = new Date(pubRaw); if (!isNaN(d)) dateStr = d.toISOString().slice(0, 10); } catch(e) {}
      const amtMatch = title.match(/\$?([\d,.]+)\s*(M\b|B\b|K\b|million|billion|thousand)/i);
      let amount = null;
      if (amtMatch) {
        const n = parseFloat(amtMatch[1].replace(/,/g, ""));
        const u = amtMatch[2][0].toUpperCase();
        amount = u === "B" ? n * 1000 : u === "K" ? n / 1000 : n;
      }
      return { name: title.slice(0, 120), date: dateStr, amount, chain: "—", vector: "—", source: sourceName, link: typeof link === "string" ? link : "" };
    }).filter(i => {
      if (!i.date || i.date < CUTOFF) return false;
      const t = i.name.toLowerCase();
      return HACK_WORDS.some(w => t.includes(w)) || i.amount != null;
    });

    console.log(`  ${sourceName} filtered: ${out.length}`);
    return out;
  } catch(e) {
    console.error(`  ${sourceName} failed:`, e.message);
    return [];
  }
}

async function main() {
  const [llama, w3igg, rekt] = await Promise.all([
    fetchDefiLlama(),
    fetchRSS("https://www.web3isgoinggreat.com/feed.xml", "web3isgoinggreat"),
    fetchRSS("https://rekt.news/feed/", "Rekt.news"),
  ]);

  const all = [...llama, ...w3igg, ...rekt];
  console.log(`\nTotal before dedup: ${all.length}`);
  const incidents = mergeAndDedupe(all);
  console.log(`Total after dedup: ${incidents.length}`);

  const output = {
    updated: new Date().toISOString(),
    sources: {
      defillama: llama.length,
      web3isgoinggreat: w3igg.length,
      rekt: rekt.length,
    },
    incidents,
  };

  writeFileSync("data.json", JSON.stringify(output, null, 2));
  console.log(`\nWrote data.json with ${incidents.length} incidents`);
}

main().catch(e => { console.error(e); process.exit(1); });
