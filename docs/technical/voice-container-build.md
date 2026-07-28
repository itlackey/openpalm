# Voice Container Build

The operational contract and commands live in
[`containers/voice/README.md`](../../containers/voice/README.md). This document
records the build decisions that are easy to lose when changing the image.

## Supported Images

One Dockerfile accepts `VARIANT=cpu` or `VARIANT=cu121` and publishes:

- `openpalm/voice:<version>-cpu` for `linux/amd64` and `linux/arm64`
- `openpalm/voice:<version>-cu121` for `linux/amd64`

ROCm is not implemented by the Dockerfile. The build fails for unsupported
variants, and the control plane reports the ROCm profile unavailable until a
real image exists.

`OP_VOICE_VERSION` is a base version such as `1.0.0` or `latest`. Managed
Compose appends the selected hardware suffix. It is not a complete image tag.

## Runtime Boundary

Voice is an unauthenticated OpenAI-compatible TTS/STT API. Managed Compose
therefore:

- binds it to literal `127.0.0.1`
- permits only `OP_VOICE_PORT_HOST` to change the host port
- places it on `addon_net`, not `assistant_net`
- exposes it to browsers only through the authenticated host UI `/voice/*`
  pass-through

Do not add a configurable LAN bind without first adding an authenticated edge.

## Models

The default Kokoro and faster-whisper `base.en` assets come from the pinned
`openpalm/voice-models` build image and are copied into the final image. Default
cold start must not download model files. A user-selected non-default Whisper
model may download into the persistent model mount.

## Release Flow

`.github/workflows/publish-voice.yml` is independent from the platform release.
It requires an immutable base version, builds and signs both supported variants,
and only then promotes `latest-cpu` and `latest-cu121`. A failure in either
variant leaves both moving tags unchanged.

## Verification

At minimum, a changed image must prove:

1. Both supported Docker targets build.
2. `/health` and `/v1/models` respond.
3. One transcription and one speech request complete.
4. The CPU image runs on both declared architectures.
5. CUDA remains amd64-only and does not silently fall back to CPU packages.
