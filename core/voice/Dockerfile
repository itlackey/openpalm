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

# ── model fetch ──
# Pre-downloads the Kokoro model + voices bundle AND the default
# faster-whisper STT model so first-run cold-start has zero network
# dependencies. Model files are layered into the runtime image at
# /opt/kokoro and /opt/whisper respectively. Operators who want to use
# a different Whisper model size override OP_VOICE_WHISPER_MODEL and
# accept a one-time download on first request to /v1/audio/transcriptions.
# Pinned to $BUILDPLATFORM (the build host's native arch, amd64 on CI): the
# model artifacts are platform-AGNOSTIC data files, so there is no reason to
# re-run this stage under QEMU for the arm64 target. The amd64-built models are
# COPY --from'd into both the amd64 and arm64 runtime images. This removes the
# slow emulated arm64 download (and the HuggingFace 429s it provoked), and makes
# the modelfetch layers IDENTICAL across the cpu/cu121 variant builds — which is
# what lets a shared build cache dedupe them.
FROM --platform=$BUILDPLATFORM python:3.11-slim-bookworm AS modelfetch

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# kokoro-onnx model URLs — pinned to the v1.0 release artifacts. Bumping
# the model version is a Dockerfile-level decision; runtime never refetches.
ARG KOKORO_MODEL_URL=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
ARG KOKORO_VOICES_URL=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin

RUN mkdir -p /opt/kokoro \
    && curl -fsSL --retry 5 --retry-delay 2 -o /opt/kokoro/kokoro-v1.0.onnx "$KOKORO_MODEL_URL" \
    && curl -fsSL --retry 5 --retry-delay 2 -o /opt/kokoro/voices-v1.0.bin   "$KOKORO_VOICES_URL"

# Pre-fetch the default faster-whisper model into the HF cache layout that
# WhisperModel(download_root=...) expects. Pinned model name lives in
# `WHISPER_MODEL`; bump together with stt.py's default if you change it.
ARG WHISPER_MODEL=Systran/faster-whisper-base.en

RUN pip install --no-cache-dir --disable-pip-version-check "huggingface-hub==0.27.0" \
    && mkdir -p /opt/whisper \
    && python -c "from huggingface_hub import snapshot_download; snapshot_download('${WHISPER_MODEL}', cache_dir='/opt/whisper')"

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
