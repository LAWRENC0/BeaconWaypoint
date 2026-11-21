import { project, fovVDeg, cameraVector, vectorToAim, blendVector, wrap180, distanceM, fitCalibration } from "./geo.js";
import { declinationDeg } from "./vendor/declination.js";

const $ = (id) => document.getElementById(id);
const els = {
  stepItems: [...document.querySelectorAll("#stepper li")],
  cards: [...document.querySelectorAll(".step")],
  targetCard: document.querySelector('.step[data-step="0"]'),
  targetTitle: $("target-title"), targetLead: $("target-lead"),
  place: $("place"), search: $("search"), candidates: $("candidates"), hintTarget: $("hint-target"),
  changeTarget: $("change-target"), sheetDone: $("sheet-done"), targetLine: $("target-line"),
  calHeight: $("cal-height"), fullscreen: $("fullscreen"),
  startAccess: $("start-access"), hintAccess: $("hint-access"), deviceLine: $("device-line"),
  stCam: $("st-cam"), stGps: $("st-gps"), stSensor: $("st-sensor"),
  cam: $("cam"), canvas: $("live"), liveMsg: $("liveMsg"),
  calibrate: $("calibrate"), calHint: $("cal-hint"), calInfo: $("cal-info"), resetCal: $("reset-cal"), undoCal: $("undo-cal"),
  fov: $("fov"), fovOut: $("fovOut"), height: $("height"), heightOut: $("heightOut"),
  back: $("back"), next: $("next"), progressFill: $("progress-fill"),
};

const STEP_TARGET = 0, STEP_ACCESS = 1, STEP_LIVE = 2;
const SENSOR_SMOOTHING = 0.2;      // 0..1, lower = smoother but laggier
const SENSOR_TIMEOUT_MS = 1000;    // no sensor event for this long = compass considered inactive
const MAX_DISTANCE_M = 70000;      // flat-plane model is only valid to ~70 km (LTP/MVP spec gate)
const CAL_MAX_DISTANCE_M = 50000;  // calibration is flagged when used farther than this from where it was made
const CAL_RESIDUAL_WARN = 3;       // degrees: landmarks disagreeing by more than this are flagged

// Profile versions:
//   2: one global heading/pitch offset
//   3: per-tap points (replaced by landmarks)
//   4: landmarks the user identified and tapped; offsets and FOV are fitted from them
const PROFILE_VERSION = 4;
function defaultProfile() {
  return { version: PROFILE_VERSION, fovH: 70, headingOffset: 0, pitchOffset: 0, landmarks: [], calLat: null, calLon: null };
}

const state = {
  step: STEP_TARGET,
  candidates: [],
  target: null,        // { lat, lon, name }
  user: null,          // { lat, lon }
  stream: null,
  cameraOk: false,
  gpsOk: false,
  vec: null,           // smoothed camera direction vector
  lastSensor: 0,
  sheetOpen: false,    // target picker shown over the live view
  sheetMode: "target", // "target" = choose what to find; "cal" = choose a landmark to calibrate on
  calibrating: false,  // waiting for a tap on the calibration landmark
  calTarget: null,     // landmark being tapped during calibration
  calHeight: 0,        // landmark height above the user's eyes (m), entered in the sheet
  device: "unknown device",
  profile: defaultProfile(),
  heightDiffM: 0,
  declDeg: 0,          // magnetic declination at the user's position (east positive)
};

// ---------- device profile (saved calibration) ----------

function profileKey() { return `beacon:cal:${state.device}`; }

function loadProfile() {
  let saved = null;
  try {
    const raw = localStorage.getItem(profileKey());
    saved = raw ? JSON.parse(raw) : null;
  } catch { saved = null; }

  const fresh = defaultProfile();
  if (saved && saved.version === PROFILE_VERSION) {
    state.profile = { ...fresh, ...saved, landmarks: Array.isArray(saved.landmarks) ? saved.landmarks : [] };
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
  if (state.step !== STEP_LIVE) { state.sheetOpen = false; state.calibrating = false; state.calTarget = null; }
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
  els.calibrate.textContent = state.calibrating ? "Cancel calibration" : "Calibrate with landmarks";
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
  state.calibrating = false;
  state.calTarget = null;
  els.calHint.textContent = "";
  renderCandidates();
  renderSteps();
}

els.changeTarget.addEventListener("click", () => openSheet("target"));
els.sheetDone.addEventListener("click", () => { state.sheetOpen = false; renderSteps(); });

els.calibrate.addEventListener("click", () => {
  if (state.calibrating) {
    state.calibrating = false;
    state.calTarget = null;
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

function pickCandidate(c) {
  if (state.sheetMode === "cal" && state.step === STEP_LIVE && state.sheetOpen) {
    // Calibration: this place is a landmark to tap, not the navigation target.
    state.calTarget = c;
    state.calHeight = parseFloat(els.calHeight.value) || 0;
    state.calibrating = true;
    state.sheetOpen = false;
    els.calHint.textContent = "";
    renderCandidates();
    renderSteps();
    return;
  }
  state.target = c;
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

function projectTarget(W, H, target) {
  const aim = currentAim();
  return project({
    user: state.user,
    target,
    heightDiffM: state.calibrating ? state.calHeight : state.heightDiffM,
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

  const p = projectTarget(W, H, target);
  const distTxt = p.dist >= 1000 ? `${(p.dist / 1000).toFixed(2)} km` : `${Math.round(p.dist)} m`;
  if (state.calibrating) {
    // Landmark tapping: show where it should be, but do not treat it as the navigation target.
    if (p.dist > MAX_DISTANCE_M) return setLiveMsg(`${target.name.split(",")[0]} is too far to use as a landmark (${distTxt}).`);
  } else if (p.dist > MAX_DISTANCE_M) {
    return setLiveMsg(`Target is ${distTxt} away. Beyond the ${MAX_DISTANCE_M / 1000} km limit of this model.`);
  }
  const label = `${target.name.split(",")[0]} · ${distTxt}`;

  if (p.inFrame) {
    drawBeacon(ctx, p.x, p.y, label, W, false);
    setLiveMsg(state.calibrating ? `Tap "${target.name.split(",")[0]}" on the picture · ${distTxt}` : `On target · ${distTxt}`);
  } else {
    const cx = Math.min(Math.max(p.x, 0), W), cy = Math.min(Math.max(p.y, 0), H);
    drawBeacon(ctx, cx, cy, label, W, true);
    const hint = [];
    if (p.dTheta < -1) hint.push(`turn ${Math.abs(p.dTheta).toFixed(0)}° left`);
    if (p.dTheta > 1) hint.push(`turn ${p.dTheta.toFixed(0)}° right`);
    if (p.dPhi > 1) hint.push(`tilt ${p.dPhi.toFixed(0)}° up`);
    if (p.dPhi < -1) hint.push(`tilt ${Math.abs(p.dPhi).toFixed(0)}° down`);
    setLiveMsg(`${state.calibrating ? "Landmark" : "Target"} ${hint.join(", ") || "nearby"} · ${distTxt}`);
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

// ---------- calibration: tap known landmarks ----------
// Each tapped landmark is a known bearing and elevation, paired with the screen position
// the user tapped. geo.js fitCalibration() solves heading offset, pitch offset and FOV.

function refitProfile(landmarks) {
  const fit = fitCalibration(landmarks, state.profile.fovH);
  if (fit.error) return fit;
  state.profile.headingOffset = fit.headingOffset;
  state.profile.pitchOffset = fit.pitchOffset;
  if (fit.count >= 2) state.profile.fovH = fit.fovH; // FOV can only be measured from two or more landmarks
  return fit;
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
  if (!state.calibrating || !state.calTarget) return;
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
  const point = {
    name: target.name, tLat: target.lat, tLon: target.lon, hDiff: state.calHeight,
    uLat: state.user.lat, uLon: state.user.lon,
    rawH: a.heading, rawP: a.pitch,
    dx: (tx - W / 2) / W,      // + = right of centre, as a fraction of width
    dy: -(ty - H / 2) / H,     // + = above centre, as a fraction of height
    aspect: H / W,
  };

  state.calibrating = false;
  state.calTarget = null;
  const candidate = [...state.profile.landmarks, point];
  const fit = fitCalibration(candidate, state.profile.fovH);
  if (fit.error) {
    els.calHint.textContent = `That tap does not fit the calibration: ${fit.error}. Try the landmark again, or check you tapped the right spot.`;
    renderSteps();
    return;
  }
  state.profile.landmarks = candidate;
  refitProfile(candidate);
  state.profile.calLat = state.user.lat;
  state.profile.calLon = state.user.lon;
  saveProfile();
  els.calHint.textContent = describeFit(fit);
  renderSteps();
});

els.undoCal.addEventListener("click", () => {
  const lm = state.profile.landmarks;
  if (!lm.length) { els.calHint.textContent = "No landmarks to undo."; return; }
  lm.pop();
  if (lm.length) {
    refitProfile(lm);
    els.calHint.textContent = `Removed the last landmark. ${describeFit(fitCalibration(lm, state.profile.fovH))}`;
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
  saveProfile();
  els.calHint.textContent = "Calibration reset for this device.";
});

// ---------- start ----------

(async function init() {
  state.device = await detectDevice();
  loadProfile();
  renderCalInfo();
  renderSteps();
  renderCandidates();
  requestAnimationFrame(frame);
  document.body.dataset.ready = "1"; // index.html shows a notice if this never happens
})();
