# Configuración de emisores GPS

Este proyecto admite dos mecanismos para entregar posiciones GPS al servidor:

1. **WebSocket** (modo actual): conexión `ws://<host>/nmea?id=<dispositivo>` que envía sentencias NMEA (`$GNGGA`, `$GNRMC`, etc.).
2. **HTTP POST** (nuevo): solicitud HTTP `POST` a `http(s)://<host>/api/gps` con un JSON por fix.

Los emisores pueden elegir el mecanismo a través de un parámetro de configuración local, por ejemplo:

```json
{
  "transport": "http", // "ws" para WebSocket; "http" para POST
  "endpoint": "https://example.com/api/gps",
  "deviceId": "vehiculo-001"
}
```

## Payload HTTP

Cuando `transport` sea `http`, cada posición debe enviarse con el siguiente cuerpo JSON:

```json
{
  "id": "vehiculo-001",
  "lat": 20.029954,
  "lon": -98.785524,
  "ts": 1733955905123,
  "fix": 2,
  "nm": 1284
}
```

Campos:

- `id` (**obligatorio**): identificador del emisor.
- `lat`, `lon` (**obligatorios**): coordenadas en grados decimales. Se aceptan números o cadenas numéricas.
- `ts` (opcional): marca de tiempo en milisegundos desde Unix epoch. Si se omite, el servidor usa la hora de recepción.
- `fix` (opcional): calidad de fix GPS (entero, p. ej. `1`=GPS, `2`=DGPS, `4`=RTK). Si falta, se registra como `null`.
- `nm` (opcional): número entero consecutivo del mensaje para trazabilidad.

Respuesta:

- `200 OK` con `{"ok": true}` en caso de éxito.
- `400 Bad Request` con `{"ok": false, "error": "…"}` si el JSON es inválido o faltan campos.

## Transporte WebSocket

Para continuar usando WebSocket no se requiere cambio alguno. El parámetro `transport` debe quedar en `"ws"` y se mantiene la conexión actual a `/nmea`.

## Consideraciones

- Ambos mecanismos (WS y HTTP) conviven y alimentan la misma visualización tanto en modo competencia como testing.
- Los emisores deben implementar reintentos para el POST en caso de fallos de red (backoff recomendado).
- Los datos enviados por HTTP se retransmiten en tiempo real a los clientes web (`type: "gps"`) siguiendo el mismo formato que las actualizaciones por WebSocket.
