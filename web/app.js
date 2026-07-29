import { createViewer } from "./viewer.js";

const $ = (id) => document.getElementById(id);
const sidebar = $("sidebar");
const statusDot = $("statusDot");
const statusText = $("statusText");
const viewportHud = $("viewportHud");
const frustaToggle = $("frustaToggle");
const frustaCheckbox = $("frustaCheckbox");
const fileInput = $("fileInput");

const viewer = createViewer($("canvas"));

const STAGES = ["frames", "poses", "train", "export"];
const STAGE_LABEL = { frames: "Frames", poses: "Poses", train: "Train", export: "Export" };

let jobId = null;
let es = null;
let selectedFile = null;
let currentPanel = null; // 'idle' | 'running' | 'done' | 'error'
let els = {}; // cached refs into the currently-mounted panel
let seenFrames = new Set();
let lastSparseUrl = null;
let lastCheckpointUrl = null;
let checkpointCount = 0;
let lastCamerasCount = 0;

frustaCheckbox.addEventListener("change", () => viewer.setFrustaVisible(frustaCheckbox.checked));

function humanSize(bytes) {
  if (bytes == null) return "";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes, u = 0;
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u++; }
  return `${n.toFixed(u === 0 ? 0 : 1)} ${units[u]}`;
}

function setStatusPill(stage) {
  statusText.textContent = (stage || "idle").toUpperCase();
  statusDot.className = "dot" + (
    stage === "done" ? " good" :
    stage === "error" || stage === "cancelled" ? " bad" :
    STAGES.includes(stage) ? " active" : ""
  );
}

// ---------------------------------------------------------------- mounting --
function mount(panel) {
  currentPanel = panel;
  if (panel === "idle") mountIdle();
  else if (panel === "running") mountRunning();
  else if (panel === "done") mountDone();
  else if (panel === "error") mountError();
}

function mountIdle() {
  sidebar.innerHTML = `
    <div class="eyebrow">new reconstruction</div>
    <div class="dropzone" id="dropzone" tabindex="0">
      <div class="glyph">⌁</div>
      <div class="hint">Drop a video, or click to browse</div>
      <div class="sub">MP4 · MOV · WEBM</div>
    </div>
    <div id="videoPreviewSlot"></div>
    <div class="field">
      <label>Preset</label>
      <select id="presetSelect">
        <option value="preview">Preview — ~8 min</option>
        <option value="high" selected>High — ~14 min</option>
        <option value="max">Max — ~1 h</option>
      </select>
    </div>
    <div class="field">
      <label>Pose backend</label>
      <select id="poseSelect">
        <option value="colmap" selected>COLMAP — best quality</option>
        <option value="da3">Depth Anything 3 — fast, experimental</option>
      </select>
    </div>
    <button class="btn btn-primary" id="startBtn" disabled>Start reconstruction</button>
    <div class="inline-msg" id="startMsg"></div>
  `;
  els = {
    dropzone: $("dropzone"),
    previewSlot: $("videoPreviewSlot"),
    presetSelect: $("presetSelect"),
    poseSelect: $("poseSelect"),
    startBtn: $("startBtn"),
    startMsg: $("startMsg"),
  };
  els.dropzone.addEventListener("click", () => fileInput.click());
  els.dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
  els.dropzone.addEventListener("dragover", (e) => { e.preventDefault(); els.dropzone.classList.add("drag"); });
  els.dropzone.addEventListener("dragleave", () => els.dropzone.classList.remove("drag"));
  els.dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("drag");
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.onchange = () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); };
  els.startBtn.addEventListener("click", startJob);
  if (selectedFile) renderVideoPreview();
}

function handleFile(file) {
  if (!file.type.startsWith("video/")) {
    els.startMsg.textContent = "That doesn't look like a video file.";
    return;
  }
  els.startMsg.textContent = "";
  selectedFile = file;
  renderVideoPreview();
}

function renderVideoPreview() {
  els.previewSlot.innerHTML = `
    <div class="video-preview">
      <video src="${URL.createObjectURL(selectedFile)}" muted loop autoplay playsinline></video>
    </div>
    <div class="video-meta"><span>${selectedFile.name} · ${humanSize(selectedFile.size)}</span><button id="clearBtn">remove</button></div>
  `;
  $("clearBtn").addEventListener("click", () => { selectedFile = null; els.previewSlot.innerHTML = ""; els.startBtn.disabled = true; });
  els.startBtn.disabled = false;
}

function mountRunning() {
  sidebar.innerHTML = `
    <div class="eyebrow">reconstruction in progress</div>
    <div class="stage-tracker" id="stageTracker">
      ${STAGES.map((s) => `
        <div class="stage-row" data-stage="${s}">
          <span class="dot"></span>
          <span class="label">${STAGE_LABEL[s]}</span>
          <span class="detail" data-detail="${s}"></span>
        </div>`).join("")}
    </div>
    <div class="progress-track"><div class="progress-fill" id="progressFill"></div></div>
    <div class="status-msg" id="statusMsg">—</div>
    <div id="filmstripSlot"></div>
    <hr class="hr" />
    <button class="btn btn-danger" id="cancelBtn">Cancel job</button>
  `;
  els = {
    tracker: $("stageTracker"),
    progressFill: $("progressFill"),
    statusMsg: $("statusMsg"),
    filmstripSlot: $("filmstripSlot"),
    cancelBtn: $("cancelBtn"),
  };
  els.cancelBtn.addEventListener("click", () => {
    els.cancelBtn.disabled = true;
    els.cancelBtn.textContent = "Cancelling…";
    fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" }).catch(() => {});
  });
  frustaToggle.hidden = false;
}

function mountDone() {
  sidebar.innerHTML = `
    <div class="eyebrow">reconstruction complete</div>
    <h2 class="panel-title">Scene ready</h2>
    <div class="artifact-list" id="artifactList"></div>
    <hr class="hr" />
    <button class="btn" id="newVideoBtn">New video</button>
  `;
  els = { artifactList: $("artifactList") };
  $("newVideoBtn").addEventListener("click", resetToIdle);
}

function mountError() {
  sidebar.innerHTML = `
    <div class="eyebrow" id="errorEyebrow">error</div>
    <h2 class="panel-title" id="errorTitle">Something went wrong</h2>
    <div class="center-note" id="errorMsg"></div>
    <button class="btn" id="resetBtn">Reset</button>
  `;
  els = { title: $("errorTitle"), msg: $("errorMsg"), eyebrow: $("errorEyebrow") };
  $("resetBtn").addEventListener("click", resetToIdle);
}

// ------------------------------------------------------------- updating ----
function updateRunning(state) {
  const idx = STAGES.indexOf(state.stage);
  els.tracker.querySelectorAll(".stage-row").forEach((row) => {
    const s = row.dataset.stage;
    const i = STAGES.indexOf(s);
    row.classList.toggle("done", idx > i || state.stage === "done");
    row.classList.toggle("active", idx === i);
  });
  const detail = els.tracker.querySelector('[data-detail="frames"]');
  if (state.frames?.count) detail.textContent = `${state.frames.count}`;
  const trainDetail = els.tracker.querySelector('[data-detail="train"]');
  if (state.checkpoint) trainDetail.textContent = `${state.checkpoint.step.toLocaleString()} / ${state.checkpoint.total_steps.toLocaleString()}`;

  els.progressFill.style.width = `${Math.round((state.progress || 0) * 100)}%`;
  els.statusMsg.textContent = state.message || "";

  const samples = state.frames?.sample || [];
  if (samples.length) {
    if (!els.filmstripSlot.querySelector(".filmstrip")) {
      els.filmstripSlot.innerHTML = `<div class="filmstrip" id="filmstrip"></div>`;
      els.filmstrip = $("filmstrip");
    }
    for (const src of samples) {
      if (seenFrames.has(src)) continue;
      seenFrames.add(src);
      const img = document.createElement("img");
      img.src = src;
      img.loading = "lazy";
      els.filmstrip.appendChild(img);
    }
  }
}

function updateDone(state) {
  els.artifactList.innerHTML = (state.artifacts || []).map((a) => `
    <div class="artifact">
      <div><div class="name">${a.name}</div><div class="size">${humanSize(a.bytes)}</div></div>
      <a class="btn" href="${a.url}" download>Download</a>
    </div>
  `).join("") || `<div class="center-note">No artifacts listed.</div>`;
}

function updateError(state) {
  const cancelled = state.stage === "cancelled";
  els.eyebrow.textContent = cancelled ? "cancelled" : "error";
  els.title.textContent = cancelled ? "Job cancelled" : "Reconstruction failed";
  els.msg.textContent = state.error || state.message || (cancelled ? "The job was cancelled." : "An unknown error occurred.");
}

function updateViewer(state) {
  if (state.sparse_url && state.sparse_url !== lastSparseUrl) {
    lastSparseUrl = state.sparse_url;
    viewer.loadSparse(state.sparse_url);
  }
  if (state.cameras && state.cameras.length && state.cameras.length !== lastCamerasCount) {
    lastCamerasCount = state.cameras.length;
    viewer.setCameras(state.cameras);
  }
  if (state.checkpoint && state.checkpoint.url !== lastCheckpointUrl) {
    lastCheckpointUrl = state.checkpoint.url;
    checkpointCount++;
    viewer.loadCheckpoint(state.checkpoint.url);
  }
  viewportHud.innerHTML = state.checkpoint
    ? `<div class="line">checkpoint <b>${checkpointCount}</b></div><div class="line">step <b>${state.checkpoint.step.toLocaleString()}</b> / ${state.checkpoint.total_steps.toLocaleString()}</div>`
    : "";
}

// --------------------------------------------------------------- driving ---
function render(state) {
  setStatusPill(state.stage);
  const panel = state.stage === "done" ? "done" : state.stage === "error" || state.stage === "cancelled" ? "error" : "running";
  if (panel !== currentPanel) mount(panel);
  if (panel === "running") updateRunning(state);
  else if (panel === "done") updateDone(state);
  else updateError(state);
  updateViewer(state);
  if (["done", "error", "cancelled"].includes(state.stage) && es) { es.close(); es = null; }
}

function connectEvents(id) {
  if (es) es.close();
  es = new EventSource(`/api/jobs/${id}/events`);
  es.addEventListener("state", (e) => render(JSON.parse(e.data)));
  es.addEventListener("open", () => {
    fetch(`/api/jobs/${id}`).then((r) => r.json()).then(render).catch(() => {});
  });
  es.addEventListener("error", () => { /* browser retries automatically */ });
}

function startJob() {
  if (!selectedFile) return;
  els.startBtn.disabled = true;
  els.startMsg.textContent = "";
  const form = new FormData();
  form.append("video", selectedFile);
  form.append("preset", els.presetSelect.value);
  form.append("pose_backend", els.poseSelect.value);
  fetch("/api/jobs", { method: "POST", body: form })
    .then(async (r) => {
      if (r.status === 409) throw new Error("A job is already running.");
      if (!r.ok) throw new Error(`Failed to start job (${r.status}).`);
      return r.json();
    })
    .then(({ job_id }) => {
      jobId = job_id;
      sessionStorage.setItem("vts_job", job_id);
      seenFrames = new Set();
      lastSparseUrl = null;
      lastCheckpointUrl = null;
      checkpointCount = 0;
      lastCamerasCount = 0;
      mount("running");
      setStatusPill("frames");
      connectEvents(job_id);
    })
    .catch((err) => {
      els.startBtn.disabled = false;
      els.startMsg.textContent = err.message;
    });
}

function resetToIdle() {
  if (es) { es.close(); es = null; }
  sessionStorage.removeItem("vts_job");
  jobId = null;
  selectedFile = null;
  seenFrames = new Set();
  lastSparseUrl = null;
  lastCheckpointUrl = null;
  checkpointCount = 0;
  lastCamerasCount = 0;
  frustaToggle.hidden = true;
  frustaCheckbox.checked = true;
  viewer.setFrustaVisible(true);
  viewportHud.innerHTML = "";
  viewer.reset();
  mount("idle");
  setStatusPill("idle");
}

// ------------------------------------------------------------------- init --
(async function init() {
  let saved = sessionStorage.getItem("vts_job");
  if (!saved) {
    // attach to a job started elsewhere (another tab, or via the API)
    try {
      const { job_id } = await (await fetch("/api/jobs/active")).json();
      if (job_id) saved = job_id;
    } catch { /* older server without the endpoint */ }
  }
  if (saved) {
    jobId = saved;
    sessionStorage.setItem("vts_job", saved);
    mount("running");
    connectEvents(saved);
  } else {
    mount("idle");
  }
})();
