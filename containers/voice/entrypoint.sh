#!/usr/bin/env bash
# Entrypoint for the openpalm/voice container.
# Prints the detected variant + ONNX/torch device providers at boot so an
# operator can confirm GPU passthrough is wired up correctly, then execs
# uvicorn so signals reach the FastAPI app directly (no shell middleman).
set -euo pipefail

VARIANT="${VOICE_VARIANT:-cpu}"
PORT="${OP_VOICE_PORT:-8880}"

# ── AVX2 feature probe ────────────────────────────────────────────────────────
# onnxruntime==1.20.1's CPU execution provider requires AVX2 (not just AVX —
# the prebuilt wheels are compiled for Haswell+). CPUs that lack AVX2 (some
# Atom/Celeron NUCs people use as home servers, and pre-Haswell Xeons) will
# start the container fine, pass the FastAPI healthcheck, then SIGILL
# ("Illegal instruction") on the first /v1/audio/speech request. We detect
# this BEFORE python loads so the failure is fast, visible, and surfaces via
# Docker's restart loop instead of "works until first request".
#
# The cu121 variant runs ONNX inference on the GPU via CUDAExecutionProvider,
# so the CPU AVX2 requirement is moot — a GPU host without AVX2 is a valid
# deployment target. Skip the probe entirely on cu121.
#
# AVX_CHECK_FILE is honored for negative-path testing; defaults to /proc/cpuinfo.
ARCH="$(uname -m)"
AVX_CHECK_FILE="${AVX_CHECK_FILE:-/proc/cpuinfo}"
if [ "$VARIANT" = "cu121" ]; then
    echo "[voice] AVX probe skipped — GPU variant (cu121) runs ONNX on CUDA; CPU AVX2 not required"
else
    case "$ARCH" in
        x86_64|amd64)
            if grep -qE '(^|[[:space:]])avx2([[:space:]]|$)' "$AVX_CHECK_FILE"; then
                echo "[voice] AVX2 probe ok — arch=${ARCH}"
            else
                echo "voice: FATAL — CPU lacks AVX2 (required by onnxruntime 1.20.x CPU EP). Container exiting to surface the failure via Docker restart loop." >&2
                exit 1
            fi
            ;;
        aarch64|arm64)
            # ARM ISA — onnxruntime ships a separate ARM wheel without AVX
            # requirements. Nothing to check.
            echo "[voice] AVX2 probe skipped — arch=${ARCH} (ARM)"
            ;;
        *)
            echo "[voice] WARN — unknown arch=${ARCH}, skipping AVX2 probe" >&2
            ;;
    esac
fi

echo "[voice] starting — variant=${VARIANT} port=${PORT}"

# ONNX Runtime providers (kokoro-onnx surface).
python - <<'PY' || true
import onnxruntime as ort
print(f"[voice] onnxruntime providers={ort.get_available_providers()}")
PY

# Torch CUDA — only meaningful on the cu121 variant, but query unconditionally
# so the cpu variant logs the expected "cuda: False" line for clarity.
python - <<'PY' || true
try:
    import torch
    print(f"[voice] torch.cuda.is_available={torch.cuda.is_available()}")
    if torch.cuda.is_available():
        print(f"[voice] torch.cuda.device_count={torch.cuda.device_count()}")
        for i in range(torch.cuda.device_count()):
            print(f"[voice] torch.cuda[{i}]={torch.cuda.get_device_name(i)}")
except Exception as e:
    print(f"[voice] torch import failed: {e!r}")
PY

# If args were passed (e.g. `docker run … openpalm/voice:tag sh -c '…'`),
# exec them instead of starting uvicorn. The AVX2 probe and provider logs
# above still run so diagnostic smoke tests get the same boot trail the
# real service does.
if [ "$#" -gt 0 ]; then
    exec "$@"
fi

exec uvicorn app.server:app --host 0.0.0.0 --port "$PORT" --workers 1
