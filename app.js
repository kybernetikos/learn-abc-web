// learn-abc PWA — capture → corners → transcribe → render

// API base — point at the deployed Modal endpoint.  Override with
// ?api=http://localhost:8000 for local dev against scripts/api_server.py.
const API_BASE = new URLSearchParams(location.search).get("api")
                  || "https://kybernetikos--learn-abc-32b-web.modal.run";

const $ = (id) => document.getElementById(id);
const stepCapture  = $("step-capture");
const stepCorners  = $("step-corners");
const stepResult   = $("step-result");
const fileInput    = $("file-input");
const canvas       = $("corner-canvas");
const ctx          = canvas.getContext("2d");
const btnRetake    = $("btn-retake");
const btnTranscribe = $("btn-transcribe");
const btnStartOver = $("btn-start-over");
const btnPlay      = $("btn-play");
const btnRerender  = $("btn-rerender");
const btnCopy      = $("btn-copy");
const btnCorrect   = $("btn-correct");
const btnRateGood  = $("btn-rate-good");
const btnRateBad   = $("btn-rate-bad");
const optSave      = $("opt-save");
const ratingStatus = $("rating-status");
const abcText      = $("abc-text");
const abcRender    = $("abc-render");
const warpedPreview = $("warped-preview");
const statusEl     = $("status");

const HANDLE_RADIUS = 22;  // CSS px touch target on screen
let state = {
  img: null,              // Image element with the full-res photo
  corners: null,          // [[x,y],...] in SOURCE pixel coords, order TL TR BR BL
  dragIdx: null,          // index of the handle currently being dragged
  displayScale: 1,        // CSS-pixels-per-source-pixel factor for the canvas
  synthController: null,  // abcjs synth controller
  submissionId: null,     // returned by /transcribe, used by /rating
};

// ----- service worker -----
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./service-worker.js").catch(() => {});
}

// ----- pre-warm the GPU inference container -----
// Modal scales to zero when idle; the first request after a quiet period
// has to spin up a GPU container + load the 32B model (~60-90s).  Fire a
// fire-and-forget GET to /warmup on page load so the GPU container starts
// spinning up while the user is taking the photo / dragging corners.  By
// the time they hit Transcribe, container is usually ready and the
// transcribe response comes back fast (no Modal 303-redirect issues).
fetch(`${API_BASE}/warmup`, { method: "GET", mode: "cors" }).catch(() => {});

// ----- capture -----
fileInput.addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    state.img = img;
    initCorners(img.naturalWidth, img.naturalHeight);
    showStep("corners");
    drawCanvas();
  };
  img.onerror = () => alert("Could not load that image.");
  img.src = url;
});

function initCorners(w, h) {
  // Default to a small inset from each edge so the user can see the handles.
  const m = Math.round(Math.min(w, h) * 0.06);
  state.corners = [
    [m, m],         // TL
    [w - m, m],     // TR
    [w - m, h - m], // BR
    [m, h - m],     // BL
  ];
}

// ----- canvas sizing + drawing -----

function resizeCanvas() {
  if (!state.img) return;
  const iw = state.img.naturalWidth;
  const ih = state.img.naturalHeight;
  // Fit canvas to container width, preserving aspect ratio.  The canvas
  // backing store matches the CSS size × devicePixelRatio so strokes look
  // sharp on mobile.
  const rect = canvas.parentElement.getBoundingClientRect();
  const cssW = rect.width;
  const cssH = Math.round(cssW * ih / iw);
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  state.displayScale = cssW / iw;   // source-px → CSS-px
}

function drawCanvas() {
  if (!state.img) return;
  resizeCanvas();
  const cssW = parseFloat(canvas.style.width);
  const cssH = parseFloat(canvas.style.height);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.drawImage(state.img, 0, 0, cssW, cssH);

  const pts = state.corners.map(([x, y]) =>
    [x * state.displayScale, y * state.displayScale]);

  // Quadrilateral outline
  ctx.strokeStyle = "rgba(74, 123, 255, 0.95)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.stroke();

  // Shaded region outside the quad, so the user can see their selection.
  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
  ctx.beginPath();
  ctx.rect(0, 0, cssW, cssH);
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 3; i >= 0; i--) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill("evenodd");
  ctx.restore();

  // Handles
  const labels = ["TL", "TR", "BR", "BL"];
  for (let i = 0; i < 4; i++) {
    const [x, y] = pts[i];
    ctx.beginPath();
    ctx.arc(x, y, HANDLE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(74, 123, 255, 0.9)";
    ctx.fill();
    ctx.strokeStyle = "white";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "white";
    ctx.font = "bold 11px system-ui";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(labels[i], x, y);
  }
}

window.addEventListener("resize", () => {
  if (!stepCorners.classList.contains("hidden")) drawCanvas();
});

// ----- drag handles (pointer events cover touch + mouse + pen) -----

function pointerToSrc(ev) {
  const rect = canvas.getBoundingClientRect();
  const x_css = ev.clientX - rect.left;
  const y_css = ev.clientY - rect.top;
  return [x_css / state.displayScale, y_css / state.displayScale];
}

canvas.addEventListener("pointerdown", (ev) => {
  if (!state.corners) return;
  const [sx, sy] = pointerToSrc(ev);
  // Find the closest handle within a generous touch radius.
  let bestI = -1, bestD = Infinity;
  for (let i = 0; i < 4; i++) {
    const [cx, cy] = state.corners[i];
    const d = Math.hypot(cx - sx, cy - sy);
    if (d < bestD) { bestD = d; bestI = i; }
  }
  const touchRadiusSrc = (HANDLE_RADIUS * 1.8) / state.displayScale;
  if (bestD <= touchRadiusSrc) {
    state.dragIdx = bestI;
    canvas.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  }
});

canvas.addEventListener("pointermove", (ev) => {
  if (state.dragIdx === null) return;
  const [sx, sy] = pointerToSrc(ev);
  const w = state.img.naturalWidth;
  const h = state.img.naturalHeight;
  state.corners[state.dragIdx] = [
    Math.max(0, Math.min(w, sx)),
    Math.max(0, Math.min(h, sy)),
  ];
  drawCanvas();
});

function endDrag(ev) {
  if (state.dragIdx !== null) {
    canvas.releasePointerCapture?.(ev.pointerId);
    state.dragIdx = null;
  }
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

// ----- transcribe -----

btnRetake.addEventListener("click", () => {
  state.img = null;
  state.corners = null;
  fileInput.value = "";
  showStep("capture");
});

// ----- transcribe loading overlay -----

const loadingOverlay = $("loading-overlay");
const loadingStatus = $("loading-status");
const loadingElapsed = $("loading-elapsed");

const LOADING_PHASES = [
  { atSec:  0, msg: "Uploading photo…" },
  { atSec:  4, msg: "Server received — running inference" },
  { atSec: 20, msg: "Likely a cold start — model is loading on the GPU" },
  { atSec: 60, msg: "Model is loaded — transcribing now" },
  { atSec: 90, msg: "Still working — complex scores can take a while" },
  { atSec: 150, msg: "Taking longer than expected — please be patient" },
];

let _loadingTimer = null;

function showLoading() {
  loadingOverlay.classList.remove("hidden");
  loadingOverlay.setAttribute("aria-hidden", "false");
  const t0 = performance.now();
  const tick = () => {
    const elapsedSec = (performance.now() - t0) / 1000;
    loadingElapsed.textContent = elapsedSec < 60
      ? `${elapsedSec.toFixed(1)}s`
      : `${Math.floor(elapsedSec / 60)}m ${(elapsedSec % 60).toFixed(0)}s`;
    let phase = LOADING_PHASES[0];
    for (const p of LOADING_PHASES) {
      if (elapsedSec >= p.atSec) phase = p;
    }
    loadingStatus.textContent = phase.msg;
  };
  tick();
  _loadingTimer = setInterval(tick, 200);
}

function hideLoading() {
  loadingOverlay.classList.add("hidden");
  loadingOverlay.setAttribute("aria-hidden", "true");
  if (_loadingTimer) { clearInterval(_loadingTimer); _loadingTimer = null; }
}

btnTranscribe.addEventListener("click", async () => {
  if (!state.img || !state.corners) return;
  btnTranscribe.disabled = true;
  statusEl.textContent = "transcribing…";
  showLoading();

  try {
    // Re-encode the source image to a JPEG blob so we're not uploading the
    // full phone-sized PNG/HEIC via the raw file.  If we scale the upload
    // down, we must scale the corner coordinates to match.
    const { blob, scale } = await encodeForUpload(state.img, 2400, 0.92);
    const uploadCorners = state.corners.map(([x, y]) => [x * scale, y * scale]);

    // Helper to POST with retry.  Cold-start + mobile network combos are
    // intermittent; one retry covers most of the noise.
    const sendOnce = async () => {
      const form = new FormData();
      form.append("image", blob, "photo.jpg");
      form.append("corners", JSON.stringify(uploadCorners));
      const headers = {};
      if (!optSave.checked) headers["X-Save-Submission"] = "false";
      const r = await fetch(`${API_BASE}/transcribe`, {
        method: "POST", body: form, headers,
      });
      if (r.status === 429) {
        // rate-limited — retrying won't help, surface immediately
        throw new Error(`rate limited: ${await r.text()}`);
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      return await r.json();
    };

    let data;
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        data = await sendOnce();
        break;
      } catch (err) {
        lastErr = err;
        // Don't retry rate-limit responses — just bubble up.
        if (String(err.message).startsWith("rate limited")) throw err;
        if (attempt < 3) {
          loadingStatus.textContent =
            `Connection hiccup (attempt ${attempt}/3) — retrying in ${attempt * 4}s…`;
          await new Promise(r => setTimeout(r, attempt * 4000));
        }
      }
    }
    if (!data) throw lastErr || new Error("transcribe failed after 3 attempts");

    abcText.value = data.abc || "";
    state.submissionId = data.submission_id || null;
    resetRatingUI();
    renderAbc(abcText.value);
    // Show the warped preview so the user can see what the model saw.
    warpedPreview.innerHTML = "";
    const warpBlob = await warpClientPreview(state.img, state.corners);
    if (warpBlob) {
      const img = new Image();
      img.src = URL.createObjectURL(warpBlob);
      warpedPreview.appendChild(img);
    }
    showStep("result");
    statusEl.textContent = `inference ${data.elapsed_sec}s`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = "error";
    alert("Transcribe failed: " + err.message);
  } finally {
    hideLoading();
    btnTranscribe.disabled = false;
  }
});

// ----- rating + correction submission -----

function resetRatingUI() {
  btnRateGood.classList.remove("selected");
  btnRateBad.classList.remove("selected");
  ratingStatus.textContent = "";
}

async function sendRating(value) {
  if (!state.submissionId) {
    ratingStatus.textContent = "(saving disabled — no rating sent)";
    return;
  }
  const form = new FormData();
  form.append("submission_id", state.submissionId);
  form.append("rating", String(value));
  try {
    const r = await fetch(`${API_BASE}/rating`, { method: "POST", body: form });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    ratingStatus.textContent = "thanks!";
  } catch (err) {
    ratingStatus.textContent = "(failed to send)";
    console.error(err);
  }
}

btnRateGood.addEventListener("click", () => {
  btnRateGood.classList.add("selected");
  btnRateBad.classList.remove("selected");
  sendRating(5);
});
btnRateBad.addEventListener("click", () => {
  btnRateBad.classList.add("selected");
  btnRateGood.classList.remove("selected");
  sendRating(1);
});

btnCorrect.addEventListener("click", async () => {
  if (!state.submissionId) {
    ratingStatus.textContent = "(saving disabled — correction not sent)";
    return;
  }
  const form = new FormData();
  form.append("submission_id", state.submissionId);
  form.append("correction", abcText.value);
  btnCorrect.disabled = true;
  try {
    const r = await fetch(`${API_BASE}/rating`, { method: "POST", body: form });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    ratingStatus.textContent = "correction saved, thanks!";
  } catch (err) {
    ratingStatus.textContent = "(failed to save correction)";
    console.error(err);
  } finally {
    btnCorrect.disabled = false;
  }
});

async function encodeForUpload(img, maxLongSide, quality) {
  // Resize down if the image is huge.  Phone photos can be 4000+ px long
  // side; server-side warp doesn't need more than ~2400 to get a clean staff
  // image.  Returns the blob and the scale factor so the caller can scale
  // corner coordinates to match.
  const w = img.naturalWidth, h = img.naturalHeight;
  const scale = Math.min(1, maxLongSide / Math.max(w, h));
  const cw = Math.round(w * scale);
  const ch = Math.round(h * scale);
  const off = new OffscreenCanvas(cw, ch);
  off.getContext("2d").drawImage(img, 0, 0, cw, ch);
  const blob = await off.convertToBlob({ type: "image/jpeg", quality });
  return { blob, scale };
}

async function warpClientPreview(img, corners) {
  // Best-effort preview: axis-aligned crop to the corners' bounding box.  We
  // skip doing a real perspective warp here (the server has the real one) —
  // this is just to show the user what region was sent.
  const xs = corners.map(c => c[0]);
  const ys = corners.map(c => c[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(img.naturalWidth,  Math.ceil(Math.max(...xs)));
  const y1 = Math.min(img.naturalHeight, Math.ceil(Math.max(...ys)));
  const w = x1 - x0, h = y1 - y0;
  if (w < 10 || h < 10) return null;
  const off = new OffscreenCanvas(w, h);
  off.getContext("2d").drawImage(img, x0, y0, w, h, 0, 0, w, h);
  return await off.convertToBlob({ type: "image/jpeg", quality: 0.85 });
}

// ----- abc rendering + playback -----

function renderAbc(abc) {
  if (!abc.trim()) { abcRender.innerHTML = ""; return; }
  try {
    ABCJS.renderAbc(abcRender, abc, {
      responsive: "resize",
      staffwidth: 900,
    });
  } catch (e) {
    abcRender.innerHTML =
      '<div style="color:#c33;padding:8px;font-family:monospace">render error: ' +
      e.message + "</div>";
  }
}

btnRerender.addEventListener("click", () => renderAbc(abcText.value));

btnCopy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(abcText.value);
    statusEl.textContent = "copied";
    setTimeout(() => statusEl.textContent = "", 1500);
  } catch (e) {
    alert("copy failed: " + e.message);
  }
});

btnPlay.addEventListener("click", async () => {
  const abc = abcText.value.trim();
  if (!abc) return;
  try {
    if (!ABCJS.synth.supportsAudio()) {
      alert("Audio not supported in this browser.");
      return;
    }
    // Stop any previous synth.
    state.synthController?.pause?.();
    // Parse the ABC so the synth has a visualObj to play.
    const visualObj = ABCJS.renderAbc("*", abc)[0];
    const audioCtx = ABCJS.synth.activeAudioContext() || new (window.AudioContext || window.webkitAudioContext)();
    // Some mobile browsers suspend the context until a user gesture; this
    // click handler counts.
    if (audioCtx.state === "suspended") await audioCtx.resume();
    ABCJS.synth.registerAudioContext(audioCtx);
    const synth = new ABCJS.synth.CreateSynth();
    await synth.init({ audioContext: audioCtx, visualObj });
    await synth.prime();
    synth.start();
    state.synthController = synth;
    statusEl.textContent = "playing";
  } catch (e) {
    console.error(e);
    alert("Play failed: " + e.message);
  }
});

btnStartOver.addEventListener("click", () => {
  state.synthController?.stop?.();
  state.synthController = null;
  state.img = null;
  state.corners = null;
  fileInput.value = "";
  abcText.value = "";
  abcRender.innerHTML = "";
  warpedPreview.innerHTML = "";
  statusEl.textContent = "";
  showStep("capture");
});

function showStep(name) {
  stepCapture.classList.toggle("hidden", name !== "capture");
  stepCorners.classList.toggle("hidden", name !== "corners");
  stepResult.classList.toggle("hidden", name !== "result");
}
