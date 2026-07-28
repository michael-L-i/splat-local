// Landing page: stream the hero scene in with a real progress bar, then hand
// it to the shared viewer.
import { createViewer, FILE_TYPES } from "./viewer.js";

const SCENE_URL = "./scenes/home.sog";

const canvas = document.getElementById("canvas");
const veil = document.getElementById("veil");
const veilFill = document.getElementById("veilFill");
const veilLabel = document.getElementById("veilLabel");

function fail(msg) {
  veil.classList.remove("hidden");
  veilLabel.textContent = msg;
  veilFill.style.width = "100%";
  veilFill.style.background = "var(--bad)";
}

// Fetch with progress so the bar reflects real bytes rather than a fake timer.
async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !total) return res.blob();

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received / total);
  }
  return new Blob(chunks);
}

async function main() {
  let viewer;
  try {
    viewer = createViewer(canvas, { idleSpin: true });
  } catch (e) {
    console.error(e);
    fail("webgl unavailable");
    return;
  }

  let objectUrl;
  try {
    const blob = await fetchWithProgress(SCENE_URL, (frac) => {
      veilFill.style.width = `${Math.round(frac * 100)}%`;
    });
    veilFill.style.width = "100%";
    veilLabel.textContent = "building scene";

    objectUrl = URL.createObjectURL(blob);
    await viewer.loadSplat(objectUrl, FILE_TYPES.sog);
    veil.classList.add("hidden");
  } catch (e) {
    console.error("hero scene failed to load:", e);
    fail("scene failed to load");
  } finally {
    // Spark keeps its own copy of the decoded data; release the blob handle.
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }
}

main();
