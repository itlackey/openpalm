import type { ComposeService } from "./compose-spec.ts";

export function renderCaddyComposeService(): ComposeService {
  return {
    image: "caddy:2-alpine",
    restart: "unless-stopped",
    ports: [
      "${OPENPALM_INGRESS_BIND_ADDRESS:-127.0.0.1}:80:80",
      "${OPENPALM_INGRESS_BIND_ADDRESS:-127.0.0.1}:443:443",
    ],
    volumes: [
      "${OPENPALM_STATE_HOME}/caddy.json:/etc/caddy/caddy.json:ro",
      "${OPENPALM_STATE_HOME}/caddy/data:/data/caddy",
      "${OPENPALM_STATE_HOME}/caddy/config:/config/caddy",
    ],
    command: "caddy run --config /etc/caddy/caddy.json",
    healthcheck: {
      test: ["CMD-SHELL", "curl -sf http://localhost:80/ || exit 1"],
      interval: "10s",
      timeout: "5s",
      retries: 5,
    },
    networks: ["assistant_net", "channel_net"],
  };
}

export function renderPostgresComposeService(): ComposeService {
  return {
    image: "postgres:16-alpine",
    restart: "unless-stopped",
    env_file: ["${OPENPALM_STATE_HOME}/postgres/.env"],
    environment: {
      POSTGRES_DB: "${POSTGRES_DB:-openpalm}",
      POSTGRES_USER: "${POSTGRES_USER:-openpalm}",
      POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}",
    },
    volumes: ["${OPENPALM_DATA_HOME}/postgres:/var/lib/postgresql/data"],
    networks: ["assistant_net"],
    healthcheck: {
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-openpalm}"],
      interval: "10s",
      timeout: "5s",
      retries: 5,
    },
  };
}

export function renderQdrantComposeService(): ComposeService {
  return {
    image: "qdrant/qdrant:v1.13.2",
    restart: "unless-stopped",
    env_file: ["${OPENPALM_STATE_HOME}/qdrant/.env"],
    volumes: ["${OPENPALM_DATA_HOME}/qdrant:/qdrant/storage"],
    networks: ["assistant_net"],
    healthcheck: {
      test: ["CMD-SHELL", "curl -sf http://localhost:6333/readyz || exit 1"],
      interval: "10s",
      timeout: "5s",
      retries: 5,
    },
  };
}

export function renderOpenMemoryComposeService(): ComposeService {
  return {
    image: "mem0/openmemory-mcp:latest",
    restart: "unless-stopped",
    env_file: ["${OPENPALM_STATE_HOME}/openmemory/.env"],
    ports: ["${OPENPALM_OPENMEMORY_BIND_ADDRESS:-127.0.0.1}:8765:8765"],
    volumes: ["${OPENPALM_DATA_HOME}/openmemory:/data"],
    networks: ["assistant_net"],
    depends_on: {
      qdrant: { condition: "service_healthy" },
      postgres: { condition: "service_healthy" },
    },
    healthcheck: {
      test: ["CMD-SHELL", "curl -sf http://localhost:8765/ || exit 1"],
      interval: "15s",
      timeout: "10s",
      retries: 5,
    },
  };
}

export function renderOpenMemoryUiComposeService(): ComposeService {
  return {
    image: "mem0/openmemory-ui:latest",
    restart: "unless-stopped",
    environment: [
      "NEXT_PUBLIC_API_URL=${OPENMEMORY_DASHBOARD_API_URL:-http://localhost:8765}",
      "NEXT_PUBLIC_USER_ID=${OPENMEMORY_USER_ID:-default-user}",
    ],
    ports: ["${OPENPALM_OPENMEMORY_DASHBOARD_BIND_ADDRESS:-127.0.0.1}:3001:3000"],
    networks: ["assistant_net"],
    depends_on: {
      openmemory: { condition: "service_healthy" },
    },
    healthcheck: {
      test: ["CMD-SHELL", "curl -sf http://localhost:3000/ || exit 1"],
      interval: "10s",
      timeout: "5s",
      retries: 5,
    },
  };
}
