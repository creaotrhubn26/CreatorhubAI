# Glimmer cloud compute coordinator

This Cloudflare Worker owns the unattended RunPod v2 lifecycle. A singleton Durable Object
persists every create intent before the one allowed provider `POST`, reconciles an ambiguous result
only by exact Pod name, prepares a missing model cache on a CPU Pod (or one explicitly configured
Secure GPU fallback when CPU stock is unavailable), and starts a GPU worker only after an
Ed25519-signed `cache-ready.json` attestation has been verified.

The independent watchdog remains a separate Worker and RunPod credential. The coordinator sends a
minimal v2 lease before every provider create and refreshes it from Durable Object alarms, so the
Mac can sleep after the job has been accepted.

## Required secrets

- `RUNPOD_API_KEY`: restricted RunPod key that can read/create/delete Pods and read the selected
  network volume, registry credential metadata, and CPU/GPU catalogs.
- `INGEST_TOKEN`: 32 random bytes encoded as base64url, shared only with Control Center.
- `WATCHDOG_INGEST_TOKEN`: the watchdog's separate HMAC token.
- `CACHE_SIGNING_PRIVATE_KEY`: PKCS#8 Ed25519 private key encoded as base64url. It never leaves the
  coordinator; the CPU submits bounded verified metadata for signing and receives only the signed
  document.
- `CACHE_SIGNING_PUBLIC_KEY`: the matching raw 32-byte public key encoded as base64url. It is safe
  to pass to GPU Pods and is exposed by `/v1/status`.
- `JOB_ENCRYPTION_KEY`: independent random 32-byte base64url key used to encrypt the delayed worker
  bootstrap token in Durable Object storage.

Set `WATCHDOG_URL` and `COORDINATOR_PUBLIC_URL` as HTTPS origins with `wrangler secret put` as well;
keeping deployment-specific URLs out of the checked-in config prevents accidental cross-account
routing. Deploy the watchdog first and wait for a successful scheduled sweep. Then run
`npm run coordinator:test` and `npm run coordinator:deploy -- --dry-run` before a real deployment.

No source code, prompts, model bytes, registry passwords, or RunPod keys are returned by the API.
The CPU ceiling remains `$0.0225/hour`. Production permits only an exact `NVIDIA L4` fallback at
`$0.49/hour` for automatic cache repair. Its 28-minute deadline plus the watchdog's two-minute
deletion margin stays below `$0.25`; configuration fails closed if the TTL/rate product can exceed
that total. Every GPU worker remains bounded by the request's separate hourly ceiling and hard
deadline.
