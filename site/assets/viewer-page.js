// Standalone splat viewer: drop a file, fly through it. Nothing is uploaded —
// files are read straight into the page as blob URLs.
import { createViewer, fileTypeFor, FILE_TYPES } from "./viewer.js";

const DEMO_URL = "./scenes/home.sog";

const canvas = document.getElementById("canvas");
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileRow = document.getElementById("fileRow");
const fileName = document.getElementById("fileName");
const fileSize = document.getElementById("fileSize");
const clearBtn = document.getElementById("clearBtn");
const demoBtn = document.getElementById("demoBtn");
const statusMsg = document.getElementById("statusMsg");
const errorMsg = document.getElementById("errorMsg");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const progressTrack = document.getElementById("progressTrack");
const progressFill = document.getElementById("progressFill");
const hud = document.getElementById("hud");

let viewer = null;
let currentUrl = null;

function setStatus(state, text, message) {
  statusDot.className = `dot ${state}`;
  statusText.textContent = text;
  if (message !== undefined) statusMsg.textContent = message;
}

function setError(text) {
  errorMsg.textContent = text || "";
  if (text) setStatus("bad", "ERROR");
}

function humanSize(bytes) {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${(bytes / (1 << 10)).toFixed(0)} KB`;
  return `${bytes} B`;
}

function showProgress(frac) {
  progressTrack.hidden = false;
  progressFill.style.width = `${Math.round(frac * 100)}%`;
}

function hideProgress() {
  progressTrack.hidden = true;
  progressFill.style.width = "0%";
}

function releaseCurrent() {
  if (currentUrl) {
    const stale = currentUrl;
    currentUrl = null;
    setTimeout(() => URL.revokeObjectURL(stale), 30_000);
  }
}

async function show(blob, name, fileType) {
  setError("");
  setStatus("active", "LOADING", `Decoding ${name}…`);
  showProgress(1);

  releaseCurrent();
  currentUrl = URL.createObjectURL(blob);
  try {
    const mesh = await viewer.loadSplat(currentUrl, fileType);
    const count = mesh?.packedSplats?.numSplats ?? mesh?.numSplats;
    fileName.textContent = name;
    fileSize.textContent = humanSize(blob.size);
    fileRow.hidden = false;
    hud.innerHTML = count
      ? `<div class="line"><b>${count.toLocaleString()}</b> splats</div>`
      : "";
    setStatus("good", "READY", `${name} loaded.`);
  } catch (e) {
    console.error("splat load failed:", e);
    setError("Could not read that file — is it a splat export?");
    statusMsg.textContent = "Nothing loaded.";
    hud.innerHTML = "";
  } finally {
    hideProgress();
  }
}

async function openFile(file) {
  const fileType = fileTypeFor(file.name);
  if (!fileType) {
    setError("Unsupported file type. Try .ply, .spz, .sog, .splat or .ksplat.");
    return;
  }
  await show(file, file.name, fileType);
}

async function loadDemo() {
  setError("");
  setStatus("active", "LOADING", "Fetching the demo scene…");
  try {
    const res = await fetch(DEMO_URL);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const total = Number(res.headers.get("content-length")) || 0;
    let blob;
    if (res.body && total) {
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        showProgress(received / total);
      }
      blob = new Blob(chunks);
    } else {
      blob = await res.blob();
    }
    await show(blob, "home.sog", FILE_TYPES.sog);
  } catch (e) {
    console.error("demo scene failed:", e);
    setError("Demo scene failed to load.");
    hideProgress();
  }
}

function clearScene() {
  viewer.clear();
  releaseCurrent();
  fileRow.hidden = true;
  hud.innerHTML = "";
  setError("");
  setStatus("", "IDLE", "Nothing loaded yet.");
}

// --- wiring ------------------------------------------------------------------
try {
  viewer = createViewer(canvas);
} catch (e) {
  console.error(e);
  setError("WebGL is unavailable in this browser.");
}

if (viewer) {
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files?.[0]) openFile(fileInput.files[0]);
    fileInput.value = "";
  });

  // Accept a drop anywhere on the page, not just on the dropzone.
  for (const ev of ["dragenter", "dragover"]) {
    window.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("drag"); });
  }
  for (const ev of ["dragleave", "drop"]) {
    window.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === "dragleave" && e.relatedTarget) return; // ignore inner-element churn
      dropzone.classList.remove("drag");
    });
  }
  window.addEventListener("drop", (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) openFile(file);
  });

  clearBtn.addEventListener("click", clearScene);
  demoBtn.addEventListener("click", loadDemo);
}
