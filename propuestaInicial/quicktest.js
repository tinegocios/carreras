const { simulateRace } = require('./src/raceSimulator');

const track = [
  { lat: 4.65178, lon: -74.05602 },
  { lat: 4.65178, lon: -74.05500 },
  { lat: 4.65178, lon: -74.05420 },
  { lat: 4.65178, lon: -74.05450 },
  { lat: 4.65178, lon: -74.05560 },
  { lat: 4.65178, lon: -74.05660 },
  { lat: 4.65178, lon: -74.05700 },
  { lat: 4.65178, lon: -74.05660 },
  { lat: 4.65178, lon: -74.05602 },
];

const sim = simulateRace({ track, competitors: 4, avgDurationMs: 5000, tickMs: 250, lateralSpreadMeters: 5 });
let ticks = 0;
sim.on('tick', (snap) => {
  ticks++;
  console.log(`[${(snap.t/1000).toFixed(1)}s]`);
  for (const c of snap.competitors) {
    console.log(
      `${c.id} ${(c.progress * 100).toFixed(1)}% @ (${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}) v=${c.speedMps.toFixed(2)}m/s ${c.finished ? '✓' : ''}`
    );
  }
  console.log('----');
  if (ticks >= 20) {
    sim.stop();
    console.log('Stopped after 20 ticks');
  }
});

sim.on('end', () => console.log('End')); 
