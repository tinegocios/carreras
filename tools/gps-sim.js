#!/usr/bin/env node
// Simple GPS simulator: sends coordinates step-by-step on ENTER to a WebSocket server
// Usage: node tools/gps-sim.js --url ws://localhost:3000 --id C1 --file ./coords.json [--steps N] [--post-steps K]

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--id') out.id = argv[++i];
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--steps') out.steps = parseInt(argv[++i], 10);
    else if (a === '--post-steps') out.postSteps = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.url || !args.id || !args.file) {
    console.log('Usage: node tools/gps-sim.js --url ws://localhost:3000 --id C1 --file ./coords.json [--steps N] [--post-steps K]');
    process.exit(1);
  }
  const raw = fs.readFileSync(path.resolve(args.file), 'utf8');
  let coords = JSON.parse(raw);
  if (!Array.isArray(coords) || coords.length === 0) throw new Error('Invalid JSON: expected array of {lat, lon}');
  coords = coords.filter(p => typeof p.lat === 'number' && typeof p.lon === 'number');
  if (coords.length === 0) throw new Error('No valid coordinates');

  // Optional resampling to N steps uniformly along distance
  const { computeCumulative, interpolateAlong, haversine, bearing, displace } = require('../src/utils');
  let baseTrackForDelta = null; // track used to compute step length and bearing
  let stepLenMeters = null;     // per-step along-track distance
  let endBearing = null;        // bearing of the final segment (radians)

  if (Number.isFinite(args.steps)) {
    if (args.steps < 2) throw new Error('--steps must be >= 2');
    // If last equals first (closed loop repeated vertex), drop last to avoid zero-length segment
    const first = coords[0];
    const last = coords[coords.length - 1];
    try {
      const close = haversine(first, last) <= 1; // meters
      const track = close && coords.length > 2 ? coords.slice(0, -1) : coords.slice();
      const cumulative = computeCumulative(track);
      const total = cumulative[cumulative.length - 1] || 0;
      if (total > 0) {
        const N = args.steps;
        const out = [];
        for (let i = 0; i < N; i++) {
          const d = (i * total) / (N - 1);
          const p = interpolateAlong(track, cumulative, d);
          out.push({ lat: +p.lat, lon: +p.lon });
        }
        coords = out;
        baseTrackForDelta = track;
        stepLenMeters = total / (N - 1);
        // estimate end bearing from last two resampled points
        if (coords.length >= 2) endBearing = bearing(coords[coords.length - 2], coords[coords.length - 1]);
      } // else keep original coords if degenerate
    } catch (e) {
      console.warn('Resampling failed, using original coordinates:', e.message);
    }
  }

  // If not resampled, compute stepLen from original coords for overshoot purposes
  if (!Number.isFinite(stepLenMeters)) {
    const first = coords[0];
    const last = coords[coords.length - 1];
    const close = haversine(first, last) <= 1; // meters
    const track = close && coords.length > 2 ? coords.slice(0, -1) : coords.slice();
    baseTrackForDelta = track;
    const cumulative = computeCumulative(track);
    const total = cumulative[cumulative.length - 1] || 0;
    if (total > 0 && track.length >= 2) {
      stepLenMeters = total / (track.length - 1);
      endBearing = bearing(track[track.length - 2], track[track.length - 1]);
    }
  }

  // Optional post-finish overshoot steps
  const postSteps = Number.isFinite(args.postSteps) && args.postSteps > 0 ? args.postSteps : 0;
  if (postSteps > 0 && stepLenMeters && endBearing != null && coords.length >= 1) {
    const last = coords[coords.length - 1];
    for (let j = 1; j <= postSteps; j++) {
      const dist = stepLenMeters * j;
      const north = dist * Math.cos(endBearing);
      const east = dist * Math.sin(endBearing);
      const p = displace(last.lat, last.lon, east, north);
      coords.push({ lat: +p.lat, lon: +p.lon });
    }
  }

  const WebSocket = require('ws');
  const ws = new WebSocket(args.url);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  console.log(`Connected to ${args.url}. Ready to send for id=${args.id}`);
  if (Number.isFinite(args.steps)) console.log(`Resampled steps: ${args.steps}`);
  if (postSteps > 0 && stepLenMeters) console.log(`Post-steps: ${postSteps} (delta ~ ${stepLenMeters.toFixed(2)} m)`);
  console.log('Press ENTER to send next coordinate. Ctrl+C to exit.');

  let idx = 0;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', () => {
    if (idx >= coords.length) {
      console.log('No more coordinates.');
      return;
    }
    const p = coords[idx++];
    const msg = { type: 'gps', id: args.id, lat: p.lat, lon: p.lon, ts: Date.now() };
    ws.send(JSON.stringify(msg));
    console.log(`Sent ${idx}/${coords.length}: ${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`);
  });
}

main().catch((e) => {
  console.error('gps-sim error:', e.message);
  process.exit(1);
});
