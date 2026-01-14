const http = require('http');
const fs = require('fs');
const path = require('path');
const { simulateRace } = require('./src/raceSimulator');
const { computeCumulative, projectToTrack, haversine } = require('./src/utils');

const PORT = process.env.PORT || 3030;

// Simple static file server for ./public
const publicDir = path.join(__dirname, 'public');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Static file handling
  const urlPath = (req.url || '/').split('?')[0];
  const relPath = (urlPath === '/' || urlPath === '') ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(publicDir, relPath);
  const resolved = path.resolve(filePath);

  // prevent path traversal
  if (!resolved.startsWith(path.resolve(publicDir))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end('Not found');
      return;
    }
    const ext = path.extname(resolved);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// WebSocket server
let wss;
try {
  const WebSocket = require('ws');
  wss = new WebSocket.Server({ server });
} catch (e) {
  console.error('Falta dependencia "ws". Ejecuta: npm install ws');
}

let currentSim = null;
let currentReal = null; // { track, cumulative, trackLength, startTime, expectedTotal, competitors: Map }

if (wss) {
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello', msg: 'connected' }));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', error: 'invalid_json' }));
        return;
      }

      if (msg.type === 'start') {
        const { track, competitors, avgDurationMs, tickMs, lateralSpreadMeters } = msg;
        if (!Array.isArray(track) || track.length < 2) {
          ws.send(JSON.stringify({ type: 'error', error: 'track_invalido' }));
          return;
        }
        if (!avgDurationMs || avgDurationMs <= 0) {
          ws.send(JSON.stringify({ type: 'error', error: 'avgDurationMs_invalido' }));
          return;
        }

        if (currentSim) {
          try { currentSim.stop(); } catch {}
          currentSim = null;
        }
        // stop real if running
        if (currentReal) currentReal = null;

        currentSim = simulateRace({ track, competitors, avgDurationMs, tickMs, lateralSpreadMeters });

        const onTick = (snapshot) => {
          const payload = { type: 'tick', snapshot };
          // broadcast to all clients
          wss.clients.forEach((client) => {
            if (client.readyState === 1) client.send(JSON.stringify(payload));
          });
        };
        const onEnd = () => {
          const payload = { type: 'end' };
          wss.clients.forEach((client) => {
            if (client.readyState === 1) client.send(JSON.stringify(payload));
          });
        };

        currentSim.on('tick', onTick);
        currentSim.on('end', onEnd);

        ws.send(JSON.stringify({ type: 'started' }));
      } else if (msg.type === 'start_real') {
        const { track, competitors } = msg; // competitors opcional: número esperado
        if (!Array.isArray(track) || track.length < 2) {
          ws.send(JSON.stringify({ type: 'error', error: 'track_invalido' }));
          return;
        }
        // stop simulated if running
        if (currentSim) {
          try { currentSim.stop(); } catch {}
          currentSim = null;
        }
        // init real state
        const cumulative = computeCumulative(track);
        const trackLength = cumulative[cumulative.length - 1] || 0;
        currentReal = {
          track,
          cumulative,
          trackLength,
          startTime: Date.now(),
          expectedTotal: Number.isFinite(competitors) && competitors > 0 ? competitors : null,
          competitors: new Map(), // id -> { id, lat, lon, distance, progress, speedMps, finished, lastTs, lastDistance }
        };
        ws.send(JSON.stringify({ type: 'started_real' }));
      } else if (msg.type === 'gps') {
        if (!currentReal) {
          ws.send(JSON.stringify({ type: 'error', error: 'real_no_iniciado' }));
          return;
        }
        const { id, lat, lon, ts } = msg;
        if (!id || typeof lat !== 'number' || typeof lon !== 'number') {
          ws.send(JSON.stringify({ type: 'error', error: 'gps_invalido' }));
          return;
        }
        const now = typeof ts === 'number' && ts > 0 ? ts : Date.now();
        const proj = projectToTrack(currentReal.track, currentReal.cumulative, { lat, lon });
        const existing = currentReal.competitors.get(id);
        const rec = existing || {
          id,
          lat,
          lon,
          distance: 0,
          progress: 0,
          speedMps: 0,
          finished: false,
          lastTs: null,
          lastDistance: null,
        };
        // compute proposed new distance along track
        let newDistRaw = Math.max(0, Math.min(currentReal.trackLength, proj.distance));
        // Heurística de inicio: si el primer punto cae muy cerca del inicio de pista
        // (y la pista está cerrada repitiendo el primer punto al final), evita arrancar en el final
        if (!existing) {
          const startPt = currentReal.track[0];
          const endPt = currentReal.track[currentReal.track.length - 1];
          const dStart = haversine({ lat, lon }, startPt);
          const dEnd = haversine({ lat, lon }, endPt);
          const NEAR = 5; // metros
          if (dStart <= NEAR && dEnd <= NEAR) {
            newDistRaw = 0; // coincide con ambos extremos, preferimos inicio
          } else if (dStart <= NEAR) {
            newDistRaw = 0;
          }
        }
        // monotonic clamp for distance (avoid regress when near vertices or noisy GPS)
        let newDist = Math.max(existing?.distance ?? 0, newDistRaw);
        // Tolerancia de meta: si está muy cerca del final, "snap" a trackLength
        const FIN_EPS = 5.0; // metros
        const lastVertex = currentReal.track[currentReal.track.length - 1];
        const dToEndVertex = haversine({ lat: proj.lat, lon: proj.lon }, lastVertex);
        if (existing && ((currentReal.trackLength - newDist) <= FIN_EPS || dToEndVertex <= FIN_EPS)) {
          newDist = currentReal.trackLength;
        }
        // compute speed from along-distance change (m/s)
        if (!existing?.finished && rec.lastTs != null && rec.lastDistance != null && now > rec.lastTs) {
          const dt = (now - rec.lastTs) / 1000;
          const dd = newDist - rec.lastDistance;
          rec.speedMps = dd / dt;
        }
        rec.lat = lat;
        rec.lon = lon;
        rec.distance = newDist;
        rec.progress = currentReal.trackLength === 0 ? 1 : newDist / currentReal.trackLength;
        rec.finished = existing?.finished || newDist >= currentReal.trackLength;
        rec.lastTs = now;
        rec.lastDistance = newDist;
        currentReal.competitors.set(id, rec);

        // Build and broadcast snapshot
        const arr = Array.from(currentReal.competitors.values()).map((c) => ({
          id: c.id,
          lat: c.lat,
          lon: c.lon,
          distance: c.distance,
          progress: c.progress,
          speedMps: c.speedMps || 0,
          finished: c.finished,
        }));
        const finishedCount = arr.filter((c) => c.finished).length;
        const total = currentReal.expectedTotal ?? arr.length;
        const snapshot = {
          t: Date.now() - currentReal.startTime,
          tickMs: null,
          competitors: arr,
          finishedCount,
          total,
        };
        const payload = { type: 'tick', snapshot };
        wss.clients.forEach((client) => {
          if (client.readyState === 1) client.send(JSON.stringify(payload));
        });

        // end if all finished and we know total
        if (currentReal.expectedTotal && finishedCount >= currentReal.expectedTotal) {
          const endPayload = { type: 'end' };
          wss.clients.forEach((client) => {
            if (client.readyState === 1) client.send(JSON.stringify(endPayload));
          });
          currentReal = null;
        }
      } else if (msg.type === 'stop') {
        if (currentSim) {
          try { currentSim.stop(); } catch {}
          currentSim = null;
        }
        if (currentReal) currentReal = null;
        const payload = { type: 'end' };
        wss.clients.forEach((client) => {
          if (client.readyState === 1) client.send(JSON.stringify(payload));
        });
      }
    });
  });
}

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
