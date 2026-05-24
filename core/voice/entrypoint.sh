#!/usr/bin/env bash
# Entrypoint for the openpalm/voice container.
# Prints the detected variant + ONNX/torch device providers at boot so an
# operator can confirm GPU passthrough is wired up correctly, then execs
# uvicorn so signals reach the FastAPI app directly (no shell middleman).
set -euo pipefail

VARIANT="${VOICE_VARIANT:-cpu}"
PORT="${OP_VOICE_PORT:-8880}"

# ── AVX feature probe ─────────────────────────────────────────────────────────
# onnxruntime==1.20.1 (and onnxruntime-gpu==1.20.1's CPU fallback paths)
# require AVX. CPUs that lack AVX (some Atom/Celeron NUCs people use as home
# servers) will start the container fine, pass the FastAPI healthcheck, then
# SIGILL ("Illegal instruction") on the first /v1/audio/speech request. We
# detect this BEFORE python loads so the failure is fast, visible, and
# surfaces via Docker's restart loop instead of "works until first request".
#
# AVX_CHECK_FILE is honored for negative-path testing; defaults to /proc/cpuinfo.
ARCH="$(uname -m)"
AVX_CHECK_FILE="${AVX_CHECK_FILE:-/proc/cpuinfo}"
case "$ARCH" in
    x86_64|amd64)
        if grep -qE '(^|[[:space:]])(avx|avx2)([[:space:]]|$)' "$AVX_CHECK_FILE"; then
            echo "[voice] AVX probe ok — arch=${ARCH}"
        else
            echo "voice: FATAL — CPU lacks AVX, ONNX runtime will crash. Container exiting to surface the failure via Docker restart loop." >&2
            exit 1
        fi
        ;;
    aarch64|arm64)
        # ARM ISA — onnxruntime ships a separate ARM wheel without AVX
        # requirements. Nothing to check.
        echo "[voice] AVX probe skipped — arch=${ARCH} (ARM)"
        ;;
    *)
        echo "[voice] WARN — unknown arch=${ARCH}, skipping AVX probe" >&2
        ;;
esac

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

exec uvicorn app.server:app --host 0.0.0.0 --port "$PORT" --workers 1
