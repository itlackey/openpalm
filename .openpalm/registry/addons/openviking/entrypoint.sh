#!/bin/sh
set -eu

# Generate ov.conf from environment variables injected by compose.
# The control plane resolves OP_CAP_* capabilities and maps them to
# OV_* env vars in the compose environment block.

# Validate/default numeric values
OV_EMBEDDING_DIMS="${OV_EMBEDDING_DIMS:-768}"
case "$OV_EMBEDDING_DIMS" in
  *[!0-9]* | '')
    echo "WARNING: OV_EMBEDDING_DIMS='$OV_EMBEDDING_DIMS' is not numeric, defaulting to 768"
    OV_EMBEDDING_DIMS=768
    ;;
esac

python3 -c "
import json, os, sys

conf = {
    'storage': {
        'workspace': '/workspace',
        'vectordb': {
            'dimension': int(os.environ.get('OV_EMBEDDING_DIMS', '768')),
            'distance_metric': 'cosine',
        },
    },
    'embedding': {
        'dense': {
            'provider': os.environ.get('OV_EMBEDDING_PROVIDER', 'openai'),
            'model': os.environ.get('OV_EMBEDDING_MODEL', 'nomic-embed-text'),
            'api_key': os.environ.get('OV_EMBEDDING_API_KEY', ''),
            'api_base': os.environ.get('OV_EMBEDDING_BASE_URL', ''),
            'dimension': int(os.environ.get('OV_EMBEDDING_DIMS', '768')),
        },
    },
    'server': {
        'host': '0.0.0.0',
        'port': 1933,
        'root_api_key': os.environ.get('OV_ROOT_API_KEY', ''),
    },
    'auto_generate_l0': True,
    'auto_generate_l1': True,
}

with open('/app/ov.conf', 'w') as f:
    json.dump(conf, f, indent=2)
"

exec openviking-server --config /app/ov.conf
