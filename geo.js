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

// Angle above horizon to a point at ground distance distM and height heightDiffM above the
// observer's eye, minus Earth curvature and refraction (full spec §6.2.2, k = 0.13).
export function elevationDeg(distM, heightDiffM) {
  const curvatureDeg = toDeg((distM / (2 * R)) * (1 - REFRACTION_K));
  return toDeg(Math.atan2(heightDiffM, distM)) - curvatureDeg;
}

// Inverse of elevationDeg: the height difference that gives elevation angle elevDeg at distM.
export function heightForElevation(distM, elevDeg) {
  const curvatureDeg = toDeg((distM / (2 * R)) * (1 - REFRACTION_K));
  return distM * Math.tan(toRad(elevDeg + curvatureDeg));
}

// Flat-plane projection of the target onto the photo.
//   headingDeg : camera azimuth, true north = 0, clockwise positive
//   pitchDeg   : camera tilt, 0 = horizon, positive = looking up
//   heightDiffM: target height minus observer eye height (metres)
export function project({ user, target, heightDiffM, headingDeg, pitchDeg, fovHDeg, width, height }) {
  const dist = distanceM(user.lat, user.lon, target.lat, target.lon);
  const bearing = bearingDeg(user.lat, user.lon, target.lat, target.lon);
  const dTheta = wrap180(bearing - headingDeg); // horizontal offset from image centre
  const elev = elevationDeg(dist, heightDiffM);
  const dPhi = elev - pitchDeg; // vertical offset from image centre

  const fovV = fovVDeg(fovHDeg, width, height);
  const ppdH = width / fovHDeg; // pixels per degree
  const ppdV = height / fovV;

  const x = width / 2 + dTheta * ppdH;
  const y = height / 2 - dPhi * ppdV;
  const inFrame = x >= 0 && x <= width && y >= 0 && y <= height;

  return { dist, bearing, dTheta, elev, dPhi, x, y, inFrame };
}

// Calibration from landmarks the user can see and has tapped.
// Each point:
//   uLat, uLon : user position when tapped
//   tLat, tLon : landmark position (map)
//   groundDiffM: ground height at the landmark minus eye height at the user (metres), from terrain data
//   bh         : height of the tapped spot above the landmark's ground (m), or null if unknown
//   rawH, rawP : sensor aim at the tap (true heading, pitch) before any correction
//   dx         : tapped x offset from image centre, as a fraction of image width  (+ = right)
//   dy         : tapped y offset from image centre, as a fraction of image height (+ = up)
//   aspect     : image height / width
//
// Model: the true angle to the tapped spot is the screen angle, so
//   dx * F = (bearing - rawH) - headingOffset      (horizontal, F = horizontal FOV)
//   dy * fovV = elevation - (rawP + pitchOffset)   (vertical)
// Heading and FOV use every point (horizontal angles do not depend on height). The pitch offset
// uses only points whose height is known, since their elevation is then known. A point with
// unknown height gets its height inferred from its tap once the pitch offset is known.
//
// With 2+ points, F and headingOffset come from a least-squares line fit; with 1 point, F is
// taken from fovFallbackDeg. Returns
//   { fovH, headingOffset, pitchOffset, residualH, residualP, count, heights }
// where heights[i] is the spot's height above the landmark's ground (known or inferred), or { error }.
export function fitCalibration(points, fovFallbackDeg) {
  const n = points.length;
  if (!n) return { error: "no points" };
  const obs = points.map((q) => {
    const dist = distanceM(q.uLat, q.uLon, q.tLat, q.tLon);
    const known = q.bh !== null && q.bh !== undefined;
    return {
      dist,
      D: wrap180(bearingDeg(q.uLat, q.uLon, q.tLat, q.tLon) - q.rawH),
      known,
      hDiff: known ? q.groundDiffM + q.bh : null,
      groundDiffM: q.groundDiffM,
      rawP: q.rawP, dx: q.dx, dy: q.dy, aspect: q.aspect,
    };
  });

  let fov, headingOffset;
  if (n === 1) {
    fov = fovFallbackDeg;
    headingOffset = obs[0].D - fov * obs[0].dx;
  } else {
    // Solve dx_i = a * D_i - c with a = 1/F and c = a * headingOffset.
    let sD = 0, sDD = 0, sx = 0, sDx = 0;
    for (const o of obs) { sD += o.D; sDD += o.D * o.D; sx += o.dx; sDx += o.D * o.dx; }
    const det = -n * sDD + sD * sD;
    if (Math.abs(det) < 1e-6 * Math.max(n * sDD, 1)) return { error: "landmarks are all in the same direction" };
    const a = (-n * sDx + sD * sx) / det;
    const c = (sDD * sx - sD * sDx) / det;
    if (!(a > 0)) return { error: "tapped spots do not fit a camera" };
    fov = 1 / a;
    headingOffset = c / a;
  }
  if (fov < 30 || fov > 110) return { error: `field of view ${fov.toFixed(0)}° is implausible` };

  const fovVs = obs.map((o) => fovVDeg(fov, 1, o.aspect));
  const ref = obs.filter((o) => o.known);
  if (!ref.length) return { error: "needs one landmark at ground level or with a known height first" };
  let pitchOffset = 0;
  ref.forEach((o) => {
    const i = obs.indexOf(o);
    pitchOffset += (elevationDeg(o.dist, o.hDiff) - o.rawP - o.dy * fovVs[i]) / ref.length;
  });

  // Heights of unknown spots, from the tap under the fitted pitch offset.
  const heights = obs.map((o, i) => {
    if (o.known) return o.hDiff - o.groundDiffM;
    const elev = o.rawP + pitchOffset + o.dy * fovVs[i];
    return heightForElevation(o.dist, elev) - o.groundDiffM;
  });

  let residualH = 0, residualP = 0;
  obs.forEach((o, i) => {
    residualH = Math.max(residualH, Math.abs((o.D - headingOffset) - fov * o.dx));
    if (o.known) residualP = Math.max(residualP, Math.abs((elevationDeg(o.dist, o.hDiff) - o.rawP - pitchOffset) - o.dy * fovVs[i]));
  });

  // Pitch is physically limited; heading is not bounded (an uncalibrated phone can be far off).
  headingOffset = wrap180(headingOffset);
  if (Math.abs(pitchOffset) > 45) return { error: `pitch correction ${pitchOffset.toFixed(0)}° is too large` };
  return { fovH: fov, headingOffset, pitchOffset, residualH, residualP, count: n, heights };
}
