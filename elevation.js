// Ground elevation (metres above sea level) from Open-Meteo's free elevation endpoint
// (no API key, CORS enabled). Results are cached in localStorage, rounded to ~10 m,
// since terrain does not change.
//
// Privacy: a lookup sends the coordinates of the spot (the user's position and the place
// being looked at) to api.open-meteo.com. Coordinates are rounded to 4 decimals before sending.

const ENDPOINT = "https://api.open-meteo.com/v1/elevation";
const KEY_PREFIX = "beacon:elev:";

function cacheKey(lat, lon) {
  return `${KEY_PREFIX}${lat.toFixed(4)},${lon.toFixed(4)}`;
}

function readCache(lat, lon) {
  try {
    const v = localStorage.getItem(cacheKey(lat, lon));
    return v === null ? null : parseFloat(v);
  } catch { return null; }
}

function writeCache(lat, lon, value) {
  try { localStorage.setItem(cacheKey(lat, lon), String(value)); } catch { /* storage full or disabled */ }
}

// Resolves to a number of metres, or null if the lookup failed (no network, service down).
export async function groundElevation(lat, lon) {
  const cached = readCache(lat, lon);
  if (cached !== null && !Number.isNaN(cached)) return cached;
  try {
    const url = `${ENDPOINT}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = await res.json();
    const value = Array.isArray(body.elevation) ? body.elevation[0] : null;
    if (typeof value !== "number" || Number.isNaN(value)) return null;
    writeCache(lat, lon, value);
    return value;
  } catch {
    return null;
  }
}
