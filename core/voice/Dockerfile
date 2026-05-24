# ── Voice Service ──────────────────────────────────────────────────────────────
# OpenAI-compatible /v1/audio/speech (Kokoro-82M TTS) + /v1/audio/transcriptions
# (faster-whisper STT) behind a thin FastAPI app.
#
# Two image tags from the SAME Dockerfile via build-arg VARIANT:
#   VARIANT=cpu   (default) — torch+cpu, onnxruntime          → openpalm/voice:vX.Y.Z-cpu
#   VARIANT=cu121           — torch+cu121, onnxruntime-gpu    → openpalm/voice:vX.Y.Z-cu121
#
# Multi-stage build keeps the runtime image lean: the builder stage installs
# pip deps into a virtualenv; runtime copies just /opt/venv.
#
# No docker socket, no privileged mode. Runs as the unprivileged "voice"
# user inside the container.
# ──────────────────────────────────────────────────────────────────────────────

# ── builder ──
FROM python:3.11-slim-bookworm AS builder

ARG VARIANT=cpu

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1

# Build deps for any pure-python wheels that need a C compiler at install
# time (faster-whisper pulls a prebuilt ctranslate2 wheel; soundfile uses
# libsndfile via a manylinux wheel; nothing here actually compiles, but
# build-essential is cheap and avoids surprises across architectures).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Upgrade pip inside the venv first so resolver is current.
RUN pip install --upgrade pip setuptools wheel

WORKDIR /build
COPY requirements.txt /build/requirements.txt

# Branch on VARIANT to pick the right torch + onnxruntime wheels. Same
# requirements.txt feeds both; only torch (cpu vs cu121 index) and the
# onnxruntime package name differ.
RUN set -eux; \
    if [ "$VARIANT" = "cu121" ]; then \
        pip install --extra-index-url https://download.pytorch.org/whl/cu121 \
            "torch==2.5.1+cu121" ; \
        pip install "onnxruntime-gpu==1.20.1" ; \
    else \
        pip install --index-url https://download.pytorch.org/whl/cpu \
            "torch==2.5.1+cpu" ; \
        pip install "onnxruntime==1.20.1" ; \
    fi ; \
    pip install -r /build/requirements.txt

# ── runtime ──
FROM python:3.11-slim-bookworm AS runtime

ARG VARIANT=cpu
ENV VOICE_VARIANT=${VARIANT} \
    PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    OP_VOICE_PORT=8880 \
    OP_VOICE_WHISPER_MODEL_DIR=/models/whisper \
    OP_VOICE_KOKORO_DIR=/models/kokoro \
    OP_VOICE_WHISPER_MODEL=base.en \
    OP_VOICE_KOKORO_VOICE=af_bella

# Runtime apt deps:
#   ffmpeg      — referenced by faster-whisper for arbitrary input decoding
#   libsndfile1 — soundfile backend (mp3/opus/wav encoding)
#   curl        — Docker HEALTHCHECK probe
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        libsndfile1 \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Non-root runtime user. python:3.11-slim-bookworm already ships a system
# group named "voice" (gid 105) — use a different group name + UID 1000 so
# the host's mapped user can own bind-mount files cleanly.
RUN groupadd --gid 1000 op \
    && useradd --create-home --shell /usr/sbin/nologin --uid 1000 --gid 1000 op \
    && mkdir -p /models/whisper /models/kokoro \
    && chown -R op:op /models

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
COPY app /app/app
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
    && chown -R op:op /app

USER op

EXPOSE 8880

HEALTHCHECK --interval=10s --timeout=5s --start-period=180s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8880/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
