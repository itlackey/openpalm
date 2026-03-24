#!/usr/bin/env bash
set -euo pipefail

# Generate ov.conf from environment variables injected by compose.
# The control plane resolves OP_CAP_* capabilities and maps them to
# OV_* env vars in the compose environment block.

# Validate/default numeric values
OV_EMBEDDING_DIMS="${OV_EMBEDDING_DIMS:-768}"
if ! [[ "$OV_EMBEDDING_DIMS" =~ ^[0-9]+$ ]]; then
  echo "WARNING: OV_EMBEDDING_DIMS='$OV_EMBEDDING_DIMS' is not numeric, defaulting to 768"
  OV_EMBEDDING_DIMS=768
fi

cat > /app/ov.conf <<EOF
{
  "storage": {
    "workspace": "/workspace",
    "vectordb": {
      "dimension": ${OV_EMBEDDING_DIMS:-768},
      "distance_metric": "cosine"
    }
  },
  "embedding": {
    "dense": {
      "provider": "${OV_EMBEDDING_PROVIDER:-openai}",
      "model": "${OV_EMBEDDING_MODEL:-nomic-embed-text}",
      "api_key": "${OV_EMBEDDING_API_KEY:-}",
      "api_base": "${OV_EMBEDDING_BASE_URL:-}",
      "dimension": ${OV_EMBEDDING_DIMS:-768}
    }
  },
  "server": {
    "host": "0.0.0.0",
    "port": 1933,
    "root_api_key": "${OV_ROOT_API_KEY:-}"
  },
  "auto_generate_l0": true,
  "auto_generate_l1": true
}
EOF

exec openviking-server --config /app/ov.conf
