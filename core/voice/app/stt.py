"""faster-whisper wrapper.

Single global `STT` instance lives in `app.server`. `load()` materializes
the model lazily (so the HTTP server can bind :8880 + answer /health while
the model is still downloading) and is idempotent — re-calling does nothing.
"""
from __future__ import annotations

import io
import logging
import os
from typing import Optional, Tuple

logger = logging.getLogger("voice.stt")


class STT:
    def __init__(self) -> None:
        self._model = None
        self._device = "cpu"
        self._compute_type = "int8"
        self.error: Optional[str] = None

    @property
    def ready(self) -> bool:
        return self._model is not None and self.error is None

    @property
    def device(self) -> str:
        return self._device

    def load(self) -> None:
        """Download (if needed) and warm the configured faster-whisper model."""
        if self._model is not None:
            return

        model_name = os.environ.get("OP_VOICE_WHISPER_MODEL", "base.en")
        cache_dir = os.environ.get("OP_VOICE_WHISPER_MODEL_DIR", "/opt/whisper")
        os.makedirs(cache_dir, exist_ok=True)

        # GPU detection — kept inside load() so the cpu variant never tries to
        # import torch.cuda machinery (torch+cpu still has the symbol; just
        # returns False).
        device = "cpu"
        compute_type = "int8"
        try:
            import torch  # type: ignore

            if torch.cuda.is_available():
                device = "cuda"
                compute_type = "float16"
        except Exception as exc:  # noqa: BLE001
            logger.warning("torch import failed during STT load: %r", exc)

        logger.info(
            "loading whisper model=%s device=%s compute_type=%s cache=%s",
            model_name, device, compute_type, cache_dir,
        )

        from faster_whisper import WhisperModel  # local import — heavy

        try:
            self._model = WhisperModel(
                model_name,
                device=device,
                compute_type=compute_type,
                download_root=cache_dir,
            )
            self._device = device
            self._compute_type = compute_type
            logger.info("whisper ready")
        except Exception as exc:  # noqa: BLE001
            self.error = f"whisper load failed: {exc!r}"
            logger.exception("whisper load failed")
            raise

    def transcribe(
        self,
        audio_bytes: bytes,
        language: Optional[str] = None,
        prompt: Optional[str] = None,
        temperature: float = 0.0,
    ) -> Tuple[str, str]:
        """Run STT against the provided audio bytes.

        Returns (text, detected_language). faster-whisper accepts a
        BinaryIO; ffmpeg (installed in the image) handles the actual decode
        of arbitrary input formats.
        """
        if self._model is None:
            raise RuntimeError("STT model not loaded")

        segments, info = self._model.transcribe(
            io.BytesIO(audio_bytes),
            language=language,
            initial_prompt=prompt,
            temperature=temperature,
        )
        text = "".join(seg.text for seg in segments).strip()
        return text, info.language
