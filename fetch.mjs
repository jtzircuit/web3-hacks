import { readFileSync, writeFileSync } from "fs";
import { parseStringPromise } from "xml2js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CUTOFF = "2020-01-01";

const HACK_WORDS = [
  "hack", "exploit", "breach", "drain", "steal", "stolen", "attack", "scam",
  "phish", "rug", "compromis", "vulnerab", "theft", "loss",
];

const NOISE_WORDS = /\b(protocol|finance|labs|lab|dao|network|exchange|bridge|defi|crypto|token|hack|exploit|breach|attack|the|a|an|of|on|in|at|by)\b/g;
const NOISE_CHARS = /[^a-z0-9]/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeUrl(url) {
  if (!url || typeof url !== "string") return "";
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") ? url : "";
  } catch {
    return "";
  }
}

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

  // Trigram similarity
  const trigramsA = new Set(na.match(/.{3}/g) || []);
  let common = 0;
  for (const tri of (nb.match(/.{3}/g) || [])) {
    if (trigramsA.has(tri)) common++;
  }
  const denom = (na.length - 2) + (nb.length - 2);
  return denom > 0 && (2 * common) / denom > 0.6;
}

// Link quality: specific article > SlowMist > anything else > DefiLlama generic page
function linkScore(incident) {
  if (!incident.link || incident.link === "https://defillama.com/hacks") return 0;
  if (incident.source === "web3isgoinggreat") return 3;
  if (incident.source === "SlowMist") return 2;
  return 1;
}

function mergeAndDedupe(all) {
  const clusters = [];

  for (const incident of all.filter(i => i.name && i.date)) {
    let placed = false;
    for (const cluster of clusters) {
      if (isFuzzyDupe(incident, cluster[0])) {
        cluster.push(incident);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([incident]);
  }

  return clusters.map(cluster => {
    // Pick the cluster member with the most populated fields as the base
    const scored = cluster.map(i => ({
      incident: i,
      score: (i.amount != null ? 3 : 0)
           + (i.chain  && i.chain  !== "—" ? 2 : 0)
           + (i.vector && i.vector !== "—" ? 2 : 0)
           + (i.source === "DefiLlama" ? 1 : 0),
    }));
    const base = scored.reduce((best, s) => s.score > best.score ? s : best, scored[0]).incident;
    const merged = { ...base };

    // Fill any gaps from other cluster members
    for (const i of cluster) {
      if (merged.amount == null && i.amount != null) merged.amount = i.amount;
      if ((!merged.chain  || merged.chain  === "—") && i.chain  && i.chain  !== "—") merged.chain  = i.chain;
      if ((!merged.vector || merged.vector === "—") && i.vector && i.vector !== "—") merged.vector = i.vector;
    }

    merged.link   = cluster.reduce((best, i) => linkScore(i) > linkScore(best) ? i : best, cluster[0]).link || "";
    merged.source = [...new Set(cluster.map(i => i.source))].join(" · ");
    return merged;
  }).sort((a, b) => (b.date || "") > (a.date || "") ? 1 : -1);
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

async function fetchDefiLlama() {
  console.log("Fetching DefiLlama...");
  try {
    const res = await fetch("https://api.llama.fi/hacks", { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rows = Array.isArray(data) ? data : (data.hacks || []);
    console.log(`  DefiLlama raw rows: ${rows.length}`);

    const out = rows.map(h => {
      let dateStr = null;
      try {
        const raw = h.date;
        const d = typeof raw === "number" ? new Date(raw * 1000) : new Date(raw);
        if (!isNaN(d)) dateStr = d.toISOString().slice(0, 10);
      } catch {}

      const rawAmt = h.amount ?? h.fundsLost ?? h.lostUsd ?? null;
      // API returns USD; divide by 1e6 for millions (values already in millions are <= 1000)
      const amount = rawAmt != null ? (rawAmt > 1e3 ? rawAmt / 1e6 : rawAmt) : null;

      return {
        name:   h.name || h.protocol || "Unknown",
        date:   dateStr,
        amount,
        chain:  Array.isArray(h.chain) ? h.chain.join("/") : (h.chain || "—"),
        vector: h.category || h.technique || h.type || "—",
        source: "DefiLlama",
        link:   h.url || h.link || "https://defillama.com/hacks",
      };
    }).filter(i => i.date && i.date >= CUTOFF);

    console.log(`  DefiLlama filtered (>= ${CUTOFF}): ${out.length}`);
    return out;
  } catch (e) {
    console.error("  DefiLlama failed:", e.message);
    return [];
  }
}

async function fetchRSS(url, sourceName) {
  console.log(`Fetching ${sourceName}...`);
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "web3-hack-tracker/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const parsed = await parseStringPromise(text, { explicitArray: false });

    const channel = parsed?.rss?.channel || parsed?.feed;
    const rawItems = channel?.item || channel?.entry || [];
    const items = Array.isArray(rawItems) ? rawItems : [rawItems];
    console.log(`  ${sourceName} raw items: ${items.length}`);

    const out = items.map(item => {
      const title  = (item.title?._ || item.title || "").trim();
      const pubRaw = item.pubDate || item.published || item.updated || "";
      const link   = safeUrl(item.link?.$?.href || item.link?.href || item.link || item.guid?._ || item.guid || "");

      let dateStr = null;
      try {
        const d = new Date(pubRaw);
        if (!isNaN(d)) dateStr = d.toISOString().slice(0, 10);
      } catch {}

      // Parse dollar amounts like "$4.5M", "$1.2B", "$500K"
      const amtMatch = title.match(/\$?([\d,.]+)\s*(M\b|B\b|K\b|million|billion|thousand)/i);
      let amount = null;
      if (amtMatch) {
        const n    = parseFloat(amtMatch[1].replace(/,/g, ""));
        const unit = amtMatch[2][0].toUpperCase();
        amount = unit === "B" ? n * 1000 : unit === "K" ? n / 1000 : n;
      }

      return {
        name:   title.slice(0, 120),
        date:   dateStr,
        amount,
        chain:  "—",
        vector: "—",
        source: sourceName,
        link:   typeof link === "string" ? link : "",
      };
    }).filter(i => {
      if (!i.date || i.date < CUTOFF) return false;
      const lower = i.name.toLowerCase();
      return HACK_WORDS.some(w => lower.includes(w)) || i.amount != null;
    });

    console.log(`  ${sourceName} filtered: ${out.length}`);
    return out;
  } catch (e) {
    console.error(`  ${sourceName} failed:`, e.message);
    return [];
  }
}

async function fetchSlowMist() {
  console.log("Fetching SlowMist...");
  try {
    const res = await fetch("https://hacked.slowmist.io/", {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "web3-hack-tracker/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const out = [];
    const liPattern = /<li>([\s\S]*?)<\/li>/g;
    let match;

    while ((match = liPattern.exec(html)) !== null) {
      const li = match[1];
      const dateMatch = li.match(/<span class="time">(\d{4}-\d{2}-\d{2})<\/span>/);
      const nameMatch = li.match(/<em>Hacked target: <\/em>([^<]+)<\/h3>/);
      if (!dateMatch || !nameMatch) continue;

      const dateStr = dateMatch[1];
      if (dateStr < CUTOFF) continue;

      const amtMatch  = li.match(/\$\s*([\d,]+)/);
      const vecMatch  = li.match(/<em>Attack method: <\/em>([^<]+)<\/span>/);
      const linkMatch = li.match(/class="link-reference"><a href="([^"]+)"/);

      let amount = null;
      if (amtMatch) {
        const n = parseFloat(amtMatch[1].replace(/,/g, ""));
        amount = n > 1e3 ? n / 1e6 : n;
      }

      out.push({
        name:   nameMatch[1].trim(),
        date:   dateStr,
        amount,
        chain:  "—",
        vector: vecMatch  ? vecMatch[1].trim()    : "—",
        source: "SlowMist",
        link:   linkMatch ? safeUrl(linkMatch[1]) : "",
      });
    }

    console.log(`  SlowMist filtered: ${out.length}`);
    return out;
  } catch (e) {
    console.error("  SlowMist failed:", e.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function loadExistingLinks() {
  try {
    const raw = readFileSync("data.js", "utf8").replace(/^window\.__DATA__\s*=\s*/, "").replace(/;?\s*$/, "");
    const data = JSON.parse(raw);
    const map = new Map();
    for (const inc of data.incidents || []) {
      if (inc.link && inc.link !== "https://defillama.com/hacks") {
        const key = (inc.name + inc.date).toLowerCase().replace(/\W/g, "");
        map.set(key, inc.link);
      }
    }
    return map;
  } catch { return new Map(); }
}

async function main() {
  const existingLinks = loadExistingLinks();

  const [llamaRows, w3iggRows, slowmistRows] = await Promise.all([
    fetchDefiLlama(),
    fetchRSS("https://www.web3isgoinggreat.com/feed.xml", "web3isgoinggreat"),
    fetchSlowMist(),
  ]);

  const all = [...llamaRows, ...w3iggRows, ...slowmistRows];
  console.log(`\nTotal before dedup: ${all.length}`);
  const incidents = mergeAndDedupe(all);
  console.log(`Total after dedup:  ${incidents.length}`);

  // Restore backfilled links that the live sources don't carry
  let restored = 0;
  for (const inc of incidents) {
    if (!inc.link || inc.link === "https://defillama.com/hacks") {
      const key = (inc.name + inc.date).toLowerCase().replace(/\W/g, "");
      const saved = existingLinks.get(key);
      if (saved) { inc.link = saved; restored++; }
    }
  }
  if (restored) console.log(`Restored ${restored} backfilled links from previous data.js`);

  const output = {
    updated: new Date().toISOString(),
    sources: {
      defillama:        llamaRows.length,
      web3isgoinggreat: w3iggRows.length,
      slowmist:         slowmistRows.length,
    },
    incidents,
  };

  writeFileSync("data.js", `window.__DATA__ = ${JSON.stringify(output, null, 2)};\n`);
  console.log(`\nWrote data.js with ${incidents.length} incidents`);
}

main().catch(e => { console.error(e); process.exit(1); });
