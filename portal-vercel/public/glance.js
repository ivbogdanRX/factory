/* VA Loans glance — utility-first status page fed by the Mac's snapshot. */

const $ = (sel) => document.querySelector(sel);

let lastSnap = null;
let fetching = false;
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

const PT_SHORT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

const fmtPt = (iso) => (iso ? PT_SHORT.format(new Date(iso)) : "—");

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

const money = (n) => `$${Number(n).toFixed(Number(n) >= 100 ? 0 : 2)}`;

/** "2026-08-14" → "Thu 8/14" without UTC-midnight date shifting. */
function dayLabel(ymd) {
  const [y, m, d] = String(ymd).split("-").map(Number);
  if (!y || !m || !d) return ymd;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(y, m - 1, d).getDay()];
  return `${wd} ${m}/${d}`;
}

/* ---- access key (only needed off-LAN) ---- */

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
  wrap.className = "keyform";
  wrap.innerHTML = `
    <div class="kf-title">Access key</div>
    <div class="kf-sub">Enter the dashboard key once — it'll be remembered.</div>
    <form>
      <input type="password" inputmode="text" autocomplete="current-password" placeholder="adf-…" />
      <button type="submit">Unlock</button>
    </form>
    <div class="kf-err" hidden>Wrong key — try again.</div>`;
  $("#app").replaceChildren(wrap);
  wrap.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const val = wrap.querySelector("input").value.trim();
    if (!val) return;
    setKey(val);
    const res = await fetch(snapshotUrl(), { cache: "no-store" });
    if (res.ok) render(await res.json());
    else wrap.querySelector(".kf-err").hidden = false;
  });
}

/* ---- refresh loop ---- */

async function refresh() {
  if (fetching) return;
  fetching = true;
  try { await doRefresh(); } finally { fetching = false; }
}

async function doRefresh() {
  let snap;
  try {
    const res = await fetch(snapshotUrl(), { cache: "no-store" });
    if (res.status === 401) {
      setHeader("bad", "locked");
      showKeyForm();
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    snap = await res.json();
  } catch (err) {
    setHeader("bad", "offline");
    $("#app").innerHTML = `
      <div class="attn">
        <div><b>Can't reach the Mac</b><div class="sub">${esc(err.message || err)} — be on the same Wi-Fi as the Mac mini, or connect Tailscale.</div></div>
      </div>
      ${lastSnap ? `<div class="row"><span class="l">Last seen</span><span class="v muted">${esc(ago(lastSnap.generatedAt))}</span></div>` : ""}`;
    return;
  }
  render(snap);
}

function setHeader(state, text) {
  $("#sdot").className = `sdot${state === "ok" ? "" : ` ${state}`}`;
  const upd = $("#updated");
  upd.textContent = text;
  upd.className = `upd${state === "ok" ? "" : state === "warn" ? " stale" : " off"}`;
}

/* ---- what actually needs Ivan's eyes ---- */

function attentionItems(snap, macAgeMs) {
  const items = [];
  if (macAgeMs > 180_000) {
    items.push({ t: "Mac mini offline", sub: `last heartbeat ${ago(snap.generatedAt)} — nothing runs until it's back` });
  }
  for (const p of snap.problems || []) items.push({ t: p });

  const accts = snap.accounts?.accounts || [];
  const main = accts.find((a) => a.label === "VA Loans");
  if (main && !main.ok) {
    items.push({ t: `Main ad account is ${main.status}`, sub: "tomorrow's drop needs an active account — spares are listed below" });
  }
  for (const c of snap.health?.checks || []) {
    if (c.status === "fail") items.push({ t: `${c.name} is down`, sub: c.detail });
  }
  for (const r of snap.runs || []) {
    if (r.status === "error") items.push({ t: `${r.vertical} flight errored`, sub: r.error || r.note || "" });
  }
  if (snap.globalPause) items.push({ t: "Factory is paused", sub: "resume with /adops in Slack" });
  if (snap.skipNext) items.push({ t: "Next drop will be skipped" });
  if (snap.dryRun) items.push({ t: "Dry-run mode", sub: "no real money is being spent" });

  const seen = new Set();
  return items.filter((i) => (seen.has(i.t) ? false : seen.add(i.t)));
}

/* ---- render ---- */

function render(snap) {
  lastSnap = snap;
  const form = $("#keyform");
  if (form) form.remove();

  const macAgeMs = Date.now() - new Date((snap.mac && snap.mac.lastSeen) || snap.generatedAt).getTime();
  const stale = macAgeMs > 90_000;
  const attn = attentionItems(snap, macAgeMs);
  setHeader(attn.length ? "bad" : stale ? "warn" : "ok", stale ? `stale · ${ago(snap.generatedAt)}` : "live");

  const parts = [];

  // 1. Exceptions first — or one quiet all-clear line.
  if (attn.length) {
    parts.push(`<div class="attn">${attn.map((i) =>
      `<div><b>${esc(i.t)}</b>${i.sub ? `<div class="sub">${esc(i.sub)}</div>` : ""}</div>`).join("")}</div>`);
  } else {
    parts.push(`<div class="allclear">All clear — nothing needs you.</div>`);
  }

  // 2. Money today.
  const spend = snap.perf?.spendToday ?? 0;
  const purch = snap.perf?.purchasesToday ?? 0;
  const cpa = snap.perf?.cpaToday;
  const noSpend = !spend && !purch;
  parts.push(`<div class="nums">
    <div><div class="n${noSpend ? " dim" : ""}">${money(spend)}</div><div class="t">spend</div></div>
    <div><div class="n${noSpend ? " dim" : ""}">${purch}</div><div class="t">purchases</div></div>
    <div><div class="n${cpa != null ? "" : " dim"}">${cpa != null ? money(cpa) : "—"}</div><div class="t">cpa</div></div>
  </div>`);

  // 3. Per-day history — the "how's it actually going" table.
  const daily = snap.daily || [];
  if (daily.length) {
    parts.push(`<div class="days">
      <div class="dhead"><span>last 7 days</span><span>spend</span><span>buys</span><span>cpa</span></div>
      ${daily.map((d) => `<div class="day${d.spend || d.purchases ? "" : " dim"}">
        <span class="dt">${esc(dayLabel(d.date))}</span>
        <span>${money(d.spend)}</span>
        <span>${d.purchases}</span>
        <span>${d.cpa != null ? money(d.cpa) : "—"}</span>
      </div>`).join("")}
    </div>`);
  } else {
    parts.push(`<div class="row"><span class="l">Last 7 days</span><span class="v muted">no flight history yet</span></div>`);
  }

  // 4. Flights: live ones get a row each; otherwise just the next drop.
  const live = (snap.runs || []).filter((r) => ["live", "scheduled", "generating", "uploading"].includes(r.status));
  for (const r of live) {
    let v = "";
    if (r.status === "live") v = `<b class="good">live</b><span class="sub">${r.adCount} ads · auto-off ${esc(until(r.flightEndsAt))}</span>`;
    else if (r.status === "scheduled") v = `<b>scheduled</b><span class="sub">${r.adCount} ads · live ${esc(fmtPt(r.goLiveAt))} PT</span>`;
    else v = `<b class="warned">${esc(r.status)}…</b>${r.creativeCount ? `<span class="sub">${r.creativeCount} creatives so far</span>` : ""}`;
    parts.push(`<div class="row"><span class="l">${esc(r.vertical)}</span><span class="v">${v}</span></div>`);
  }
  if (snap.nextRunAt) {
    const offer = snap.offer || {};
    const plan = [offer.dailyCount ? `${offer.dailyCount} ads` : null, offer.budgetUsd ? `${money(offer.budgetUsd)}/day` : null]
      .filter(Boolean).join(" · ");
    parts.push(`<div class="row"><span class="l">Next drop</span>
      <span class="v"><b>${esc(fmtPt(snap.nextRunAt))} PT</b> · ${esc(until(snap.nextRunAt))}${plan ? `<span class="sub">${esc(plan)}</span>` : ""}</span></div>`);
  }

  // 4. Ad accounts — summary row, list on tap.
  const accts = snap.accounts?.accounts || [];
  if (accts.length) {
    const okN = accts.filter((a) => a.ok).length;
    const badN = accts.length - okN;
    parts.push(`<details id="d-accounts">
      <summary><div class="row"><span class="l">Ad accounts</span>
        <span class="v"><b class="${badN ? "warned" : "good"}">${okN} of ${accts.length} usable</b></span></div></summary>
      <div class="dlist">${accts.map((a) =>
        `<div class="drow"><span class="dot ${a.ok ? "" : "bad"}"></span><span class="nm">${esc(a.label)}</span><span class="st ${a.ok ? "" : "bad"}">${esc(a.status)}</span></div>`).join("")}</div>
    </details>`);
  }

  // 5. Ads rendered today — count + tappable thumbs.
  const creatives = snap.latestCreatives || [];
  parts.push(`<div class="row"${creatives.length ? ` style="border-bottom:0"` : ""}>
    <span class="l">Ads today</span>
    <span class="v">${creatives.length ? `<b>${creatives.length} rendered</b><span class="sub">newest ${esc(ago(creatives[0].createdAt))}</span>` : `<span class="muted">none yet</span>`}</span></div>`);
  if (creatives.length) {
    parts.push(`<div class="thumbs" style="border-bottom:1px solid var(--line)">${creatives.map((c, i) => `
      <a class="thumb" href="${esc(c.videoUrl)}">
        ${c.posterUrl ? `<img src="${esc(c.posterUrl)}" alt="" loading="lazy" />` : ""}
        <div class="cap">v${creatives.length - i}</div>
      </a>`).join("")}</div>`);
  }

  // 6. Machine — one line unless something is off.
  const checks = snap.health?.checks || [];
  const notOk = checks.filter((c) => c.status !== "ok");
  const macLabel = (snap.mac && snap.mac.hostname) || "Mac mini";
  parts.push(`<details id="d-machine">
    <summary><div class="row"><span class="l">Machine</span>
      <span class="v">${macAgeMs > 180_000
        ? `<b class="broke">offline</b>`
        : notOk.length
          ? `<b class="warned">${notOk.length} warning${notOk.length > 1 ? "s" : ""}</b>`
          : `<b class="good">healthy</b>`}<span class="sub">${esc(macLabel)}</span></span></div></summary>
    <div class="dlist">${checks.map((c) =>
      `<div class="drow"><span class="dot ${c.status === "ok" ? "" : c.status === "warn" ? "warn" : "bad"}"></span><span class="nm">${esc(c.name)}</span><span class="st">${esc(c.detail.length > 34 ? `${c.detail.slice(0, 34)}…` : c.detail)}</span></div>`).join("")}</div>
  </details>`);

  const local = ["localhost", "127.0.0.1"].includes(location.hostname) || location.hostname.endsWith(".local");
  parts.push(`<footer>updated ${esc(ago(snap.generatedAt))}${local ? ` · <a href="/manage">manage</a>` : ""} · controls in Slack /adops</footer>`);

  // Keep expanded sections expanded across the 20s re-render.
  const open = new Set([...document.querySelectorAll("details[open]")].map((d) => d.id));
  $("#app").innerHTML = parts.join("");
  for (const id of open) {
    const d = document.getElementById(id);
    if (d) d.open = true;
  }
}

/* ---- launch control: expand → hold 3s to arm → type LAUNCH → go ---- */

(() => {
  const panel = $("#launch-panel");
  const holdBtn = $("#hold-btn");
  const holdFill = $("#hold-fill");
  const holdTxt = $("#hold-txt");
  const armRow = $("#lp-arm");
  const word = $("#launch-word");
  const go = $("#launch-go");
  const msg = $("#lp-msg");

  const HOLD_MS = 3000;
  let holdStart = 0;
  let holdTimer = null;
  let disarmTimer = null;

  function reset() {
    clearInterval(holdTimer);
    clearTimeout(disarmTimer);
    holdTimer = null;
    holdFill.style.width = "0%";
    holdTxt.textContent = "Hold for 3 seconds to arm";
    holdBtn.disabled = false;
    armRow.hidden = true;
    word.value = "";
    go.disabled = true;
  }

  $("#launch-toggle").addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    msg.hidden = true;
    if (!panel.hidden) reset();
  });

  function arm() {
    clearInterval(holdTimer);
    holdTimer = null;
    holdFill.style.width = "100%";
    holdTxt.textContent = "Armed";
    holdBtn.disabled = true;
    armRow.hidden = false;
    word.focus();
    // Auto-disarm if nothing happens — no live grenades left lying around.
    disarmTimer = setTimeout(reset, 60_000);
  }

  function startHold(e) {
    e.preventDefault();
    if (holdBtn.disabled || holdTimer) return;
    holdStart = Date.now();
    holdTimer = setInterval(() => {
      const pct = Math.min(100, ((Date.now() - holdStart) / HOLD_MS) * 100);
      holdFill.style.width = `${pct}%`;
      if (pct >= 100) arm();
    }, 50);
  }

  function cancelHold() {
    if (holdBtn.disabled) return;
    clearInterval(holdTimer);
    holdTimer = null;
    holdFill.style.width = "0%";
  }

  holdBtn.addEventListener("touchstart", startHold, { passive: false });
  holdBtn.addEventListener("mousedown", startHold);
  for (const ev of ["touchend", "touchcancel", "mouseup", "mouseleave"]) {
    holdBtn.addEventListener(ev, cancelHold);
  }
  holdBtn.addEventListener("contextmenu", (e) => e.preventDefault());

  word.addEventListener("input", () => {
    go.disabled = word.value.trim().toUpperCase() !== "LAUNCH";
  });

  go.addEventListener("click", async () => {
    if (go.disabled) return;
    go.disabled = true;
    go.textContent = "Launching…";
    try {
      const res = await fetch("/api/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: word.value.trim().toUpperCase() }),
      });
      const data = await res.json().catch(() => ({}));
      msg.hidden = false;
      if (res.ok) {
        msg.className = "lp-msg ok";
        msg.textContent = data.message || "Production run started.";
        panel.hidden = true;
        setTimeout(refresh, 2000);
      } else {
        msg.className = "lp-msg err";
        msg.textContent = data.error || `Failed (HTTP ${res.status})`;
      }
    } catch (err) {
      msg.hidden = false;
      msg.className = "lp-msg err";
      msg.textContent = `Couldn't reach the Mac: ${err.message || err}`;
    }
    go.textContent = "Launch";
    reset();
  });
})();

refresh();
setInterval(refresh, 20_000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
window.addEventListener("focus", refresh);
window.addEventListener("pageshow", refresh);
window.addEventListener("online", refresh);
