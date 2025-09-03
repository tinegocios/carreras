# Simulador de carrera (Node.js)

Simula una carrera por una pista definida por una polilínea de geoposiciones (lat/lon). Calcula la posición de cada competidor en intervalos regulares, con variaciones aleatorias de velocidad y ligeros desvíos laterales respecto a la línea de la pista.

## Entradas

- `track`: Array de puntos `{ lat, lon }` en orden secuencial (mínimo 2 puntos).
- `competitors`: Número de competidores simultáneos (por defecto 5).
- `avgDurationMs`: Duración promedio esperada de la carrera en milisegundos (obligatorio).
- `tickMs`: Intervalo de actualización en milisegundos (por defecto `250`).
- `lateralSpreadMeters`: Ancho total en metros para desvíos laterales aleatorios (por defecto `6`).

## Salida

Emite un evento `tick` con un snapshot:

```
{
  t: <elapsedMs>,
  tickMs: <intervalo>,
  competitors: [
    { id, lat, lon, distance, progress, speedMps, finished }
  ],
  finishedCount,
  total
}
```

Se emite `end` cuando todos los competidores finalizan.

## Uso rápido

1. Ejecutar el ejemplo incluido:

```
node example.js
```

2. Uso programático:

```js
const { simulateRace } = require('./src/raceSimulator');

const track = [
  { lat: 40.0, lon: -3.7 },
  { lat: 40.0005, lon: -3.699 },
  { lat: 40.001, lon: -3.698 },
];

const sim = simulateRace({
  track,
  competitors: 10,
  avgDurationMs: 180000, // 3 min
  tickMs: 250,
  lateralSpreadMeters: 8,
});

sim.on('tick', (snap) => {
  // consumir posiciones
});

sim.on('end', () => console.log('Fin'));
```

## Detalles de la simulación

- La velocidad base de cada competidor se ajusta para que, en promedio, la carrera complete en `avgDurationMs`, con variación individual ±15% y deriva aleatoria por tick (suavizada hacia 1.0).
- Cada competidor tiene un desvío lateral aleatorio dentro de `lateralSpreadMeters`, que cambia gradualmente a lo largo de la carrera para no seguir estrictamente la línea central.
- La interpolación a lo largo de la pista usa distancias geodésicas por segmento (Haversine) y una interpolación lineal de lat/lon para puntos intermedios, apropiada para segmentos cortos.

## Notas

- Si se requiere reproducibilidad determinística, se podría agregar soporte de `seed` (no incluido por defecto).
- Si los segmentos son muy largos, puede preferirse interpolación geodésica más precisa; en la mayoría de pistas urbanas/deportivas esto es suficiente.

