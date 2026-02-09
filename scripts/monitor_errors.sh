#!/bin/bash

# ==========================================
# VIGILANTE SILENCIOSO - LA NAVE 5
# ==========================================
# Este script revisa las últimas líneas del log
# y te avisa si encuentra problemas.

# 1. CONFIGURACIÓN
# ----------------
# Cambia esto por tu email real:
EMAIL_DESTINO="ikerameas@gmail.com"

# Dónde está el log (ajusta la ruta si es necesario)
LOG_FILE="../server.log"

# Qué buscamos (palabras clave de peligro)
PATRONES="error|fail|exception|crashed|fatal"

# 2. LÓGICA DE REVISIÓN
# ---------------------
echo "🔍 Revisando $LOG_FILE en busca de problemas..."

if [ ! -f "$LOG_FILE" ]; then
    echo "❌ Error: No encuentro el archivo log en $LOG_FILE"
    exit 1
fi

# Miramos las últimas 50 líneas
ERRORES=$(tail -n 50 "$LOG_FILE" | grep -iE "$PATRONES")

if [ ! -z "$ERRORES" ]; then
    echo "⚠️  ¡PROBLEMAS DETECTADOS!"
    echo "$ERRORES"
    
    # 3. ENVÍO DE ALERTA
    # ------------------
    # Intenta enviar un mail usando el comando del sistema 'mail'
    echo "Se han detectado errores recientes en el servidor de La Nave 5:\n\n$ERRORES" | mail -s "🚨 ALERTA URGENTE: Error en CostOS" "$EMAIL_DESTINO"
    
    echo "✅ Alerta enviada a $EMAIL_DESTINO"
else
    echo "✅ Todo tranquilo. Sistema funcionando correctamente."
fi
