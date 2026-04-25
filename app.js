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
const btnRotate    = $("btn-rotate");
const btnTranscribe = $("btn-transcribe");
const btnStartOver = $("btn-start-over");
const btnPlay      = $("btn-play");
const btnRerender  = $("btn-rerender");
const btnCopy      = $("btn-copy");
const btnTradpub   = $("btn-tradpub");
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
  img: null,              // ImageBitmap (or HTMLImageElement fallback)
  rotation: 0,            // 0/90/180/270 degrees clockwise applied at display+upload
  corners: null,          // [[x,y],...] in EFFECTIVE (post-rotation) image coords; order TL TR BR BL
  dragIdx: null,          // index of the handle currently being dragged
  displayScale: 1,        // CSS-pixels-per-effective-image-pixel
  synthController: null,
  submissionId: null,
};

function imgNativeDims(img) {
  return [
    img.naturalWidth || img.width,
    img.naturalHeight || img.height,
  ];
}

function effDims() {
  const [w, h] = imgNativeDims(state.img);
  return ((state.rotation % 180) === 0) ? [w, h] : [h, w];
}

// ----- service worker -----
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./service-worker.js").catch(() => {});
}

// ----- pre-warm the GPU inference container -----
// Modal scales to zero when idle; the first request after a quiet period
// has to spin up a GPU container + load the 32B model (~60-150s).  If
// the user hits Transcribe before the container is warm, Modal's HTTP
// edge times out the response and 303-redirects to a polling URL whose
// CORS handling is unreliable.  So we kick off /warmup on page load AND
// await it before transcribing.  By the time the user finishes taking
// a photo and dragging corners, the warmup is usually done.
//
// `state.warmupPromise` resolves to true when the GPU container has
// loaded the model; false if warmup failed.  Refreshed when the user
// starts a fresh transcribe so a long-idle session re-warms.
let warmupPromise = startWarmup();

function startWarmup() {
  return fetch(`${API_BASE}/warmup`, { method: "GET", mode: "cors" })
    .then(r => r.ok)
    .catch(() => false);
}

// ----- capture -----
fileInput.addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  state.rotation = 0;
  // Honour EXIF orientation when supported, so phone photos arrive upright.
  try {
    state.img = await createImageBitmap(f, { imageOrientation: "from-image" });
  } catch {
    const url = URL.createObjectURL(f);
    state.img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => { URL.revokeObjectURL(url); res(i); };
      i.onerror = rej;
      i.src = url;
    });
  }
  const [w, h] = effDims();
  initCorners(w, h);
  showStep("corners");
  drawCanvas();
});

btnRotate.addEventListener("click", () => {
  if (!state.img || !state.corners) return;
  const [, oldH] = effDims();
  state.corners = state.corners.map(([x, y]) => [oldH - y, x]);
  state.rotation = (state.rotation + 90) % 360;
  drawCanvas();
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
  const [iw, ih] = effDims();   // post-rotation
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
  state.displayScale = cssW / iw;   // effective-image-px → CSS-px
}

function drawCanvas() {
  if (!state.img) return;
  resizeCanvas();
  const cssW = parseFloat(canvas.style.width);
  const cssH = parseFloat(canvas.style.height);
  ctx.clearRect(0, 0, cssW, cssH);

  // Draw the image with rotation applied.  After rotate, the native
  // (imgW × imgH) image fills the canvas's effective dimensions.
  const [imgW, imgH] = imgNativeDims(state.img);
  const s = state.displayScale;
  ctx.save();
  ctx.translate(cssW / 2, cssH / 2);
  ctx.rotate(state.rotation * Math.PI / 180);
  ctx.drawImage(state.img,
                -imgW * s / 2, -imgH * s / 2,
                imgW * s,      imgH * s);
  ctx.restore();

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
  const [w, h] = effDims();
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
  state.rotation = 0;
  fileInput.value = "";
  showStep("capture");
});

// ----- transcribe loading overlay -----

const loadingOverlay = $("loading-overlay");
const loadingStatus = $("loading-status");
const loadingElapsed = $("loading-elapsed");
const loadingEta = $("loading-eta");
const loadingBar = $("loading-progress-bar");

const LOADING_PHASES = [
  { atSec:  0, msg: "Uploading photo…" },
  { atSec:  4, msg: "Running inference on the GPU" },
  { atSec: 25, msg: "Cold start — model is loading" },
  { atSec: 75, msg: "Model loaded — transcribing your image" },
  { atSec: 150, msg: "Almost there…" },
  { atSec: 240, msg: "Taking longer than expected — keep waiting" },
];

// Estimated total duration; the bar fills monotonically toward this and
// asymptotes once we cross it (so it never visually finishes prematurely).
const EXPECTED_TOTAL_SEC = 180;

let _loadingTimer = null;
let _wakeLock = null;

function fmtSec(sec) {
  if (sec < 60) return `${sec.toFixed(0)}s`;
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}

async function acquireWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    _wakeLock = await navigator.wakeLock.request("screen");
    _wakeLock.addEventListener("release", () => { _wakeLock = null; });
  } catch (e) {
    // wakeLock may be denied; not fatal.
    console.warn("wakeLock denied:", e);
  }
}

async function releaseWakeLock() {
  try { if (_wakeLock) await _wakeLock.release(); } catch {}
  _wakeLock = null;
}

// If the page tab is briefly backgrounded and the wake lock is auto-released,
// re-request it when we come back to the foreground (still in flight).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible"
      && !loadingOverlay.classList.contains("hidden")) {
    acquireWakeLock();
  }
});

function showLoading() {
  loadingOverlay.classList.remove("hidden");
  loadingOverlay.setAttribute("aria-hidden", "false");
  acquireWakeLock();
  const t0 = performance.now();
  loadingBar.classList.remove("indeterminate");
  loadingBar.style.width = "0%";

  const tick = () => {
    const elapsedSec = (performance.now() - t0) / 1000;

    loadingElapsed.textContent = `${fmtSec(elapsedSec)} elapsed`;

    // Progress bar: fill toward EXPECTED_TOTAL_SEC, then go indeterminate
    // once we exceed it so it doesn't pretend we're done.
    if (elapsedSec >= EXPECTED_TOTAL_SEC) {
      loadingBar.classList.add("indeterminate");
      loadingEta.textContent = "should be any moment now";
    } else {
      const fraction = Math.min(0.95, elapsedSec / EXPECTED_TOTAL_SEC);
      loadingBar.style.width = `${(fraction * 100).toFixed(1)}%`;
      const remainingSec = Math.max(5, EXPECTED_TOTAL_SEC - elapsedSec);
      loadingEta.textContent = `about ${fmtSec(remainingSec)} remaining`;
    }

    // Override status with rotating phase messages.
    let phase = LOADING_PHASES[0];
    for (const p of LOADING_PHASES) if (elapsedSec >= p.atSec) phase = p;
    // Don't overwrite a retry message
    if (!loadingStatus.textContent.startsWith("Connection hiccup")) {
      loadingStatus.textContent = phase.msg;
    }
  };
  tick();
  _loadingTimer = setInterval(tick, 250);
}

function hideLoading() {
  loadingOverlay.classList.add("hidden");
  loadingOverlay.setAttribute("aria-hidden", "true");
  releaseWakeLock();
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
    const { blob, scale } = await encodeForUpload(state.img, state.rotation, 2400, 0.92);
    const uploadCorners = state.corners.map(([x, y]) => [x * scale, y * scale]);

    // Wait for the GPU container to be warm before sending the transcribe.
    // The page-load warmup is usually done by the time the user clicks
    // Transcribe (they spent ~30s taking the photo + dragging corners), but
    // on a fresh-cold-start visit the container can take 90-150s to load
    // and we MUST not race it — that's what triggers the 303 → CORS issue.
    loadingStatus.textContent = "Waiting for GPU container to be ready…";
    const warmReady = await warmupPromise;
    if (!warmReady) {
      // Try one more warmup, then proceed regardless.
      warmupPromise = startWarmup();
      await warmupPromise;
    }

    // Helper to POST with retry.  With warmup confirmed, transient failures
    // are most likely network blips — short backoffs are appropriate.
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
        if (String(err.message).startsWith("rate limited")) throw err;
        if (attempt < 3) {
          loadingStatus.textContent =
            `Connection hiccup (attempt ${attempt}/3) — retrying in ${attempt * 6}s…`;
          await new Promise(r => setTimeout(r, attempt * 6000));
          // Re-prime warmup before retry — container may have scaled down
          warmupPromise = startWarmup();
          await warmupPromise;
        }
      }
    }
    if (!data) throw lastErr || new Error("transcribe failed after 3 attempts");
    // Refresh the warmup promise so subsequent transcribes use a fresh check.
    warmupPromise = startWarmup();

    abcText.value = data.abc || "";
    state.submissionId = data.submission_id || null;
    resetRatingUI();
    renderAbc(abcText.value);
    refreshTradpubLink();
    // Show the warped preview so the user can see what the model saw.
    warpedPreview.innerHTML = "";
    const warpBlob = await warpClientPreview(state.img, state.corners, state.rotation);
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

async function encodeForUpload(img, rotation, maxLongSide, quality) {
  // Resize down if the image is huge AND bake any rotation in, so the
  // server receives an upright JPEG with no EXIF orientation surprises.
  // Returns the blob and the scale factor so the caller can scale
  // corner coordinates (which are in EFFECTIVE image space) to match.
  const [iw, ih] = imgNativeDims(img);
  const swap = (rotation % 180) !== 0;
  const ew = swap ? ih : iw;
  const eh = swap ? iw : ih;
  const scale = Math.min(1, maxLongSide / Math.max(ew, eh));
  const cw = Math.round(ew * scale);
  const ch = Math.round(eh * scale);
  const off = new OffscreenCanvas(cw, ch);
  const c = off.getContext("2d");
  c.translate(cw / 2, ch / 2);
  c.rotate(rotation * Math.PI / 180);
  c.drawImage(img, -iw * scale / 2, -ih * scale / 2, iw * scale, ih * scale);
  const blob = await off.convertToBlob({ type: "image/jpeg", quality });
  return { blob, scale };
}

async function warpClientPreview(img, corners, rotation) {
  // Best-effort preview: axis-aligned crop to the corners' bounding box from
  // the rotation-baked image.  Corners are in EFFECTIVE image space.
  const [iw, ih] = imgNativeDims(img);
  const swap = (rotation % 180) !== 0;
  const ew = swap ? ih : iw;
  const eh = swap ? iw : ih;
  const xs = corners.map(c => c[0]);
  const ys = corners.map(c => c[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const x1 = Math.min(ew, Math.ceil(Math.max(...xs)));
  const y1 = Math.min(eh, Math.ceil(Math.max(...ys)));
  const w = x1 - x0, h = y1 - y0;
  if (w < 10 || h < 10) return null;
  // Render the rotation-baked image at full effective size, then crop.
  const baked = new OffscreenCanvas(ew, eh);
  const bctx = baked.getContext("2d");
  bctx.translate(ew / 2, eh / 2);
  bctx.rotate(rotation * Math.PI / 180);
  bctx.drawImage(img, -iw / 2, -ih / 2);
  const off = new OffscreenCanvas(w, h);
  off.getContext("2d").drawImage(baked, x0, y0, w, h, 0, 0, w, h);
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

// ----- trad.pub share link -----
//
// trad.pub accepts a tune via `?t=<base64url(deflate-raw(utf8(abc)))>#music`.
// The deflate compresses the ABC; base64url is the URL-safe variant
// (`+`→`-`, `/`→`_`, no `=` padding).  On modern browsers, all of this is
// built-in: CompressionStream, TextEncoder, btoa.
async function tradpubUrlFor(abc) {
  if (!abc.trim()) return null;
  const bytes = new TextEncoder().encode(abc);
  const stream = new CompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  writer.write(bytes); writer.close();
  const compressed = new Uint8Array(
    await new Response(stream.readable).arrayBuffer());
  let latin1 = "";
  for (const b of compressed) latin1 += String.fromCharCode(b);
  const b64url = btoa(latin1)
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `https://trad.pub/?t=${b64url}#music`;
}

async function refreshTradpubLink() {
  try {
    const url = await tradpubUrlFor(abcText.value);
    if (url) btnTradpub.href = url;
  } catch (e) {
    console.warn("trad.pub link build failed:", e);
  }
}
// Refresh the link whenever the ABC textarea changes (debounced lightly).
let _tradpubTimer = null;
abcText.addEventListener("input", () => {
  clearTimeout(_tradpubTimer);
  _tradpubTimer = setTimeout(refreshTradpubLink, 200);
});
// And when the link is clicked, build it just-in-time so a navigation never
// uses a stale URL.
btnTradpub.addEventListener("click", async (ev) => {
  ev.preventDefault();
  const url = await tradpubUrlFor(abcText.value);
  if (url) window.open(url, "_blank", "noopener");
});

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
  state.rotation = 0;
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
