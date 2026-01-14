import serial
import socket

def parsear_gngga(mensaje):
    """
    Parsea un mensaje NMEA $GNGGA y extrae lat, lon y altitud
    Formato: $GNGGA,tiempo,lat,N/S,lon,E/W,quality,numSat,hdop,alt,M,...
    """
    try:
        partes = mensaje.split(',')
        
        # Verificar que tenga suficientes campos
        if len(partes) < 11:
            return None
        
        # Extraer campos
        lat_raw = partes[2]
        lat_dir = partes[3]
        lon_raw = partes[4]
        lon_dir = partes[5]
        quality = partes[6]
        num_sat = partes[7]
        alt_raw = partes[9]
        
        # Si no hay coordenadas válidas
        if not lat_raw or not lon_raw or quality == '0':
            return None
        
        # Convertir latitud de DDMM.MMMM a DD.DDDDDD
        lat_grados = int(lat_raw[:2])
        lat_minutos = float(lat_raw[2:])
        latitud = lat_grados + (lat_minutos / 60)
        if lat_dir == 'S':
            latitud = -latitud
        
        # Convertir longitud de DDDMM.MMMM a DD.DDDDDD
        lon_grados = int(lon_raw[:3])
        lon_minutos = float(lon_raw[3:])
        longitud = lon_grados + (lon_minutos / 60)
        if lon_dir == 'W':
            longitud = -longitud
        
        # Altitud
        altitud = float(alt_raw) if alt_raw else 0.0
        
        return {
            'latitud': latitud,
            'longitud': longitud,
            'altitud': altitud,
            'num_satelites': int(num_sat),
            'quality': int(quality)
        }
    
    except (ValueError, IndexError) as e:
        return None

def enviar_tcp(latitud, longitud, altitud, calidad):
    """
    Envía las coordenadas al servidor TCP en formato:
    Latitud;Longitud;Altitud;Calidad-FIX
    """
    try:
        # Crear socket TCP
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(5)  # Timeout de 5 segundos
        
        # Conectar al servidor
        sock.connect(('5.tcp.ngrok.io', 22500))
        
        # Formatear mensaje
        mensaje = f"{latitud:.6f};{longitud:.6f};{altitud:.1f};{calidad}-FIX\n"
        
        # Enviar
        sock.sendall(mensaje.encode('utf-8'))
        
        # Cerrar conexión
        sock.close()
        
        return True
    except Exception as e:
        print(f"❌ Error al enviar TCP: {e}")
        return False

# Parámetros configurables
puerto = 'COM6'
baudio = 9600

# Iniciar conexión
ser = serial.Serial(port=puerto, baudrate=baudio, timeout=1)

print(f"Escuchando {puerto} a {baudio} baudios.")
print("Esperando coordenadas GPS...\n")

try:
    while True:
        if ser.in_waiting:
            data = ser.readline()
            mensaje = data.decode('utf-8', errors='ignore').strip()
            
            # Filtrar solo mensajes GGA
            if mensaje.startswith('$GNGGA') or mensaje.startswith('$GPGGA'):
                coords = parsear_gngga(mensaje)
                
                if coords:
                    print(f"Latitud:    {coords['latitud']:.6f}°")
                    print(f"Longitud:   {coords['longitud']:.6f}°")
                    print(f"Altitud:    {coords['altitud']:.1f} m")
                    print(f"Satélites:  {coords['num_satelites']}")
                    print(f"Calidad:    {coords['quality']} (0=sin fix, 1=GPS, 2=DGPS, 4=RTK Fix, 5=RTK Float)")
                    
                    # Enviar por TCP
                    if enviar_tcp(coords['latitud'], coords['longitud'], 
                                 coords['altitud'], coords['quality']):
                        print("✓ Enviado al servidor TCP")
                    
                    print("-" * 50)
                else:
                    print("⚠ Esperando señal GPS... (sin fix)")
                
except KeyboardInterrupt:
    print("\nFinalizando escucha.")
finally:
    ser.close()