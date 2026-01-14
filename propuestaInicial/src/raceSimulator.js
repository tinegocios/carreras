const EventEmitter = require('events');
const {
  computeCumulative,
  interpolateAlong,
  applyLateralOffset,
  haversine,
} = require('./utils');

function clamp(x, a, b) {
  return Math.min(b, Math.max(a, x));
}

class RaceSimulator extends EventEmitter {
  constructor(options) {
    super();
    const {
      track,
      competitors = 5,
      avgDurationMs,
      tickMs = 250,
      lateralSpreadMeters = 6, // width where competitors can deviate laterally
      idPrefix = 'C',
    } = options || {};

    if (!Array.isArray(track) || track.length < 2) {
      throw new Error('track debe ser un array de al menos 2 puntos {lat, lon}');
    }
    if (!avgDurationMs || avgDurationMs <= 0) {
      throw new Error('avgDurationMs debe ser un número positivo en milisegundos');
    }

    this.track = track;
    this.cumulative = computeCumulative(track);
    this.trackLength = this.cumulative[this.cumulative.length - 1];
    this.tickMs = tickMs;
    this.avgDurationMs = avgDurationMs;
    this.lateralSpread = lateralSpreadMeters;
    this.timer = null;
    this.startTime = null;
    this.elapsedMs = 0;

    // Initialize competitors
    const baseMps = this.trackLength / (avgDurationMs / 1000);
    this.state = Array.from({ length: competitors }).map((_, i) => {
      // Per-competitor variation ±15%
      const mult = 1 + (Math.random() * 0.3 - 0.15);
      const baseSpeed = baseMps * mult;

      // Staggered start small jitter so they don't overlap exactly at t=0
      const jitter = Math.random() * 0.5; // seconds worth of head-start distance
      const d0 = baseSpeed * jitter;

      // Lateral offset target and smoothing state
      const targetOffset = (Math.random() - 0.5) * this.lateralSpread; // meters
      return {
        id: `${idPrefix}${i + 1}`,
        distance: d0,
        finished: false,
        baseSpeedMps: baseSpeed,
        speedFactor: 1, // dynamic factor that drifts over time
        targetOffset,
        currentOffset: targetOffset * 0.6,
        offsetChangeCooldown: Math.floor(10 + Math.random() * 20), // ticks until new target
        lat: track[0].lat,
        lon: track[0].lon,
        progress: 0,
        speedMps: 0,
      };
    });
  }

  start() {
    if (this.timer) return;
    this.startTime = Date.now();
    this.elapsedMs = 0;

    // Emit initial state
    this._update(0);

    this.timer = setInterval(() => {
      const now = Date.now();
      this.elapsedMs = now - this.startTime;
      this._update(this.tickMs);
    }, this.tickMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  _update(dtMs) {
    const dt = dtMs / 1000;
    let finishedCount = 0;
    for (const c of this.state) {
      if (c.finished) {
        finishedCount++;
        continue;
      }

      // Random drift of speedFactor (Ornstein-Uhlenbeck-ish towards 1)
      const drift = (Math.random() - 0.5) * 0.08; // small random change
      const pull = (1 - c.speedFactor) * 0.05; // pull back towards 1
      c.speedFactor = clamp(c.speedFactor + drift + pull, 0.7, 1.3);

      // Occasional lateral target change
      c.offsetChangeCooldown -= 1;
      if (c.offsetChangeCooldown <= 0) {
        c.targetOffset = (Math.random() - 0.5) * this.lateralSpread;
        c.offsetChangeCooldown = Math.floor(12 + Math.random() * 24);
      }
      // Smoothly approach target
      const offsetDelta = c.targetOffset - c.currentOffset;
      c.currentOffset += offsetDelta * 0.15; // easing

      // Update distance
      c.speedMps = c.baseSpeedMps * c.speedFactor;
      const step = c.speedMps * dt;
      c.distance += step;
      if (c.distance >= this.trackLength) {
        c.distance = this.trackLength;
        c.finished = true;
        finishedCount++;
      }

      // Project to track and apply lateral offset
      const p = interpolateAlong(this.track, this.cumulative, c.distance);
      const withOffset = applyLateralOffset(p.lat, p.lon, p.bearing, c.currentOffset);
      c.lat = withOffset.lat;
      c.lon = withOffset.lon;
      c.progress = this.trackLength === 0 ? 1 : c.distance / this.trackLength;
    }

    // Emit snapshot
    this.emit('tick', {
      t: this.elapsedMs,
      tickMs: this.tickMs,
      competitors: this.state.map((c) => ({
        id: c.id,
        lat: c.lat,
        lon: c.lon,
        distance: c.distance,
        progress: c.progress,
        speedMps: c.speedMps,
        finished: c.finished,
      })),
      finishedCount,
      total: this.state.length,
    });

    // Stop automatically when all finished
    if (finishedCount === this.state.length) {
      this.stop();
      this.emit('end');
    }
  }
}

function simulateRace(options) {
  const sim = new RaceSimulator(options);
  // start lazily to allow user to register listeners immediately
  process.nextTick(() => sim.start());
  return sim;
}

module.exports = {
  RaceSimulator,
  simulateRace,
};

