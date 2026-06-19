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
    const html = readFileSync("index.html", "utf8");
    const match = html.match(/window\.__DATA__\s*=\s*(\{[\s\S]*\});\s*<\/script>/);
    if (!match) return new Map();
    const data = JSON.parse(match[1]);
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

// Manual field corrections for incidents where a source reports bad data.
const MANUAL_CORRECTIONS = [
  // DefiLlama reports 915 (millions) instead of 0.915 (~$915K per SlowMist)
  { name: "Haedal Vault", date: "2026-06-09", amount: 0.915 },
];

function applyManualCorrections(incidents) {
  const byKey = new Map(incidents.map(i => [`${i.name}|${i.date}`, i]));
  for (const fix of MANUAL_CORRECTIONS) {
    const inc = byKey.get(`${fix.name}|${fix.date}`);
    if (!inc) continue;
    if (fix.amount  !== undefined) inc.amount  = fix.amount;
    if (fix.chain   !== undefined) inc.chain   = fix.chain;
    if (fix.vector  !== undefined) inc.vector  = fix.vector;
    if (fix.link    !== undefined) inc.link    = fix.link;
  }
  return incidents;
}

// Manual merge overrides for incidents that escape fuzzy dedup due to large
// date gaps between sources. Each entry maps a duplicate (name+date from one
// source) onto a canonical (name+date from another). The duplicate is dropped
// and its source/link are merged into the canonical.
const MANUAL_MERGES = [
  // DefiLlama reports the hack date; web3isgoinggreat reports the article date
  { dup: { name: "Gravity Bridge drained of $5.4 million", date: "2026-06-15" }, canonical: { name: "Gravity Bridge", date: "2026-05-30" } },
  { dup: { name: "DxSale exploited for $7.3 million",      date: "2026-06-15" }, canonical: { name: "DxSale",         date: "2026-05-28" } },
  { dup: { name: "Humanity Protocol loses $36 million to employee laptop compromise", date: "2026-06-15" }, canonical: { name: "Humanity", date: "2026-06-08" } },
];

function applyManualMerges(incidents) {
  const byKey = new Map(incidents.map(i => [`${i.name}|${i.date}`, i]));
  const toRemove = new Set();

  for (const { dup, canonical } of MANUAL_MERGES) {
    const dupInc = byKey.get(`${dup.name}|${dup.date}`);
    const canInc = byKey.get(`${canonical.name}|${canonical.date}`);
    if (!dupInc || !canInc) continue;

    // Merge source tags
    const sources = new Set([...canInc.source.split(" · "), ...dupInc.source.split(" · ")]);
    canInc.source = [...sources].join(" · ");

    // Fill any gaps from the dup
    if (canInc.amount == null && dupInc.amount != null) canInc.amount = dupInc.amount;
    if ((!canInc.chain  || canInc.chain  === "—") && dupInc.chain  && dupInc.chain  !== "—") canInc.chain  = dupInc.chain;
    if ((!canInc.vector || canInc.vector === "—") && dupInc.vector && dupInc.vector !== "—") canInc.vector = dupInc.vector;

    toRemove.add(`${dup.name}|${dup.date}`);
  }

  const result = incidents.filter(i => !toRemove.has(`${i.name}|${i.date}`));
  if (toRemove.size) console.log(`Applied ${toRemove.size} manual merge(s)`);
  return result;
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
  const incidents = applyManualCorrections(applyManualMerges(mergeAndDedupe(all)));
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
  if (restored) console.log(`Restored ${restored} backfilled links from previous index.html`);

  const output = {
    updated: new Date().toISOString(),
    sources: {
      defillama:        llamaRows.length,
      web3isgoinggreat: w3iggRows.length,
      slowmist:         slowmistRows.length,
    },
    incidents,
  };

  const html = readFileSync("index.html", "utf8");
  const injected = html.replace(
    /<script>window\.__DATA__[\s\S]*?<\/script>/,
    `<script>window.__DATA__ = ${JSON.stringify(output)};</script>`
  );
  writeFileSync("index.html", injected);
  console.log(`\nWrote index.html with ${incidents.length} incidents`);
}

main().catch(e => { console.error(e); process.exit(1); });
