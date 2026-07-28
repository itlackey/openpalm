"""kokoro-onnx wrapper.

`load()` downloads the two model artifacts on first start if they're
missing (idempotent — presence-only check; users can pre-seed the bind
mount) and instantiates the Kokoro engine. Inference happens in
`synthesize()`; the FastAPI route hops it onto a thread so the event loop
stays responsive.
"""
from __future__ import annotations

import logging
import os
import urllib.request
from pathlib import Path
from typing import Optional, Tuple

import numpy as np

logger = logging.getLogger("voice.tts")

# Pinned to the v1.0 release artifacts so the URL stays stable across
# kokoro-onnx package upgrades. The model file is the canonical Kokoro-82M
# ONNX export; voices-v1.0.bin bundles all 54 voices including bf_isabella.
# Both files are pre-baked into the image at /opt/kokoro (see the modelfetch
# stage in the Dockerfile). `_download_if_missing` is a no-op in that case;
# it remains for dev/test runs against an unbundled cache dir.
_MODEL_URL = (
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
    "kokoro-v1.0.onnx"
)
_VOICES_URL = (
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
    "voices-v1.0.bin"
)


def _download_if_missing(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    logger.info("downloading %s -> %s", url, dest)
    tmp = dest.with_suffix(dest.suffix + ".part")
    # urllib is dependency-free; httpx is in requirements but only used by
    # consumers of this image, not the install path.
    with urllib.request.urlopen(url) as resp, open(tmp, "wb") as f:  # noqa: S310
        while True:
            chunk = resp.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
    tmp.rename(dest)
    logger.info("downloaded %s (%d bytes)", dest.name, dest.stat().st_size)


class TTS:
    def __init__(self) -> None:
        self._engine = None
        self._default_voice = os.environ.get("OP_VOICE_KOKORO_VOICE", "bf_isabella")
        self.error: Optional[str] = None

    @property
    def ready(self) -> bool:
        return self._engine is not None and self.error is None

    @property
    def default_voice(self) -> str:
        return self._default_voice

    def load(self) -> None:
        if self._engine is not None:
            return

        cache_dir = Path(os.environ.get("OP_VOICE_KOKORO_DIR", "/opt/kokoro"))
        cache_dir.mkdir(parents=True, exist_ok=True)
        model_path = cache_dir / "kokoro-v1.0.onnx"
        voices_path = cache_dir / "voices-v1.0.bin"

        try:
            _download_if_missing(_MODEL_URL, model_path)
            _download_if_missing(_VOICES_URL, voices_path)
        except Exception as exc:  # noqa: BLE001
            self.error = f"kokoro download failed: {exc!r}"
            logger.exception("kokoro download failed")
            raise

        try:
            from kokoro_onnx import Kokoro  # local import — heavy

            engine = Kokoro(str(model_path), str(voices_path))
            providers = engine.sess.get_providers()
            expected_provider = os.environ.get("ONNX_PROVIDER")
            if expected_provider and expected_provider not in providers:
                raise RuntimeError(
                    f"kokoro requested {expected_provider} but loaded {providers}"
                )
            self._engine = engine
            logger.info(
                "kokoro ready (voice=%s providers=%s)",
                self._default_voice,
                providers,
            )
        except Exception as exc:  # noqa: BLE001
            self.error = f"kokoro load failed: {exc!r}"
            logger.exception("kokoro load failed")
            raise

    def synthesize(
        self,
        text: str,
        voice: Optional[str] = None,
        speed: float = 1.0,
        lang: str = "en-us",
    ) -> Tuple[np.ndarray, int]:
        """Run TTS. Returns (mono float32 PCM in [-1, 1], sample_rate)."""
        if self._engine is None:
            raise RuntimeError("TTS engine not loaded")
        v = voice or self._default_voice
        pcm, sr = self._engine.create(text, voice=v, speed=speed, lang=lang)
        return pcm, sr
