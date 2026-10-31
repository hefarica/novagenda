# Notas de voz en Telegram

La app entiende **notas de voz**, audios, videos y videomensajes de Telegram. El flujo
es local: Telegram entrega el archivo, la app lo descarga, lo convierte con
`ffmpeg`, lo transcribe con Whisper en CPU y pasa el texto al mismo asistente
que atiende los mensajes escritos.

## Requisitos (una vez)

- `ffmpeg` y `ffprobe` en el PATH.
- Python 3.10–3.12.
- Dependencias:

```powershell
python -m pip install -r requirements-voice.txt
```

La primera transcripción descarga el modelo `small` (unos 460 MB) a la caché de
Hugging Face. Después funciona sin conexión.

Variables opcionales:

| Variable | Valor por defecto | Uso |
|---|---|---|
| `STT_MODEL` | `base` | `tiny` (rápido), `base` (equilibrado), `small` (más preciso y lento), `medium` |
| `STT_LANGUAGE` | `es` | Idioma forzado |
| `PYTHON_BIN` | `python` | Intérprete |
| `FFMPEG_BIN` | `ffmpeg` | Convertidor |

## Límites

- Hasta **20 MB** por archivo (límite de descarga de bots de Telegram).
- Hasta **5 minutos** de audio.
- Si no se detecta voz, se responde con un aviso y no se inventa texto.
- El audio temporal se borra al terminar; no se envía a ninguna API.

## Prueba

```powershell
npm run verify:voice
```

Genera una frase en español, la convierte a OGG/Opus y valida la transcripción
completa, incluidos acentos.

También se probó de extremo a extremo: una nota de voz enviada al bot con
«¿Qué tengo hoy en la agenda?» produjo la transcripción y la respuesta de
agenda por Telegram.

## Integración

- `lib/channel/transcribe.mjs`: descarga, conversión y transcripción.
- `scripts/transcribe-audio.py`: puente con `faster-whisper`.
- `lib/channel/telegram.mjs`: detecta `voice`, `audio` y `video_note`, descarga
  el archivo, transcribe y añade `meta.voice` + `meta.transcription` al mensaje.
- El texto transcrito entra al pipeline normal, con aprobaciones y auditoría.

## Velocidad\n\n- Primera nota: carga del modelo (unos segundos).\n- Notas siguientes: el worker ya está caliente; en este equipo una nota de\n  4–5 s tarda aproximadamente 4–6 s en total, frente a ~13 s con small.\n- El audio se normaliza a 16 kHz mono con loudnorm y highpass; eso mejora\n  el volumen bajo y reduce ruido de baja frecuencia.\n
