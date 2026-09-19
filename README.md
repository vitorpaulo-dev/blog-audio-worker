# blog-audio-worker

Audio generation worker for the blog narration & podcast pipeline (issue #19).

## What it does

Spring (`blog-service`) dispatches HTTP `POST /generate` jobs. For each of the 4 artifacts
(`NARRATION|PODCAST × ENGLISH|PORTUGUESE`) the worker:

1. Writes progress to Redis (`{postId}:{type}:{language}` → `{status, progress, error}`, TTL 7 days)
   — skipped entirely when `REDIS_URL` is unset (the service then falls back to the database status).
2. Generates audio:
   - `NARRATION`: cleans markdown (code blocks stripped), synthesizes via VoiceStudio
     `POST /v1/audio/speech` with 4096-char sentence-boundary chunking and concat.
   - `PODCAST`: generates a two-speaker JSON script via the OpenCode serve HTTP API
     (humanizer-skill style prompt), renders each turn with the per-segment HOST/GUEST voice profile, concats.
3. Uploads the MP3 to the presigned PUT URL provided in the job payload.
4. Marks `READY` — or `FAILED` with the error. One artifact failing never aborts the others.

The endpoint answers `202` immediately; artifacts are processed in the background with
a concurrency limit of 2 per accepted batch.

## Configuration

All upstreams are network endpoints — see `.env.example`:

| Variable | Meaning |
| --- | --- |
| `PORT` | HTTP port (default 3901) |
| `REDIS_URL` | optional, `redis://[:password@]host:6379` or `rediss://...` (TLS) — when unset, Redis is disabled and progress writes are skipped |
| `VOICE_STUDIO_URL` | required, VoiceStudio base URL |
| `VOICE_STUDIO_TOKEN` | VoiceStudio bearer token |
| `OPENCODE_URL` | OpenCode serve endpoint |
| `OPENCODE_MODEL` / `OPENCODE_TOKEN` | optional model / bearer token (falls back to `CASE_OPENCODE_TOKEN`) |
| `VOICE_PROFILE_ID_{ENGLISH,PORTUGUESE}_HOST` / `VOICE_PROFILE_ID_{ENGLISH,PORTUGUESE}_GUEST` | voice profiles: narration and podcast host segments use the `_HOST` variant, podcast guest segments use the `_GUEST` variant; no fallback — if the required profile is empty, the artifact fails with a `voiceMissing` error |

At startup the worker validates env presence (`VOICE_STUDIO_URL`; `REDIS_URL` optional), then
probes each upstream. A missing `VOICE_STUDIO_URL` kills the start; an unreachable Redis/VoiceStudio/
OpenCode does **not** — the worker starts and artifacts fail per-job until connectivity recovers.
With `REDIS_URL` unset the worker logs once that Redis is disabled and runs without progress writes.
Redis reconnects on the next write.

## Logging

Every log line is a timestamped JSON event (`{time, level, event, ...}`) covering the job
lifecycle: `job.accepted`, `segment.start`/`segment.end` (role, voice profile, duration),
`script.start`/`script.end` (opencode generation), `synthesis.start`/`synthesis.end`,
`upload.start`/`upload.end` (presigned URL logged without its query string — signatures are
never emitted), `artifact.completed`/`artifact.failed`, `redis.disabled` (once at startup),
`redis.connected`/`redis.probeFailed`, and a `dispatch.summary` with the per-artifact outcome
(of a batch) at the end of each dispatch.

## Redis client

Plain TCP RESP client implemented in-repo (`src/redis.ts`) — no Redis process is bundled and no
Redis dependency is installed. Connection URLs are parsed by `parseRedisUrl`. During tests the
socket is never real; reconnection behavior is covered by mocked factories.

## Podcast script prompt

`src/podcast.ts` builds the prompt with humanizer-style instructions (natural speech, no
formulaic LLM phrasing, title-first opening, ≥90% content coverage without reading code aloud)
and requires a strict `[{"speaker": "HOST"|"GUEST", "text": "..."}]` JSON answer.

## Development

```sh
npm install
npm run build   # tsc
npm test        # vitest
npm start       # node dist/index.js
```
