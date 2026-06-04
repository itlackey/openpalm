#!/usr/bin/env bash
# Live verification of the OpenCode 1.15.13 permission + turn-end event surface
# (design Appendix A, extended to capture the real session.status idle marker so
# TURN_IDLE_STATUSES can be pinned). Isolated install — NO Docker, does NOT touch
# the prod assistant. Self-contained; safe to delete OCHOME after.
#
# MODEL CHOICE (verified 2026-06-04): local Ollama models (devstral, qwen3-coder-30b,
# gpt-oss) proved UNRELIABLE at emitting the bash tool call through OpenCode's
# openai-compatible path, so the permission gate never triggered. The hosted
# opencode-provider model `opencode/big-pickle` tool-called on the first try. To
# use it, stage ONLY the opencode credential into the isolated home (not the whole
# multi-secret auth.json) and set the model+config to the opencode provider:
#   mkdir -p "$OCHOME/.local/share/opencode"
#   python3 -c "import json;a=json.load(open('$HOME/.local/share/opencode/auth.json'));\
#     json.dump({'opencode':a['opencode']},open('$OCHOME/.local/share/opencode/auth.json','w'))"
#   # then in opencode.json: {"model":"opencode/big-pickle","permission":{"bash":"ask"}}
# The Ollama path below is kept as a no-credential fallback (override OC_VERIFY_MODEL).
set -uo pipefail

OCHOME=/var/tmp/oc-verify-1513
PORT=5599
MODEL="${OC_VERIFY_MODEL:-devstral:latest}"
rm -rf "$OCHOME"; mkdir -p "$OCHOME/work"

echo "== 1. Isolated install of OpenCode 1.15.13 =="
HOME=$OCHOME curl -fsSL https://opencode.ai/install | HOME=$OCHOME bash -s -- \
  --no-modify-path --version 1.15.13 >"$OCHOME/install.log" 2>&1
BIN=$OCHOME/.opencode/bin/opencode
HOME=$OCHOME "$BIN" --version || { echo "install failed"; cat "$OCHOME/install.log"; exit 1; }

echo "== 2. Minimal config: Ollama tool model + bash gated to ask =="
cat > "$OCHOME/work/opencode.json" <<JSON
{ "\$schema": "https://opencode.ai/config.json",
  "provider": { "ollama": { "npm": "@ai-sdk/openai-compatible", "name": "Ollama",
    "options": { "baseURL": "http://127.0.0.1:11434/v1" },
    "models": { "devstral": { "id": "${MODEL}", "capabilities": { "tool": true } } } } },
  "model": "ollama/devstral",
  "permission": { "bash": "ask", "edit": "ask", "task": "ask" } }
JSON

echo "== 3. Serve + capture the global event stream =="
( cd "$OCHOME/work" && HOME=$OCHOME "$BIN" serve --pure --port $PORT \
  --hostname 127.0.0.1 >"$OCHOME/server.log" 2>&1 & )
sleep 5
curl -sN --max-time 150 http://127.0.0.1:$PORT/event >"$OCHOME/events.log" 2>&1 &
EVPID=$!

echo "== 4. Create session, force a bash tool call (async → 204) =="
SID=$(curl -s -X POST http://127.0.0.1:$PORT/session -H 'content-type: application/json' \
  -d '{"title":"perm-test"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
echo "session = $SID"
echo -n "prompt_async HTTP status: "
curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://127.0.0.1:$PORT/session/$SID/prompt_async" \
  -H 'content-type: application/json' \
  -d "{\"messageID\":\"msg_$(openssl rand -hex 12)\",\"parts\":[{\"type\":\"text\",\"text\":\"Use the bash tool to run exactly: echo hello-from-tool . Call the bash tool now. Do not explain.\"}]}"

echo "== 5. Wait for the model to call bash (up to 90s) =="
for i in $(seq 1 90); do grep -q permission.asked "$OCHOME/events.log" && break; sleep 1; done

echo "--- permission.asked present? ---"
grep -c permission.asked "$OCHOME/events.log" | sed 's/^/permission.asked frames: /'
echo "--- pending permission (GET /permission) ---"
curl -s http://127.0.0.1:$PORT/permission

echo; echo "== 6. Approve via the CURRENT endpoint =="
PID=$(curl -s http://127.0.0.1:$PORT/permission | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['id'] if d else '')" 2>/dev/null)
echo "permission id = $PID"
if [ -n "$PID" ]; then
  echo -n "reply once → "; curl -s -X POST "http://127.0.0.1:$PORT/permission/$PID/reply" \
    -H 'content-type: application/json' -d '{"reply":"once"}'; echo
fi

echo "== 7. Let the turn finish, then inspect the event surface =="
sleep 8
kill $EVPID 2>/dev/null
echo "--- distinct event types seen ---"
python3 - "$OCHOME/events.log" <<'PY'
import sys, json, collections
types = collections.Counter()
statuses = collections.Counter()
sample = {}
for line in open(sys.argv[1]):
    line = line.strip()
    if not line.startswith("data:"): continue
    try: ev = json.loads(line[5:].strip())
    except Exception: continue
    t = ev.get("type","?"); types[t]+=1
    props = ev.get("properties") or {}
    if t == "session.status":
        s = props.get("status")
        statuses[repr(s)] += 1
    if t in ("session.idle","session.status") and t not in sample:
        sample[t] = props
for t,c in types.most_common(): print(f"  {c:4d}  {t}")
print("--- session.status `status` values ---")
for s,c in statuses.most_common(): print(f"  {c:4d}  status={s}")
print("--- sample turn-end frames ---")
for t,p in sample.items(): print(f"  {t}: {json.dumps(p)[:200]}")
PY
echo "== events.log saved at $OCHOME/events.log =="