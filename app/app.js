"use strict";
// ---- Config ----
const REPO = "ripcitylove/Scarlet-Enclave";
const POLL_MS = 60_000;          // live feeds + status
const STALE_MIN = 15;            // server data older than this is flagged
const KEYWORDS = /ground ?stop|grounded|faa|air traffic|atc|flights?|airport|outage|radar|nas\b|delays?/i;
const LEVEL_LABEL = { critical: "Critical", severe: "Severe", elevated: "Elevated", minor: "Minor",
  normal: "Normal", unknown: "Unknown" };
const $ = id => document.getElementById(id);

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

let watched = store.get("watched", []);
let seen = new Set(store.get("seenNews", []));
let lastLevel = store.get("lastLevel", null);
let lastGs = new Set(store.get("lastGs", []));
let filter = store.get("filter", "all");
let firstLoad = true;
let lastData = null;
let lastFeed = [];
let lastCheck = 0;
let busy = false;

// ---- Helpers ----
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function ago(iso) {
  const t = typeof iso === "number" ? iso : Date.parse(iso); if (!t) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return "just now"; const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
function plain(html) { return new DOMParser().parseFromString(html || "", "text/html").body.textContent.trim(); }
function clip(s, n = 220) { s = s.replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
const isWatched = code => watched.includes(String(code).toUpperCase());
async function getJSON(url, opts = {}, ms = 12000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) throw new Error(r.status);
    return { json: await r.json(), res: r };
  } finally { clearTimeout(t); }
}

// ---- Server status (FAA + curated headlines), newest copy wins ----
let apiBackoffUntil = 0;
async function fetchStatus() {
  const tries = [];
  if (Date.now() > apiBackoffUntil) {
    // GitHub API: no CDN cache, so it sees new data within seconds. 60 req/hour per phone.
    tries.push(getJSON(`https://api.github.com/repos/${REPO}/contents/data/status.json?ref=live`,
      { headers: { Accept: "application/vnd.github.raw+json" }, cache: "no-cache" }).then(({ json, res }) => {
        const left = Number(res.headers.get("x-ratelimit-remaining"));
        if (Number.isFinite(left) && left < 8) apiBackoffUntil = Date.now() + 15 * 60_000;
        return json;
      }).catch(e => { if (String(e.message) === "403" || String(e.message) === "429") apiBackoffUntil = Date.now() + 15 * 60_000; throw e; }));
  }
  tries.push(getJSON(`https://raw.githubusercontent.com/${REPO}/live/data/status.json?t=${Date.now()}`, { cache: "no-store" }).then(x => x.json));
  tries.push(getJSON(`data/status.json?t=${Date.now()}`, { cache: "no-store" }).then(x => x.json));
  const got = (await Promise.allSettled(tries)).filter(r => r.status === "fulfilled" && r.value?.generated).map(r => r.value);
  got.sort((a, b) => Date.parse(b.generated) - Date.parse(a.generated));
  return got[0] || null;
}

// ---- Live sources fetched directly by the phone ----
const LIVE_SOURCES = [
  async function gdelt() {
    const q = encodeURIComponent('("ground stop" OR "air traffic control" OR "flights grounded" OR "FAA outage")');
    const { json } = await getJSON(`https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&format=json&maxrecords=30&timespan=12h&sort=datedesc`);
    return (json.articles || []).filter(a => (a.language || "English") === "English").map(a => ({
      kind: "news", title: a.title, url: a.url, source: a.domain,
      time: a.seendate ? a.seendate.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, "$1-$2-$3T$4:$5:$6Z") : "",
    }));
  },
  async function bluesky() {
    const out = [];
    for (const q of ['"ground stop"', "FAA outage flights"]) {
      const { json } = await getJSON(`https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&sort=latest&limit=25`);
      for (const p of json.posts || []) {
        const text = p.record?.text || ""; if (!KEYWORDS.test(text)) continue;
        out.push({ kind: "social", title: clip(text), source: `@${p.author?.handle} · Bluesky`,
          url: `https://bsky.app/profile/${p.author?.handle}/post/${p.uri.split("/").pop()}`,
          time: p.record?.createdAt || p.indexedAt, followers: p.likeCount || 0 });
      }
    }
    return out;
  },
  async function mastodon() {
    const out = [];
    for (const tag of ["groundstop", "FAA", "aviation"]) {
      const { json } = await getJSON(`https://mastodon.social/api/v1/timelines/tag/${tag}?limit=20`);
      for (const s of json || []) {
        const text = plain(s.content); if (!/ground ?stop|grounded|outage|air traffic|atc/i.test(text)) continue;
        out.push({ kind: "social", title: clip(text), url: s.url, source: `@${s.account?.acct} · Mastodon`, time: s.created_at });
      }
    }
    return out;
  },
];

async function fetchLive() {
  const results = await Promise.allSettled(LIVE_SOURCES.map(f => f()));
  const ok = results.filter(r => r.status === "fulfilled").length;
  return { items: results.flatMap(r => r.status === "fulfilled" ? r.value : []), ok, total: results.length };
}

function mergeFeed(...lists) {
  const byKey = new Map();
  for (const i of lists.flat()) {
    if (!i?.title || !i.url) continue;
    const key = i.kind === "social" ? i.url : i.title.toLowerCase().replace(/\W+/g, "").slice(0, 70);
    if (!byKey.has(key)) byKey.set(key, { kind: "news", ...i });
  }
  const cutoff = Date.now() - 48 * 3600_000;
  return [...byKey.values()].filter(i => !i.time || Date.parse(i.time) > cutoff)
    .sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0)).slice(0, 80);
}

// ---- Rendering ----
function list(el, items, render) {
  const sorted = [...items].sort((a, b) => isWatched(b.airport) - isWatched(a.airport));
  el.innerHTML = sorted.length ? sorted.map(i =>
    `<div class="card${isWatched(i.airport) ? " watched" : ""}"><div class="row"><span class="code">${esc(i.airport)}</span><div>${render(i)}</div></div></div>`
  ).join("") : `<div class="empty">None reported</div>`;
}

function renderFaa(faa) {
  const f = faa || { ground_stops: [], ground_delays: [], closures: [], delays: [] };
  list($("gs"), f.ground_stops, i => `${esc(i.reason || "Ground stop")}${i.until ? `<div class="sub">Until ${esc(i.until)}</div>` : ""}`);
  list($("gd"), f.ground_delays, i => `${esc(i.reason)}<div class="sub">Avg ${esc(i.avg)} · Max ${esc(i.max)}</div>`);
  list($("cl"), f.closures, i => `${esc(i.reason)}<div class="sub">${esc(i.start)}${i.reopen ? " → reopen " + esc(i.reopen) : ""}</div>`);
  list($("dl"), f.delays, i => `${esc(i.reason)}<div class="sub">${(i.detail || []).map(d =>
    `${esc(d.type)} ${esc(d.min)}–${esc(d.max)} ${esc(d.trend)}`).join(" · ")}</div>`);

  const all = [...f.ground_stops.map(x => ({ ...x, k: "Ground stop" })), ...f.ground_delays.map(x => ({ ...x, k: "Ground delay" })),
    ...f.closures.map(x => ({ ...x, k: "Closed" })), ...f.delays.map(x => ({ ...x, k: "Delays" }))];
  $("watchList").innerHTML = watched.map(code => {
    const hits = all.filter(x => String(x.airport).toUpperCase() === code);
    return `<div class="card${hits.length ? " watched" : ""}"><div class="row"><span class="code">${esc(code)}</span><div>${
      hits.length ? hits.map(h => `<b>${esc(h.k)}</b> — ${esc(h.reason)}`).join("<br>") : `<span class="sub">No airport-specific FAA programs</span>`}</div></div></div>`;
  }).join("");
}

function renderFeed() {
  document.querySelectorAll("#feedTabs button").forEach(b => b.classList.toggle("on", b.dataset.f === filter));
  const items = lastFeed.filter(i => filter === "all" || i.kind === filter);
  $("news").innerHTML = items.length ? items.slice(0, 40).map(n =>
    `<div class="card news${n.isNew ? " fresh" : ""}"><span class="tag tag-${n.kind}">${n.kind === "social" ? "Social" : "News"}</span>
      <a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>
      <div class="sub">${esc(n.source)}${n.time ? " · " + ago(n.time) : ""}${n.isNew ? '<span class="new">NEW</span>' : ""}</div></div>`
  ).join("") : `<div class="empty">Nothing yet — checking every minute</div>`;
}

function renderBanner() {
  const data = lastData;
  const a = data?.assessment || { level: "unknown", headline: "No data yet" };
  const b = $("banner");
  b.className = `banner lvl-${a.level}`;
  b.querySelector(".lvl").textContent = LEVEL_LABEL[a.level] || a.level;
  b.querySelector(".head").textContent = a.headline;
  b.querySelector(".meta").textContent = data
    ? `FAA updated ${data.faa?.updated || "n/a"} · server checked ${ago(data.generated)}` : "";
  $("live").textContent = lastCheck ? `Live · checked ${ago(lastCheck)}` : "Connecting…";
}

async function notify(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, { body, icon: "icon.svg", tag: title });
    else new Notification(title, { body });
  } catch { /* ignore */ }
  if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
}

// ---- Main loop ----
async function load() {
  if (busy) return; busy = true;
  $("refresh").disabled = true; $("dot").classList.add("pulse");
  const [data, live] = await Promise.all([fetchStatus().catch(() => null), fetchLive()]);
  if (data) lastData = data;
  lastCheck = Date.now();

  const warn = [];
  if (!data && !lastData) warn.push("Can't reach the FAA status server right now.");
  else if (lastData && (Date.now() - Date.parse(lastData.generated)) / 60000 > STALE_MIN)
    warn.push(`FAA status is ${Math.round((Date.now() - Date.parse(lastData.generated)) / 60000)} min old.`);
  if (live.ok === 0 && !navigator.onLine) warn.push("You're offline.");
  $("warn").hidden = !warn.length; $("warn").textContent = warn.join(" ");

  // Merge server headlines with live items; flag what's new since last look.
  const feed = mergeFeed(live.items, lastData?.news || []);
  const fresh = [];
  for (const i of feed) {
    i.isNew = !seen.has(i.url) && !firstLoad;
    if (!seen.has(i.url)) { seen.add(i.url); if (!firstLoad) fresh.push(i); }
  }
  // Keep NEW badges from the previous round visible for one more cycle.
  const prevNew = new Set(lastFeed.filter(i => i.isNew).map(i => i.url));
  feed.forEach(i => { if (prevNew.has(i.url)) i.isNew = true; });
  lastFeed = feed;
  seen = new Set([...seen].slice(-1500)); store.set("seenNews", [...seen]);

  renderBanner(); renderFaa(lastData?.faa); renderFeed();
  $("foot").textContent = `Live sources responding: ${live.ok}/${live.total}` +
    (lastData?.errors?.length ? ` · Server issues: ${lastData.errors.join("; ")}` : "");

  // Alerts: level change, ground stop at a watched airport, new news headlines.
  const a = lastData?.assessment;
  const gsNow = new Set((lastData?.faa?.ground_stops || []).map(g => String(g.airport).toUpperCase()));
  if (a && a.level !== "unknown") {
    if (lastLevel && a.level !== lastLevel) notify(`Status: ${LEVEL_LABEL[a.level]}`, a.headline);
    const newWatched = [...gsNow].filter(c => isWatched(c) && !lastGs.has(c));
    if (newWatched.length) notify(`Ground stop: ${newWatched.join(", ")}`, "One of your airports is now under a ground stop.");
    lastLevel = a.level; store.set("lastLevel", lastLevel);
    lastGs = gsNow; store.set("lastGs", [...gsNow]);
  }
  const freshNews = fresh.filter(i => i.kind === "news" || store.get("notifySocial", false));
  if (freshNews.length) notify(freshNews.length > 1 ? `${freshNews.length} new updates` : "New update", freshNews[0].title);

  firstLoad = false; busy = false;
  $("refresh").disabled = false; $("dot").classList.remove("pulse");
}

async function loadBriefing() {
  try {
    const b = await (await fetch("data/briefing.json", { cache: "no-store" })).json();
    $("brief").innerHTML = `<div class="card"><div class="sub">As of ${esc(b.asOf)}</div><ul>${
      b.points.map(p => `<li>${esc(p)}</li>`).join("")}</ul>${
      b.sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>`).join(" · ")}</div>`;
  } catch { $("brief").innerHTML = ""; }
}

function updateNotifyButton() {
  const p = "Notification" in window ? Notification.permission : "unsupported";
  $("notify").textContent = p === "granted" ? "🔔 On" : p === "denied" ? "🔕 Blocked" : "🔔 Alerts";
}

// ---- Wiring ----
$("notify").onclick = async () => {
  if (!("Notification" in window)) { alert("On iPhone: tap Share → Add to Home Screen, open the app from there, then enable alerts."); return; }
  await Notification.requestPermission(); updateNotifyButton();
  if (Notification.permission === "granted") notify("Alerts on", "You'll be alerted to status changes and new headlines.");
};
$("refresh").onclick = load;
$("feedTabs").onclick = e => { const f = e.target.dataset?.f; if (f) { filter = f; store.set("filter", f); renderFeed(); } };
$("notifySocial").checked = store.get("notifySocial", false);
$("notifySocial").onchange = e => store.set("notifySocial", e.target.checked);
$("watchInput").value = watched.join(" ");
$("watchSave").onclick = () => {
  watched = [...new Set($("watchInput").value.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean)
    .map(c => (c.length === 4 && c.startsWith("K") ? c.slice(1) : c)))];
  store.set("watched", watched); $("watchInput").value = watched.join(" ");
  renderFaa(lastData?.faa);
};
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
window.addEventListener("online", load);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
updateNotifyButton();
loadBriefing();
load();
setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
setInterval(() => { renderBanner(); if (!document.hidden) renderFeed(); }, 20_000); // keep "x min ago" fresh
