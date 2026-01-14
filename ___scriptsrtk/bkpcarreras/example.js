// Ejemplo de uso del simulador de carreras
const { simulateRace } = require('./src/raceSimulator');

// Pista de ejemplo (un circuito simple en torno a un punto)
// Reemplaza por tu propia lista de puntos [{lat, lon}, ...]
const track = [
  { lat: 4.65178, lon: -74.05602 },
  { lat: 4.65220, lon: -74.05500 },
  { lat: 4.65280, lon: -74.05420 },
  { lat: 4.65360, lon: -74.05450 },
  { lat: 4.65420, lon: -74.05560 },
  { lat: 4.65370, lon: -74.05660 },
  { lat: 4.65290, lon: -74.05700 },
  { lat: 4.65190, lon: -74.05660 },
  { lat: 4.65178, lon: -74.05602 }, // cerrar loop
];

const competitors = 6;
const avgDurationMs = 2 * 60 * 1000; // 2 minutos
const tickMs = 250; // por defecto 250ms

const sim = simulateRace({ track, competitors, avgDurationMs, tickMs, lateralSpreadMeters: 7 });

sim.on('tick', (snapshot) => {
  const { t, competitors } = snapshot;
  const secs = (t / 1000).toFixed(1);
  const lines = competitors
    .map((c) => {
      const pct = (c.progress * 100).toFixed(1);
      return `${c.id} ${pct}% @ (${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}) v=${c.speedMps.toFixed(2)}m/s ${c.finished ? '✓' : ''}`;
    })
    .join(' | ');
  console.log(`[${secs}s] ${lines}`);
});

sim.on('end', () => {
  console.log('Carrera finalizada.');
});

