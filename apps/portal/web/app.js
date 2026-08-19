/* Ad Factory portal — polls /api/state and renders runs, verticals, settings. */

const $ = (sel) => document.querySelector(sel);

let state = null;
let verticalsRendered = false;
let settingsDirty = false;

const PT_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function fmtPt(iso) {
  return iso ? `${PT_FMT.format(new Date(iso))} PT` : "—";
}

function countdown(iso) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function refresh() {
  try {
    state = await api("/api/state");
  } catch (err) {
    $("#next-run").textContent = "orchestrator unreachable";
    $("#next-run-countdown").textContent = String(err.message || err);
    return;
  }
  renderHeader();
  renderSchedule();
  renderHealth();
  renderRuns();
  renderAngles().catch(() => {});
  if (!verticalsRendered) {
    renderVerticals();
    verticalsRendered = true;
  }
}

async function renderAngles() {
  const data = await api("/api/angles");
  const host = $("#angle-stats");
  const rows = [];
  for (const v of data.verticals) {
    if (!v.angles.length) continue;
    const ranked = [...v.angles].sort((a, b) => b.weight - a.weight);
    const maxWeight = Math.max(...ranked.map((a) => a.weight));
    for (const a of ranked) {
      const cpa = a.costPerPurchase !== null ? `$${a.costPerPurchase.toFixed(2)}` : "—";
      const share = maxWeight > 0 ? Math.round((a.weight / maxWeight) * 100) : 0;
      rows.push(
        `<div class="angle-row">
          <span class="aname">${escapeHtml(a.name)} <span class="muted">[${escapeHtml(a.id)}]</span></span>
          <span class="abar"><span class="afill" style="width:${share}%"></span></span>
          <span class="astats">${a.creatives} ad(s) · $${a.spend.toFixed(2)} · ${a.purchases} purch · CPA ${cpa}</span>
        </div>`,
      );
    }
  }
  host.innerHTML = rows.length
    ? rows.join("")
    : `<div class="muted">No finished flights yet — stats appear after the first 3-day flight ends.</div>`;
}

function renderHeader() {
  const studioPill = $("#studio-pill");
  studioPill.textContent = state.studioHealthy ? "studio: up" : "studio: down";
  studioPill.className = `pill ${state.studioHealthy ? "ok" : "bad"}`;
  const modePill = $("#mode-pill");
  modePill.textContent = state.settings.dryRun ? "dry run" : "live";
  modePill.className = `pill ${state.settings.dryRun ? "bad" : "ok"}`;
  $("#studio-link").href = state.studioUrl;
}

function renderSchedule() {
  $("#next-run").textContent = fmtPt(state.nextRunAt);
  $("#next-run-countdown").textContent = state.settings.globalPause
    ? "paused globally — runs will not start"
    : countdown(state.nextRunAt);
  if (!settingsDirty) {
    $("#run-hour").value = state.settings.runHourPt;
    $("#global-pause").checked = state.settings.globalPause;
    $("#skip-next").checked = state.settings.skipNext;
  }
}

function badge(status) {
  return `<span class="badge ${status}">${status}</span>`;
}

function renderHealth() {
  const report = state.lastHealthcheck;
  const mac = state.mac || { online: true, lastSeen: state.now, hostname: "" };
  const macItem = `<div class="health-item"><span class="dot ${mac.online ? "ok" : "fail"}"></span><span class="hname">Always-on Mac</span><span class="hdetail">${mac.online ? `on${mac.hostname ? ` · ${escapeHtml(mac.hostname)}` : ""}` : "offline"}</span></div>`;
  if (!report) {
    $("#health-when").textContent = "No healthcheck run yet.";
    $("#health-checks").innerHTML = macItem;
    return;
  }
  $("#health-when").textContent = `Last run ${new Date(report.at).toLocaleString()} — ${report.ok ? "all clear" : "problems found"}`;
  $("#health-checks").innerHTML = macItem + report.checks
    .map(
      (c) =>
        `<div class="health-item"><span class="dot ${c.status}"></span><span class="hname">${escapeHtml(c.name)}</span><span class="hdetail">${escapeHtml(c.detail)}</span></div>`,
    )
    .join("");
}

function creativeCard(c) {
  const name = c.output_path.split("/").pop();
  const video = `<video src="/media?path=${encodeURIComponent(c.output_path)}" controls muted preload="metadata"></video>`;
  const metrics = c.spend !== null && c.spend !== undefined
    ? ` · $${Number(c.spend).toFixed(2)} / ${c.purchases ?? 0} purch`
    : "";
  const line = c.error
    ? `<span class="cstatus error">${c.status}: ${escapeHtml(c.error)}</span>`
    : `<span class="cstatus">${c.status}${c.ad_id ? ` · ad ${c.ad_id}` : ""}${metrics}</span>`;
  const angleTag = c.angle ? `<span class="angle-tag">${escapeHtml(c.angle)}</span>` : "";
  return `<div class="creative">${video}<div class="name">${escapeHtml(name)} ${angleTag}</div>${line}</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function runActions(run) {
  const buttons = [];
  if (run.status === "scheduled" || run.status === "live") {
    buttons.push(`<button class="btn small" data-action="pause" data-run="${run.id}">Pause</button>`);
  }
  if (run.status === "paused") {
    buttons.push(`<button class="btn small" data-action="resume" data-run="${run.id}">Resume</button>`);
  }
  if (["scheduled", "live", "paused", "generating", "uploading"].includes(run.status)) {
    buttons.push(`<button class="btn small danger" data-action="kill" data-run="${run.id}">Kill</button>`);
  }
  return buttons.join("");
}

function renderRuns() {
  const host = $("#runs");
  if (!state.runs.length) {
    host.innerHTML = `<div class="card empty">No runs yet. Hit “Run now” or wait for the daily schedule.</div>`;
    return;
  }
  host.innerHTML = state.runs
    .map((run) => {
      const vertical = state.verticals.find((v) => v.id === run.vertical_id);
      const goLive = run.go_live_at
        ? `go-live ${fmtPt(run.go_live_at)} · ${countdown(run.go_live_at)}`
        : "";
      return `
      <div class="card run">
        <div class="run-head">
          <span class="run-vertical">${escapeHtml(vertical ? vertical.label : run.vertical_id)}</span>
          ${badge(run.status)}
          <span class="run-id">${run.id}</span>
          <div class="run-actions">${runActions(run)}</div>
        </div>
        <div class="run-meta">${new Date(run.created_at).toLocaleString()} · ${run.mode}${goLive ? " · " + goLive : ""}${run.meta_campaign_id ? ` · campaign ${run.meta_campaign_id}` : ""}${run.meta_adset_id ? ` · ad set ${run.meta_adset_id}` : ""}${run.note ? " · " + escapeHtml(run.note) : ""}</div>
        ${run.error ? `<div class="run-error">${escapeHtml(run.error)}</div>` : ""}
        <div class="creatives">${run.creatives.map(creativeCard).join("")}</div>
      </div>`;
    })
    .join("");

  host.querySelectorAll("button[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.action;
      if (action === "kill" && !confirm("Kill this run? Ads will be paused and never go live.")) return;
      button.disabled = true;
      try {
        await api(`/api/runs/${button.dataset.run}/${action}`, { method: "POST" });
        await refresh();
      } catch (err) {
        alert(err.message || err);
        button.disabled = false;
      }
    });
  });
}

function field(label, name, value, type = "text") {
  return `<label>${label}<input type="${type}" name="${name}" value="${escapeHtml(value ?? "")}" /></label>`;
}

function renderVerticals() {
  const host = $("#verticals");
  host.innerHTML = state.verticals
    .map((v) => {
      return `
      <div class="card vertical-card" data-vertical="${v.id}">
        <div class="vertical-head">
          <span class="title">${escapeHtml(v.label)}</span>
          <span class="pill">${escapeHtml(v.family ?? "")}</span>
          <label class="inline toggle"><input type="checkbox" name="enabled" ${v.enabled ? "checked" : ""}/> enabled</label>
          <span class="pill">${escapeHtml(v.creativeCampaignId)}</span>
        </div>
        <div class="vgrid">
          <label>Family
            <select name="family">
              <option value="loans" ${v.family === "loans" ? "selected" : ""}>loans</option>
              <option value="debt" ${v.family === "debt" ? "selected" : ""}>debt</option>
              <option value="other" ${v.family === "other" ? "selected" : ""}>other</option>
            </select>
          </label>
          ${field("Daily count", "dailyCount", v.dailyCount, "number")}
          ${field("Ad account (act_…)", "adAccountId", v.meta.adAccountId)}
          ${field("Page ID", "pageId", v.meta.pageId)}
          <label>Mode
            <select name="mode">
              <option value="new-campaign" ${v.meta.mode === "new-campaign" ? "selected" : ""}>new CBO campaign daily</option>
              <option value="new-adset" ${v.meta.mode === "new-adset" ? "selected" : ""}>new ad set daily</option>
              <option value="existing-adset" ${v.meta.mode === "existing-adset" ? "selected" : ""}>existing ad set</option>
            </select>
          </label>
          ${field("Pixel ID", "pixelId", v.meta.pixelId)}
          ${field("CBO daily budget (cents)", "cboDailyBudgetCents", v.meta.cboDailyBudgetCents, "number")}
          <label>Bid strategy
            <select name="bidStrategy">
              <option value="LOWEST_COST_WITHOUT_CAP" ${v.meta.bidStrategy === "LOWEST_COST_WITHOUT_CAP" ? "selected" : ""}>highest volume</option>
              <option value="LOWEST_COST_WITH_BID_CAP" ${v.meta.bidStrategy === "LOWEST_COST_WITH_BID_CAP" ? "selected" : ""}>bid cap</option>
            </select>
          </label>
          ${field("Bid cap (cents)", "bidCapCents", v.meta.bidCapCents, "number")}
          ${field("Parent campaign ID", "parentCampaignId", v.meta.parentCampaignId)}
          ${field("Existing ad set ID", "existingAdSetId", v.meta.existingAdSetId)}
          ${field("Template ad set ID", "templateAdSetId", v.meta.templateAdSetId)}
          ${field("Ad set budget (cents)", "dailyBudgetCents", v.meta.dailyBudgetCents, "number")}
          ${field("Go-live hour PT", "startHourPt", v.schedule.startHourPt, "number")}
          ${field("Flight days (auto-off)", "flightDays", v.schedule.flightDays, "number")}
          ${field("Headline", "headline", v.meta.adSettings.headline)}
          ${field("Primary text", "primaryText", v.meta.adSettings.primaryText)}
          ${field("Description", "description", v.meta.adSettings.description)}
          ${field("Website URL", "websiteUrl", v.meta.adSettings.websiteUrl)}
          ${field("Display URL", "displayUrl", v.meta.adSettings.displayUrl)}
          ${field("CTA", "callToAction", v.meta.adSettings.callToAction)}
        </div>
        <div class="vfooter">
          <button class="btn primary small" data-save="${v.id}">Save</button>
          <button class="btn small" data-runv="${v.id}">Run this vertical now</button>
          <span class="save-note">saved</span>
        </div>
      </div>`;
    })
    .join("");

  host.querySelectorAll("button[data-save]").forEach((button) => {
    button.addEventListener("click", async () => {
      const card = button.closest(".vertical-card");
      const get = (name) => card.querySelector(`[name="${name}"]`);
      const patch = {
        enabled: get("enabled").checked,
        family: get("family").value,
        dailyCount: Number(get("dailyCount").value || 1),
        schedule: {
          startHourPt: Number(get("startHourPt").value || 5),
          flightDays: Number(get("flightDays").value || 3),
        },
        meta: {
          adAccountId: get("adAccountId").value.trim(),
          pageId: get("pageId").value.trim(),
          mode: get("mode").value,
          parentCampaignId: get("parentCampaignId").value.trim(),
          existingAdSetId: get("existingAdSetId").value.trim(),
          templateAdSetId: get("templateAdSetId").value.trim(),
          pixelId: get("pixelId").value.trim(),
          cboDailyBudgetCents: Number(get("cboDailyBudgetCents").value || 0),
          bidStrategy: get("bidStrategy").value,
          bidCapCents: Number(get("bidCapCents").value || 0),
          dailyBudgetCents: Number(get("dailyBudgetCents").value || 0),
          adSettings: {
            headline: get("headline").value,
            primaryText: get("primaryText").value,
            description: get("description").value,
            websiteUrl: get("websiteUrl").value.trim(),
            displayUrl: get("displayUrl").value.trim(),
            callToAction: get("callToAction").value.trim() || "LEARN_MORE",
          },
        },
      };
      button.disabled = true;
      try {
        await api(`/api/verticals/${button.dataset.save}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const note = card.querySelector(".save-note");
        note.classList.add("show");
        setTimeout(() => note.classList.remove("show"), 1800);
      } catch (err) {
        alert(err.message || err);
      } finally {
        button.disabled = false;
      }
    });
  });

  host.querySelectorAll("button[data-runv]").forEach((button) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api("/api/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ verticalId: button.dataset.runv }),
        });
        await refresh();
      } catch (err) {
        alert(err.message || err);
      } finally {
        button.disabled = false;
      }
    });
  });
}

$("#run-health").addEventListener("click", async () => {
  const btn = $("#run-health");
  btn.disabled = true;
  btn.textContent = "Running…";
  try {
    await api("/api/healthcheck", { method: "POST" });
    await refresh();
  } catch (err) {
    alert(err.message || err);
  } finally {
    btn.disabled = false;
    btn.textContent = "Run healthcheck";
  }
});

$("#run-now").addEventListener("click", async () => {
  const btn = $("#run-now");
  btn.disabled = true;
  try {
    await api("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    await refresh();
  } catch (err) {
    alert(err.message || err);
  } finally {
    btn.disabled = false;
  }
});

async function pushSettings() {
  settingsDirty = false;
  await api("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runHourPt: Number($("#run-hour").value || 10),
      globalPause: $("#global-pause").checked,
      skipNext: $("#skip-next").checked,
    }),
  });
  await refresh();
}

for (const id of ["#run-hour", "#global-pause", "#skip-next"]) {
  $(id).addEventListener("change", () => {
    settingsDirty = true;
    pushSettings().catch((err) => alert(err.message || err));
  });
}

$("#uploader-link").addEventListener("click", (e) => {
  e.preventDefault();
  window.open("http://localhost:5190", "_blank");
});

refresh();
setInterval(refresh, 5000);
