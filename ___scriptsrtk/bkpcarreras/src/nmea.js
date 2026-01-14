const CHECKSUM_RE = /^[0-9A-F]{2}$/i;

function computeChecksum(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i += 1) {
    sum ^= data.charCodeAt(i);
  }
  return sum;
}

function degMinToDecimal(raw, hemisphere, isLat) {
  if (!raw || !hemisphere) return null;
  const degLen = isLat ? 2 : 3;
  if (raw.length < degLen) return null;
  const degrees = Number.parseInt(raw.slice(0, degLen), 10);
  const minutes = Number.parseFloat(raw.slice(degLen));
  if (Number.isNaN(degrees) || Number.isNaN(minutes)) return null;
  let value = degrees + (minutes / 60);
  if (hemisphere === 'S' || hemisphere === 'W') value *= -1;
  return value;
}

function parseGga(fields) {
  // $--GGA,hhmmss.sss,ddmm.mmmm,a,dddmm.mmmm,a,x,xx,x.x,x.x,M,x.x,M,x.x,xxxx
  if (fields.length < 10) {
    return { ok: false, error: 'gga_incompleta' };
  }
  const lat = degMinToDecimal(fields[2], fields[3], true);
  const lon = degMinToDecimal(fields[4], fields[5], false);
  const fixQuality = Number.parseInt(fields[6], 10);
  if (!Number.isFinite(fixQuality) || fixQuality <= 0) {
    return { ok: false, error: 'gga_sin_fix', meta: { fixQuality } };
  }
  if (lat == null || lon == null) {
    return { ok: false, error: 'gga_coordenadas_invalidas' };
  }
  const altitude = Number.parseFloat(fields[9]);
  const satellites = Number.parseInt(fields[7], 10);
  return {
    ok: true,
    type: 'GGA',
    lat,
    lon,
    altitude: Number.isFinite(altitude) ? altitude : null,
    satellites: Number.isFinite(satellites) ? satellites : null,
    fixQuality,
  };
}

function parseRmc(fields) {
  // $--RMC,hhmmss.sss,A,ddmm.mmmm,a,dddmm.mmmm,a,x.x,x.x,ddmmyy,x.x,a
  if (fields.length < 10) {
    return { ok: false, error: 'rmc_incompleta' };
  }
  const status = fields[2];
  if (status !== 'A') {
    return { ok: false, error: 'rmc_sin_fix', meta: { status } };
  }
  const lat = degMinToDecimal(fields[3], fields[4], true);
  const lon = degMinToDecimal(fields[5], fields[6], false);
  if (lat == null || lon == null) {
    return { ok: false, error: 'rmc_coordenadas_invalidas' };
  }
  const speedKnots = Number.parseFloat(fields[7]);
  return {
    ok: true,
    type: 'RMC',
    lat,
    lon,
    speedKnots: Number.isFinite(speedKnots) ? speedKnots : null,
  };
}

function parseNmeaSentence(sentence) {
  if (!sentence || typeof sentence !== 'string') {
    return { ok: false, error: 'mensaje_vacio' };
  }
  const trimmed = sentence.trim();
  if (!trimmed.startsWith('$')) {
    return { ok: false, error: 'no_es_nmea' };
  }

  let body = trimmed.slice(1);
  let checksumText = null;
  const starIdx = body.indexOf('*');
  if (starIdx >= 0) {
    checksumText = body.slice(starIdx + 1).replace(/[^0-9A-F]/gi, '').toUpperCase();
    body = body.slice(0, starIdx);
  }
  if (checksumText && CHECKSUM_RE.test(checksumText)) {
    const computed = computeChecksum(body);
    const expected = Number.parseInt(checksumText, 16);
    if (Number.isFinite(expected) && computed !== expected) {
      return {
        ok: false,
        error: 'checksum_invalido',
        meta: { expected: checksumText, computed: computed.toString(16).toUpperCase() },
      };
    }
  }

  const fields = body.split(',');
  const header = fields[0] || '';
  if (header.length < 3) {
    return { ok: false, error: 'sentencia_invalida' };
  }
  const type = header.slice(-3).toUpperCase();

  if (type === 'GGA') {
    const result = parseGga(fields);
    if (result.ok) result.sentence = trimmed;
    return result;
  }
  if (type === 'RMC') {
    const result = parseRmc(fields);
    if (result.ok) result.sentence = trimmed;
    return result;
  }

  return { ok: false, error: 'tipo_no_soportado', meta: { type } };
}

module.exports = { parseNmeaSentence };
