// Pure geometry helpers: no DOM, no browser APIs. Safe to test in isolation.

const R = 6371000; // mean Earth radius, metres
const REFRACTION_K = 0.13; // standard atmospheric refraction coefficient
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

// Great-circle distance (haversine), metres.
export function distanceM(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Initial (forward azimuth) bearing from point 1 to point 2, degrees clockwise from true north, 0..360.
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

// Normalise an angle difference to [-180, 180).
export function wrap180(angle) {
  return ((((angle + 180) % 360) + 360) % 360) - 180;
}

// Vertical field of view from horizontal FOV and image aspect (rectilinear model).
export function fovVDeg(fovHDeg, width, height) {
  return toDeg(2 * Math.atan((height / width) * Math.tan(toRad(fovHDeg) / 2)));
}

// Direction the back camera is pointing, in an East/North/Up frame, from the W3C
// DeviceOrientation Euler angles (alpha about Z, beta about X, gamma about Y).
// The back camera looks along the device's -Z axis.
export function cameraVector(alphaDeg, betaDeg, gammaDeg) {
  const a = toRad(alphaDeg), b = toRad(betaDeg), g = toRad(gammaDeg);
  return {
    east: -Math.sin(g) * Math.cos(a) - Math.cos(g) * Math.sin(b) * Math.sin(a),
    north: -Math.sin(g) * Math.sin(a) + Math.cos(g) * Math.sin(b) * Math.cos(a),
    up: -Math.cos(g) * Math.cos(b),
  };
}

// Compass heading (0 = north, clockwise) and pitch (0 = horizon, + = up) of a direction vector.
export function vectorToAim(v) {
  return {
    heading: (toDeg(Math.atan2(v.east, v.north)) + 360) % 360,
    pitch: toDeg(Math.atan2(v.up, Math.hypot(v.east, v.north))),
  };
}

// Exponential smoothing of direction vectors (avoids heading wrap-around problems).
export function blendVector(prev, next, k) {
  if (!prev) return next;
  const e = prev.east + k * (next.east - prev.east);
  const n = prev.north + k * (next.north - prev.north);
  const u = prev.up + k * (next.up - prev.up);
  const len = Math.hypot(e, n, u) || 1;
  return { east: e / len, north: n / len, up: u / len };
}

// Flat-plane projection of the target onto the photo.
//   headingDeg : camera azimuth, true north = 0, clockwise positive
//   pitchDeg   : camera tilt, 0 = horizon, positive = looking up
//   heightDiffM: target height minus observer height (metres), 0 if unknown
export function project({ user, target, heightDiffM, headingDeg, pitchDeg, fovHDeg, width, height }) {
  const dist = distanceM(user.lat, user.lon, target.lat, target.lon);
  const bearing = bearingDeg(user.lat, user.lon, target.lat, target.lon);
  const dTheta = wrap180(bearing - headingDeg); // horizontal offset from image centre
  // Angle above horizon to target, minus Earth curvature and refraction (full spec §6.2.2, k = 0.13).
  const curvatureDeg = toDeg((dist / (2 * R)) * (1 - REFRACTION_K));
  const elev = toDeg(Math.atan2(heightDiffM, dist)) - curvatureDeg;
  const dPhi = elev - pitchDeg; // vertical offset from image centre

  const fovV = fovVDeg(fovHDeg, width, height);
  const ppdH = width / fovHDeg; // pixels per degree
  const ppdV = height / fovV;

  const x = width / 2 + dTheta * ppdH;
  const y = height / 2 - dPhi * ppdV;
  const inFrame = x >= 0 && x <= width && y >= 0 && y <= height;

  return { dist, bearing, dTheta, elev, dPhi, x, y, inFrame };
}
