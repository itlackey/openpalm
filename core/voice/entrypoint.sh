#!/usr/bin/env bash
# Entrypoint for the openpalm/voice container.
# Prints the detected variant + ONNX/torch device providers at boot so an
# operator can confirm GPU passthrough is wired up correctly, then execs
# uvicorn so signals reach the FastAPI app directly (no shell middleman).
set -euo pipefail

VARIANT="${VOICE_VARIANT:-cpu}"
PORT="${OP_VOICE_PORT:-8880}"

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
