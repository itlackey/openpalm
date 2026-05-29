#!/bin/bash
set -e

set -a

source ${OP_HOME}/config/stack/stack.env
docker compose --project-name ${OP_PROJECT_NAME} \
    --profile ${OP_VOICE_PROFILE} \
    -f ${OP_HOME}/config/stack/core.compose.yml \
    --env-file ${OP_HOME}/config/stack/stack.env \
    --env-file ${OP_HOME}/config/stack/guardian.env up -d
set +a