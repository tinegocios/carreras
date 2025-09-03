// Geodesic helpers for race simulation (CommonJS)
// Distances in meters, angles in radians unless noted

const R = 6371000; // Earth radius in meters

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

// Haversine distance in meters
function haversine(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = lat2 - lat1;
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return R * c;
}

// Initial bearing from a to b, radians (0 = north, clockwise)
function bearing(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return Math.atan2(y, x); // returns in range [-pi, pi]
}

// Given an array of points [{lat, lon}], compute cumulative distances per vertex
function computeCumulative(track) {
  const cum = [0];
  for (let i = 1; i < track.length; i++) {
    cum[i] = cum[i - 1] + haversine(track[i - 1], track[i]);
  }
  return cum;
}

// Interpolate along the polyline by distance d from start, return {lat, lon, segIndex, bearing}
function interpolateAlong(track, cumulative, d) {
  const total = cumulative[cumulative.length - 1];
  if (d <= 0) return { ...track[0], segIndex: 0, bearing: bearing(track[0], track[1]) };
  if (d >= total) {
    const last = track.length - 1;
    return { ...track[last], segIndex: last - 1, bearing: bearing(track[last - 1], track[last]) };
  }
  // find segment: cumulative[i] <= d < cumulative[i+1]
  let i = 0;
  // Linear scan is fine for small tracks; binary search for long tracks
  let lo = 0, hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (cumulative[mid] <= d) lo = mid + 1; else hi = mid;
  }
  i = Math.max(0, lo - 1);
  const segStart = track[i];
  const segEnd = track[i + 1];
  const segLen = cumulative[i + 1] - cumulative[i];
  const along = (d - cumulative[i]) / segLen;

  // Simple geographic interpolation (lerp in lat/lon); for short segments it's fine
  const lat = segStart.lat + (segEnd.lat - segStart.lat) * along;
  const lon = segStart.lon + (segEnd.lon - segStart.lon) * along;
  const brg = bearing(segStart, segEnd);
  return { lat, lon, segIndex: i, bearing: brg };
}

// Apply local EN displacement (east, north in meters) at given lat/lon
function displace(lat, lon, east, north) {
  const dLat = (north / R) * (180 / Math.PI);
  const dLon = (east / (R * Math.cos(toRad(lat)))) * (180 / Math.PI);
  return { lat: lat + dLat, lon: lon + dLon };
}

// Apply lateral offset (meters) perpendicular to segment bearing
function applyLateralOffset(lat, lon, brgRad, offsetMeters) {
  const perp = brgRad + Math.PI / 2; // +90 degrees
  const north = offsetMeters * Math.cos(perp);
  const east = offsetMeters * Math.sin(perp);
  return displace(lat, lon, east, north);
}

module.exports = {
  R,
  toRad,
  toDeg,
  haversine,
  bearing,
  computeCumulative,
  interpolateAlong,
  displace,
  applyLateralOffset,
  projectToTrack,
};

// Project an arbitrary point {lat, lon} to the closest point on the polyline `track`.
// Returns { distance, lat, lon, segIndex, bearing, distToTrack } where `distance`
// is meters from start along the polyline and `distToTrack` is the lateral distance in meters.
function projectToTrack(track, cumulative, point) {
  if (!Array.isArray(track) || track.length < 2) {
    throw new Error('track inválido');
  }
  let best = null;
  const EPS = 1e-6; // for tie-breaking on distances
  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i];
    const b = track[i + 1];
    // Local EN frame at segment start a
    const lat0 = a.lat;
    const lon0 = a.lon;
    // Convert to local meters (approx equirectangular)
    const wE = (point.lon - lon0) * Math.cos(toRad(lat0)) * (Math.PI / 180) * R;
    const wN = (point.lat - lat0) * (Math.PI / 180) * R;
    const vE = (b.lon - lon0) * Math.cos(toRad(lat0)) * (Math.PI / 180) * R;
    const vN = (b.lat - lat0) * (Math.PI / 180) * R;
    const vLen2 = vE * vE + vN * vN;
    if (vLen2 === 0) continue;
    const t = Math.max(0, Math.min(1, (wE * vE + wN * vN) / vLen2));
    const pE = t * vE;
    const pN = t * vN;
    const dE = wE - pE;
    const dN = wN - pN;
    const distOff = Math.hypot(dE, dN);
    const segLen = cumulative[i + 1] - cumulative[i];
    const along = cumulative[i] + t * segLen;
    const proj = displace(lat0, lon0, pE, pN);
    const brg = bearing(a, b);
    if (!best || distOff < best.distToTrack - EPS) {
      best = { distance: along, lat: proj.lat, lon: proj.lon, segIndex: i, bearing: brg, distToTrack: distOff };
    } else if (Math.abs(distOff - best.distToTrack) <= EPS) {
      // Tie-break: prefer the candidate with larger along-distance (avoids wrapping to 0 at closed-loop start)
      if (along > best.distance) {
        best = { distance: along, lat: proj.lat, lon: proj.lon, segIndex: i, bearing: brg, distToTrack: distOff };
      }
    }
  }
  // Fallback
  if (!best) {
    const brg = bearing(track[0], track[1]);
    return { distance: 0, lat: track[0].lat, lon: track[0].lon, segIndex: 0, bearing: brg, distToTrack: 0 };
  }
  return best;
}
