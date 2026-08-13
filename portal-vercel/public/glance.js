/* VA Loans glance — live snapshot from the always-on Mac. */

const $ = (sel) => document.querySelector(sel);

let lastSnap = null;
let fetching = false;
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

const PT_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});
const PT_DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "long",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function fmtPt(iso) {
  return iso ? `${PT_FMT.format(new Date(iso))} PT` : "—";
}

function fmtDay(iso) {
  return iso ? `${PT_DAY.format(new Date(iso))} PT` : "—";
}

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function until(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h >= 48) return `in ${Math.round(h / 24)}d`;
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

const money = (n) => `$${Number(n).toFixed(n >= 100 ? 0 : 2)}`;

(() => {
  const urlKey = new URLSearchParams(location.search).get("key");
  if (urlKey) {
    try { localStorage.setItem("adf-key", urlKey.trim()); } catch { /* private mode */ }
    history.replaceState(null, "", location.pathname);
  }
})();

let memKey = null;

function getKey() {
  try { return localStorage.getItem("adf-key") || memKey; } catch { return memKey; }
}

function setKey(key) {
  memKey = key;
  try { localStorage.setItem("adf-key", key); } catch { /* private mode */ }
}

function snapshotUrl() {
  const key = getKey();
  return key ? `/api/snapshot?key=${encodeURIComponent(key)}` : "/api/snapshot";
}

function showKeyForm() {
  if ($("#keyform")) return;
  const wrap = document.createElement("div");
  wrap.id = "keyform";
  wrap.className = "card keyform";
  wrap.innerHTML = `
    <div class="kf-title">Access key</div>
    <div class="kf-sub">Enter the dashboard key once — it'll be remembered.</div>
    <form>
      <input type="password" inputmode="text" autocomplete="current-password" placeholder="adf-…" />
      <button type="submit">Unlock</button>
    </form>
    <div class="kf-err" hidden>Wrong key — try again.</div>`;
  $("#app").prepend(wrap);
  wrap.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const val = wrap.querySelector("input").value.trim();
    if (!val) return;
    setKey(val);
    const res = await fetch(snapshotUrl(), { cache: "no-store" });
    if (res.ok) {
      wrap.remove();
      render(await res.json());
    } else {
      wrap.querySelector(".kf-err").hidden = false;
    }
  });
}

async function refresh() {
  if (fetching) return;
  fetching = true;
  try {
    await doRefresh();
  } finally {
    fetching = false;
  }
}

async function doRefresh() {
  let snap;
  try {
    const res = await fetch(snapshotUrl(), { cache: "no-store" });
    if (res.status === 401) {
      $("#updated").textContent = "locked";
      $("#updated").className = "live stale";
      $("#hero-text").textContent = "Enter access key";
      showKeyForm();
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    snap = await res.json();
    const form = $("#keyform");
    if (form) form.remove();
  } catch (err) {
    $("#updated").textContent = "offline";
    $("#updated").className = "live stale";
    $("#hero-kicker").textContent = "Can't reach the Mac";
    $("#hero-text").textContent = "Factory is offline";
    $("#hero-problems").innerHTML = `<div>${esc(err.message || err)}</div>`;
    $("#hero-next").textContent = "Open this page on the same Wi-Fi as the Mac mini, or via Tailscale.";
    return;
  }
  render(snap);
}

function macCheckFromSnap(snap) {
  const last = (snap.mac && snap.mac.lastSeen) || snap.generatedAt;
  const ageMs = Math.max(0, Date.now() - new Date(last).getTime());
  const host = (snap.mac && snap.mac.hostname) || "Mac mini";
  if (ageMs < 90_000) return { name: host, status: "ok", detail: `on · ${ago(last)}` };
  if (ageMs < 180_000) return { name: host, status: "warn", detail: `heartbeat ${ago(last)}` };
  return { name: host, status: "fail", detail: `offline · ${ago(last)}` };
}

function render(snap) {
  lastSnap = snap;
  const ageMs = Date.now() - new Date(snap.generatedAt).getTime();
  const stale = ageMs > 90 * 1000;
  const macOffline = ageMs > 180 * 1000;
  const upd = $("#updated");
  upd.textContent = stale ? `stale · ${ago(snap.generatedAt)}` : "live";
  upd.className = stale ? "live stale" : "live";

  const offer = snap.offer || {};
  const problems = [...(snap.problems || [])];
  if (macOffline) problems.unshift("Mac mini is offline");
  const ok = problems.length === 0 && !macOffline;

  $("#hero-kicker").textContent = ok ? "Running" : macOffline ? "Offline" : "Needs attention";
  $("#hero-text").textContent = offer.name || "VA Loans";
  $("#hero-next").innerHTML = snap.nextRunAt
    ? `Next drop <b>${fmtDay(snap.nextRunAt)}</b> · ${until(snap.nextRunAt)}`
    : "";
  $("#hero-problems").innerHTML = problems.map((p) => `<div>• ${esc(p)}</div>`).join("");
  const flags = [];
  if (snap.dryRun) flags.push("dry run");
  if (snap.globalPause) flags.push("paused");
  if (snap.skipNext) flags.push("skipping next");
  if (offer.dailyCount) flags.push(`${offer.dailyCount} ads / day`);
  if (offer.budgetUsd) flags.push(`${money(offer.budgetUsd)} budget`);
  $("#hero-flags").innerHTML = flags.map((f) => `<span class="flag">${esc(f)}</span>`).join("");

  const spend = snap.perf?.spendToday ?? 0;
  const purch = snap.perf?.purchasesToday ?? 0;
  $("#stat-spend").textContent = money(spend);
  $("#stat-purch").textContent = String(purch);
  $("#stat-cpa").textContent = snap.perf?.cpaToday != null ? money(snap.perf.cpaToday) : "—";
  const liveFlights = (snap.runs || []).filter((r) => r.status === "live" || r.status === "scheduled");
  $("#stats-note").textContent = liveFlights.length
    ? `${liveFlights.length} flight${liveFlights.length > 1 ? "s" : ""} live or queued.`
    : "No Meta flights live yet. Numbers fill in after tomorrow’s 10am PT drop.";

  const hook = offer.hook || "";
  const headline = offer.headline || "";
  $("#hook").innerHTML = hook
    ? `<p class="quote">“${esc(hook)}”</p>
       ${headline ? `<div class="headline">${esc(headline)}</div>` : ""}
       <div class="meta">locked script · pretty-woman UGC</div>`
    : `<div class="empty">No locked hook in the VA campaign config.</div>`;

  const creatives = snap.latestCreatives || [];
  $("#creatives").innerHTML = creatives.length
    ? creatives.map((c) => {
        const poster = c.posterUrl
          ? `<img src="${esc(c.posterUrl)}" alt="" />`
          : `<div class="ph">ad</div>`;
        return `<a class="creative" href="${esc(c.videoUrl)}">
          ${poster}
          <div>
            <div class="nm">${esc(c.name)}</div>
            <div class="when">${esc(ago(c.createdAt))} · tap to play</div>
          </div>
        </a>`;
      }).join("")
    : `<div class="card empty">No VA ads rendered today.</div>`;

  const activeStatuses = ["generating", "uploading", "scheduled", "live", "paused"];
  const runs = (snap.runs || []).filter((r) => activeStatuses.includes(r.status)).concat(
    (snap.runs || []).filter((r) => r.status === "completed" || r.status === "error").slice(0, 3),
  );
  $("#flights").innerHTML = runs.length
    ? runs.map(flightCard).join("")
    : `<div class="card empty">Nothing scheduled. First automated flight is ${snap.nextRunAt ? until(snap.nextRunAt) : "queued"}.</div>`;

  const accounts = snap.accounts?.accounts || [];
  const acctOk = accounts.filter((a) => a.ok).length;
  $("#accounts").innerHTML = accounts.length
    ? `<div class="hrow"><b>${acctOk}/${accounts.length} active</b><span class="hd">${snap.accounts.at ? ago(snap.accounts.at) : ""}</span></div>` +
      accounts.map((a) => `<div class="acct"><span class="dot ${a.ok ? "ok" : "bad"}"></span>${esc(a.label)}<span class="st ${a.ok ? "ok" : "bad"}">${esc(a.status)}</span></div>`).join("")
    : `<div class="empty">Account check runs every 10 minutes. Pull to refresh in a bit.</div>`;

  const mac = macCheckFromSnap(snap);
  const health = snap.health;
  const checks = [mac, ...((health && health.checks) || []).filter((c) => c.name !== "Always-on Mac")];
  $("#health").innerHTML = checks.map((c) => {
    const short = c.detail.length > 64 ? `${c.detail.slice(0, 64)}…` : c.detail;
    return `<div class="hrow"><span class="dot ${esc(c.status === "ok" ? "ok" : c.status === "warn" ? "warn" : "bad")}"></span>${esc(c.name)}<span class="hd">${esc(short)}</span></div>`;
  }).join("");

  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  $("#foot").innerHTML = local
    ? `<a href="/manage">management console</a> · Slack /adops`
    : `controls in Slack /adops`;
}

function flightCard(r) {
  let sub = "";
  let bar = "";
  const now = Date.now();
  if (r.status === "scheduled" && r.goLiveAt) {
    sub = `Goes live <b>${fmtPt(r.goLiveAt)}</b> · ${until(r.goLiveAt)} · ${r.adCount} ad(s)`;
  } else if (r.status === "live" && r.goLiveAt && r.flightEndsAt) {
    const total = new Date(r.flightEndsAt).getTime() - new Date(r.goLiveAt).getTime();
    const pct = Math.min(100, Math.max(0, Math.round(((now - new Date(r.goLiveAt).getTime()) / total) * 100)));
    sub = `Live · auto-off ${until(r.flightEndsAt)} · ${r.adCount} ad(s)`;
    bar = `<div class="bar"><span class="fill" style="width:${pct}%"></span></div>`;
  } else if (r.status === "generating" || r.status === "uploading") {
    sub = `${r.status === "generating" ? "Generating" : "Uploading"}… ${r.creativeCount ? `${r.creativeCount} so far` : ""}`;
  } else if (r.status === "completed") {
    sub = r.note ? esc(r.note) : "Flight completed";
  } else if (r.note) {
    sub = esc(r.note);
  }
  return `<div class="card flight">
    <div class="flight-head"><span class="v">${esc(r.vertical)}</span><span class="chip ${esc(r.status)}">${esc(r.status)}</span></div>
    ${sub ? `<div class="flight-sub">${sub}</div>` : ""}
    ${r.error ? `<div class="flight-error">${esc(r.error.length > 90 ? `${r.error.slice(0, 90)}…` : r.error)}</div>` : ""}
    ${bar}
  </div>`;
}

refresh();
setInterval(refresh, 20_000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh();
});
window.addEventListener("focus", refresh);
window.addEventListener("pageshow", refresh);
window.addEventListener("online", refresh);
setInterval(() => {
  if (lastSnap && !$("#keyform")) render(lastSnap);
}, 5_000);
