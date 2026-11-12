import { project } from "./geo.js";

const $ = (id) => document.getElementById(id);
const els = {
  photo: $("photo"), place: $("place"), search: $("search"),
  locate: $("locate"), compass: $("compass"), useHeading: $("useHeading"),
  heading: $("heading"), pitch: $("pitch"), fov: $("fov"), height: $("height"),
  status: $("status"), message: $("message"), canvas: $("result"),
};

const state = {
  image: null,      // HTMLImageElement of the chosen photo
  user: null,       // { lat, lon, accuracy }
  target: null,     // { lat, lon, name }
  liveHeading: null // latest compass reading, degrees
};

const setStatus = (text) => { els.status.textContent = text; };

// Keep the slider readouts in sync.
for (const [input, out] of [[els.heading, "headingOut"], [els.pitch, "pitchOut"], [els.fov, "fovOut"], [els.height, "heightOut"]]) {
  input.addEventListener("input", () => { $(out).textContent = input.value; render(); });
}

// 1. Photo
els.photo.addEventListener("change", () => {
  const file = els.photo.files[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => { state.image = img; setStatus(`Photo loaded (${img.naturalWidth}×${img.naturalHeight}).`); render(); URL.revokeObjectURL(img.src); };
  img.src = URL.createObjectURL(file);
});

// 2. Target search via Nominatim (OpenStreetMap)
els.search.addEventListener("click", async () => {
  const q = els.place.value.trim();
  if (!q) return setStatus("Type a place or address first.");
  setStatus("Searching…");
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { "Accept-Language": navigator.language || "en" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const hits = await res.json();
    if (!hits.length) { state.target = null; setStatus("No place found."); return render(); }
    const hit = hits[0];
    state.target = { lat: parseFloat(hit.lat), lon: parseFloat(hit.lon), name: hit.display_name };
    setStatus(`Target: ${state.target.name}\n(${state.target.lat.toFixed(5)}, ${state.target.lon.toFixed(5)})`);
    render();
  } catch (err) {
    setStatus(`Search failed: ${err.message}`);
  }
});

// 3a. GPS
els.locate.addEventListener("click", () => {
  if (!navigator.geolocation) return setStatus("Geolocation not supported.");
  setStatus("Getting GPS fix…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.user = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
      setStatus(`You: (${state.user.lat.toFixed(5)}, ${state.user.lon.toFixed(5)}) ±${Math.round(state.user.accuracy)} m`);
      render();
    },
    (err) => setStatus(`GPS error: ${err.message}`),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
});

// 3b. Compass (heading). iOS needs an explicit permission request from a user gesture.
els.compass.addEventListener("click", async () => {
  try {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      const p = await DeviceOrientationEvent.requestPermission();
      if (p !== "granted") return setStatus("Orientation permission denied.");
    }
    const handler = (e) => {
      if (typeof e.webkitCompassHeading === "number") state.liveHeading = e.webkitCompassHeading; // iOS
      else if (e.absolute && typeof e.alpha === "number") state.liveHeading = (360 - e.alpha) % 360; // Android
      else return;
    };
    window.addEventListener("deviceorientationabsolute", handler);
    window.addEventListener("deviceorientation", handler);
    setStatus("Compass on. Press \"Use current heading\" to copy the live value.");
  } catch (err) {
    setStatus(`Compass error: ${err.message}`);
  }
});

els.useHeading.addEventListener("click", () => {
  if (state.liveHeading == null) return setStatus("No compass reading yet.");
  els.heading.value = Math.round(state.liveHeading);
  $("headingOut").textContent = els.heading.value;
  render();
});

// Draw the photo and, if everything is known, the beacon.
function render() {
  const c = els.canvas;
  const ctx = c.getContext("2d");
  if (!state.image) {
    c.width = 0; c.height = 0; els.message.textContent = ""; return;
  }
  const W = state.image.naturalWidth, H = state.image.naturalHeight;
  c.width = W; c.height = H;
  ctx.drawImage(state.image, 0, 0, W, H);

  if (!state.target || !state.user) {
    els.message.textContent = !state.target ? "Search a target." : "Get your GPS position.";
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
    drawBeacon(ctx, p.x, p.y, distTxt);
  } else {
    const hint = [];
    if (p.dTheta < 0) hint.push(`${Math.abs(p.dTheta).toFixed(0)}° to the left`);
    if (p.dTheta > 0) hint.push(`${p.dTheta.toFixed(0)}° to the right`);
    if (p.dPhi > 0) hint.push(`${p.dPhi.toFixed(0)}° above`);
    if (p.dPhi < 0) hint.push(`${Math.abs(p.dPhi).toFixed(0)}° below`);
    els.message.textContent = `Target out of frame: ${hint.join(", ")} · ${distTxt}`;
    // Show the clamped position so you can see roughly where it is.
    const cx = Math.min(Math.max(p.x, 0), W), cy = Math.min(Math.max(p.y, 0), H);
    drawBeacon(ctx, cx, cy, distTxt, true);
  }
}

function drawBeacon(ctx, x, y, label, dimmed = false) {
  const r = Math.max(10, state.image.naturalWidth / 100); // scale with image size
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

render();
