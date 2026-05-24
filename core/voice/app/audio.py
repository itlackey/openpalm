"""Encode PCM audio to a target container format.

stdlib `wave` handles WAV. `soundfile` (libsndfile) handles everything else
the spec asks for (mp3, opus, flac). Keeping all formats behind one function
keeps `server.py` free of branching by content-type.
"""
from __future__ import annotations

import io
import wave
from typing import Tuple

import numpy as np
import soundfile as sf


# Map response_format → (mime, soundfile format, subtype-or-None).
# Subtype=None lets soundfile pick the default for that container.
_FORMAT_TABLE = {
    "wav":  ("audio/wav",  "WAV",  "PCM_16"),
    "mp3":  ("audio/mpeg", "MP3",  None),
    "opus": ("audio/ogg",  "OGG",  "OPUS"),
    "flac": ("audio/flac", "FLAC", "PCM_16"),
}


def supported_formats() -> Tuple[str, ...]:
    return tuple(_FORMAT_TABLE.keys())


def mime_for(fmt: str) -> str:
    fmt = fmt.lower()
    if fmt not in _FORMAT_TABLE:
        raise ValueError(f"unsupported response_format: {fmt}")
    return _FORMAT_TABLE[fmt][0]


def encode(pcm: np.ndarray, sample_rate: int, fmt: str) -> bytes:
    """Encode a mono float32 PCM array to the requested container.

    `pcm` is expected to be float32 in the [-1, 1] range as produced by
    kokoro-onnx. WAV is hand-encoded via stdlib `wave` so the runtime image
    is not coupled to a specific libsndfile WAV path; everything else
    delegates to soundfile.
    """
    fmt = fmt.lower()
    if fmt not in _FORMAT_TABLE:
        raise ValueError(f"unsupported response_format: {fmt}")

    # Coerce to mono if a (samples, 1) array slips through.
    if pcm.ndim == 2 and pcm.shape[1] == 1:
        pcm = pcm[:, 0]

    if fmt == "wav":
        # int16 PCM keeps the file small and matches what most consumers expect
        # from an "audio/wav" stream.
        clipped = np.clip(pcm, -1.0, 1.0)
        ints = (clipped * 32767.0).astype(np.int16)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(sample_rate)
            wav.writeframes(ints.tobytes())
        return buf.getvalue()

    _, sf_format, sf_subtype = _FORMAT_TABLE[fmt]
    buf = io.BytesIO()
    kwargs = {"format": sf_format}
    if sf_subtype:
        kwargs["subtype"] = sf_subtype
    sf.write(buf, pcm.astype(np.float32), sample_rate, **kwargs)
    return buf.getvalue()
