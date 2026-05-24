"""FastAPI server — OpenAI-compatible /v1/audio/* endpoints.

Background model loading: the lifespan handler kicks off a single asyncio
task that loads Whisper then Kokoro. The HTTP server is already accepting
connections during that load, so `/health` can answer with `status=loading`
and Docker's healthcheck stays red until both models report `ready`.

Concurrency: every inference call runs through `asyncio.to_thread` so the
event loop is free to serve `/health` and queue other requests. faster-
whisper and kokoro-onnx are both Python-with-native-extensions and release
the GIL inside the C extensions, so two requests will overlap on a multi-
core CPU. RAM pressure stays bounded because only one engine instance is
shared across requests.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import time
from typing import Optional

import onnxruntime as ort
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from .audio import encode, mime_for, supported_formats
from .stt import STT
from .tts import TTS

logging.basicConfig(
    level=os.environ.get("OP_VOICE_LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("voice.server")

VARIANT = os.environ.get("VOICE_VARIANT", "cpu")

# Module-level singletons. The lifespan handler populates these; routes
# read them. We don't gate routes on readiness — they raise 503 if hit too
# early instead, which keeps the contract simple.
stt = STT()
tts = TTS()
_load_task: Optional[asyncio.Task] = None


async def _load_models() -> None:
    """Background loader. Runs Whisper then Kokoro to avoid spiking RAM."""
    logger.info("model loader starting (variant=%s)", VARIANT)
    try:
        await asyncio.to_thread(stt.load)
    except Exception:
        logger.exception("STT load failed — /health will report stt=error")
    try:
        await asyncio.to_thread(tts.load)
    except Exception:
        logger.exception("TTS load failed — /health will report tts=error")
    logger.info("model loader done (stt.ready=%s tts.ready=%s)", stt.ready, tts.ready)


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    global _load_task
    _load_task = asyncio.create_task(_load_models())
    try:
        yield
    finally:
        if _load_task and not _load_task.done():
            _load_task.cancel()
            with contextlib.suppress(BaseException):
                await _load_task


app = FastAPI(title="openpalm/voice", version="0.11.0", lifespan=lifespan)


def _component_state(component) -> str:
    if component.error:
        return "error"
    if component.ready:
        return "ready"
    return "loading"


@app.get("/health")
async def health():
    """Health probe — 200 when both engines ready, 503 otherwise."""
    stt_state = _component_state(stt)
    tts_state = _component_state(tts)
    body = {
        "status": "ok" if stt.ready and tts.ready else "loading",
        "stt": stt_state,
        "tts": tts_state,
        "variant": VARIANT,
        "providers": list(ort.get_available_providers()),
    }
    if stt_state == "error" or tts_state == "error":
        body["status"] = "error"
        return JSONResponse(body, status_code=503)
    if not (stt.ready and tts.ready):
        return JSONResponse(body, status_code=503)
    return body


@app.get("/v1/models")
async def list_models():
    created = int(time.time())
    return {
        "object": "list",
        "data": [
            {"id": "whisper-1", "object": "model", "created": created, "owned_by": "openpalm"},
            {"id": "kokoro",    "object": "model", "created": created, "owned_by": "openpalm"},
        ],
    }


# ── /v1/audio/transcriptions ─────────────────────────────────────────────────

_SUPPORTED_TRANSCRIPTION_FORMATS = {"json", "text"}


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model: str = Form("whisper-1"),
    language: Optional[str] = Form(None),
    prompt: Optional[str] = Form(None),
    response_format: str = Form("json"),
    temperature: float = Form(0.0),
):
    if not stt.ready:
        raise HTTPException(503, detail={"error": "stt model not ready"})

    fmt = response_format.lower()
    if fmt not in _SUPPORTED_TRANSCRIPTION_FORMATS:
        raise HTTPException(
            400,
            detail={
                "error": f"unsupported response_format: {response_format}",
                "supported": sorted(_SUPPORTED_TRANSCRIPTION_FORMATS),
            },
        )

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(400, detail={"error": "empty audio upload"})

    try:
        text, detected_language = await asyncio.to_thread(
            stt.transcribe,
            audio_bytes,
            language,
            prompt,
            temperature,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("transcription failed")
        raise HTTPException(500, detail={"error": f"transcription failed: {exc!r}"})

    if fmt == "text":
        return StreamingResponse(iter([text]), media_type="text/plain")
    return {"text": text, "language": detected_language}


# ── /v1/audio/speech ─────────────────────────────────────────────────────────


class SpeechRequest(BaseModel):
    model: str = "kokoro"
    input: str
    voice: Optional[str] = None
    response_format: str = Field("mp3")
    speed: float = 1.0
    # OpenAI accepts language as part of voice; kokoro takes it separately.
    # Surface it as an optional knob so callers can override en-us.
    language: Optional[str] = None


@app.post("/v1/audio/speech")
async def speech(req: SpeechRequest):
    if not tts.ready:
        raise HTTPException(503, detail={"error": "tts engine not ready"})

    fmt = req.response_format.lower()
    if fmt not in supported_formats():
        raise HTTPException(
            400,
            detail={
                "error": f"unsupported response_format: {req.response_format}",
                "supported": list(supported_formats()),
            },
        )
    if not req.input.strip():
        raise HTTPException(400, detail={"error": "input must be non-empty"})

    try:
        pcm, sr = await asyncio.to_thread(
            tts.synthesize,
            req.input,
            req.voice,
            req.speed,
            req.language or "en-us",
        )
        encoded = await asyncio.to_thread(encode, pcm, sr, fmt)
    except Exception as exc:  # noqa: BLE001
        logger.exception("speech synthesis failed")
        raise HTTPException(500, detail={"error": f"synthesis failed: {exc!r}"})

    return StreamingResponse(iter([encoded]), media_type=mime_for(fmt))
