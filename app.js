import { project, fovVDeg, cameraVector, vectorToAim, blendVector, wrap180, distanceM } from "./geo.js";
import { declinationDeg } from "./vendor/declination.js";

const $ = (id) => document.getElementById(id);
const els = {
  stepItems: [...document.querySelectorAll("#stepper li")],
  cards: [...document.querySelectorAll(".step")],
  place: $("place"), search: $("search"), candidates: $("candidates"), hintTarget: $("hint-target"),
  startAccess: $("start-access"), hintAccess: $("hint-access"), deviceLine: $("device-line"),
  stCam: $("st-cam"), stGps: $("st-gps"), stSensor: $("st-sensor"),
  cam: $("cam"), canvas: $("live"), liveMsg: $("liveMsg"),
  calibrate: $("calibrate"), calHint: $("cal-hint"), calInfo: $("cal-info"), resetCal: $("reset-cal"),
  fov: $("fov"), fovOut: $("fovOut"), height: $("height"), heightOut: $("heightOut"),
  back: $("back"), next: $("next"), progressFill: $("progress-fill"),
};

const STEP_TARGET = 0, STEP_ACCESS = 1, STEP_LIVE = 2;
const SENSOR_SMOOTHING = 0.2;   // 0..1, lower = smoother but laggier
const SENSOR_TIMEOUT_MS = 1000; // no sensor event for this long = compass considered inactive
const CAL_MAX_CORRECTION = 30;  // larger corrections are rejected as a likely wrong tap
const MAX_DISTANCE_M = 70000;   // flat-plane model is only valid to ~70 km (LTP/MVP spec gate)

// Bump when the meaning of saved offsets changes. Version 1 offsets were calibrated
// without declination and are discarded on load.
const PROFILE_VERSION = 2;
const DEFAULT_PROFILE = { version: PROFILE_VERSION, headingOffset: 0, pitchOffset: 0, fovH: 70, calLat: null, calLon: null };

const state = {
  step: STEP_TARGET,
  candidates: [],
  target: null,        // { lat, lon, name }
  user: null,          // { lat, lon }
  gpsAccuracy: null,
  stream: null,
  cameraOk: false,
  gpsOk: false,
  vec: null,           // smoothed camera direction vector
  lastSensor: 0,
  calibrating: false,
  device: "unknown device",
  profile: { ...DEFAULT_PROFILE },
  heightDiffM: 0,
  declDeg: 0,          // magnetic declination at the user's position (east positive)
};

// ---------- device profile (saved calibration) ----------

function profileKey() { return `beacon:cal:${state.device}`; }

function loadProfile() {
  try {
    const raw = localStorage.getItem(profileKey());
    const saved = raw ? JSON.parse(raw) : null;
    state.profile = saved && saved.version === PROFILE_VERSION
      ? { ...DEFAULT_PROFILE, ...saved }
      : { ...DEFAULT_PROFILE, fovH: saved && saved.fovH ? saved.fovH : DEFAULT_PROFILE.fovH };
  } catch {
    state.profile = { ...DEFAULT_PROFILE };
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

// Declination is applied automatically now; the calibration offset only covers
// device/phone bias. Far from the calibration spot, the bias itself may differ, so
// the panel suggests recalibrating.
const CAL_MAX_DISTANCE_M = 50000;

function renderCalInfo() {
  const p = state.profile;
  els.calInfo.textContent =
    `Device: ${state.device}\nHeading correction ${p.headingOffset.toFixed(1)}°, pitch correction ${p.pitchOffset.toFixed(1)}°, field of view ${p.fovH}°.`;
  const hasCal = p.headingOffset || p.pitchOffset;
  let line = `Device: ${state.device}. ` +
    (hasCal ? "Saved calibration found and applied." : "No calibration yet. Calibrate on the target once you can see it.");
  if (hasCal && p.calLat != null && state.user &&
      distanceM(p.calLat, p.calLon, state.user.lat, state.user.lon) > CAL_MAX_DISTANCE_M) {
    line += " You are far from where it was calibrated. Recalibrate here.";
  }
  els.deviceLine.textContent = line;
}

// ---------- navigation ----------

function canAdvance() {
  if (state.step === STEP_TARGET) return !!state.target;
  if (state.step === STEP_ACCESS) return state.cameraOk && state.gpsOk;
  return false;
}

function goTo(step) {
  state.step = Math.max(STEP_TARGET, Math.min(STEP_LIVE, step));
  renderSteps();
}

function renderSteps() {
  const s = state.step;
  els.cards.forEach((c) => c.classList.toggle("on", Number(c.dataset.step) === s));
  els.stepItems.forEach((li, i) => {
    li.classList.toggle("current", i === s);
    li.classList.toggle("done", i < s);
  });
  els.progressFill.style.width = `${(s / (STEP_LIVE)) * 100}%`;
  els.back.disabled = s === STEP_TARGET;
  els.next.style.display = s === STEP_LIVE ? "none" : "";
  els.next.disabled = !canAdvance();
  els.next.textContent = s === STEP_ACCESS ? "Go live" : "Next";
  els.canvas.classList.toggle("calibrating", state.calibrating);
}

els.back.addEventListener("click", () => goTo(state.step - 1));
els.next.addEventListener("click", async () => {
  if (state.step === STEP_ACCESS) {
    goTo(STEP_LIVE);
    renderCalInfo();
    return;
  }
  goTo(state.step + 1);
});

// ---------- step 1: target search ----------

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
    btn.addEventListener("click", () => {
      state.target = c;
      els.hintTarget.textContent = `Target set: ${c.name}`;
      renderCandidates();
      renderSteps();
    });
    li.appendChild(btn);
    els.candidates.appendChild(li);
  });
}

// ---------- step 2: camera, GPS, orientation ----------

els.startAccess.addEventListener("click", startAccess);

async function startAccess() {
  els.hintAccess.textContent = "";
  els.startAccess.disabled = true;

  // Camera: needs HTTPS (or localhost). Requested from this click so mobile browsers accept it.
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("camera API unavailable (open the page over HTTPS)");
    }
    if (!state.stream) {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } }, audio: false,
      });
      els.cam.srcObject = state.stream;
    }
    await els.cam.play();
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
        state.gpsAccuracy = pos.coords.accuracy;
        state.declDeg = declinationDeg(pos.coords.latitude, pos.coords.longitude);
        state.gpsOk = true;
        els.stGps.textContent = `±${Math.round(pos.coords.accuracy)} m`;
        els.stGps.className = pos.coords.accuracy > 30 ? "warn" : "ok";
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

// Current aim with saved corrections applied, in the same frame as the video.
function currentAim() {
  const sensorOn = state.vec && performance.now() - state.lastSensor < SENSOR_TIMEOUT_MS;
  const raw = sensorOn ? vectorToAim(state.vec) : { heading: 0, pitch: 0 };
  // Sensor heading is magnetic north; add declination to get true north (spec §3.2).
  return {
    sensorOn,
    heading: (raw.heading + state.declDeg + state.profile.headingOffset + 720) % 360,
    pitch: raw.pitch + state.profile.pitchOffset,
  };
}

function projectTarget(W, H) {
  return project({
    user: state.user,
    target: state.target,
    heightDiffM: state.heightDiffM,
    headingDeg: currentAim().heading,
    pitchDeg: currentAim().pitch,
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

  // The 70° field of view only holds for the sensor's long side, so the overlay is landscape-only.
  if (window.matchMedia("(orientation: portrait)").matches) return setLiveMsg("Rotate your phone to landscape.");
  if (!state.target) return setLiveMsg("No target chosen. Go back to step 1.");
  if (!state.user) return setLiveMsg("Waiting for GPS…");
  if (!state.vec) return setLiveMsg("Waiting for compass… (move the phone)");
  if (!currentAim().sensorOn) return setLiveMsg("Compass stopped sending data. Move the phone or restart sensors.");

  const p = projectTarget(W, H);
  const distTxt = p.dist >= 1000 ? `${(p.dist / 1000).toFixed(2)} km` : `${Math.round(p.dist)} m`;
  if (p.dist > MAX_DISTANCE_M) return setLiveMsg(`Target is ${distTxt} away. Beyond the ${MAX_DISTANCE_M / 1000} km limit of this model.`);
  const label = `${state.target.name.split(",")[0]} · ${distTxt}`;

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

// ---------- calibration: tap the target building ----------

els.calibrate.addEventListener("click", () => {
  if (!state.target || !state.user || !state.vec) {
    els.calHint.textContent = "Need the target, GPS and compass before calibrating.";
    return;
  }
  state.calibrating = !state.calibrating;
  els.calibrate.textContent = state.calibrating ? "Cancel calibration" : "Calibrate on target";
  els.calHint.textContent = state.calibrating
    ? "Line up the crosshair with the middle of the target building, then tap it on the picture."
    : "";
  renderSteps();
});

els.canvas.addEventListener("click", (e) => {
  if (!state.calibrating) return;
  const W = els.canvas.width, H = els.canvas.height;
  const rect = els.canvas.getBoundingClientRect();
  const tx = (e.clientX - rect.left) * (W / rect.width);
  const ty = (e.clientY - rect.top) * (H / rect.height);

  const p = projectTarget(W, H);            // where the target is relative to current (corrected) aim
  const ppdH = W / state.profile.fovH;
  const ppdV = H / fovVDeg(state.profile.fovH, W, H);
  const tapTheta = (tx - W / 2) / ppdH;     // where the tapped point really is, relative to centre
  const tapPhi = -(ty - H / 2) / ppdV;

  const corrH = wrap180(p.dTheta - tapTheta);
  const corrP = p.dPhi - tapPhi;

  state.calibrating = false;
  els.calibrate.textContent = "Calibrate on target";
  if (Math.abs(corrH) > CAL_MAX_CORRECTION || Math.abs(corrP) > CAL_MAX_CORRECTION) {
    els.calHint.textContent =
      `That correction would be ${corrH.toFixed(0)}° / ${corrP.toFixed(0)}°, which is too large. ` +
      "Probably the wrong spot was tapped. Try again, or check the target is the building you see.";
    renderSteps();
    return;
  }
  state.profile.headingOffset = wrap180(state.profile.headingOffset + corrH);
  state.profile.pitchOffset += corrP;
  state.profile.calLat = state.user.lat;
  state.profile.calLon = state.user.lon;
  saveProfile();
  els.calHint.textContent =
    `Calibrated: heading ${corrH >= 0 ? "+" : ""}${corrH.toFixed(1)}°, pitch ${corrP >= 0 ? "+" : ""}${corrP.toFixed(1)}°. Saved for this device.`;
  renderSteps();
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
  state.profile = { ...DEFAULT_PROFILE, fovH: state.profile.fovH };
  saveProfile();
  els.calHint.textContent = "Calibration reset for this device.";
});

// ---------- start ----------

(async function init() {
  state.device = await detectDevice();
  loadProfile();
  renderCalInfo();
  renderSteps();
  requestAnimationFrame(frame);
  document.body.dataset.ready = "1"; // index.html shows a notice if this never happens
})();
