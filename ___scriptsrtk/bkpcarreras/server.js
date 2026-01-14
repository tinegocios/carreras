const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { simulateRace } = require('./src/raceSimulator');
const { computeCumulative, projectToTrack, haversine } = require('./src/utils');
const { parseNmeaSentence } = require('./src/nmea');

const PORT = process.env.PORT || 3030;
const MODE = (() => {
  if (process.env.MODE) return String(process.env.MODE).toLowerCase();
  const arg = process.argv.find((a) => a.startsWith('--mode='));
  if (arg) return arg.split('=')[1].toLowerCase();
  return 'competition';
})();
const isTesting = MODE === 'testing';

// Simple static file server for ./public
const publicDir = path.join(__dirname, isTesting ? 'public-testing' : 'public');
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

  if (req.method === 'POST' && urlPath === '/api/gps') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.connection.destroy();
    });
    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'json_invalido' }));
        return;
      }
      const result = handleGpsUpdate(payload);
      if (!result.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: result.error || 'gps_invalido' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    });
    req.on('error', () => {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'lectura_fallida' }));
    });
    return;
  }

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

const logsDir = path.join(__dirname, 'logs');
const nmeaLogPath = path.join(logsDir, 'nmea.log');

function ensureLogsDir() {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
  } catch (err) {
    console.error(`No se pudo crear el directorio de logs (${logsDir}): ${err.message}`);
  }
}

function appendNmeaLog(line) {
  ensureLogsDir();
  fs.appendFile(nmeaLogPath, `${line}\n`, (err) => {
    if (err) console.error(`No se pudo escribir en ${nmeaLogPath}: ${err.message}`);
  });
}

function broadcastToClients(obj) {
  if (!wss) return;
  const data = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(data);
  });
}

function handleGpsUpdate(payload, sendError) {
  if (isTesting) {
    const { id, lat, lon, ts, fix, nm } = payload || {};
    const fixNum = Number.isFinite(fix) ? fix : (Number.isFinite(Number(fix)) ? Number(fix) : null);
    const nmNum = Number.isFinite(nm) ? nm : (Number.isFinite(Number(nm)) ? Number(nm) : null);
    if (!id || typeof lat !== 'number' || Number.isNaN(lat) || typeof lon !== 'number' || Number.isNaN(lon)) {
      if (sendError) sendError('gps_invalido');
      return { ok: false, error: 'gps_invalido' };
    }
    const now = Number.isFinite(ts) && ts > 0 ? ts : Date.now();
    const message = {
      id,
      lat,
      lon,
      ts: now,
      fix: fixNum,
      nm: nmNum,
    };
    broadcastToClients({ type: 'gps', data: message });
    return { ok: true, data: message };
  }

  const { id, lat, lon, ts, fix, nm } = payload || {};
  const fixNum = Number.isFinite(fix) ? fix : (Number.isFinite(Number(fix)) ? Number(fix) : null);
  const nmNum = Number.isFinite(nm) ? nm : (Number.isFinite(Number(nm)) ? Number(nm) : null);

  if (!currentReal) {
    if (sendError) sendError('real_no_iniciado');
    return { ok: false, error: 'real_no_iniciado' };
  }
  if (!id || typeof lat !== 'number' || Number.isNaN(lat) || typeof lon !== 'number' || Number.isNaN(lon)) {
    if (sendError) sendError('gps_invalido');
    return { ok: false, error: 'gps_invalido' };
  }
  const now = Number.isFinite(ts) && ts > 0 ? ts : Date.now();
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
    fix: fixNum,
    nm: nmNum,
  };
  let newDistRaw = Math.max(0, Math.min(currentReal.trackLength, proj.distance));
  if (!existing) {
    const startPt = currentReal.track[0];
    const endPt = currentReal.track[currentReal.track.length - 1];
    const dStart = haversine({ lat, lon }, startPt);
    const dEnd = haversine({ lat, lon }, endPt);
    const NEAR = 5; // metros
    if (dStart <= NEAR && dEnd <= NEAR) {
      newDistRaw = 0;
    } else if (dStart <= NEAR) {
      newDistRaw = 0;
    }
  }
  let newDist = Math.max(existing?.distance ?? 0, newDistRaw);
  const FIN_EPS = 5.0; // metros
  const lastVertex = currentReal.track[currentReal.track.length - 1];
  const dToEndVertex = haversine({ lat: proj.lat, lon: proj.lon }, lastVertex);
  if (existing && ((currentReal.trackLength - newDist) <= FIN_EPS || dToEndVertex <= FIN_EPS)) {
    newDist = currentReal.trackLength;
  }
  if (!existing?.finished && rec.lastTs != null && rec.lastDistance != null && now > rec.lastTs) {
    const dt = (now - rec.lastTs) / 1000;
    const dd = newDist - rec.lastDistance;
    rec.speedMps = dt > 0 ? dd / dt : rec.speedMps;
  }
  rec.lat = lat;
  rec.lon = lon;
  rec.distance = newDist;
  rec.progress = currentReal.trackLength === 0 ? 1 : newDist / currentReal.trackLength;
  rec.finished = existing?.finished || newDist >= currentReal.trackLength;
  rec.lastTs = now;
  rec.lastDistance = newDist;
  rec.fix = fixNum ?? (existing?.fix ?? null);
  rec.nm = nmNum ?? (existing?.nm ?? null);
  currentReal.competitors.set(id, rec);

  const arr = Array.from(currentReal.competitors.values()).map((c) => ({
    id: c.id,
    lat: c.lat,
    lon: c.lon,
    distance: c.distance,
    progress: c.progress,
    speedMps: c.speedMps || 0,
    finished: c.finished,
    fix: Number.isFinite(c.fix) ? c.fix : null,
    nm: Number.isFinite(c.nm) ? c.nm : null,
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
  broadcastToClients({ type: 'tick', snapshot });

  if (currentReal.expectedTotal && finishedCount >= currentReal.expectedTotal) {
    broadcastToClients({ type: 'end' });
    currentReal = null;
  }

  return { ok: true, snapshot };
}

function handleNmeaInput({ raw, deviceId, ip }) {
  if (!raw) return;
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  const trimmed = text.trim();
  if (!trimmed) return;

  const parseResult = parseNmeaSentence(trimmed);
  const labelId = deviceId || 'sin-id';
  const stamp = new Date();

  if (!parseResult.ok) {
    const meta = parseResult.meta ? ` ${JSON.stringify(parseResult.meta)}` : '';
    appendNmeaLog(`${stamp.toISOString()} ip=${ip || 'desconocido'} id=${labelId} raw="${trimmed}" -> ERROR ${parseResult.error}${meta}`);
    return;
  }

  const gpsPayload = {
    id: deviceId || ip || 'gps-sin-id',
    lat: parseResult.lat,
    lon: parseResult.lon,
    ts: Date.now(),
    fix: Number.isFinite(parseResult.fixQuality) ? parseResult.fixQuality : null,
    nm: parseResult.sequence ?? null,
  };
  const result = handleGpsUpdate(gpsPayload);
  const logData = {
    type: parseResult.type,
    lat: parseResult.lat,
    lon: parseResult.lon,
    altitude: parseResult.altitude ?? null,
    satellites: parseResult.satellites ?? null,
    fix: Number.isFinite(parseResult.fixQuality) ? parseResult.fixQuality : null,
    nm: parseResult.sequence ?? null,
    handled: result.ok,
    error: result.ok ? null : result.error,
  };
  appendNmeaLog(
    `${stamp.toISOString()} ip=${ip || 'desconocido'} id=${labelId} raw="${trimmed}" -> ${JSON.stringify(logData)}`,
  );
}

if (wss) {
  wss.on('connection', (ws, req) => {
    let mode = 'control';
    let deviceId = null;
    try {
      const fullUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      mode = fullUrl.pathname === '/nmea' ? 'nmea' : 'control';
      deviceId = fullUrl.searchParams.get('id');
    } catch (err) {
      console.error(`No se pudo interpretar la URL de conexión WS: ${err.message}`);
    }
    const remoteIp = req.socket?.remoteAddress || 'desconocido';

    if (mode === 'nmea') {
      ws.send(JSON.stringify({ type: 'hello', msg: isTesting ? 'connected_nmea_testing' : 'connected_nmea', id: deviceId || null }));
    } else {
      ws.send(JSON.stringify({ type: 'hello', msg: isTesting ? 'connected_testing' : 'connected' }));
    }

    ws.on('message', (raw) => {
      if (mode === 'nmea') {
        handleNmeaInput({ raw, deviceId, ip: remoteIp });
        return;
      }

      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', error: 'invalid_json' }));
        return;
      }

      if (isTesting) {
        if (msg.type === 'gps') {
          const sendError = (error) => {
            ws.send(JSON.stringify({ type: 'error', error }));
          };
          handleGpsUpdate(msg, sendError);
        } else {
          ws.send(JSON.stringify({ type: 'error', error: 'modo_testing_no_permite_esta_operacion' }));
        }
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
        if (currentReal) currentReal = null;

        currentSim = simulateRace({ track, competitors, avgDurationMs, tickMs, lateralSpreadMeters });

        const onTick = (snapshot) => {
          broadcastToClients({ type: 'tick', snapshot });
        };
        const onEnd = () => {
          broadcastToClients({ type: 'end' });
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
        if (currentSim) {
          try { currentSim.stop(); } catch {}
          currentSim = null;
        }
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
        const sendError = (error) => {
          ws.send(JSON.stringify({ type: 'error', error }));
        };
        handleGpsUpdate(msg, sendError);
      } else if (msg.type === 'stop') {
        if (currentSim) {
          try { currentSim.stop(); } catch {}
          currentSim = null;
        }
        if (currentReal) currentReal = null;
        broadcastToClients({ type: 'end' });
      }
    });
  });
}

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT} (mode=${isTesting ? 'testing' : 'competition'})`);
});
