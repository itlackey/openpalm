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

# ── model bundle ──
# The Kokoro TTS + faster-whisper STT artifacts come from the prebuilt
# `openpalm/voice-models` image (core/voice/Dockerfile.models, published
# out-of-band by publish-voice-models.yml) — NOT downloaded here. This means a
# voice build never touches HuggingFace/GitHub for models (no 429s) and the
# heavy ~0.6 GB download happens once per model bump instead of on every
# cpu/cu121 build. The models are platform-agnostic data, so we pull the bundle
# for the BUILD host arch (`--platform=$BUILDPLATFORM`, amd64 on CI) and
# COPY --from it into both the amd64 and arm64 runtime images.
#
# Bumping models: publish a new openpalm/voice-models tag (see Dockerfile.models)
# and update this default. Operators/CI can override via --build-arg.
ARG VOICE_MODELS_IMAGE=openpalm/voice-models:v1
FROM --platform=$BUILDPLATFORM ${VOICE_MODELS_IMAGE} AS modelfetch

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
#
# The rocm6 branch is an explicit guard: ROCm support has not been
# implemented yet, but compose overlays / docs still reference a `rocm6`
# tag. Failing the build loudly here prevents an ad-hoc
# `docker build --build-arg VARIANT=rocm6` from silently producing a
# CPU-only image mislabelled `rocm6`.
RUN set -eux; \
    if [ "$VARIANT" = "rocm6" ]; then \
        echo "rocm6 variant not implemented yet" >&2 ; \
        exit 1 ; \
    elif [ "$VARIANT" = "cu121" ]; then \
        pip install --extra-index-url https://download.pytorch.org/whl/cu121 \
            "torch==2.5.1+cu121" ; \
        pip install "onnxruntime-gpu==1.20.1" ; \
    else \
        # NB: the cpu index publishes 2.5.x as plain "2.5.1" (no +cpu local
        # tag); the +cpu suffix only exists from 2.6.0 onward. --index-url
        # already pins this to the CPU build, so do NOT add "+cpu" here.
        pip install --index-url https://download.pytorch.org/whl/cpu \
            "torch==2.5.1" ; \
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
    OP_VOICE_WHISPER_MODEL_DIR=/opt/whisper \
    OP_VOICE_KOKORO_DIR=/opt/kokoro \
    OP_VOICE_WHISPER_MODEL=base.en \
    OP_VOICE_KOKORO_VOICE=bf_isabella

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
    && mkdir -p /models/whisper /models/kokoro /opt/kokoro /opt/whisper \
    && chown -R op:op /models /opt/kokoro /opt/whisper

COPY --from=builder    /opt/venv   /opt/venv
# Pre-baked Kokoro + Whisper artifacts (see modelfetch stage). Live under
# /opt/... to keep /models/ free for operator bind-mounts when they
# override OP_VOICE_KOKORO_DIR / OP_VOICE_WHISPER_MODEL_DIR.
COPY --from=modelfetch --chown=op:op /opt/kokoro/  /opt/kokoro/
COPY --from=modelfetch --chown=op:op /opt/whisper/ /opt/whisper/

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
