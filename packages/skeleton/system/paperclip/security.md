# Paperclip Agent Security

- Never inspect, enumerate, print, or log process environment variables. Do not
  run `env`, `printenv`, `set`, `export`, or read `/proc/*/environ`.
- Treat credential, key, password, secret, token, authorization, and cookie
  values as secrets. Never put their values in tool arguments, output,
  responses, comments, or files.
- Paperclip supplies `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY`. Use those
  variable references directly when calling its API. Never discover or expand
  their values first.
- AKM env and secret list operations may report safe key, ref, and path names.
  Never report a value. Retrieve one only when the assigned task requires using
  it, then pass it directly to the intended operation without logging it.
