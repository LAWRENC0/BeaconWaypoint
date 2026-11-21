import { project, fovVDeg, cameraVector, vectorToAim, blendVector, wrap180, distanceM, fitCalibration } from "./geo.js";
import { declinationDeg } from "./vendor/declination.js";
import { groundElevation } from "./elevation.js";

const $ = (id) => document.getElementById(id);
const els = {
  stepItems: [...document.querySelectorAll("#stepper li")],
  cards: [...document.querySelectorAll(".step")],
  targetTitle: $("target-title"), targetLead: $("target-lead"),
  place: $("place"), search: $("search"), candidates: $("candidates"), hintTarget: $("hint-target"),
  changeTarget: $("change-target"), sheetDone: $("sheet-done"), targetLine: $("target-line"),
  calKindRadios: [...document.querySelectorAll('input[name="cal-kind"]')],
  fullscreen: $("fullscreen"),
  camRow: $("cam-row"), camSelect: $("cam-select"),
  startAccess: $("start-access"), hintAccess: $("hint-access"), deviceLine: $("device-line"),
  stCam: $("st-cam"), stGps: $("st-gps"), stSensor: $("st-sensor"),
  cam: $("cam"), canvas: $("live"), liveMsg: $("liveMsg"),
  calibrate: $("calibrate"), calHint: $("cal-hint"), calInfo: $("cal-info"), resetCal: $("reset-cal"), undoCal: $("undo-cal"),
  showLandmarks: $("show-landmarks"),
  pendPanel: $("pend-panel"), pendHeight: $("pend-height"), pendOut: $("pend-out"),
  pendSave: $("pend-save"), pendDiscard: $("pend-discard"),
  fov: $("fov"), fovOut: $("fovOut"), height: $("height"), heightOut: $("heightOut"),
  back: $("back"), next: $("next"), progressFill: $("progress-fill"),
};

const STEP_TARGET = 0, STEP_ACCESS = 1, STEP_LIVE = 2;
const SENSOR_SMOOTHING = 0.2;      // 0..1, lower = smoother but laggier
const SENSOR_TIMEOUT_MS = 1000;    // no sensor event for this long = compass considered inactive
const MAX_DISTANCE_M = 70000;      // flat-plane model is only valid to ~70 km (LTP/MVP spec gate)
const CAL_MAX_DISTANCE_M = 50000;  // calibration is flagged when used farther than this from where it was made
const CAL_RESIDUAL_WARN = 3;       // degrees: landmarks disagreeing by more than this are flagged
const EYE_HEIGHT = 1.6;            // metres from ground to the phone camera, when standing
const GROUND_REFRESH_M = 150;      // look up the user's terrain height again after moving this far
const GROUND_RETRY_MS = 10000;     // wait this long after a failed terrain lookup

// Profile versions:
//   2: one global heading/pitch offset
//   3: per-tap points (replaced by landmarks)
//   4: landmarks with a height entered by the user (hDiff)
//   5: landmarks with terrain-based ground difference (groundDiffM) and spot height above ground (bh, null = inferred)
const PROFILE_VERSION = 5;
function defaultProfile() {
  return { version: PROFILE_VERSION, fovH: 70, headingOffset: 0, pitchOffset: 0, landmarks: [], calLat: null, calLon: null };
}

const state = {
  step: STEP_TARGET,
  candidates: [],
  target: null,        // { lat, lon, name, ground }  ground = terrain height in metres, once looked up
  user: null,          // { lat, lon }
  userGround: null,    // terrain height at the user's position, metres
  userGroundAt: null,  // where userGround was looked up
  lastGroundTry: 0,
  stream: null,
  cameraId: null,      // camera chosen by the user (deviceId), null = browser default back camera
  cameraKey: null,     // deviceId of the camera actually in use
  cameraOk: false,
  gpsOk: false,
  vec: null,           // smoothed camera direction vector
  lastSensor: 0,
  sheetOpen: false,    // target picker shown over the live view
  sheetMode: "target", // "target" = choose what to find; "cal" = choose a landmark to calibrate on
  calibrating: false,  // waiting for a tap on the calibration landmark
  calTarget: null,     // landmark being tapped during calibration
  calKind: "ground",   // "ground" = tap the base of something; "top" = tap the top
  pending: null,       // a measured top, waiting for the user to confirm its height: { point, bh, adjusted }
  showLandmarks: false,// draw every saved landmark, to check the calibration by eye
  device: "unknown device",
  profile: defaultProfile(),
  heightDiffM: 0,      // target height above its ground, from the slider (m)
  declDeg: 0,          // magnetic declination at the user's position (east positive)
};

// ---------- device profile (saved calibration) ----------

function profileKeyFor(cameraKey) { return `beacon:cal:${state.device}:${cameraKey || "default"}`; }
function profileKey() { return profileKeyFor(state.cameraKey); }

function loadProfile() {
  let saved = null;
  try {
    const raw = localStorage.getItem(profileKey());
    saved = raw ? JSON.parse(raw) : null;
  } catch { saved = null; }

  const fresh = defaultProfile();
  if (saved && saved.version === PROFILE_VERSION) {
    state.profile = { ...fresh, ...saved, landmarks: Array.isArray(saved.landmarks) ? saved.landmarks : [] };
  } else if (saved && saved.version === 4) {
    // The height a user typed becomes the ground difference, with the spot taken as the ground.
    const lm = Array.isArray(saved.landmarks) ? saved.landmarks : [];
    state.profile = { ...fresh, ...saved, version: PROFILE_VERSION,
      landmarks: lm.map((l) => ({ ...l, groundDiffM: l.hDiff, bh: 0 })) };
  } else if (saved && saved.version === 3) {
    // Keep the averaged per-tap correction as the offset; the tap points themselves are not landmarks.
    const pts = Array.isArray(saved.points) ? saved.points : [];
    const mean = (k, fallback) => (pts.length ? pts.reduce((s, q) => s + q[k], 0) / pts.length : fallback);
    state.profile = { ...fresh, fovH: saved.fovH || fresh.fovH,
      headingOffset: mean("errH", saved.headingOffset || 0), pitchOffset: mean("errP", saved.pitchOffset || 0),
      calLat: saved.calLat != null ? saved.calLat : null, calLon: saved.calLon != null ? saved.calLon : null };
  } else if (saved && saved.version === 2) {
    state.profile = { ...fresh, headingOffset: saved.headingOffset || 0, pitchOffset: saved.pitchOffset || 0,
      fovH: saved.fovH || fresh.fovH, calLat: saved.calLat != null ? saved.calLat : null, calLon: saved.calLon != null ? saved.calLon : null };
  } else {
    state.profile = { ...fresh, fovH: saved && saved.fovH ? saved.fovH : fresh.fovH };
  }
  els.fov.value = state.profile.fovH;
  els.fovOut.textContent = state.profile.fovH;
}

function saveProfile() {
  try { localStorage.setItem(profileKey(), JSON.stringify(state.profile)); } catch { /* storage unavailable: keep in memory only */ }
  renderCalInfo();
}

async function detectDevice() {
  try {
    const ua = navigator.userAgentData;
    if (ua && ua.getHighEntropyValues) {
      const v = await ua.getHighEntropyValues(["model"]);
      if (v.model) return v.model;
    }
  } catch { /* not available */ }
  // Model is only exposed on Chromium Android. Fall back to a weak fingerprint so
  // unrelated phones (iOS, desktop) do not share one saved calibration.
  return `${navigator.platform || "unknown"} ${screen.width}x${screen.height}`;
}

function signed(v) { return `${v >= 0 ? "+" : ""}${v.toFixed(1)}°`; }

function renderCalInfo() {
  const p = state.profile;
  const n = p.landmarks.length;
  const hasCal = n > 0 || p.headingOffset || p.pitchOffset;
  els.calInfo.textContent = n
    ? `Device: ${state.device}\nCalibration from ${n} landmark${n > 1 ? "s" : ""}: heading ${signed(p.headingOffset)}, pitch ${signed(p.pitchOffset)}, field of view ${p.fovH.toFixed(1)}°.`
    : `Device: ${state.device}\nNo calibration. Field of view ${p.fovH}°.`;
  let line = `Device: ${state.device}. ` +
    (hasCal ? "Saved calibration applied." : "Optional: calibrate with landmarks you can see for better accuracy.");
  if (hasCal && p.calLat != null && state.user &&
      distanceM(p.calLat, p.calLon, state.user.lat, state.user.lon) > CAL_MAX_DISTANCE_M) {
    line += " You are far from where it was calibrated. Consider recalibrating here.";
  }
  if (state.user && state.userGround === null) line += " Terrain height not loaded yet (needs internet).";
  els.deviceLine.textContent = line;
}

// ---------- terrain ----------

// Terrain height at the user's position. Looked up again only after moving a good distance.
async function refreshUserGround() {
  if (!state.user) return;
  const now = Date.now();
  if (now - state.lastGroundTry < GROUND_RETRY_MS) return;
  if (state.userGroundAt && distanceM(state.userGroundAt.lat, state.userGroundAt.lon, state.user.lat, state.user.lon) < GROUND_REFRESH_M) return;
  state.lastGroundTry = now;
  const at = { lat: state.user.lat, lon: state.user.lon };
  const g = await groundElevation(at.lat, at.lon);
  if (g !== null) {
    state.userGround = g;
    state.userGroundAt = at;
    renderCalInfo();
  }
}

// Height of a point at ground level `ground` above the user's eye, from terrain data.
function groundDiffFor(ground) {
  if (ground == null || state.userGround == null) return null;
  return ground - (state.userGround + EYE_HEIGHT);
}

// Navigation target: its terrain height plus the slider (height of the target above ground).
// Without terrain data the slider is used alone, as before.
function targetHeightDiff(target) {
  const gd = groundDiffFor(target.ground);
  return gd === null ? state.heightDiffM : gd + state.heightDiffM;
}

// ---------- navigation ----------

function canAdvance() {
  if (state.step === STEP_TARGET) return !!state.target;
  if (state.step === STEP_ACCESS) return state.cameraOk && state.gpsOk;
  return false;
}

function goTo(step) {
  state.step = Math.max(STEP_TARGET, Math.min(STEP_LIVE, step));
  if (state.step !== STEP_LIVE) cancelCalibration();
  renderSteps();
}

function renderSteps() {
  const s = state.step;
  const inLive = s === STEP_LIVE;
  // In the live step the target card becomes a bottom sheet that is only shown when opened.
  els.cards.forEach((c) => {
    const n = Number(c.dataset.step);
    const isSheet = inLive && n === STEP_TARGET;
    c.classList.toggle("sheet", isSheet);
    c.classList.toggle("on", isSheet ? state.sheetOpen : n === s);
    if (n === STEP_TARGET) c.classList.toggle("calmode", isSheet && state.sheetMode === "cal");
  });
  const calMode = state.sheetMode === "cal";
  els.targetTitle.textContent = calMode ? "Calibration: find something you can see" : "What are you looking for?";
  els.targetLead.textContent = calMode
    ? "Search for a place visible from here (a church, monument, tower). Pick it, then tap it on the picture. Use two or more places in different directions."
    : "Type a name or address, then pick the right match from the list.";

  els.stepItems.forEach((li, i) => {
    li.classList.toggle("current", i === s);
    li.classList.toggle("done", i < s);
  });
  els.progressFill.style.width = `${(s / STEP_LIVE) * 100}%`;
  els.back.disabled = s === STEP_TARGET;
  els.next.style.display = inLive ? "none" : "";
  els.next.disabled = !canAdvance();
  els.next.textContent = s === STEP_ACCESS ? "Go live" : "Next";
  els.canvas.classList.toggle("calibrating", state.calibrating);
  els.calibrate.textContent = state.calibrating || state.pending ? "Cancel calibration" : "Calibrate with landmarks";
  els.pendPanel.hidden = !state.pending;
  els.targetLine.textContent = state.target
    ? `Target: ${state.target.name.split(",")[0]}`
    : "No target chosen yet.";
}

els.back.addEventListener("click", () => goTo(state.step - 1));
els.next.addEventListener("click", () => {
  if (state.step === STEP_ACCESS) {
    goTo(STEP_LIVE);
    renderCalInfo();
    return;
  }
  goTo(state.step + 1);
});

function openSheet(mode) {
  state.sheetMode = mode;
  state.sheetOpen = true;
  cancelCalibration();
  els.calHint.textContent = "";
  renderCandidates();
  renderSteps();
}

function cancelCalibration() {
  state.calibrating = false;
  state.calTarget = null;
  state.pending = null;
}

els.changeTarget.addEventListener("click", () => openSheet("target"));
els.sheetDone.addEventListener("click", () => { state.sheetOpen = false; renderSteps(); });

els.calibrate.addEventListener("click", () => {
  if (state.calibrating || state.pending) {
    cancelCalibration();
    els.calHint.textContent = "Calibration cancelled.";
    renderSteps();
    return;
  }
  if (!state.user || !state.vec) {
    els.calHint.textContent = "Calibration needs your location and the compass. Wait for both, then try again.";
    return;
  }
  openSheet("cal");
});

// ---------- full screen (not available on iPhone Safari) ----------

if (!document.documentElement.requestFullscreen) {
  els.fullscreen.hidden = true;
} else {
  els.fullscreen.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => { /* refused: stay windowed */ });
  });
  document.addEventListener("fullscreenchange", () => {
    els.fullscreen.textContent = document.fullscreenElement ? "Exit full screen" : "Full screen";
  });
}

// ---------- place search (step 1, the sheet in the live view, and landmark picking) ----------

els.search.addEventListener("click", searchPlace);
els.place.addEventListener("keydown", (e) => { if (e.key === "Enter") searchPlace(); });

async function searchPlace() {
  const q = els.place.value.trim();
  if (!q) { els.hintTarget.textContent = "Type a name or address first."; return; }
  els.hintTarget.textContent = "Searching…";
  els.candidates.innerHTML = "";
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=6&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { "Accept-Language": navigator.language || "en" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.candidates = (await res.json()).map((h) => ({
      lat: parseFloat(h.lat), lon: parseFloat(h.lon), name: h.display_name, kind: h.type || h.class || "",
    }));
    if (!state.candidates.length) {
      els.hintTarget.textContent = "No matches. Try a more complete address or add the city.";
      return;
    }
    els.hintTarget.textContent = `${state.candidates.length} possible matches. Pick the right one.`;
    renderCandidates(true);
  } catch (err) {
    els.hintTarget.textContent = `Search failed: ${err.message}`;
  }
}

function renderCandidates(fresh = false) {
  els.candidates.innerHTML = "";
  state.candidates.forEach((c, i) => {
    const li = document.createElement("li");
    // Only new search results animate in; re-rendering after a pick stays still.
    if (fresh) li.style.animationDelay = `${i * 60}ms`;
    else li.style.animation = "none";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-pressed", String(!!state.target && state.target.name === c.name));
    const title = document.createElement("span");
    title.textContent = c.name;
    btn.appendChild(title);
    if (c.kind) {
      const small = document.createElement("small");
      small.textContent = c.kind;
      btn.appendChild(small);
    }
    btn.addEventListener("click", () => pickCandidate(c));
    li.appendChild(btn);
    els.candidates.appendChild(li);
  });
}

async function pickCandidate(c) {
  if (state.sheetMode === "cal" && state.step === STEP_LIVE && state.sheetOpen) {
    // Calibration: this place is a landmark to tap, not the navigation target.
    els.calHint.textContent = "Looking up the terrain height…";
    const g = await groundElevation(c.lat, c.lon);
    if (g === null || state.userGround === null) {
      els.calHint.textContent = "Terrain height is not available right now (needs internet and your location). Try again.";
      return;
    }
    c.ground = g;
    state.calTarget = c;
    state.calKind = els.calKindRadios.find((r) => r.checked).value;
    state.calibrating = true;
    state.sheetOpen = false;
    els.calHint.textContent = state.calKind === "top"
      ? "Tap the top of this object on the picture."
      : "Tap the base of this object on the picture.";
    renderCandidates();
    renderSteps();
    return;
  }
  state.target = c;
  c.ground = undefined;
  groundElevation(c.lat, c.lon).then((g) => { c.ground = g; renderCalInfo(); });
  els.hintTarget.textContent = `Target set: ${c.name}`;
  if (state.step === STEP_LIVE) state.sheetOpen = false; // back to the live view with the new target
  renderCandidates();
  renderSteps();
}

// ---------- step 2: camera, GPS, orientation ----------

els.startAccess.addEventListener("click", startAccess);

async function startAccess() {
  els.hintAccess.textContent = "";
  els.startAccess.disabled = true;

  // Camera: needs HTTPS (or localhost). Requested from this click so mobile browsers accept it.
  try {
    if (!state.stream) await openCamera(state.cameraId);
    state.cameraOk = true;
    els.stCam.textContent = "ready";
    els.stCam.className = "ok";
  } catch (err) {
    els.stCam.textContent = `error: ${err.message}`;
    els.stCam.className = "warn";
  }

  // Motion / compass: iOS needs an explicit permission from a user gesture.
  try {
    if (typeof DeviceOrientationEvent === "undefined") throw new Error("no motion sensors");
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      const p = await DeviceOrientationEvent.requestPermission();
      if (p !== "granted") throw new Error("permission denied");
    }
    window.addEventListener("deviceorientationabsolute", onOrientation);
    window.addEventListener("deviceorientation", onOrientation);
    els.stSensor.textContent = "waiting for data…";
    els.stSensor.className = "";
  } catch (err) {
    els.stSensor.textContent = `unavailable: ${err.message}`;
    els.stSensor.className = "warn";
  }

  // GPS: watch continuously so the live view always uses the latest fix.
  if (!navigator.geolocation) {
    els.stGps.textContent = "unavailable";
    els.stGps.className = "warn";
  } else if (!state.gpsOk && !state.gpsWatch) {
    state.gpsWatch = navigator.geolocation.watchPosition(
      (pos) => {
        state.user = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        state.declDeg = declinationDeg(pos.coords.latitude, pos.coords.longitude);
        state.gpsOk = true;
        els.stGps.textContent = `±${Math.round(pos.coords.accuracy)} m`;
        els.stGps.className = pos.coords.accuracy > 30 ? "warn" : "ok";
        refreshUserGround();
        renderSteps();
      },
      (err) => {
        els.stGps.textContent = `error: ${err.message}`;
        els.stGps.className = "warn";
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
  }

  els.startAccess.disabled = false;
  renderSteps();
}

// ---------- camera choice ----------
// The browser otherwise picks the back camera itself, often a wide or ultra-wide lens.
// Each lens has a different field of view, so calibration is kept per camera.

async function openCamera(deviceId) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("camera API unavailable (open the page over HTTPS)");
  }
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  const video = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } };
  state.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  els.cam.srcObject = state.stream;
  await els.cam.play();
  const id = state.stream.getVideoTracks()[0].getSettings().deviceId || null;
  if (id !== state.cameraKey) useCameraProfile(id);
  await listCameras();
}

async function listCameras() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
  if (cams.length < 2) { els.camRow.hidden = true; return; }
  const active = state.cameraKey;
  els.camSelect.innerHTML = "";
  cams.forEach((d, i) => {
    const o = document.createElement("option");
    o.value = d.deviceId;
    o.textContent = d.label || `Camera ${i + 1}`;
    o.selected = d.deviceId === active;
    els.camSelect.appendChild(o);
  });
  els.camRow.hidden = false;
}

// Calibration is stored per camera. A calibration made before cameras were distinguished
// is copied to the first camera used, since that is the most likely one.
function useCameraProfile(id) {
  state.cameraKey = id;
  try {
    if (id && localStorage.getItem(profileKeyFor(id)) === null && localStorage.getItem(profileKeyFor(null)) !== null) {
      localStorage.setItem(profileKeyFor(id), localStorage.getItem(profileKeyFor(null)));
    }
  } catch { /* storage unavailable */ }
  loadProfile();
  renderCalInfo();
}

els.camSelect.addEventListener("change", async () => {
  const id = els.camSelect.value;
  state.cameraId = id;
  try { localStorage.setItem("beacon:camera", id); } catch { /* storage unavailable */ }
  try {
    await openCamera(id);
    els.calHint.textContent = "Camera changed. Calibration for this camera is loaded.";
  } catch (err) {
    els.stCam.textContent = `error: ${err.message}`;
    els.stCam.className = "warn";
  }
});

function onOrientation(e) {
  let alpha = null;
  if (typeof e.webkitCompassHeading === "number" && e.webkitCompassHeading >= 0) {
    alpha = (360 - e.webkitCompassHeading) % 360; // iOS: compass heading is clockwise from north
  } else if (e.absolute === true && typeof e.alpha === "number") {
    alpha = e.alpha;                                // Android: absolute (earth-referenced) alpha
  }
  if (alpha === null || e.beta == null || e.gamma == null) return;
  state.vec = blendVector(state.vec, cameraVector(alpha, e.beta, e.gamma), SENSOR_SMOOTHING);
  state.lastSensor = performance.now();
  if (state.cameraOk || state.gpsOk) {
    els.stSensor.textContent = "active";
    els.stSensor.className = "ok";
  }
}

// ---------- step 3: live overlay ----------

// Aim from the sensors only (true north, no saved correction).
function rawAim() {
  const sensorOn = !!state.vec && performance.now() - state.lastSensor < SENSOR_TIMEOUT_MS;
  const r = sensorOn ? vectorToAim(state.vec) : { heading: 0, pitch: 0 };
  // Sensor heading is magnetic north; add declination to get true north (spec §3.2).
  return { sensorOn, heading: (r.heading + state.declDeg + 360) % 360, pitch: r.pitch };
}

// Aim with the fitted calibration applied, in the same frame as the video.
function currentAim() {
  const a = rawAim();
  return {
    sensorOn: a.sensorOn,
    heading: (a.heading + state.profile.headingOffset + 360) % 360,
    pitch: a.pitch + state.profile.pitchOffset,
  };
}

// What the beacon points at: the calibration landmark while tapping it, otherwise the target.
function activeTarget() {
  return state.calibrating && state.calTarget ? state.calTarget : state.target;
}

function heightDiffFor(target) {
  if (state.calibrating && target === state.calTarget) {
    const gd = groundDiffFor(target.ground);
    return gd === null ? 0 : gd; // landmark: ground level until a top is tapped
  }
  return targetHeightDiff(target);
}

function projectTarget(W, H, target) {
  const aim = currentAim();
  return project({
    user: state.user,
    target,
    heightDiffM: heightDiffFor(target),
    headingDeg: aim.heading,
    pitchDeg: aim.pitch,
    fovHDeg: state.profile.fovH,
    width: W,
    height: H,
  });
}

function frame() {
  requestAnimationFrame(frame);
  if (state.step !== STEP_LIVE) return;
  const v = els.cam;
  if (v.readyState < 2 || !v.videoWidth) return;

  const W = v.videoWidth, H = v.videoHeight;
  if (els.canvas.width !== W || els.canvas.height !== H) {
    els.canvas.width = W;
    els.canvas.height = H;
  }
  const ctx = els.canvas.getContext("2d");
  ctx.drawImage(v, 0, 0, W, H);
  drawCrosshair(ctx, W, H);

  // The field of view only holds for the sensor's long side, so the overlay is landscape-only.
  if (window.matchMedia("(orientation: portrait)").matches) return setLiveMsg("Rotate your phone to landscape.");
  const target = activeTarget();
  if (!target) return setLiveMsg("No target chosen. Tap Change target.");
  if (!state.user) return setLiveMsg("Waiting for GPS…");
  if (!state.vec) return setLiveMsg("Waiting for compass… (move the phone)");
  if (!currentAim().sensorOn) return setLiveMsg("Compass stopped sending data. Move the phone or restart sensors.");

  if (state.showLandmarks) drawLandmarks(ctx, W, H);
  if (state.pending) drawPending(ctx, W, H);

  const p = projectTarget(W, H, target);
  const distTxt = p.dist >= 1000 ? `${(p.dist / 1000).toFixed(2)} km` : `${Math.round(p.dist)} m`;
  if (p.dist > MAX_DISTANCE_M) {
    return setLiveMsg(state.calibrating
      ? `${target.name.split(",")[0]} is too far to use as a landmark (${distTxt}).`
      : `Target is ${distTxt} away. Beyond the ${MAX_DISTANCE_M / 1000} km limit of this model.`);
  }
  const label = `${target.name.split(",")[0]} · ${distTxt}`;

  if (state.calibrating) {
    if (p.inFrame) drawBeacon(ctx, p.x, p.y, label, W, false);
    setLiveMsg(`Tap "${target.name.split(",")[0]}" on the picture · ${distTxt}`);
    return;
  }

  if (p.inFrame) {
    drawBeacon(ctx, p.x, p.y, label, W, false);
    setLiveMsg(`On target · ${distTxt}`);
  } else {
    const cx = Math.min(Math.max(p.x, 0), W), cy = Math.min(Math.max(p.y, 0), H);
    drawBeacon(ctx, cx, cy, label, W, true);
    const hint = [];
    if (p.dTheta < -1) hint.push(`turn ${Math.abs(p.dTheta).toFixed(0)}° left`);
    if (p.dTheta > 1) hint.push(`turn ${p.dTheta.toFixed(0)}° right`);
    if (p.dPhi > 1) hint.push(`tilt ${p.dPhi.toFixed(0)}° up`);
    if (p.dPhi < -1) hint.push(`tilt ${Math.abs(p.dPhi).toFixed(0)}° down`);
    setLiveMsg(`Target ${hint.join(", ") || "nearby"} · ${distTxt}`);
  }
}

let lastMsg = "";
function setLiveMsg(text) {
  if (text !== lastMsg) { els.liveMsg.textContent = text; lastMsg = text; }
}

function drawCrosshair(ctx, W, H) {
  const s = Math.max(W, H) / 60;
  ctx.save();
  ctx.strokeStyle = state.calibrating ? "#00e5ff" : "rgba(255,255,255,0.7)";
  ctx.lineWidth = Math.max(1.5, s / 6);
  ctx.beginPath();
  ctx.moveTo(W / 2 - s, H / 2); ctx.lineTo(W / 2 + s, H / 2);
  ctx.moveTo(W / 2, H / 2 - s); ctx.lineTo(W / 2, H / 2 + s);
  ctx.stroke();
  ctx.restore();
}

function drawBeacon(ctx, x, y, label, W, dimmed) {
  const r = Math.max(12, W / 80);
  ctx.save();
  ctx.globalAlpha = dimmed ? 0.6 : 1;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = "#FF0000";
  ctx.fill();
  ctx.lineWidth = Math.max(2, r / 8);
  ctx.strokeStyle = "#FFFFFF";
  ctx.stroke();

  const fontPx = Math.max(16, r * 1.1);
  ctx.font = `bold ${fontPx}px system-ui, sans-serif`;
  ctx.lineWidth = fontPx / 5;
  ctx.strokeStyle = "rgba(0,0,0,0.8)";
  ctx.fillStyle = "#FFFFFF";
  const tx = x + r * 1.5, ty = y + fontPx / 3;
  ctx.strokeText(label, tx, ty);
  ctx.fillText(label, tx, ty);
  ctx.restore();
}

// Ring with a text label, used for saved landmarks and the pending top.
function drawRing(ctx, x, y, text, color, W) {
  const r = Math.max(10, W / 60);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2, r / 5);
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.font = `bold ${Math.max(14, r)}px system-ui, sans-serif`;
  ctx.lineWidth = Math.max(3, r / 4);
  ctx.strokeStyle = "rgba(0,0,0,0.8)";
  ctx.fillStyle = color;
  ctx.strokeText(text, x + r * 1.3, y + r * 0.4);
  ctx.fillText(text, x + r * 1.3, y + r * 0.4);
  ctx.restore();
}

// Each saved landmark at its position under the current calibration. If the calibration is
// consistent, every ring sits on its spot as the phone is panned.
function drawLandmarks(ctx, W, H) {
  const lm = state.profile.landmarks;
  const fit = fitCalibration(lm, state.profile.fovH);
  const aim = currentAim();
  lm.forEach((q, i) => {
    const bh = q.bh !== null && q.bh !== undefined ? q.bh : (fit.heights ? fit.heights[i] : 0);
    const p = project({
      user: state.user, target: { lat: q.tLat, lon: q.tLon }, heightDiffM: q.groundDiffM + bh,
      headingDeg: aim.heading, pitchDeg: aim.pitch, fovHDeg: state.profile.fovH, width: W, height: H,
    });
    if (p.inFrame) drawRing(ctx, p.x, p.y, `${i + 1} ${q.name.split(",")[0]}`, "#00e5ff", W);
  });
}

// The measured top, drawn at the height the user is confirming.
function drawPending(ctx, W, H) {
  const pend = state.pending;
  const aim = currentAim();
  const p = project({
    user: state.user, target: { lat: pend.point.tLat, lon: pend.point.tLon },
    heightDiffM: pend.point.groundDiffM + pend.bh,
    headingDeg: aim.heading, pitchDeg: aim.pitch, fovHDeg: state.profile.fovH, width: W, height: H,
  });
  if (p.inFrame) drawRing(ctx, p.x, p.y, "top?", "#ffb300", W);
}

// ---------- calibration: tap known landmarks ----------
// Each tapped spot is a known bearing, paired with the screen position the user tapped.
// Its elevation comes from terrain data (base of an object) or from the tap itself (top,
// once the pitch offset is known). geo.js fitCalibration() solves heading, FOV and pitch.

function applyFit(fit) {
  state.profile.headingOffset = fit.headingOffset;
  state.profile.pitchOffset = fit.pitchOffset;
  if (fit.count >= 2) state.profile.fovH = fit.fovH; // FOV can only be measured from two or more spots
}

function describeFit(fit) {
  const n = fit.count;
  const worst = Math.max(fit.residualH, fit.residualP);
  let text = `Calibration from ${n} landmark${n > 1 ? "s" : ""}: heading ${signed(fit.headingOffset)}, pitch ${signed(fit.pitchOffset)}, field of view ${state.profile.fovH.toFixed(1)}°`;
  text += n === 1 ? " (field of view assumed; add a second landmark to measure it)." : `. Landmarks disagree by up to ${worst.toFixed(1)}°.`;
  if (n < 3) text += " Adding more landmarks in other directions improves accuracy.";
  if (n >= 2 && worst > CAL_RESIDUAL_WARN) text += " These disagree a lot: undo the last landmark if it was a wrong tap.";
  return text;
}

els.canvas.addEventListener("click", (e) => {
  if (!state.calibrating || !state.calTarget || state.pending) return;
  const W = els.canvas.width, H = els.canvas.height;
  const rect = els.canvas.getBoundingClientRect();
  const tx = (e.clientX - rect.left) * (W / rect.width);
  const ty = (e.clientY - rect.top) * (H / rect.height);

  const a = rawAim();
  if (!a.sensorOn) {
    els.calHint.textContent = "The compass has no data right now. Move the phone and tap again.";
    return;
  }
  const target = state.calTarget;
  const isTop = state.calKind === "top";
  const point = {
    name: target.name, tLat: target.lat, tLon: target.lon,
    groundDiffM: groundDiffFor(target.ground),
    bh: isTop ? null : 0,      // ground spot: height above its ground is zero
    uLat: state.user.lat, uLon: state.user.lon,
    rawH: a.heading, rawP: a.pitch,
    dx: (tx - W / 2) / W,      // + = right of centre, as a fraction of width
    dy: -(ty - H / 2) / H,     // + = above centre, as a fraction of height
    aspect: H / W,
  };

  state.calibrating = false;
  const candidate = [...state.profile.landmarks, point];
  const fit = fitCalibration(candidate, state.profile.fovH);
  if (fit.error) {
    state.calTarget = null;
    els.calHint.textContent = isTop && fit.error.includes("ground level")
      ? "Tap the base of something first (ground level), so the app knows the pitch. Then measure tops."
      : `That tap does not fit the calibration: ${fit.error}. Try again, or check you tapped the right spot.`;
    renderSteps();
    return;
  }

  if (!isTop) {
    commitLandmark(candidate, fit);
    state.calTarget = null;
    els.calHint.textContent = describeFit(fit);
    renderSteps();
    return;
  }

  // Top: show the inferred height and let the user confirm it on the picture.
  state.pending = { point, bh: fit.heights[candidate.length - 1], adjusted: false };
  els.pendHeight.value = Math.round(state.pending.bh);
  els.pendOut.textContent = Math.round(state.pending.bh);
  const bh = Math.round(state.pending.bh);
  els.calHint.textContent = `Top measured at about ${bh} m above the ground. ` +
    (bh < -5 || bh > 300 ? "That is an unusual height, so check the tap. " : "") +
    "Move the ring onto the top with the slider if needed, then save.";
  renderSteps();
});

function commitLandmark(list, fit) {
  state.profile.landmarks = list;
  applyFit(fit);
  state.profile.calLat = state.user.lat;
  state.profile.calLon = state.user.lon;
  saveProfile();
}

els.pendHeight.addEventListener("input", () => {
  if (!state.pending) return;
  state.pending.bh = parseFloat(els.pendHeight.value);
  state.pending.adjusted = true;
  els.pendOut.textContent = els.pendHeight.value;
});

els.pendSave.addEventListener("click", () => {
  const pend = state.pending;
  if (!pend) return;
  // A top the user did not adjust keeps its height inferred from the tap, so it stays consistent
  // when later landmarks change the pitch offset. An adjusted top is a known height.
  const point = { ...pend.point, bh: pend.adjusted ? pend.bh : null };
  const candidate = [...state.profile.landmarks, point];
  const fit = fitCalibration(candidate, state.profile.fovH);
  if (fit.error) {
    els.calHint.textContent = `Could not save: ${fit.error}. Adjust the height or discard.`;
    return;
  }
  commitLandmark(candidate, fit);
  state.pending = null;
  state.calTarget = null;
  els.calHint.textContent = `Top saved at about ${Math.round(fit.heights[candidate.length - 1])} m. ${describeFit(fit)}`;
  renderSteps();
});

els.pendDiscard.addEventListener("click", () => {
  state.pending = null;
  state.calTarget = null;
  els.calHint.textContent = "Top discarded.";
  renderSteps();
});

els.showLandmarks.addEventListener("click", () => {
  state.showLandmarks = !state.showLandmarks;
  els.showLandmarks.textContent = state.showLandmarks ? "Hide landmarks" : "Show landmarks";
});

els.undoCal.addEventListener("click", () => {
  const lm = state.profile.landmarks;
  if (!lm.length) { els.calHint.textContent = "No landmarks to undo."; return; }
  lm.pop();
  if (lm.length) {
    const fit = fitCalibration(lm, state.profile.fovH);
    if (fit.error) {
      els.calHint.textContent = `Removed the last landmark. The rest no longer give a calibration (${fit.error}); offsets kept.`;
    } else {
      applyFit(fit);
      els.calHint.textContent = `Removed the last landmark. ${describeFit(fit)}`;
    }
  } else {
    state.profile.headingOffset = 0;
    state.profile.pitchOffset = 0;
    els.calHint.textContent = "Removed the last landmark. No calibration left.";
  }
  saveProfile();
});

// ---------- settings ----------

els.fov.addEventListener("input", () => {
  els.fovOut.textContent = els.fov.value;
  state.profile.fovH = parseFloat(els.fov.value);
  saveProfile();
});

els.height.addEventListener("input", () => {
  state.heightDiffM = parseFloat(els.height.value);
  els.heightOut.textContent = els.height.value;
});

els.resetCal.addEventListener("click", () => {
  state.profile = { ...defaultProfile(), fovH: state.profile.fovH };
  cancelCalibration();
  saveProfile();
  els.calHint.textContent = "Calibration reset for this device.";
  renderSteps();
});

// ---------- start ----------

(async function init() {
  state.device = await detectDevice();
  try {
    state.cameraId = localStorage.getItem("beacon:camera") || null;
    // Calibrations saved before cameras were distinguished move to the default key.
    const legacy = localStorage.getItem(`beacon:cal:${state.device}`);
    if (legacy !== null && localStorage.getItem(profileKeyFor(null)) === null) {
      localStorage.setItem(profileKeyFor(null), legacy);
    }
  } catch { /* storage unavailable */ }
  loadProfile();
  renderCalInfo();
  renderSteps();
  renderCandidates();
  requestAnimationFrame(frame);
  document.body.dataset.ready = "1"; // index.html shows a notice if this never happens
})();
