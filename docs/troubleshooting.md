# Troubleshooting

Common issues and how to resolve them.

## General: check service logs

For any issue, start by checking the logs of the relevant service:

```bash
docker compose -f ~/.local/state/openpalm/rendered/docker-compose.yml logs <service-name> --tail=100
```

Replace `<service-name>` with one of: `assistant`, `gateway`, `admin`, `openmemory`, `openmemory-ui`, `postgres`, `qdrant`, `caddy`, `channel-chat`, `channel-discord`, `channel-voice`, `channel-telegram`.

## Service won't start

**Symptoms:** `docker compose ps` shows a service as `restarting` or `exited`.

**Steps:**
1. Check logs: `docker compose -f ~/.local/state/openpalm/rendered/docker-compose.yml logs <service-name> --tail=50`
2. Look for missing environment variables, port conflicts, or failed health checks.
3. Verify the Docker daemon is running: `docker info`
4. Check available disk space: `df -h`
5. Restart the service: `docker compose -f ~/.local/state/openpalm/rendered/docker-compose.yml restart <service-name>`

## Admin UI shows "Server unreachable"

**Symptoms:** The admin dashboard at `http://localhost` cannot connect to the backend.

**Steps:**
1. Verify the admin container is healthy: `docker compose -f ~/.local/state/openpalm/rendered/docker-compose.yml ps admin`
2. Check that port 8100 is accessible inside the container: `docker compose -f ~/.local/state/openpalm/rendered/docker-compose.yml exec admin curl -s http://localhost:8100/health`
3. Check Caddy is routing correctly: `docker compose -f ~/.local/state/openpalm/rendered/docker-compose.yml logs caddy --tail=20`
4. Verify the Caddy config has the admin route: check `~/.local/state/openpalm/rendered/caddy/caddy.json`

## Memory not working

**Symptoms:** The assistant does not recall past conversations or fails to save memories.

**Steps:**
1. Verify `OPENAI_API_KEY` is set in `~/.config/openpalm/secrets.env` (OpenMemory uses OpenAI for embeddings).
2. Check OpenMemory logs: `docker compose -f ~/.local/state/openpalm/rendered/docker-compose.yml logs openmemory --tail=50`
3. Check Qdrant is running: `docker compose -f ~/.local/state/openpalm/rendered/docker-compose.yml ps qdrant`
4. Test the OpenMemory API directly: `curl http://localhost:8765/api/v1/apps/`
5. Verify the `openmemory-http` plugin is loaded by checking assistant logs for plugin initialization messages.

## Channels not responding

**Symptoms:** Messages sent via Discord, Telegram, or other channels get no response.

**Steps:**
1. Verify the channel env file has correct credentials: check `~/.local/state/openpalm/channel-<name>/.env`
2. Check channel container logs: `docker compose -f ~/.local/state/openpalm/rendered/docker-compose.yml logs channel-<name> --tail=50`
3. Verify the gateway is healthy: `docker compose -f ~/.local/state/openpalm/rendered/docker-compose.yml ps gateway`
4. Check that the channel secret matches between the channel env and the gateway environment (e.g., `CHANNEL_DISCORD_SECRET`).
5. For Discord: verify the bot token is valid and the bot has been invited to the server with correct permissions.
6. For Telegram: verify the bot token via `https://api.telegram.org/bot<token>/getMe`.

## Assistant not responding

**Symptoms:** Messages reach the gateway but the assistant does not reply, or replies with an error.

**Steps:**
1. Verify `ANTHROPIC_API_KEY` is set in `~/.config/openpalm/secrets.env`.
2. Check assistant logs: `docker compose -f ~/.local/state/openpalm/rendered/docker-compose.yml logs assistant --tail=50`
3. Look for API rate limit or authentication errors in the logs.
4. Verify the assistant container is healthy: `docker compose -f ~/.local/state/openpalm/rendered/docker-compose.yml ps assistant`
5. Test the gateway health endpoint: `curl http://localhost:8080/health`

## Port conflicts

**Symptoms:** A service fails to start with "address already in use."

**Steps:**
1. Identify which process is using the port: `lsof -i :<port>` or `ss -tlnp | grep <port>`
2. Either stop the conflicting process or change the OpenPalm bind address in your env configuration (e.g., `OPENPALM_INGRESS_BIND_ADDRESS`, `OPENCODE_CORE_BIND_ADDRESS`).

## Still stuck?

- Check the [Architecture guide](../dev/docs/architecture.md) to understand how services connect.
- Review [Admin Guide](../docs/admin-guide.md) for configuration details.
- Open an issue at [github.com/itlackey/openpalm](https://github.com/itlackey/openpalm/issues).
