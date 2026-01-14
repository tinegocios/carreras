// Usage: node tools/generateOval.js <centerLat> <centerLon> <semiMajorMeters> <semiMinorMeters> <points> [rotationDeg]
// Outputs JSON array [{lat, lon}, ...] to stdout representing an oval track.

function toRad(d){return d*Math.PI/180}
function toDeg(r){return r*180/Math.PI}
const R=6371000
function displace(lat, lon, east, north){
  const dLat = (north / R) * (180 / Math.PI);
  const dLon = (east / (R * Math.cos(toRad(lat)))) * (180 / Math.PI);
  return { lat: lat + dLat, lon: lon + dLon };
}

const [,, latStr, lonStr, aStr, bStr, nStr, rotStr] = process.argv;
if (!latStr || !lonStr) {
  console.error('Usage: node tools/generateOval.js <centerLat> <centerLon> <semiMajorMeters> <semiMinorMeters> <points>');
  process.exit(1);
}
const lat0 = parseFloat(latStr);
const lon0 = parseFloat(lonStr);
const a = parseFloat(aStr ?? '600'); // semi-major (east-west) in meters
const b = parseFloat(bStr ?? '350'); // semi-minor (north-south) in meters
const N = parseInt(nStr ?? '80', 10);
const rot = ((parseFloat(rotStr ?? '0') || 0) * Math.PI) / 180; // rotation clockwise from east axis

const pts = [];
for (let i=0;i<N;i++){
  const t = (i / N) * 2 * Math.PI;
  // ellipse param before rotation
  const ex = a * Math.cos(t);
  const ny = b * Math.sin(t);
  // rotate by rot (clockwise positive)
  const east = ex * Math.cos(rot) + ny * Math.sin(rot);
  const north = -ex * Math.sin(rot) + ny * Math.cos(rot);
  const p = displace(lat0, lon0, east, north);
  pts.push({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) });
}
// close loop by repeating first point
pts.push(pts[0]);
process.stdout.write(JSON.stringify(pts, null, 2));
