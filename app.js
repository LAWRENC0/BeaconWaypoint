import { project } from "./geo.js";

const $ = (id) => document.getElementById(id);
const els = {
  photo: $("photo"), place: $("place"), search: $("search"), candidates: $("candidates"),
  hintTarget: $("hint-target"), locate: $("locate"), hintUser: $("hint-user"),
  compass: $("compass"), useHeading: $("useHeading"), hintAim: $("hint-aim"),
  heading: $("heading"), pitch: $("pitch"), fov: $("fov"), height: $("height"),
  stage: $("stage"), canvas: $("result"), message: $("message"),
  back: $("back"), next: $("next"),
  stepItems: [...document.querySelectorAll("#stepper li")],
  stepCards: [...document.querySelectorAll(".step")],
};

const STEP_PHOTO = 0, STEP_TARGET = 1, STEP_USER = 2, STEP_AIM = 3, STEP_RESULT = 4;
const LAST_STEP = STEP_RESULT;

const state = {
  step: STEP_PHOTO,
  image: null,       // HTMLImageElement
  candidates: [],    // search results
  target: null,      // chosen { lat, lon, name }
  user: null,        // { lat, lon, accuracy }
  liveHeading: null, // latest compass reading
  compassOn: false,
};

// ---------- navigation ----------

function canAdvance() {
  switch (state.step) {
    case STEP_PHOTO: return !!state.image;
    case STEP_TARGET: return !!state.target;
    case STEP_USER: return !!state.user;
    case STEP_AIM: return true;
    default: return false;
  }
}

function goTo(step) {
  state.step = Math.max(0, Math.min(LAST_STEP, step));
  renderSteps();
}

function renderSteps() {
  const s = state.step;
  els.stepCards.forEach((card) => card.classList.toggle("on", Number(card.dataset.step) === s));
  els.stepItems.forEach((li, i) => {
    li.classList.toggle("current", i === s);
    li.classList.toggle("done", i < s);
  });
  els.back.disabled = s === STEP_PHOTO;
  els.next.disabled = !canAdvance();
  els.next.textContent =
    s === STEP_AIM ? "See result" :
    s === STEP_RESULT ? "Start over" : "Next";
  els.stage.classList.toggle("on", s >= STEP_AIM && !!state.image);
  if (s === STEP_RESULT) els.stage.classList.add("on");
  drawPreview();
}

els.back.addEventListener("click", () => goTo(state.step - 1));
els.next.addEventListener("click", () => {
  if (state.step === STEP_RESULT) return reset();
  goTo(state.step + 1);
});

function reset() {
  state.image = null; state.candidates = []; state.target = null; state.user = null;
  els.photo.value = ""; els.place.value = ""; els.candidates.innerHTML = "";
  els.hintTarget.textContent = ""; els.hintUser.textContent = "";
  goTo(STEP_PHOTO);
}

// ---------- slider readouts ----------

for (const [input, out] of [[els.heading, "headingOut"], [els.pitch, "pitchOut"], [els.fov, "fovOut"], [els.height, "heightOut"]]) {
  input.addEventListener("input", () => { $(out).textContent = input.value; drawPreview(); });
}

// ---------- step 1: photo ----------

els.photo.addEventListener("change", () => {
  const file = els.photo.files[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(img.src);
    state.image = img;
    renderSteps();
  };
  img.src = URL.createObjectURL(file);
});

// ---------- step 2: target search (several candidates) ----------

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
    renderCandidates();
  } catch (err) {
    els.hintTarget.textContent = `Search failed: ${err.message}`;
  }
}

function renderCandidates() {
  els.candidates.innerHTML = "";
  state.candidates.forEach((c) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-pressed", String(state.target && state.target.name === c.name));
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

// ---------- step 3: GPS ----------

els.locate.addEventListener("click", () => {
  if (!navigator.geolocation) { els.hintUser.textContent = "This browser has no location support."; return; }
  els.hintUser.textContent = "Getting your position…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.user = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
      els.hintUser.textContent = `Position found (±${Math.round(state.user.accuracy)} m accuracy).`;
      renderSteps();
    },
    (err) => { els.hintUser.textContent = `Could not get position: ${err.message}`; },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
});

// ---------- step 4: compass ----------

els.compass.addEventListener("click", async () => {
  try {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      const p = await DeviceOrientationEvent.requestPermission();
      if (p !== "granted") { setAimHint("Compass permission denied. Set the heading by hand."); return; }
    }
    if (!state.compassOn) {
      const handler = (e) => {
        if (typeof e.webkitCompassHeading === "number") state.liveHeading = e.webkitCompassHeading; // iOS
        else if (e.absolute && typeof e.alpha === "number") state.liveHeading = (360 - e.alpha) % 360; // Android
      };
      window.addEventListener("deviceorientationabsolute", handler);
      window.addEventListener("deviceorientation", handler);
      state.compassOn = true;
    }
    setAimHint("Compass on. Press \"Use live compass\" to copy the reading.");
  } catch (err) {
    setAimHint(`Compass error: ${err.message}`);
  }
});

els.useHeading.addEventListener("click", () => {
  if (state.liveHeading == null) { setAimHint("No compass reading yet. Enable the compass first."); return; }
  els.heading.value = Math.round(state.liveHeading);
  $("headingOut").textContent = els.heading.value;
  setAimHint("");
  drawPreview();
});

function setAimHint(text) {
  els.hintAim.textContent = text;
}

// ---------- preview / beacon ----------

function drawPreview() {
  const ctx = els.canvas.getContext("2d");
  if (!state.image) { els.canvas.width = 0; els.canvas.height = 0; return; }
  const W = state.image.naturalWidth, H = state.image.naturalHeight;
  els.canvas.width = W; els.canvas.height = H;
  ctx.drawImage(state.image, 0, 0, W, H);

  if (state.step < STEP_AIM) return;

  if (!state.target || !state.user) {
    els.message.textContent = !state.target
      ? "No target chosen yet. Go back to step 2."
      : "No position yet. Go back to step 3.";
    return;
  }

  const p = project({
    user: state.user,
    target: state.target,
    heightDiffM: parseFloat(els.height.value),
    headingDeg: parseFloat(els.heading.value),
    pitchDeg: parseFloat(els.pitch.value),
    fovHDeg: parseFloat(els.fov.value),
    width: W,
    height: H,
  });

  const distTxt = p.dist >= 1000 ? `${(p.dist / 1000).toFixed(2)} km` : `${Math.round(p.dist)} m`;

  if (p.inFrame) {
    els.message.textContent = `Target in frame · ${distTxt}`;
    drawBeacon(ctx, p.x, p.y, `${state.target.name.split(",")[0]} · ${distTxt}`, false);
  } else {
    const hint = [];
    if (p.dTheta < -1) hint.push(`turn ${Math.abs(p.dTheta).toFixed(0)}° left`);
    if (p.dTheta > 1) hint.push(`turn ${p.dTheta.toFixed(0)}° right`);
    if (p.dPhi > 1) hint.push(`tilt ${p.dPhi.toFixed(0)}° up`);
    if (p.dPhi < -1) hint.push(`tilt ${Math.abs(p.dPhi).toFixed(0)}° down`);
    els.message.textContent = `Target out of frame: ${hint.join(", ") || "adjust sliders"} · ${distTxt}`;
    const cx = Math.min(Math.max(p.x, 0), W), cy = Math.min(Math.max(p.y, 0), H);
    drawBeacon(ctx, cx, cy, `${state.target.name.split(",")[0]} · ${distTxt}`, true);
  }
}

function drawBeacon(ctx, x, y, label, dimmed) {
  const r = Math.max(10, state.image.naturalWidth / 100);
  ctx.save();
  ctx.globalAlpha = dimmed ? 0.6 : 1;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = "#FF0000";
  ctx.fill();
  ctx.lineWidth = Math.max(2, r / 8);
  ctx.strokeStyle = "#FFFFFF";
  ctx.stroke();

  const fontPx = Math.max(14, r * 1.1);
  ctx.font = `bold ${fontPx}px system-ui, sans-serif`;
  ctx.lineWidth = fontPx / 5;
  ctx.strokeStyle = "rgba(0,0,0,0.8)";
  ctx.fillStyle = "#FFFFFF";
  const tx = x + r * 1.5, ty = y + fontPx / 3;
  ctx.strokeText(label, tx, ty);
  ctx.fillText(label, tx, ty);
  ctx.restore();
}

renderSteps();
