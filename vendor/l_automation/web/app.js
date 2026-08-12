const state = {
  campaigns: [],
  assets: [],
  selectedIndex: -1,
  watchedJobId: null,
  jobSource: null,
};

const els = {
  campaignList: document.getElementById("campaignList"),
  newCampaignBtn: document.getElementById("newCampaignBtn"),
  emptyState: document.getElementById("emptyState"),
  form: document.getElementById("campaignForm"),
  bodyVideoSelect: document.getElementById("bodyVideoSelect"),
  deleteBtn: document.getElementById("deleteCampaignBtn"),
  saveHint: document.getElementById("saveHint"),
  runCampaign: document.getElementById("runCampaign"),
  runCount: document.getElementById("runCount"),
  runVariant: document.getElementById("runVariant"),
  runHook: document.getElementById("runHook"),
  runHookBubbleText: document.getElementById("runHookBubbleText"),
  runRandom: document.getElementById("runRandom"),
  runBtn: document.getElementById("runBtn"),
  jobMeta: document.getElementById("jobMeta"),
  jobList: document.getElementById("jobList"),
  capacity: document.getElementById("capacity"),
  watching: document.getElementById("watching"),
  logs: document.getElementById("logs"),
  progressBadge: document.getElementById("progressBadge"),
  progressThumb: document.getElementById("progressThumb"),
  thumbPlaceholder: document.getElementById("thumbPlaceholder"),
  progressImg: document.getElementById("progressImg"),
  progressSteps: document.getElementById("progressSteps"),
  progressInfo: document.getElementById("progressInfo"),
  statusBackend: document.getElementById("statusBackend"),
  budgetText: document.getElementById("budgetText"),
  budgetFill: document.getElementById("budgetFill"),
  budgetSub: document.getElementById("budgetSub"),
  modelList: document.getElementById("modelList"),
  outputs: document.getElementById("outputs"),
  refreshOutputs: document.getElementById("refreshOutputs"),
  busyBadge: document.getElementById("busyBadge"),
  previewModal: document.getElementById("previewModal"),
  previewVideo: document.getElementById("previewVideo"),
  previewName: document.getElementById("previewName"),
  previewClose: document.getElementById("previewClose"),
};

const LIST_FIELDS = ["hooks", "creatorPrompts", "scenePrompts", "cameraPrompts"];
const TEXT_FIELDS = [
  "id",
  "name",
  "vertical",
  "angle",
  "bodyVideo",
  "outputName",
  "promptContext",
  "cameraStyle",
  "promptTemplate",
  "captionStyle",
  "captionPosition",
  "hookBubbleEnabled",
  "hookBubbleText",
];
const NUM_FIELDS = ["trimSeconds", "captionVerticalPosition"];

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

function mediaUrl(absPath) {
  return `/media?path=${encodeURIComponent(absPath)}`;
}

function assetRelPath(name) {
  return `./assets/${name}`;
}

function blankCampaign() {
  return {
    id: "",
    name: "",
    vertical: "",
    angle: "",
    bodyVideo: state.assets[0] ? assetRelPath(state.assets[0].name) : "",
    outputName: "",
    promptContext: "",
    cameraStyle: "",
    cameraPrompts: [],
    creatorPrompts: [],
    scenePrompts: [],
    promptTemplate: "",
    hooks: [],
    variants: [],
    maxHookSeconds: 7.8,
    trimSeconds: 0.2,
    captionVerticalPosition: 0,
    captionStyle: "",
    captionPosition: "",
    hookBubbleEnabled: "",
    hookBubbleText: "",
  };
}

function renderCampaignList() {
  els.campaignList.innerHTML = "";
  state.campaigns.forEach((c, idx) => {
    const li = document.createElement("li");
    if (idx === state.selectedIndex) li.classList.add("active");
    li.innerHTML = `<div class="c-name">${c.name || c.id || "(unnamed)"}</div><div class="c-id">${c.id || "no-id"}</div>`;
    li.addEventListener("click", () => selectCampaign(idx));
    els.campaignList.appendChild(li);
  });
}

function renderBodyOptions(selected) {
  els.bodyVideoSelect.innerHTML = "";
  const values = new Set();
  state.assets.forEach((a) => values.add(assetRelPath(a.name)));
  if (selected) values.add(selected);
  values.forEach((val) => {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = val;
    if (val === selected) opt.selected = true;
    els.bodyVideoSelect.appendChild(opt);
  });
}

function selectCampaign(idx) {
  state.selectedIndex = idx;
  const c = state.campaigns[idx];
  if (!c) return;
  els.emptyState.classList.add("hidden");
  els.form.classList.remove("hidden");
  renderBodyOptions(c.bodyVideo);

  TEXT_FIELDS.forEach((f) => {
    els.form.elements[f].value = c[f] ?? "";
  });
  NUM_FIELDS.forEach((f) => {
    els.form.elements[f].value = c[f] ?? "";
  });
  LIST_FIELDS.forEach((f) => {
    els.form.elements[f].value = (c[f] ?? []).join("\n");
  });
  renderCampaignList();
}

function readFormIntoCampaign() {
  const c = state.campaigns[state.selectedIndex];
  if (!c) return;
  TEXT_FIELDS.forEach((f) => {
    c[f] = els.form.elements[f].value.trim();
  });
  NUM_FIELDS.forEach((f) => {
    const v = els.form.elements[f].value;
    c[f] = v === "" ? 0 : Number(v);
  });
  LIST_FIELDS.forEach((f) => {
    c[f] = els.form.elements[f].value
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  });
}

function resolveVariants(c) {
  if (c.variants?.length) return c.variants;
  const n = Math.max(
    c.creatorPrompts?.length || 0,
    c.scenePrompts?.length || 0,
    c.cameraPrompts?.length || 0,
    1,
  );
  const variants = [];
  for (let i = 0; i < n; i++) {
    variants.push({
      id: `variant-${i + 1}`,
      name: `Variant ${i + 1}`,
      hooks: c.hooks || [],
    });
  }
  return variants;
}

function selectedRunCampaign() {
  const id = els.runCampaign.value;
  return state.campaigns.find((c) => c.id === id);
}

function renderRunVariants() {
  els.runVariant.innerHTML = '<option value="">Random persona</option>';
  const c = selectedRunCampaign();
  if (!c) return;
  resolveVariants(c).forEach((v, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = v.name || v.id || `Variant ${i + 1}`;
    els.runVariant.appendChild(opt);
  });
  renderRunHooks();
}

function renderRunHooks() {
  els.runHook.innerHTML = '<option value="">Random hook (shuffle)</option>';
  const c = selectedRunCampaign();
  if (!c) return;
  const variants = resolveVariants(c);
  const vi = els.runVariant.value;
  const variant = vi === "" ? null : variants[Number(vi)];
  const hooks = variant?.hooks?.length ? variant.hooks : c.hooks || [];
  hooks.forEach((h, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    const label = h.length > 70 ? `${h.slice(0, 67)}...` : h;
    opt.textContent = label;
    els.runHook.appendChild(opt);
  });
}

function renderRunCampaigns() {
  els.runCampaign.innerHTML = "";
  state.campaigns.forEach((c) => {
    if (!c.id) return;
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name || c.id;
    els.runCampaign.appendChild(opt);
  });
  renderRunVariants();
}

async function loadConfig() {
  const data = await api("/api/config");
  state.campaigns = (data.campaigns || []).map((c) => ({
    creatorPrompts: [],
    scenePrompts: [],
    cameraPrompts: [],
    hooks: [],
    variants: [],
    ...c,
  }));
  renderCampaignList();
  renderRunCampaigns();
}

async function loadAssets() {
  const data = await api("/api/assets");
  state.assets = data.assets || [];
}

async function saveCampaigns() {
  readFormIntoCampaign();
  els.saveHint.textContent = "Saving...";
  try {
    await api("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ campaigns: state.campaigns }),
    });
    els.saveHint.textContent = "Saved";
    renderCampaignList();
    renderRunCampaigns();
    setTimeout(() => (els.saveHint.textContent = ""), 2000);
  } catch (err) {
    els.saveHint.style.color = "var(--danger)";
    els.saveHint.textContent = err.message;
  }
}

const PHASE_ORDER = ["image", "video", "captions", "splice"];
const PHASE_LABEL = {
  image: "Image",
  video: "Hook video",
  captions: "Captions",
  splice: "Exporting",
  "run-done": "Saved",
};

function imageUrl(absPath) {
  return `/image?path=${encodeURIComponent(absPath)}`;
}

function escapeHtml(str) {
  return String(str).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]),
  );
}

function setSteps(activePhase, allDone) {
  const reached =
    activePhase === "run-done" ? PHASE_ORDER.length : PHASE_ORDER.indexOf(activePhase);
  els.progressSteps.querySelectorAll("li").forEach((li, i) => {
    li.classList.remove("active", "done");
    if (allDone || i < reached) li.classList.add("done");
    else if (i === reached) li.classList.add("active");
  });
}

function resetProgress() {
  els.progressBadge.textContent = "Idle";
  els.progressBadge.className = "badge idle";
  els.progressImg.hidden = true;
  els.progressImg.removeAttribute("src");
  els.thumbPlaceholder.hidden = false;
  els.progressThumb.classList.remove("loading");
  setSteps(null, false);
  els.progressInfo.innerHTML =
    '<p class="progress-empty">Start a generation above to watch it here.</p>';
}

function renderProgress(p, status) {
  if (status === "done") {
    els.progressBadge.textContent = "Done";
    els.progressBadge.className = "badge done";
    setSteps("run-done", true);
    els.progressThumb.classList.remove("loading");
  } else if (status === "error") {
    els.progressBadge.textContent = "Error";
    els.progressBadge.className = "badge error";
    els.progressThumb.classList.remove("loading");
  } else if (status === "queued") {
    els.progressBadge.textContent = "Queued";
    els.progressBadge.className = "badge queued";
  }

  if (!p) {
    if (status === "running") {
      els.progressBadge.textContent = "Starting";
      els.progressBadge.className = "badge running";
    }
    return;
  }

  if (status === "running") {
    els.progressBadge.textContent = PHASE_LABEL[p.phase] || "Working";
    els.progressBadge.className = "badge running";
    setSteps(p.phase, false);
    els.progressThumb.classList.toggle("loading", !p.imagePath);
  }

  if (p.imagePath) {
    const url = imageUrl(p.imagePath);
    if (els.progressImg.getAttribute("src") !== url) {
      els.progressImg.src = url;
    }
    els.progressImg.hidden = false;
    els.thumbPlaceholder.hidden = true;
  } else {
    els.progressImg.hidden = true;
    els.thumbPlaceholder.hidden = false;
  }

  const total = p.runTotal ? `${p.runIndex} / ${p.runTotal}` : `#${p.runIndex}`;
  const rows = [];
  rows.push(`<div class="pi-row"><span>Run</span><b>${total}</b></div>`);
  if (p.persona)
    rows.push(`<div class="pi-row"><span>Persona</span><b>${escapeHtml(p.persona)}</b></div>`);
  if (p.bubble)
    rows.push(`<div class="pi-row"><span>Bubble</span><b>${escapeHtml(p.bubble)}</b></div>`);
  if (p.hook)
    rows.push(`<div class="pi-hook">"${escapeHtml(p.hook)}"</div>`);
  els.progressInfo.innerHTML = rows.join("");
}

function appendLog(line) {
  const div = document.createElement("div");
  div.className = `l-${line.level}`;
  div.textContent = line.message;
  els.logs.appendChild(div);
  els.logs.scrollTop = els.logs.scrollHeight;
}

function renderCapacity(cap) {
  if (!cap) return;
  const running = cap.active > 0 || cap.queued > 0;
  els.busyBadge.textContent = running
    ? `${cap.active} running${cap.queued ? ` / ${cap.queued} queued` : ""}`
    : "Idle";
  els.busyBadge.classList.toggle("busy", running);
  els.capacity.textContent = `${cap.active}/${cap.maxConcurrent} active${
    cap.queued ? `, ${cap.queued} queued` : ""
  }`;
}

function renderJobs(jobs) {
  els.jobList.innerHTML = "";
  if (!jobs.length) {
    els.jobList.innerHTML = `<li style="cursor:default;color:var(--text-faint);background:transparent;border-color:transparent">No jobs yet.</li>`;
    return;
  }
  jobs.forEach((job) => {
    const li = document.createElement("li");
    if (job.id === state.watchedJobId) li.classList.add("active");
    const label = job.fullAd
      ? `New ad: ${job.label || "untitled"}`
      : job.fullRemake
        ? `Remake: ${job.label || ""}`.trim()
        : job.campaignId || "job";
    li.innerHTML = `<span class="j-label">${label}</span><span class="badge ${job.status}">${job.status}</span>`;
    li.addEventListener("click", () => watchJob(job.id));
    els.jobList.appendChild(li);
  });
}

const MODEL_STATE = {
  available: { label: "Ready", cls: "ready" },
  ok: { label: "Working", cls: "ok" },
  rate_limited: { label: "Rate limited", cls: "warn" },
  denied: { label: "No access", cls: "err" },
  missing: { label: "Not found", cls: "err" },
  error: { label: "Error", cls: "err" },
};

function miniBar(label, used, limit) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const level = pct >= 100 ? "full" : pct >= 70 ? "high" : "";
  return (
    `<div class="usage">` +
    `<span class="usage-top"><span>${label}</span><b>${used} / ${limit}</b></span>` +
    `<div class="mini-bar"><i class="${level}" style="width:${pct}%"></i></div>` +
    `</div>`
  );
}

function renderStatus(d) {
  if (!d) return;
  const cap = d.capacity || {};
  els.statusBackend.textContent =
    `backend: ${d.backend}` +
    (d.maxConcurrent ? ` · up to ${d.maxConcurrent} parallel` : "") +
    (cap.active ? ` · ${cap.active} active` : "");

  const b = d.veoDaily || {};
  const used = b.used ?? 0;
  const limit = b.limit ?? 0;
  els.budgetText.textContent = `${b.left ?? 0} left today`;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  els.budgetFill.style.width = `${pct}%`;
  els.budgetFill.className =
    "rate-fill " + (pct >= 100 ? "full" : pct >= 70 ? "high" : "");
  els.budgetSub.textContent =
    `${used} / ${limit} used (${b.perModelRpd}/day × each model) · ` +
    `resets midnight PT · counts runs made here`;

  els.modelList.innerHTML = "";
  (d.models || []).forEach((m) => {
    const meta = MODEL_STATE[m.state] || { label: m.state, cls: "" };
    const dayExhausted = m.rpdUsed >= m.rpdLimit;
    const li = document.createElement("li");
    li.className = "model-row";
    li.title = m.detail || meta.label;
    li.innerHTML =
      `<div class="model-row-top">` +
      `<span class="model-tier">${m.tier}${m.role === "primary" ? ' <em>primary</em>' : ""}</span>` +
      `<span class="model-status ${dayExhausted ? "err" : meta.cls}">` +
      `${dayExhausted ? "Daily limit hit" : meta.label}</span>` +
      `</div>` +
      `<div class="model-id">${escapeHtml(m.id)}</div>` +
      `<div class="model-usage">` +
      miniBar("This min", m.rpmUsed, m.rpmLimit) +
      miniBar("Today", m.rpdUsed, m.rpdLimit) +
      `</div>`;
    els.modelList.appendChild(li);
  });
}

async function loadStatus() {
  try {
    renderStatus(await api("/api/status"));
  } catch {
    // transient; ignore
  }
}

async function refreshJobs() {
  try {
    const data = await api("/api/jobs");
    renderCapacity(data.capacity);
    renderJobs(data.jobs || []);
  } catch {
    // transient; ignore
  }
}

function watchJob(id) {
  if (state.jobSource) {
    state.jobSource.close();
    state.jobSource = null;
  }
  state.watchedJobId = id;
  state.lastProgress = null;
  els.logs.innerHTML = "";
  els.watching.textContent = `watching ${id}`;
  resetProgress();
  refreshJobs();

  const source = new EventSource(`/api/jobs/${id}/stream`);
  state.jobSource = source;
  source.addEventListener("log", (e) => appendLog(JSON.parse(e.data)));
  source.addEventListener("progress", (e) => {
    state.lastProgress = JSON.parse(e.data);
    renderProgress(state.lastProgress, "running");
  });
  source.addEventListener("status", (e) => {
    const s = JSON.parse(e.data);
    renderProgress(state.lastProgress, s.status);
    if (s.status === "done") {
      els.jobMeta.textContent = `Job ${id}: done. ${s.outputs.length} output(s).`;
    } else if (s.status === "error") {
      els.jobMeta.textContent = `Job ${id}: error - ${s.error || "unknown"}`;
    } else {
      els.jobMeta.textContent = `Job ${id}: ${s.status}...`;
    }
  });
  source.addEventListener("end", () => {
    source.close();
    if (state.jobSource === source) state.jobSource = null;
    refreshJobs();
    loadOutputs();
  });
  source.onerror = () => {
    source.close();
    if (state.jobSource === source) state.jobSource = null;
  };
}

async function startRun() {
  const campaignId = els.runCampaign.value;
  if (!campaignId) {
    els.jobMeta.textContent = "Add and save a campaign with an ID first.";
    return;
  }
  try {
    const variantIndex =
      els.runVariant.value === "" ? undefined : Number(els.runVariant.value);
    const hookIndex = els.runHook.value === "" ? undefined : Number(els.runHook.value);
    const data = await api("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        campaignId,
        count: Number(els.runCount.value) || 1,
        variantIndex,
        hookIndex,
        hookBubbleText: els.runHookBubbleText.value.trim() || undefined,
        randomSelection: els.runRandom.checked,
      }),
    });
    renderCapacity(data.capacity);
    els.jobMeta.textContent = `Started job ${data.job.id} (${data.job.status})`;
    watchJob(data.job.id);
  } catch (err) {
    els.jobMeta.textContent = err.message;
  }
}

async function loadOutputs() {
  const data = await api("/api/outputs");
  els.outputs.innerHTML = "";
  (data.outputs || []).forEach((o) => {
    const card = document.createElement("div");
    card.className = "output-card";
    const url = mediaUrl(o.path);
    card.innerHTML = `<video src="${url}#t=0.5" muted preload="metadata"></video><div class="o-name">${o.name}</div>`;
    card.addEventListener("click", () => openPreview(url, o.name));
    els.outputs.appendChild(card);
  });
}

function openPreview(url, name) {
  els.previewVideo.src = url;
  els.previewName.textContent = name;
  els.previewModal.classList.remove("hidden");
  els.previewVideo.play().catch(() => {});
}

function closePreview() {
  els.previewModal.classList.add("hidden");
  els.previewVideo.pause();
  els.previewVideo.src = "";
}

els.newCampaignBtn.addEventListener("click", () => {
  state.campaigns.push(blankCampaign());
  selectCampaign(state.campaigns.length - 1);
});

els.deleteBtn.addEventListener("click", () => {
  if (state.selectedIndex < 0) return;
  if (!confirm("Delete this campaign? Remember to Save.")) return;
  state.campaigns.splice(state.selectedIndex, 1);
  state.selectedIndex = -1;
  els.form.classList.add("hidden");
  els.emptyState.classList.remove("hidden");
  renderCampaignList();
  renderRunCampaigns();
});

els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  saveCampaigns();
});

els.runBtn.addEventListener("click", startRun);
els.runCampaign.addEventListener("change", renderRunVariants);
els.runVariant.addEventListener("change", renderRunHooks);
els.refreshOutputs.addEventListener("click", loadOutputs);
els.previewClose.addEventListener("click", closePreview);
els.previewModal.addEventListener("click", (e) => {
  if (e.target === els.previewModal) closePreview();
});

// ============================ NEW AD ============================
const newAd = {
  els: {
    name: document.getElementById("naName"),
    angle: document.getElementById("naAngle"),
    body: document.getElementById("naBody"),
    persona: document.getElementById("naPersona"),
    context: document.getElementById("naContext"),
    script: document.getElementById("naScript"),
    bubble: document.getElementById("naBubble"),
    maxSegments: document.getElementById("naMaxSegments"),
    speed: document.getElementById("naSpeed"),
    autoSplit: document.getElementById("naAutoSplit"),
    captions: document.getElementById("naCaptions"),
    overlays: document.getElementById("naOverlays"),
    overlayOpts: document.getElementById("naOverlayOpts"),
    overlayStyle: document.getElementById("naOverlayStyle"),
    overlaySource: document.getElementById("naOverlaySource"),
    maxOverlays: document.getElementById("naMaxOverlays"),
    runBtn: document.getElementById("naRunBtn"),
    jobMeta: document.getElementById("naJobMeta"),
    watching: document.getElementById("naWatching"),
    logs: document.getElementById("naLogs"),
    progressBadge: document.getElementById("naProgressBadge"),
    progressThumb: document.getElementById("naProgressThumb"),
    thumbPlaceholder: document.getElementById("naThumbPlaceholder"),
    progressImg: document.getElementById("naProgressImg"),
    progressSteps: document.getElementById("naProgressSteps"),
    progressInfo: document.getElementById("naProgressInfo"),
  },
  source: null,
  lastProgress: null,
};

function renderNewAdBody() {
  const prev = newAd.els.body.value;
  const opts = [
    '<option value="">None — stitch script clips into the full video</option>',
  ];
  state.assets.forEach((a) => {
    opts.push(
      `<option value="${assetRelPath(a.name)}">${escapeHtml(a.name)}</option>`,
    );
  });
  newAd.els.body.innerHTML = opts.join("");
  if (prev) newAd.els.body.value = prev;
}

function naSetSteps(activePhase, allDone) {
  const reached =
    activePhase === "run-done" ? PHASE_ORDER.length : PHASE_ORDER.indexOf(activePhase);
  newAd.els.progressSteps.querySelectorAll("li").forEach((li, i) => {
    li.classList.remove("active", "done");
    if (allDone || i < reached) li.classList.add("done");
    else if (i === reached) li.classList.add("active");
  });
}

function naResetProgress() {
  newAd.els.progressBadge.textContent = "Idle";
  newAd.els.progressBadge.className = "badge idle";
  newAd.els.progressImg.hidden = true;
  newAd.els.progressImg.removeAttribute("src");
  newAd.els.thumbPlaceholder.hidden = false;
  newAd.els.progressThumb.classList.remove("loading");
  naSetSteps(null, false);
  newAd.els.progressInfo.innerHTML =
    '<p class="progress-empty">Write a script above and generate to watch it here.</p>';
}

function naRenderProgress(p, status) {
  if (status === "done") {
    newAd.els.progressBadge.textContent = "Done";
    newAd.els.progressBadge.className = "badge done";
    naSetSteps("run-done", true);
    newAd.els.progressThumb.classList.remove("loading");
  } else if (status === "error") {
    newAd.els.progressBadge.textContent = "Error";
    newAd.els.progressBadge.className = "badge error";
    newAd.els.progressThumb.classList.remove("loading");
  } else if (status === "queued") {
    newAd.els.progressBadge.textContent = "Queued";
    newAd.els.progressBadge.className = "badge queued";
  }

  if (!p) {
    if (status === "running") {
      newAd.els.progressBadge.textContent = "Starting";
      newAd.els.progressBadge.className = "badge running";
    }
    return;
  }

  if (status === "running") {
    newAd.els.progressBadge.textContent = PHASE_LABEL[p.phase] || "Working";
    newAd.els.progressBadge.className = "badge running";
    naSetSteps(p.phase, false);
    newAd.els.progressThumb.classList.toggle("loading", !p.imagePath);
  }

  if (p.imagePath) {
    const url = imageUrl(p.imagePath);
    if (newAd.els.progressImg.getAttribute("src") !== url) {
      newAd.els.progressImg.src = url;
    }
    newAd.els.progressImg.hidden = false;
    newAd.els.thumbPlaceholder.hidden = true;
  } else {
    newAd.els.progressImg.hidden = true;
    newAd.els.thumbPlaceholder.hidden = false;
  }

  const total = p.runTotal ? `Clip ${p.runIndex} / ${p.runTotal}` : `Clip #${p.runIndex}`;
  const rows = [];
  rows.push(`<div class="pi-row"><span>Progress</span><b>${total}</b></div>`);
  if (p.persona)
    rows.push(`<div class="pi-row"><span>Ad</span><b>${escapeHtml(p.persona)}</b></div>`);
  if (p.hook) rows.push(`<div class="pi-hook">"${escapeHtml(p.hook)}"</div>`);
  newAd.els.progressInfo.innerHTML = rows.join("");
}

function naWatchJob(id) {
  if (newAd.source) {
    newAd.source.close();
    newAd.source = null;
  }
  newAd.lastProgress = null;
  newAd.els.logs.innerHTML = "";
  newAd.els.watching.textContent = `watching ${id}`;
  naResetProgress();

  const source = new EventSource(`/api/jobs/${id}/stream`);
  newAd.source = source;
  source.addEventListener("log", (e) => {
    const line = JSON.parse(e.data);
    const div = document.createElement("div");
    div.className = `l-${line.level}`;
    div.textContent = line.message;
    newAd.els.logs.appendChild(div);
    newAd.els.logs.scrollTop = newAd.els.logs.scrollHeight;
  });
  source.addEventListener("progress", (e) => {
    newAd.lastProgress = JSON.parse(e.data);
    naRenderProgress(newAd.lastProgress, "running");
  });
  source.addEventListener("status", (e) => {
    const s = JSON.parse(e.data);
    naRenderProgress(newAd.lastProgress, s.status);
    if (s.status === "done") {
      newAd.els.jobMeta.textContent = `Job ${id}: done. ${s.outputs.length} output(s).`;
    } else if (s.status === "error") {
      newAd.els.jobMeta.textContent = `Job ${id}: error - ${s.error || "unknown"}`;
    } else {
      newAd.els.jobMeta.textContent = `Job ${id}: ${s.status}...`;
    }
  });
  source.addEventListener("end", () => {
    source.close();
    if (newAd.source === source) newAd.source = null;
    refreshJobs();
    loadOutputs();
  });
  source.onerror = () => {
    source.close();
    if (newAd.source === source) newAd.source = null;
  };
}

async function startNewAd() {
  const name = newAd.els.name.value.trim();
  const script = newAd.els.script.value.trim();
  if (!name) {
    newAd.els.jobMeta.textContent = "Add a topic / vertical name first.";
    return;
  }
  if (!script) {
    newAd.els.jobMeta.textContent = "Write a script first.";
    return;
  }
  newAd.els.runBtn.disabled = true;
  newAd.els.jobMeta.textContent = "Starting…";
  try {
    const data = await api("/api/full-ad", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        script,
        angle: newAd.els.angle.value.trim() || undefined,
        promptContext: newAd.els.context.value.trim() || undefined,
        personaPrompt: newAd.els.persona.value.trim() || undefined,
        hookBubbleText: newAd.els.bubble.value.trim() || undefined,
        bodyVideo: newAd.els.body.value || undefined,
        speed: Number(newAd.els.speed.value) || undefined,
        autoSplit: newAd.els.autoSplit.checked,
        maxSegments: Number(newAd.els.maxSegments.value) || undefined,
        captionsEnabled: newAd.els.captions.checked,
        overlays: newAd.els.overlays.checked,
        overlayStyle: newAd.els.overlayStyle.value,
        overlaySource: newAd.els.overlaySource.value,
        maxOverlays: Number(newAd.els.maxOverlays.value) || undefined,
        backend: "browser",
      }),
    });
    renderCapacity(data.capacity);
    newAd.els.jobMeta.textContent = `Started job ${data.job.id} (${data.job.status})`;
    naWatchJob(data.job.id);
    refreshJobs();
  } catch (err) {
    newAd.els.jobMeta.textContent = err.message;
  } finally {
    newAd.els.runBtn.disabled = false;
  }
}

newAd.els.runBtn.addEventListener("click", startNewAd);
newAd.els.overlays.addEventListener("change", () => {
  newAd.els.overlayOpts.style.display = newAd.els.overlays.checked ? "flex" : "none";
});

// ============================ IMAGE ADS ============================
const imageAds = {
  els: {
    files: document.getElementById("iaFiles"),
    thumbs: document.getElementById("iaThumbs"),
    vertical: document.getElementById("iaVertical"),
    angle: document.getElementById("iaAngle"),
    count: document.getElementById("iaCount"),
    mode: document.getElementById("iaMode"),
    runBtn: document.getElementById("iaRunBtn"),
    jobMeta: document.getElementById("iaJobMeta"),
    watching: document.getElementById("iaWatching"),
    logs: document.getElementById("iaLogs"),
    progressBadge: document.getElementById("iaProgressBadge"),
    progressThumb: document.getElementById("iaProgressThumb"),
    thumbPlaceholder: document.getElementById("iaThumbPlaceholder"),
    progressImg: document.getElementById("iaProgressImg"),
    progressInfo: document.getElementById("iaProgressInfo"),
    results: document.getElementById("iaResults"),
  },
  winners: [],
  results: [],
  source: null,
};

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

function iaRenderThumbs() {
  if (imageAds.winners.length === 0) {
    imageAds.els.thumbs.innerHTML = "";
    return;
  }
  imageAds.els.thumbs.innerHTML = imageAds.winners
    .map(
      (w, i) =>
        `<div class="output-card"><img src="${imageUrl(w)}" alt="winner" loading="lazy" />` +
        `<button class="btn small ghost" data-ia-remove="${i}">Remove</button></div>`,
    )
    .join("");
  imageAds.els.thumbs.querySelectorAll("[data-ia-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      imageAds.winners.splice(Number(btn.dataset.iaRemove), 1);
      iaRenderThumbs();
    });
  });
}

function iaRenderResults() {
  if (imageAds.results.length === 0) {
    imageAds.els.results.innerHTML =
      '<p class="progress-empty">Generated image ads will appear here.</p>';
    return;
  }
  imageAds.els.results.innerHTML = imageAds.results
    .map(
      (p) =>
        `<a class="output-card" href="${imageUrl(p)}" download>` +
        `<img src="${imageUrl(p)}" alt="ad" loading="lazy" /><div class="o-name">download</div></a>`,
    )
    .join("");
}

async function loadImageAdResults() {
  try {
    const data = await api("/api/image-ads/results");
    const all = data.results || [];
    // Group by vertical (the top output folder) and show only the most recent
    // vertical so old batches (e.g. bathrooms) don't clutter the grid.
    const wanted = imageAds.els.vertical.value.trim().toLowerCase();
    const vertOf = (r) => (r.name || "").split("/")[0];
    const norm = (s) => s.replace(/[^a-z0-9]+/gi, "").toLowerCase();
    let group = all;
    if (wanted) {
      group = all.filter((r) => norm(vertOf(r)).includes(norm(wanted)));
    }
    if (group.length === 0 && all.length > 0) {
      const newest = vertOf(all[0]);
      group = all.filter((r) => vertOf(r) === newest);
    }
    imageAds.results = group.map((r) => r.path);
    iaRenderResults();
  } catch {
    // best-effort; keep whatever is already shown
  }
}

async function iaUploadFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  imageAds.els.jobMeta.textContent = `Uploading ${files.length} image(s)…`;
  for (const file of files) {
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const data = await api("/api/image-ads/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, dataBase64: dataUrl }),
      });
      imageAds.winners.push(data.path);
    } catch (err) {
      imageAds.els.jobMeta.textContent = `Upload failed: ${err.message}`;
    }
  }
  imageAds.els.jobMeta.textContent = `${imageAds.winners.length} winner(s) ready.`;
  imageAds.els.files.value = "";
  iaRenderThumbs();
}

function iaWatchJob(id) {
  if (imageAds.source) {
    imageAds.source.close();
    imageAds.source = null;
  }
  imageAds.els.logs.innerHTML = "";
  imageAds.els.watching.textContent = `watching ${id}`;
  imageAds.els.progressBadge.textContent = "Queued";
  imageAds.els.progressBadge.className = "badge queued";

  const source = new EventSource(`/api/jobs/${id}/stream`);
  imageAds.source = source;
  source.addEventListener("log", (e) => {
    const line = JSON.parse(e.data);
    const div = document.createElement("div");
    div.className = `l-${line.level}`;
    div.textContent = line.message;
    imageAds.els.logs.appendChild(div);
    imageAds.els.logs.scrollTop = imageAds.els.logs.scrollHeight;
  });
  source.addEventListener("progress", (e) => {
    const p = JSON.parse(e.data);
    if (!p) return;
    imageAds.els.progressBadge.textContent = p.runTotal
      ? `${p.runIndex} / ${p.runTotal}`
      : "Working";
    imageAds.els.progressBadge.className = "badge running";
    if (p.imagePath) {
      imageAds.els.progressImg.src = imageUrl(p.imagePath);
      imageAds.els.progressImg.hidden = false;
      imageAds.els.thumbPlaceholder.hidden = true;
      // Show each finished variation in the results grid as it lands.
      if (p.phase === "image" && !imageAds.results.includes(p.imagePath)) {
        imageAds.results.push(p.imagePath);
        iaRenderResults();
      }
    }
    const rows = [];
    rows.push(
      `<div class="pi-row"><span>Progress</span><b>${p.runTotal ? `${p.runIndex} / ${p.runTotal}` : p.runIndex}</b></div>`,
    );
    if (p.hook) rows.push(`<div class="pi-hook">"${escapeHtml(p.hook)}"</div>`);
    imageAds.els.progressInfo.innerHTML = rows.join("");
  });
  source.addEventListener("status", (e) => {
    const s = JSON.parse(e.data);
    if (s.status === "done") {
      imageAds.els.progressBadge.textContent = "Done";
      imageAds.els.progressBadge.className = "badge done";
      loadImageAdResults();
      imageAds.els.jobMeta.textContent = `Job ${id}: done. ${s.outputs.length} image(s).`;
    } else if (s.status === "error") {
      imageAds.els.progressBadge.textContent = "Error";
      imageAds.els.progressBadge.className = "badge error";
      imageAds.els.jobMeta.textContent = `Job ${id}: error - ${s.error || "unknown"}`;
    }
  });
  source.addEventListener("end", () => {
    source.close();
    if (imageAds.source === source) imageAds.source = null;
    refreshJobs();
  });
  source.onerror = () => {
    source.close();
    if (imageAds.source === source) imageAds.source = null;
  };
}

async function startImageAds() {
  if (imageAds.winners.length === 0) {
    imageAds.els.jobMeta.textContent = "Upload at least one winner image first.";
    return;
  }
  imageAds.els.runBtn.disabled = true;
  imageAds.els.jobMeta.textContent = "Starting…";
  try {
    const data = await api("/api/image-ads/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        winners: imageAds.winners,
        vertical: imageAds.els.vertical.value.trim() || undefined,
        angle: imageAds.els.angle.value.trim() || undefined,
        count: Number(imageAds.els.count.value) || undefined,
        mode: imageAds.els.mode.value,
      }),
    });
    renderCapacity(data.capacity);
    imageAds.els.jobMeta.textContent = `Started job ${data.job.id} (${data.job.status})`;
    iaWatchJob(data.job.id);
    refreshJobs();
  } catch (err) {
    imageAds.els.jobMeta.textContent = err.message;
  } finally {
    imageAds.els.runBtn.disabled = false;
  }
}

imageAds.els.files.addEventListener("change", (e) => iaUploadFiles(e.target.files));
imageAds.els.runBtn.addEventListener("click", startImageAds);

// ============================ SPY ============================
const spy = {
  els: {
    badge: document.getElementById("spyBadge"),
    counts: document.getElementById("spyCounts"),
    addForm: document.getElementById("spyAddForm"),
    pageInput: document.getElementById("spyPageInput"),
    pageLabel: document.getElementById("spyPageLabel"),
    pageList: document.getElementById("spyPageList"),
    crawlBtn: document.getElementById("spyCrawlBtn"),
    crawlStatus: document.getElementById("spyCrawlStatus"),
    logs: document.getElementById("spyLogs"),
    refreshBtn: document.getElementById("spyRefreshBtn"),
    suggestions: document.getElementById("spySuggestions"),
  },
  crawlSource: null,
  lastRunning: false,
};

function bodyVideoOptions(selectedFirst) {
  const opts = state.assets
    .map((a) => `<option value="${assetRelPath(a.name)}">${escapeHtml(a.name)}</option>`)
    .join("");
  return opts || `<option value="">(add a body video to assets/)</option>`;
}

async function loadSpyState() {
  try {
    const data = await api("/api/spy/state");
    renderSpyPages(data.pages || []);
    const pending = data.counts?.suggestions ?? 0;
    spy.els.counts.textContent =
      `${data.counts?.ads ?? 0} ads · ${pending} suggestion${pending === 1 ? "" : "s"}`;
    if (spy.els.badge) {
      spy.els.badge.hidden = pending === 0;
      spy.els.badge.textContent = String(pending);
    }
    const c = data.crawl || {};
    const auto =
      data.autoCrawlMinutes > 0 ? `Auto-tracking every ${data.autoCrawlMinutes}m` : "";
    if (c.running) {
      spy.els.crawlStatus.textContent = "Crawling…";
      spy.els.crawlBtn.disabled = true;
    } else {
      spy.els.crawlBtn.disabled = false;
      const last = c.summary
        ? `Last: ${c.summary.adsFound} ads, ${c.summary.winners} winners`
        : c.error
          ? `Error: ${c.error}`
          : "";
      spy.els.crawlStatus.textContent = [auto, last].filter(Boolean).join(" · ");
    }
    // A background (auto) crawl just finished — pull fresh suggestions in.
    if (spy.lastRunning && !c.running) loadSuggestions();
    spy.lastRunning = !!c.running;
  } catch (err) {
    spy.els.crawlStatus.textContent = err.message;
  }
}

function spyPageLabel(p) {
  const l = (p.label || "").trim();
  if (l && !/^https?:\/\//i.test(l)) return l;
  try {
    const u = new URL(p.input);
    const id = u.searchParams.get("view_all_page_id");
    if (id) return `Page ${id}`;
    const q = u.searchParams.get("q");
    if (q) return q;
  } catch {
    /* not a url */
  }
  if (/^\d{5,}$/.test(p.input)) return `Page ${p.input}`;
  return l || p.input;
}

function renderSpyPages(pages) {
  spy.els.pageList.innerHTML = "";
  if (!pages.length) {
    spy.els.pageList.innerHTML =
      `<li class="spy-page-empty">No pages tracked yet.</li>`;
    return;
  }
  pages.forEach((p) => {
    const li = document.createElement("li");
    const last = p.lastCrawledAt
      ? `${p.lastAdCount ?? 0} ads · ${new Date(p.lastCrawledAt).toLocaleDateString()}`
      : "not crawled yet";
    li.innerHTML =
      `<div class="sp-main"><b>${escapeHtml(spyPageLabel(p))}</b><span>${escapeHtml(p.input)}</span></div>` +
      `<div class="sp-meta">${last}</div>` +
      `<button class="btn tiny danger ghost" data-id="${p.id}">Remove</button>`;
    li.querySelector("button").addEventListener("click", () => removeSpyPage(p.id));
    spy.els.pageList.appendChild(li);
  });
}

async function addSpyPage(e) {
  e.preventDefault();
  const input = spy.els.pageInput.value.trim();
  if (!input) return;
  try {
    await api("/api/spy/pages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input, label: spy.els.pageLabel.value.trim() || undefined }),
    });
    spy.els.pageInput.value = "";
    spy.els.pageLabel.value = "";
    loadSpyState();
  } catch (err) {
    spy.els.crawlStatus.textContent = err.message;
  }
}

async function removeSpyPage(id) {
  if (!confirm("Stop tracking this page?")) return;
  await api(`/api/spy/pages/${id}`, { method: "DELETE" });
  loadSpyState();
}

async function startCrawl() {
  try {
    spy.els.logs.innerHTML = "";
    spy.els.crawlBtn.disabled = true;
    spy.els.crawlStatus.textContent = "Starting…";
    await api("/api/spy/crawl", { method: "POST" });
    streamCrawl();
  } catch (err) {
    spy.els.crawlStatus.textContent = err.message;
    spy.els.crawlBtn.disabled = false;
  }
}

function streamCrawl() {
  if (spy.crawlSource) spy.crawlSource.close();
  const source = new EventSource("/api/spy/crawl/stream");
  spy.crawlSource = source;
  spy.els.crawlStatus.textContent = "Crawling…";
  source.addEventListener("log", (e) => {
    const line = JSON.parse(e.data);
    const div = document.createElement("div");
    div.className = `l-${line.level}`;
    div.textContent = line.message;
    spy.els.logs.appendChild(div);
    spy.els.logs.scrollTop = spy.els.logs.scrollHeight;
  });
  source.addEventListener("status", (e) => {
    const s = JSON.parse(e.data);
    if (!s.running) {
      spy.els.crawlBtn.disabled = false;
      if (s.summary) {
        spy.els.crawlStatus.textContent =
          `Done: ${s.summary.adsFound} ads, ${s.summary.winners} winners, ${s.summary.suggestions} suggestions`;
      } else if (s.error) {
        spy.els.crawlStatus.textContent = `Error: ${s.error}`;
      }
    }
  });
  source.addEventListener("end", () => {
    source.close();
    if (spy.crawlSource === source) spy.crawlSource = null;
    loadSpyState();
    loadSuggestions();
  });
  source.onerror = () => {
    source.close();
    if (spy.crawlSource === source) spy.crawlSource = null;
    loadSpyState();
  };
}

async function loadSuggestions() {
  try {
    const data = await api("/api/spy/suggestions");
    renderSuggestions(data.suggestions || []);
  } catch (err) {
    spy.els.suggestions.innerHTML = `<p class="progress-empty">${escapeHtml(err.message)}</p>`;
  }
}

function renderSuggestions(list) {
  const pending = list.filter((s) => s.status === "pending");
  if (!pending.length) {
    spy.els.suggestions.innerHTML =
      `<p class="progress-empty">No suggestions yet. Add a page and crawl.</p>`;
    return;
  }
  const groups = {};
  pending.forEach((s) => {
    (groups[s.vertical] = groups[s.vertical] || []).push(s);
  });
  spy.els.suggestions.innerHTML = "";
  Object.entries(groups)
    .sort((a, b) => b[1].length - a[1].length)
    .forEach(([vertical, items]) => {
      const section = document.createElement("div");
      section.className = "sug-group";
      section.innerHTML =
        `<div class="sug-group-head"><span class="sug-vertical">${escapeHtml(vertical)}</span>` +
        `<span class="sug-count">${items.length}</span></div>`;
      items
        .sort((a, b) => b.score - a.score)
        .forEach((s) => section.appendChild(suggestionCard(s)));
      spy.els.suggestions.appendChild(section);
    });
}

function suggestionCard(s) {
  const card = document.createElement("div");
  card.className = "sug-card";
  const ad = s.ad || {};
  const poster = ad.imageUrl
    ? `<img class="sug-thumb" src="${ad.imageUrl}" alt="" referrerpolicy="no-referrer" />`
    : `<div class="sug-thumb empty">${ad.mediaType === "video" ? "▶" : "—"}</div>`;
  const evidence =
    `<span class="ev">${s.evidence.runDays}d running</span>` +
    (s.evidence.copyCount > 1 ? `<span class="ev">${s.evidence.copyCount} copies</span>` : "") +
    `<span class="ev ${s.evidence.active ? "live" : ""}">${s.evidence.active ? "active" : "inactive"}</span>` +
    `<span class="ev score">score ${s.score}</span>`;
  card.innerHTML =
    `<div class="sug-top">${poster}` +
    `<div class="sug-body">` +
    `<div class="sug-meta">${escapeHtml(s.pageName)}</div>` +
    `<div class="sug-evidence">${evidence}</div>` +
    `<p class="sug-text">${escapeHtml(s.sampleText.slice(0, 220))}</p>` +
    (ad.snapshotUrl ? `<a class="sug-link" href="${ad.snapshotUrl}" target="_blank" rel="noreferrer">View on Meta ↗</a>` : "") +
    `</div></div>` +
    `<div class="sug-actions">` +
    `<select class="sug-body-video">${bodyVideoOptions()}</select>` +
    `<input class="sug-count-input" type="number" min="1" value="3" title="How many to generate" />` +
    `<button class="btn primary small sug-approve">Hook + body</button>` +
    `<button class="btn small sug-remake" title="Recreate the entire ad from scratch (no body video needed)">Remake full video</button>` +
    `<button class="btn small ghost sug-dismiss">Dismiss</button>` +
    `</div><div class="sug-result"></div>`;

  card.querySelector(".sug-approve").addEventListener("click", () =>
    approveSuggestion(s.id, card),
  );
  card.querySelector(".sug-remake").addEventListener("click", () =>
    remakeSuggestion(s.id, card),
  );
  card.querySelector(".sug-dismiss").addEventListener("click", () =>
    dismissSuggestion(s.id),
  );
  return card;
}

async function remakeSuggestion(id, card) {
  const result = card.querySelector(".sug-result");
  const btn = card.querySelector(".sug-remake");
  btn.disabled = true;
  result.textContent =
    "Remaking the FULL ad: downloading, transcribing, splitting into segments, generating each…";
  try {
    const data = await api(`/api/spy/suggestions/${id}/remake`, { method: "POST" });
    result.innerHTML =
      `Full remake queued as job <code>${escapeHtml(data.job.id)}</code>. ` +
      `<a href="#" class="sug-watch">Watch job →</a>`;
    card.classList.add("approved");
    const watch = result.querySelector(".sug-watch");
    if (watch && data.job) {
      watch.addEventListener("click", (e) => {
        e.preventDefault();
        document.querySelector('.tab[data-tab="generate"]').click();
        watchJob(data.job.id);
      });
    }
    refreshJobs();
  } catch (err) {
    result.textContent = err.message;
    btn.disabled = false;
  }
}

async function approveSuggestion(id, card) {
  const bodyVideo = card.querySelector(".sug-body-video").value;
  const count = Number(card.querySelector(".sug-count-input").value) || 3;
  const result = card.querySelector(".sug-result");
  const btn = card.querySelector(".sug-approve");
  if (!bodyVideo) {
    result.textContent = "Pick a body video first.";
    return;
  }
  btn.disabled = true;
  result.textContent = "Downloading winner, transcribing, drafting hooks…";
  try {
    const data = await api(`/api/spy/suggestions/${id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bodyVideo, count }),
    });
    result.innerHTML =
      `Queued <b>${count}</b> video(s) on campaign <code>${escapeHtml(data.campaignId)}</code>. ` +
      `<a href="#" class="sug-watch">Watch job →</a>`;
    card.classList.add("approved");
    const watch = result.querySelector(".sug-watch");
    if (watch && data.job) {
      watch.addEventListener("click", (e) => {
        e.preventDefault();
        document.querySelector('.tab[data-tab="generate"]').click();
        watchJob(data.job.id);
      });
    }
    loadConfig();
    refreshJobs();
  } catch (err) {
    result.textContent = err.message;
    btn.disabled = false;
  }
}

async function dismissSuggestion(id) {
  await api(`/api/spy/suggestions/${id}/dismiss`, { method: "POST" });
  loadSuggestions();
  loadSpyState();
}

function setupTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab"));
  const views = {
    generate: document.getElementById("view-generate"),
    newad: document.getElementById("view-newad"),
    imageads: document.getElementById("view-imageads"),
    campaigns: document.getElementById("view-campaigns"),
    spy: document.getElementById("view-spy"),
  };
  function show(name) {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    Object.entries(views).forEach(([key, el]) => {
      if (el) el.classList.toggle("hidden", key !== name);
    });
    if (name === "spy") {
      loadSpyState();
      loadSuggestions();
    }
    if (name === "imageads") {
      loadImageAdResults();
    }
  }
  tabs.forEach((t) => t.addEventListener("click", () => show(t.dataset.tab)));
}

spy.els.addForm.addEventListener("submit", addSpyPage);
spy.els.crawlBtn.addEventListener("click", startCrawl);
spy.els.refreshBtn.addEventListener("click", async () => {
  try {
    await api("/api/spy/suggestions/rebuild", { method: "POST" });
  } catch {
    // rebuild is best-effort; still reload what we have
  }
  loadSpyState();
  loadSuggestions();
});

async function init() {
  setupTabs();
  try {
    await loadAssets();
    renderNewAdBody();
    await loadConfig();
    await loadOutputs();
    await refreshJobs();
    await loadStatus();
    await loadSpyState();
    setInterval(refreshJobs, 3000);
    setInterval(loadStatus, 3000);
    setInterval(loadSpyState, 8000);
  } catch (err) {
    els.jobMeta.textContent = `Init error: ${err.message}`;
  }
}

init();
