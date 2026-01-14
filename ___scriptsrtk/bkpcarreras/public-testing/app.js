const DEFAULT_CENTER = [20.029821, -98.785156];
const markers = new Map();
const colorMap = new Map();
const latestData = new Map();
const trails = new Map();

let map;

function colorForIndex(i) {
  const hue = Math.round((i * 137.508) % 360);
  return `hsl(${hue}, 75%, 50%)`;
}

function colorFor(id) {
  if (!colorMap.has(id)) {
    const idx = colorMap.size;
    colorMap.set(id, colorForIndex(idx));
  }
  return colorMap.get(id);
}

function letterFor(id) {
  return (id || '?').toString().slice(0, 2).toUpperCase();
}

function fixLabel(fix) {
  if (!Number.isFinite(fix)) return 'sin datos';
  const FIX_LABELS = {
    0: 'sin fix',
    1: 'GPS',
    2: 'DGPS',
    3: 'PPS',
    4: 'RTK',
    5: 'RTK float',
    6: 'Dead reckoning',
    7: 'Manual',
    8: 'Simulado',
    9: 'WAAS',
  };
  return `${fix} · ${FIX_LABELS[fix] || 'desconocido'}`;
}

function ensureMarker(id, lat, lon, fix) {
  const color = colorFor(id);
  const label = letterFor(id);
  const html = `<div class="runner ${Number.isFinite(fix) && fix <= 0 ? 'no-fix' : ''}" style="background:${color};"><span>${label}</span></div>`;
  const icon = L.divIcon({ className: '', html, iconSize: [26, 26], iconAnchor: [13, 13] });

  if (!markers.has(id)) {
    const marker = L.marker([lat, lon], { icon });
    marker.addTo(map);
    markers.set(id, marker);
  } else {
    markers.get(id).setLatLng([lat, lon]);
    markers.get(id).setIcon(icon);
  }

  const markerEl = markers.get(id).getElement();
  if (markerEl) {
    const runnerEl = markerEl.querySelector('.runner');
    if (runnerEl) {
      runnerEl.classList.remove('blink');
      void runnerEl.offsetWidth;
      runnerEl.classList.add('blink');
    }
  }

  if (!trails.has(id)) {
    trails.set(id, L.layerGroup().addTo(map));
  }
  const trailDot = L.circleMarker([lat, lon], {
    radius: 3,
    color,
    opacity: 0.8,
    weight: 1,
    fillColor: color,
    fillOpacity: 0.6,
  });
  trails.get(id).addLayer(trailDot);

}

function renderList() {
  const list = document.getElementById('deviceList');
  const entries = Array.from(latestData.entries())
    .sort(([a], [b]) => a.localeCompare(b));

  const fragment = document.createDocumentFragment();
  const existing = new Map();
  list.querySelectorAll('li').forEach((li) => {
    const id = li.dataset.id;
    if (id) existing.set(id, li);
  });

  for (const [id, data] of entries) {
    const color = colorFor(id);
    const li = existing.get(id) || document.createElement('li');
    li.dataset.id = id;
    li.style.borderLeftColor = color;

    let dot = li.querySelector('.color-dot');
    let info = li.querySelector('.info');
    if (!dot) {
      dot = document.createElement('div');
      dot.className = 'color-dot';
      li.appendChild(dot);
    }
    if (!info) {
      info = document.createElement('div');
      info.className = 'info';
      li.appendChild(info);
    }

    dot.style.backgroundColor = color;
    dot.classList.remove('blink');
    void dot.offsetWidth;
    dot.classList.add('blink');

    info.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'header';
    header.textContent = id;

    const fixRow = document.createElement('div');
    fixRow.className = 'fix';
    if (!Number.isFinite(data.fix) || data.fix <= 0) {
      fixRow.classList.add('no-fix');
    }
    fixRow.textContent = `Fix: ${fixLabel(data.fix)}`;

    const seq = document.createElement('div');
    seq.className = 'sequence';
    seq.textContent = Number.isFinite(data.nm) ? `Mensaje #${data.nm}` : 'Mensaje #—';

    const coords = document.createElement('div');
    coords.className = 'coords';
    coords.textContent = `${data.lat.toFixed(6)}, ${data.lon.toFixed(6)}`;

    const timestamp = document.createElement('div');
    timestamp.className = 'timestamp';
    const dt = new Date(data.ts);
    timestamp.textContent = `Actualizado: ${dt.toLocaleString()}`;

    info.append(header, fixRow, seq, coords, timestamp);
    fragment.appendChild(li);
  }

  list.replaceChildren(fragment);
}

function handleGpsMessage(data) {
  if (!data || !data.id) return;
  const lat = Number(data.lat);
  const lon = Number(data.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  latestData.set(data.id, {
    id: data.id,
    lat,
    lon,
    ts: data.ts || Date.now(),
    fix: Number.isFinite(data.fix) ? data.fix : null,
    nm: Number.isFinite(data.nm) ? data.nm : (Number.isFinite(Number(data.nm)) ? Number(data.nm) : null),
  });
  ensureMarker(
    data.id,
    lat,
    lon,
    Number.isFinite(data.fix) ? data.fix : null,
    Number.isFinite(data.nm) ? data.nm : (Number.isFinite(Number(data.nm)) ? Number(data.nm) : null),
  );
  renderList();
}

function connectWS() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${window.location.host}`);
  ws.addEventListener('open', () => console.log('WS testing abierto'));
  ws.addEventListener('close', () => console.log('WS testing cerrado'));
  ws.addEventListener('error', (e) => console.error('WS testing error', e));
  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (err) {
      console.warn('Mensaje WS inválido', event.data);
      return;
    }
    if (msg.type === 'gps' && msg.data) {
      handleGpsMessage(msg.data);
    }
  });
  return ws;
}

function initMap() {
  map = L.map('map').setView(DEFAULT_CENTER, 16);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 20,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
}

window.addEventListener('DOMContentLoaded', () => {
  initMap();
  connectWS();
});
