let map;
let track = [];
let trackLine = null;
let pointMarkers = [];
let ws = null;
let raceActive = false;
const competitorMarkers = new Map();
const finishTimes = new Map(); // id -> finish ms
let chart;
const chartData = new Map(); // id -> [{x: progress(0..100), y: speed}]
const colorMap = new Map(); // id -> css color
const boardNodes = new Map(); // id -> li element
const letterMap = new Map(); // id -> short label like A, B, ...

function colorForIndex(i) {
  // Golden angle for stable distinct hues independent of total
  const hue = Math.round((i * 137.508) % 360);
  return `hsl(${hue}, 75%, 50%)`;
}

function colorFor(id) {
  return colorMap.get(id) || '#cc3333';
}

function ensureStyleForId(id) {
  if (!letterMap.has(id)) {
    const idx = letterMap.size;
    letterMap.set(id, indexToLetters(idx));
  }
  if (!colorMap.has(id)) {
    const idx = colorMap.size;
    colorMap.set(id, colorForIndex(idx));
  }
}

function updateMarkerIconIfNeeded(id) {
  const marker = competitorMarkers.get(id);
  if (!marker) return;
  const color = colorFor(id);
  const label = letterMap.get(id) || '?';
  const html = `<div class="runner" style="background:${color};"><span>${label}</span></div>`;
  const current = marker.options.icon && marker.options.icon.options && marker.options.icon.options.html;
  if (current !== html) {
    const icon = L.divIcon({ className: '', html, iconSize: [26,26], iconAnchor: [13,13] });
    marker.setIcon(icon);
  }
}

function indexToLetters(index) {
  // 0 -> A, 25 -> Z, 26 -> AA, etc.
  let n = index;
  let s = '';
  while (true) {
    const rem = n % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return s;
}

function assignLetters(ids) {
  const ordered = [...ids].sort();
  for (let i = 0; i < ordered.length; i++) {
    const id = ordered[i];
    if (!letterMap.has(id)) letterMap.set(id, indexToLetters(i));
  }
}

function initMap() {
  map = L.map('map').setView([4.65178, -74.05602], 16);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 20,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  map.on('click', (e) => {
    const edit = document.getElementById('editMode').checked;
    if (!raceActive && edit) addTrackPoint(e.latlng.lat, e.latlng.lng);
  });

  initChart();
}

function makeDraggableMarker(lat, lon, idx) {
  const marker = L.marker([lat, lon], { draggable: true, autoPan: true });
  marker.on('dragend', () => {
    const ll = marker.getLatLng();
    track[idx] = { lat: ll.lat, lon: ll.lng };
    redrawTrack(false);
  });
  return marker;
}

function refreshMarkerDraggability() {
  const editable = document.getElementById('editMode').checked && !raceActive;
  for (const m of pointMarkers) {
    if (editable) m.dragging.enable(); else m.dragging.disable();
  }
}

function hideTrackMarkers() {
  for (const m of pointMarkers) {
    if (map.hasLayer(m)) map.removeLayer(m);
  }
}

function showTrackMarkers() {
  // Only show if editing is enabled and race is not active
  if (!document.getElementById('editMode').checked || raceActive) return;
  for (const m of pointMarkers) {
    if (!map.hasLayer(m)) m.addTo(map);
  }
  refreshMarkerDraggability();
}

function addTrackPoint(lat, lon) {
  track.push({ lat, lon });
  const marker = makeDraggableMarker(lat, lon, track.length - 1).addTo(map);
  pointMarkers.push(marker);
  redrawTrack();
}

function clearTrack() {
  track = [];
  if (trackLine) { map.removeLayer(trackLine); trackLine = null; }
  pointMarkers.forEach(m => map.removeLayer(m));
  pointMarkers = [];
}

function redrawTrack(fit=true) {
  if (trackLine) map.removeLayer(trackLine);
  if (track.length >= 2) {
    trackLine = L.polyline(track.map(p => [p.lat, p.lon]), { color: '#0077ff', weight: 4 }).addTo(map);
    if (fit) map.fitBounds(trackLine.getBounds(), { padding: [50, 50] });
  }
  refreshMarkerDraggability();
}

function connectWS() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return ws;
  ws = new WebSocket(`wss://${window.location.host}`);
  ws.addEventListener('open', () => console.log('WS open'));
  ws.addEventListener('close', () => console.log('WS close'));
  ws.addEventListener('error', (e) => console.error('WS error', e));
  ws.addEventListener('message', onWSMessage);
  return ws;
}

function onWSMessage(ev) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.type === 'tick') {
    const snap = msg.snapshot;
    // ensure stable styles by arrival order, not per-tick subset
    for (const c of snap.competitors) ensureStyleForId(c.id);
    // update markers
    for (const c of snap.competitors) {
      const key = c.id;
      const pos = [c.lat, c.lon];
      const color = colorFor(key);
      const label = letterMap.get(key) || '?';
      if (!competitorMarkers.has(key)) {
        const icon = L.divIcon({
          className: '',
          html: `<div class="runner" style="background:${color};"><span>${label}</span></div>`,
          iconSize: [26,26],
          iconAnchor: [13,13],
        });
        const marker = L.marker(pos, { icon });
        marker.addTo(map);
        competitorMarkers.set(key, marker);
      } else {
        competitorMarkers.get(key).setLatLng(pos);
        updateMarkerIconIfNeeded(key);
      }

      // record chart data
      if (!chartData.has(key)) chartData.set(key, []);
      chartData.get(key).push({ x: +(c.progress * 100).toFixed(2), y: +c.speedMps.toFixed(2) });
      if (c.finished && !finishTimes.has(key)) finishTimes.set(key, snap.t);
    }
    updateBoard(snap);
    updateChartDatasets();
  } else if (msg.type === 'end') {
    raceActive = false;
    refreshMarkerDraggability();
    showTrackMarkers();
    const boardListEl = document.getElementById('boardList');
    if (boardListEl) boardListEl.replaceChildren();
    boardNodes.clear();
  }
}

function startRace() {
  if (track.length < 2) {
    alert('Agrega al menos 2 puntos a la pista');
    return;
  }
  raceActive = true;
  const competitors = parseInt(document.getElementById('competitors').value, 10) || 6;
  const avgSec = parseFloat(document.getElementById('avgSec').value) || 120;
  const tickMs = parseInt(document.getElementById('tickMs').value, 10) || 250;
  const lateral = parseFloat(document.getElementById('lateral').value) || 7;
  const modeEl = document.getElementById('raceMode');
  const mode = modeEl ? modeEl.value : 'sim';

  // clear previous markers
  competitorMarkers.forEach(m => map.removeLayer(m));
  competitorMarkers.clear();
  finishTimes.clear();
  chartData.clear();
  resetChart();
  colorMap.clear();
  boardNodes.clear();
  letterMap.clear();
  // Clear leaderboard DOM to avoid accumulation across races
  const boardListEl = document.getElementById('boardList');
  if (boardListEl) boardListEl.replaceChildren();
  // Hide track control point markers during the race
  hideTrackMarkers();

  const ws = connectWS();
  const payload = mode === 'real'
    ? { type: 'start_real', track, competitors }
    : {
        type: 'start',
        track,
        competitors,
        avgDurationMs: Math.round(avgSec * 1000),
        tickMs,
        lateralSpreadMeters: lateral,
      };
  const sendWhenOpen = () => ws.send(JSON.stringify(payload));
  if (ws.readyState === WebSocket.OPEN) sendWhenOpen();
  else ws.addEventListener('open', sendWhenOpen, { once: true });
  refreshMarkerDraggability();
}

function stopRace() {
  const w = connectWS();
  try { w.send(JSON.stringify({ type: 'stop' })); } catch {}
}

window.addEventListener('DOMContentLoaded', () => {
  initMap();
  // Modal + overlay buttons
  const modal = document.getElementById('configModal');
  const openModal = () => modal.classList.remove('hidden');
  const closeModal = () => modal.classList.add('hidden');
  const btnStart = document.getElementById('btnStart');
  const btnStop = document.getElementById('btnStop');
  const btnClear = document.getElementById('btnClear');
  const btnConfig = document.getElementById('btnConfig');
  const btnPlay = document.getElementById('btnPlay');
  const btnCloseModal = document.getElementById('btnCloseModal');
  btnStart.addEventListener('click', () => { startRace(); closeModal(); });
  if (btnStop) btnStop.addEventListener('click', stopRace);
  btnClear.addEventListener('click', clearTrack);
  btnConfig.addEventListener('click', openModal);
  btnPlay.addEventListener('click', startRace);
  btnCloseModal.addEventListener('click', closeModal);
  // Other inputs
  document.getElementById('editMode').addEventListener('change', refreshMarkerDraggability);
  document.getElementById('fileTrack').addEventListener('change', onLoadFile);
});

function onLoadFile(ev) {
  const f = ev.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data) || data.length < 2) throw new Error('Formato inválido');
      // reset
      clearTrack();
      // add points
      data.forEach((p, idx) => {
        if (typeof p.lat !== 'number' || typeof p.lon !== 'number') throw new Error('Punto inválido');
        track.push({ lat: p.lat, lon: p.lon });
        const m = makeDraggableMarker(p.lat, p.lon, idx).addTo(map);
        pointMarkers.push(m);
      });
      redrawTrack();
    } catch (e) {
      alert('Error al cargar JSON: ' + e.message);
    }
  };
  reader.readAsText(f);
}

function updateBoard(snap) {
  const list = document.getElementById('boardList');
  const arr = snap.competitors.map(c => {
    const finish = finishTimes.get(c.id);
    return {
      id: c.id,
      progress: c.progress,
      speed: c.speedMps,
      finished: c.finished,
      finishMs: finish ?? null,
    };
  });
  // Sort: finished by finishMs asc first; then by progress desc
  arr.sort((a, b) => {
    if (a.finished && b.finished) return (a.finishMs ?? Infinity) - (b.finishMs ?? Infinity);
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.progress - a.progress;
  });

  // FLIP: capture first rects for existing nodes
  const firstRects = new Map();
  for (const [id, el] of boardNodes.entries()) {
    if (el.isConnected) firstRects.set(id, el.getBoundingClientRect());
  }

  // Build/update nodes and insert in order
  let pos = 1;
  for (const c of arr) {
    let li = boardNodes.get(c.id);
    if (!li) {
      li = document.createElement('li');
      const card = document.createElement('div');
      card.className = 'competitor-card';
      const dot = document.createElement('div');
      dot.className = 'color-dot';
      dot.style.backgroundColor = colorFor(c.id);
      const body = document.createElement('div');
      const line = document.createElement('div');
      line.className = 'line';

      const c1 = document.createElement('div');
      c1.className = 'col1';
      const rankNum = document.createElement('strong');
      rankNum.className = 'rank-num';
      rankNum.textContent = `${pos}.`;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = `${letterMap.get(c.id) || c.id}`;
      c1.append(rankNum, name);

      const c2 = document.createElement('div');
      c2.className = 'col2';
      const c2ico = document.createElement('span'); c2ico.className = 'ico'; c2ico.textContent = '📈';
      const c2val = document.createElement('span'); c2val.className = 'val'; c2val.textContent = `${(c.progress*100).toFixed(1)}%`;
      c2.append(c2ico, c2val);

      const c3 = document.createElement('div');
      c3.className = 'col3';
      const c3ico = document.createElement('span'); c3ico.className = 'ico'; c3ico.textContent = '🚀';
      const c3val = document.createElement('span'); c3val.className = 'val'; c3val.textContent = `${c.speed.toFixed(2)} m/s`;
      c3.append(c3ico, c3val);

      const c4 = document.createElement('div');
      c4.className = 'col4';
      const c4ico = document.createElement('span'); c4ico.className = 'ico'; c4ico.textContent = '⏱';
      const c4val = document.createElement('span'); c4val.className = 'val'; c4val.textContent = `${c.finishMs!=null?(c.finishMs/1000).toFixed(2)+' s':'-'}`;
      c4.append(c4ico, c4val);

      line.append(c1,c2,c3,c4);
      body.appendChild(line);
      card.appendChild(dot);
      card.appendChild(body);
      li.appendChild(card);
      boardNodes.set(c.id, li);
    } else {
      const dot = li.querySelector('.color-dot');
      if (dot) dot.style.backgroundColor = colorFor(c.id);
      const line = li.querySelector('.line');
      const c2 = line.children[1].querySelector('.val');
      const c3 = line.children[2].querySelector('.val');
      const c4 = line.children[3].querySelector('.val');
      c2.textContent = `${(c.progress*100).toFixed(1)}%`;
      c3.textContent = `${c.speed.toFixed(2)} m/s`;
      c4.textContent = `${c.finishMs!=null?(c.finishMs/1000).toFixed(2)+' s':'-'}`;
      const rankNum = li.querySelector('.rank-num');
      rankNum.textContent = `${pos}.`;
      const name = li.querySelector('.name');
      name.textContent = `${letterMap.get(c.id) || c.id}`;
    }
    list.appendChild(li);
    pos++;
  }

  // Apply FLIP transforms
  requestAnimationFrame(() => {
    for (const c of arr) {
      const el = boardNodes.get(c.id);
      const last = el.getBoundingClientRect();
      const first = firstRects.get(c.id);
      if (first) {
        const dy = first.top - last.top;
        if (dy) {
          el.style.transform = `translateY(${dy}px)`;
          el.classList.add('overtake');
          requestAnimationFrame(() => {
            el.style.transition = 'transform 250ms ease';
            el.style.transform = 'translateY(0)';
            setTimeout(() => { el.style.transition = ''; el.classList.remove('overtake'); }, 270);
          });
        }
      }
    }
  });
}

function initChart() {
  const ctx = document.getElementById('speedChart');
  chart = new Chart(ctx, {
    type: 'line',
    data: { datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      scales: {
        x: { type: 'linear', min: 0, max: 100, title: { display: true, text: 'Avance (%)' } },
        y: { type: 'linear', title: { display: true, text: 'Velocidad (m/s)' } },
      },
      plugins: { legend: { position: 'bottom' } },
    },
  });
}

function resetChart() {
  chart.data.datasets = [];
  chart.update();
}

function updateChartDatasets() {
  // Ensure a dataset per competitor id
  const ids = Array.from(chartData.keys());
  // Add missing datasets
  for (const id of ids) {
    if (!chart.data.datasets.find(d => d.label === id)) {
      chart.data.datasets.push({
        label: id,
        data: [],
        showLine: true,
        fill: false,
        borderColor: colorFor(id),
        pointRadius: 0,
        borderWidth: 2,
      });
    }
  }
  // Update data arrays
  for (const ds of chart.data.datasets) {
    const data = chartData.get(ds.label) || [];
    ds.data = data;
    ds.borderColor = colorFor(ds.label);
  }
  chart.update('none');
}
