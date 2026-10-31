"""Worker persistente de transcripción (líneas JSON por stdin/stdout).

Carga Whisper una sola vez y atiende varias notas de voz sin pagar el arranque
del modelo en cada audio. Lo usa `lib/channel/transcribe.mjs`.
"""
from __future__ import annotations

import json
import os
import sys
import time


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")

    try:
        import av

        # Compatibilidad con faster-whisper 1.2.x y PyAV reciente.
        _av_open = av.open

        def _open_compatible(*args, **kwargs):
            kwargs.pop("metadata_errors", None)
            return _av_open(*args, **kwargs)

        av.open = _open_compatible
        from faster_whisper import WhisperModel
    except Exception as error:  # pragma: no cover
        emit({"type": "fatal", "error": f"faster-whisper no disponible: {error}"})
        return 2

    model_name = os.environ.get("STT_MODEL", "base")
    threads = 0
    try:
        model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=threads)
        emit({"type": "ready", "model": model_name, "threads": threads})
    except Exception as error:  # pragma: no cover
        emit({"type": "fatal", "error": f"No se pudo cargar el modelo: {error}"})
        return 3

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception as error:
            emit({"ok": False, "error": f"JSON inválido: {error}"})
            continue
        if request.get("cmd") == "shutdown":
            break
        request_id = request.get("id")
        started = time.time()
        try:
            segments, info = model.transcribe(
                request["path"],
                language=request.get("language") or "es",
                beam_size=max(1, min(10, int(request.get("beam_size") or 5))),
                best_of=1,
                temperature=0.0,
                initial_prompt=request.get("initial_prompt") or None,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 200},
                condition_on_previous_text=False,
                without_timestamps=True,
            )
            text = " ".join((segment.text or "").strip() for segment in segments).strip()
            emit({
                "id": request_id,
                "ok": True,
                "text": text,
                "language": getattr(info, "language", None) or request.get("language") or "es",
                "language_probability": round(float(getattr(info, "language_probability", 0.0) or 0.0), 3),
                "duration": round(float(getattr(info, "duration", 0.0) or 0.0), 2),
                "model": model_name,
                "elapsed_ms": int((time.time() - started) * 1000),
            })
        except Exception as error:
            emit({
                "id": request_id,
                "ok": False,
                "error": "No se pudo transcribir el audio.",
                "detail": str(error)[:800],
                "elapsed_ms": int((time.time() - started) * 1000),
            })
    return 0


if __name__ == "__main__":
    sys.exit(main())




