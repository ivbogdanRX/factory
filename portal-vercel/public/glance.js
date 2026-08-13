/* Ad Factory glance — read-only mobile hub. Fetches /api/snapshot (served
   live by the local orchestrator, or from the pushed blob on Vercel). */

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

function fmtPt(iso) {
  return iso ? `${PT_FMT.format(new Date(iso))} PT` : "—";
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

/* Access key: accepted from ?key= in the URL (so a bookmarked / home-screen
   link self-configures), remembered in localStorage, asked for via an inline
   form only as a last resort (prompt() is broken in iOS standalone mode). */
(() => {
  const urlKey = new URLSearchParams(location.search).get("key");
  if (urlKey) {
    try { localStorage.setItem("adf-key", urlKey.trim()); } catch { /* private mode */ }
    history.replaceState(null, "", location.pathname);
  }
})();

let memKey = null; // fallback when localStorage is unavailable

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
      $("#updated").className = "updated";
      $("#hero-dot").className = "dot big warn";
      $("#hero-text").textContent = "Enter access key";
      showKeyForm();
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    snap = await res.json();
    const form = $("#keyform");
    if (form) form.remove();
  } catch (err) {
    $("#updated").textContent = "unreachable";
    $("#updated").className = "updated stale";
    $("#hero-dot").className = "dot big bad";
    $("#hero-text").textContent = "Always-on Mac is offline";
    $("#hero-problems").innerHTML = `<div>• ${esc(err.message || err)}</div><div>• last heartbeat missing — is the Mac asleep or off?</div>`;
    $("#health").innerHTML = `<div class="hrow"><span class="dot bad"></span><b>Always-on Mac</b><span class="hd">offline · no snapshot</span></div>`;
    return;
  }
  render(snap);
}

function macCheckFromSnap(snap) {
  const last = (snap.mac && snap.mac.lastSeen) || snap.generatedAt;
  const ageMs = Math.max(0, Date.now() - new Date(last).getTime());
  if (ageMs < 90_000) {
    return { name: "Always-on Mac", status: "ok", detail: `on · heartbeat ${ago(last)}` };
  }
  if (ageMs < 180_000) {
    return { name: "Always-on Mac", status: "warn", detail: `heartbeat ${ago(last)} — may be stalling` };
  }
  return { name: "Always-on Mac", status: "fail", detail: `offline · last seen ${ago(last)}` };
}

function render(snap) {
  lastSnap = snap;
  // freshness
  const ageMs = Date.now() - new Date(snap.generatedAt).getTime();
  const stale = ageMs > 90 * 1000;
  const macOffline = ageMs > 180 * 1000;
  const upd = $("#updated");
  upd.textContent = `updated ${ago(snap.generatedAt)}`;
  upd.className = stale ? "updated stale" : "updated";

  // hero
  const problems = [...(snap.problems || [])];
  if (macOffline) problems.unshift("always-on Mac is offline");
  else if (stale && !problems.includes("snapshot is stale — is the Mac online?")) {
    problems.unshift("snapshot is stale — is the Mac online?");
  }
  const ok = problems.length === 0;
  $("#hero-dot").className = `dot big ${ok ? "ok" : macOffline ? "bad" : "bad"}`;
  $("#hero-text").textContent = macOffline ? "Always-on Mac is offline" : ok ? "All systems go" : "Needs attention";
  $("#hero-problems").innerHTML = problems.map((p) => `<div>• ${esc(p)}</div>`).join("");
  $("#hero-next").innerHTML = `Next batch <b>${fmtPt(snap.nextRunAt)}</b> · ${until(snap.nextRunAt)}`;
  const flags = [];
  if (snap.dryRun) flags.push("dry run");
  if (snap.globalPause) flags.push("global pause");
  if (snap.skipNext) flags.push("skipping next run");
  $("#hero-flags").innerHTML = flags.map((f) => `<span class="flag">${esc(f)}</span>`).join("");

  // money
  $("#stat-spend").textContent = money(snap.perf.spendToday);
  $("#stat-purch").textContent = String(snap.perf.purchasesToday);
  $("#stat-cpa").textContent = snap.perf.cpaToday !== null ? money(snap.perf.cpaToday) : "—";

  // flights — active runs plus a few recent finished/failed; cancelled runs
  // are old news and stay out of the glance entirely.
  const activeStatuses = ["generating", "uploading", "scheduled", "live", "paused"];
  const runs = (snap.runs || []).filter((r) => activeStatuses.includes(r.status)).concat(
    (snap.runs || []).filter((r) => r.status === "completed" || r.status === "error").slice(0, 3),
  );
  $("#flights").innerHTML = runs.length
    ? runs.map(flightCard).join("")
    : `<div class="card empty">No runs yet today.</div>`;

  // angles
  const angles = [...(snap.angles || [])].sort((a, b) => b.weight - a.weight);
  const maxW = Math.max(...angles.map((a) => a.weight), 0.0001);
  $("#angles").innerHTML = angles.length
    ? angles
        .map((a) => {
          const cpa = a.costPerPurchase !== null ? money(a.costPerPurchase) : "—";
          return `<div class="arow">
            <span class="an">${esc(a.name)}<small>${a.creatives} ad(s) · ${money(a.spend)} · ${a.purchases} purch</small></span>
            <span class="abar"><span style="width:${Math.round((a.weight / maxW) * 100)}%"></span></span>
            <span class="am">CPA<br>${cpa}</span>
          </div>`;
        })
        .join("")
    : `<div class="empty">No angles configured.</div>`;

  // health — Always-on Mac heartbeat first, then the rest. Glance only needs
  // pass/fail; hard failures get one short line, warnings are a count.
  const mac = macCheckFromSnap(snap);
  const health = snap.health;
  const checks = [mac, ...((health && health.checks) || []).filter((c) => c.name !== "Always-on Mac")];
  const fails = checks.filter((c) => c.status === "fail");
  const warns = checks.filter((c) => c.status === "warn").length;
  const passing = checks.filter((c) => c.status === "ok").length;
  const healthOk = fails.length === 0;
  const summary = [
    `${passing}/${checks.length} passing`,
    warns ? `${warns} warning${warns > 1 ? "s" : ""}` : "",
  ].filter(Boolean).join(" · ");
  const head = `<div class="hrow"><span class="dot ${healthOk ? "ok" : "bad"}"></span>
    <b>${healthOk ? "Healthy" : "Problems found"}</b>
    <span class="hd">${esc(ago((health && health.at) || snap.generatedAt))} · ${summary}</span></div>`;
  const rows = checks
    .filter((c) => c.name !== "Always-on Mac" && c.status !== "ok")
    .map((c) => {
      const short = c.detail.length > 70 ? `${c.detail.slice(0, 70)}…` : c.detail;
      return `<div class="hrow"><span class="dot ${esc(c.status === "warn" ? "warn" : "bad")}"></span>${esc(c.name)}<span class="hd">${esc(short)}</span></div>`;
    })
    .join("");
  const macRow = `<div class="hrow"><span class="dot ${esc(mac.status === "ok" ? "ok" : mac.status === "warn" ? "warn" : "bad")}"></span>${esc(mac.name)}<span class="hd">${esc(mac.detail)}</span></div>`;
  $("#health").innerHTML = head + macRow + rows;

  // footer: manage link only when served by the local orchestrator
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  $("#foot").innerHTML = local
    ? `<a href="/manage">open management console</a> · controls also in Slack /adops`
    : `read-only glance · controls in Slack /adops`;
}

function flightCard(r) {
  let sub = "";
  let bar = "";
  const now = Date.now();
  if (r.status === "scheduled" && r.goLiveAt) {
    sub = `Goes live <b>${fmtPt(r.goLiveAt)}</b> · ${until(r.goLiveAt)} · ${r.adCount} ad(s) ready`;
  } else if (r.status === "live" && r.goLiveAt && r.flightEndsAt) {
    const total = new Date(r.flightEndsAt).getTime() - new Date(r.goLiveAt).getTime();
    const pct = Math.min(100, Math.max(0, Math.round(((now - new Date(r.goLiveAt).getTime()) / total) * 100)));
    sub = `Live · auto-off ${until(r.flightEndsAt)} · ${r.adCount} ad(s)`;
    bar = `<div class="bar"><span class="fill" style="width:${pct}%"></span></div>`;
  } else if (r.status === "generating" || r.status === "uploading") {
    sub = `${r.status === "generating" ? "Generating creatives" : "Uploading to Meta"}… ${r.creativeCount ? `${r.creativeCount} so far` : ""}`;
  } else if (r.status === "completed") {
    sub = r.note ? esc(r.note) : "Flight completed";
  } else if (r.note) {
    sub = esc(r.note);
  }
  return `<div class="card flight">
    <div class="flight-head"><span class="v">${esc(r.vertical)}</span><span class="chip ${esc(r.status)}">${esc(r.status)}</span></div>
    ${sub ? `<div class="flight-sub">${sub}</div>` : ""}
    ${r.error ? `<div class="flight-error">${esc(r.error.length > 90 ? `${r.error.slice(0, 90)}…` : r.error)}</div>` : ""}
    ${r.angles && r.angles.length ? `<div class="angle-chips">${r.angles.map((a) => `<span class="angle-chip">${esc(a)}</span>`).join("")}</div>` : ""}
    ${bar}
  </div>`;
}

refresh();

// Live without reloads: poll continuously, re-poll the instant the app comes
// back to the foreground (home-screen apps freeze timers in the background),
// and keep the countdown / "updated Xs ago" labels ticking between polls.
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
