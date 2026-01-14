import argparse
import ssl
import time

import serial


try:
    from websocket import (
        WebSocketConnectionClosedException,
        WebSocketException,
        create_connection,
    )
except ImportError as exc:  # pragma: no cover - dependencia externa
    raise SystemExit(
        "Falta la librería 'websocket-client'. Instala con: pip install websocket-client"
    ) from exc


PREFIXES = ("$GNGGA", "$GPGGA")
RECONNECT_DELAY = 3


def parse_args():
    parser = argparse.ArgumentParser(
        description=(
            "Puente serie→WebSocket: lee tramas NMEA del GPS y las envía al servidor."
        )
    )
    parser.add_argument("--port", default="COM6", help="Puerto serie del GPS (por ej. COM6 o /dev/ttyUSB0)")
    parser.add_argument("--baudrate", type=int, default=9600, help="Baudios del puerto serie")
    parser.add_argument(
        "--url",
        default="wss://port-3030-tako-ruizestebans650023.codeanyapp.com/nmea",
        help="URL WS del receptor (ej. wss://host:3030/nmea)",
    )
    parser.add_argument(
        "--device-id",
        default="0001",
        help="Identificador del GPS que se agregará a la URL (?id=)",
    )
    parser.add_argument(
        "--id",
        default=None,
        help="Identificador opcional que se antepone a cada trama antes de enviarla",
    )
    parser.add_argument(
        "--ignore-ssl",
        action="store_true",
        help="Deshabilita validación SSL (útil con certificados auto-firmados)",
    )
    parser.add_argument("--sleep", type=float, default=0.05, help="Retardo entre lecturas vacías del puerto (s)")
    return parser.parse_args()


def append_device_id(url, device_id):
    final_id = device_id or "0001"
    sep = "&" if "?" in url else "?"
    return f"{url}{sep}id={final_id}"


def connect_ws(url, ignore_ssl):
    sslopt = {"cert_reqs": ssl.CERT_NONE} if ignore_ssl else None
    return create_connection(url, timeout=10, sslopt=sslopt)


def main():
    args = parse_args()
    target_url = append_device_id(args.url, args.device_id or args.id)
    ws = None

    print(
        f"Escuchando serie en {args.port} @ {args.baudrate} baudios. "
        f"Reenviando GGA a {target_url}"
    )

    with serial.Serial(port=args.port, baudrate=args.baudrate, timeout=1) as ser:
        try:
            while True:
                if not ser.in_waiting:
                    time.sleep(args.sleep)
                    continue

                raw = ser.readline().decode("utf-8", errors="ignore").strip()
                if not raw or not raw.startswith(PREFIXES):
                    continue

                payload = f"{args.id} {raw}" if args.id else raw
                attempt = 0
                while True:
                    attempt += 1
                    try:
                        if ws is None:
                            ws = connect_ws(target_url, args.ignore_ssl)
                            print("✔ Conexión WS abierta")
                        ws.send(payload)
                        print(f"→ reenviado ({attempt}): {payload}")
                        break
                    except (WebSocketConnectionClosedException, WebSocketException, OSError) as exc:
                        print(f"⚠ WebSocket desconectado ({exc}). Reintentando en {RECONNECT_DELAY}s...")
                        if ws is not None:
                            try:
                                ws.close()
                            except Exception:
                                pass
                            ws = None
                        time.sleep(RECONNECT_DELAY)
        except KeyboardInterrupt:
            print("\nFinalizando...")
        finally:
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass


if __name__ == "__main__":
    main()
