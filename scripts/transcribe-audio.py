"""Transcribe un audio local con faster-whisper (CPU, sin red en la inferencia).

Uso:
  python scripts/transcribe-audio.py --input nota.wav [--model small] [--language es]

Salida: JSON en stdout. El modelo se descarga la primera vez y queda en la
caché de Hugging Face; después funciona sin conexión.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time


def main() -> int:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--model", default=os.environ.get("STT_MODEL", "base"))
    parser.add_argument("--language", default=os.environ.get("STT_LANGUAGE", "es"))
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--prompt", default=os.environ.get("STT_PROMPT", ""))
    args = parser.parse_args()

    started = time.time()
    try:
        import av
        # faster-whisper 1.2.x pasa metadata_errors a PyAV; algunas versiones
        # recientes de PyAV ya no aceptan ese kwarg. Lo ignoramos sin tocar el
        # audio ni la decodificación.
        if "metadata_errors" not in getattr(av.open, "__doc__", ""):
            _av_open = av.open

            def _open_compatible(*open_args, **open_kwargs):
                open_kwargs.pop("metadata_errors", None)
                return _av_open(*open_args, **open_kwargs)

            av.open = _open_compatible
        from faster_whisper import WhisperModel
    except Exception as error:  # pragma: no cover - depende del entorno
        print(json.dumps({
            "ok": False,
            "error": "faster-whisper no está instalado",
            "detail": str(error),
        }, ensure_ascii=False))
        return 2

    try:
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
        segments, info = model.transcribe(
            args.input,
            language=args.language or None,
            beam_size=max(1, min(10, args.beam_size)),
            best_of=1,
            temperature=0.0,
            initial_prompt=args.prompt or None,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 200},
            condition_on_previous_text=False,
            without_timestamps=True,
        )
        parts = []
        for segment in segments:
            text = (segment.text or "").strip()
            if text:
                parts.append(text)
        text = " ".join(parts).strip()
        print(json.dumps({
            "ok": True,
            "text": text,
            "language": getattr(info, "language", None) or args.language,
            "language_probability": round(float(getattr(info, "language_probability", 0.0) or 0.0), 3),
            "duration": round(float(getattr(info, "duration", 0.0) or 0.0), 2),
            "model": args.model,
            "elapsed_ms": int((time.time() - started) * 1000),
        }, ensure_ascii=False))
        return 0 if text else 3
    except Exception as error:  # pragma: no cover - depende del entorno
        print(json.dumps({
            "ok": False,
            "error": "no se pudo transcribir",
            "detail": str(error)[:1200],
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())




