"use strict";
const POLL_MS = 60_000;
const STALE_MIN = 20; // server data older than this triggers a direct headline fallback
const LEVEL_LABEL = { critical: "Critical", severe: "Severe", elevated: "Elevated", minor: "Minor",
  normal: "Normal", unknown: "Unknown" };
const $ = id => document.getElementById(id);

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

let watched = store.get("watched", []);
let seenNews = new Set(store.get("seenNews", []));
let lastLevel = store.get("lastLevel", null);
let lastGs = new Set(store.get("lastGs", []));
let firstLoad = true;

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function ago(iso) {
  const t = Date.parse(iso); if (!t) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now"; if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
const isWatched = code => watched.includes(String(code).toUpperCase());

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
  $("watchList").innerHTML = watched.length ? watched.map(code => {
    const hits = all.filter(x => String(x.airport).toUpperCase() === code);
    return `<div class="card${hits.length ? " watched" : ""}"><div class="row"><span class="code">${esc(code)}</span><div>${
      hits.length ? hits.map(h => `<b>${esc(h.k)}</b> — ${esc(h.reason)}`).join("<br>") : `<span class="sub">No airport-specific FAA programs</span>`}</div></div></div>`;
  }).join("") : "";
}

function renderNews(items) {
  const el = $("news");
  if (!items.length) { el.innerHTML = `<div class="empty">No headlines yet</div>`; return []; }
  const fresh = [];
  el.innerHTML = items.slice(0, 25).map(n => {
    const isNew = !seenNews.has(n.url);
    if (isNew) fresh.push(n);
    return `<div class="card news"><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>
      <div class="sub">${esc(n.source)}${n.time ? " · " + ago(n.time) : ""}${isNew && !firstLoad ? '<span class="new">NEW</span>' : ""}</div></div>`;
  }).join("");
  items.forEach(n => seenNews.add(n.url));
  seenNews = new Set([...seenNews].slice(-400));
  store.set("seenNews", [...seenNews]);
  return fresh;
}

async function notify(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) reg.showNotification(title, { body, icon: "icon.svg", tag: title });
    else new Notification(title, { body });
  } catch { /* ignore */ }
  if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
}

// GDELT allows cross-origin requests, so the phone can pull headlines itself if the server feed is stale.
async function directHeadlines() {
  const q = encodeURIComponent('("ground stop" OR "air traffic control" OR "flights grounded") FAA');
  const r = await fetch(`https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&format=json&maxrecords=25&timespan=1d&sort=datedesc`);
  const j = await r.json();
  return (j.articles || []).map(a => ({
    title: a.title, url: a.url, source: a.domain,
    time: a.seendate ? a.seendate.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, "$1-$2-$3T$4:$5:$6Z") : "",
  }));
}

async function load() {
  $("refresh").disabled = true;
  let data = null, warn = "";
  try {
    const r = await fetch(`data/status.json?t=${Date.now()}`, { cache: "no-store" });
    data = await r.json();
  } catch { warn = "Couldn't reach the update server — showing the last saved data."; }

  const ageMin = data ? (Date.now() - Date.parse(data.generated)) / 60000 : Infinity;
  let news = data?.news || [];
  if (ageMin > STALE_MIN || !news.length) {
    try { const d = await directHeadlines(); if (d.length) news = d; } catch { /* offline */ }
    if (data && ageMin > STALE_MIN) warn = `Server data is ${Math.round(ageMin)} min old; headlines fetched directly.`;
  }

  const a = data?.assessment || { level: "unknown", headline: "No data yet" };
  const b = $("banner");
  b.className = `banner lvl-${a.level}`;
  b.querySelector(".lvl").textContent = LEVEL_LABEL[a.level] || a.level;
  b.querySelector(".head").textContent = a.headline;
  b.querySelector(".meta").textContent = data
    ? `FAA updated ${data.faa?.updated || "n/a"} · checked ${ago(data.generated)} · ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : "";
  $("warn").hidden = !warn; $("warn").textContent = warn;

  renderFaa(data?.faa);
  const fresh = renderNews(news);
  $("foot").textContent = data?.errors?.length ? `Source issues: ${data.errors.join("; ")}` : "";

  // Alerts: level change, new ground stops at watched airports, new headlines.
  const gsNow = new Set((data?.faa?.ground_stops || []).map(g => String(g.airport).toUpperCase()));
  if (!firstLoad || lastLevel !== null) {
    if (lastLevel && a.level !== lastLevel && a.level !== "unknown") notify(`Status: ${LEVEL_LABEL[a.level]}`, a.headline);
    const newWatched = [...gsNow].filter(c => isWatched(c) && !lastGs.has(c));
    if (newWatched.length) notify(`Ground stop: ${newWatched.join(", ")}`, "One of your airports is now under a ground stop.");
    if (!firstLoad && fresh.length) notify(`${fresh.length} new update${fresh.length > 1 ? "s" : ""}`, fresh[0].title);
  }
  if (a.level !== "unknown") { lastLevel = a.level; store.set("lastLevel", lastLevel); }
  lastGs = gsNow; store.set("lastGs", [...gsNow]);
  firstLoad = false;
  $("refresh").disabled = false;
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

$("notify").onclick = async () => {
  if (!("Notification" in window)) { alert("On iPhone: tap Share → Add to Home Screen, open the app from there, then enable alerts."); return; }
  await Notification.requestPermission(); updateNotifyButton();
  if (Notification.permission === "granted") notify("Alerts on", "You'll be alerted to status changes and new headlines while the app is open.");
};
$("refresh").onclick = load;
$("watchInput").value = watched.join(" ");
$("watchSave").onclick = () => {
  watched = [...new Set($("watchInput").value.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean)
    .map(c => (c.length === 4 && c.startsWith("K") ? c.slice(1) : c)))];
  store.set("watched", watched); $("watchInput").value = watched.join(" "); load();
};
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
updateNotifyButton();
loadBriefing();
load();
setInterval(load, POLL_MS);
