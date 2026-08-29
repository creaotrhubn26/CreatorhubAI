# Glimmer compute watchdog

This Cloudflare Worker is the independent safety boundary for paid RunPod Pods. It receives only a
minimal HMAC-signed lease from the local gateway and owns a separate, restricted RunPod key. It
does not receive repositories, prompts, model files, worker capabilities, or the gateway's RunPod
account key.

The scheduled sweep runs every two minutes. With the default 180-second heartbeat threshold, a
gateway that disappears causes termination within roughly three to five minutes. The interval also
keeps the default design within the Workers KV Free daily list/write quotas for one active lease.

## One-time deployment

Prerequisites:

- a Cloudflare account authenticated through Wrangler;
- a new RunPod restricted key with the narrowest Pod scope offered, without billing or account
  administration access;
- a separately generated, 32-byte-or-longer base64url ingest token.

Create the KV namespace, replace the placeholder `kv_namespaces[0].id` in `wrangler.jsonc`, then
store both credentials as Worker secrets:

```sh
npx wrangler kv namespace create LEASES --config watchdog/wrangler.jsonc
npx wrangler secret put RUNPOD_API_KEY --config watchdog/wrangler.jsonc
npx wrangler secret put INGEST_TOKEN --config watchdog/wrangler.jsonc
npm run watchdog:deploy
```

Never place either secret in `wrangler.jsonc`, `.dev.vars`, shell history, source control, or the
Control Center UI logs. Save the public Worker origin and the same ingest token in External compute
settings, then run **Test independent watchdog**. The first test may remain not-ready until the first
scheduled sweep has completed.

## Safety contract

- Only HTTPS, origin-only gateway endpoints are accepted.
- Requests are HMAC-SHA256 signed over method, exact path, millisecond timestamp, and exact body.
- Signatures older than two minutes are rejected.
- Lease identity, hard deadline, and hourly ceiling are immutable.
- A Pod is terminated when its heartbeat is stale, deadline has passed, observed price exceeds the
  ceiling, provider price is unavailable, GPU count differs from one, or provider identity differs
  from the lease.
- A lease is removed only after RunPod confirms that the Pod is missing or terminated, so failed
  termination calls are retried by later sweeps.

Run `npm run watchdog:test` before every deployment. `npm run watchdog:deploy -- --dry-run` validates
the bundle without changing Cloudflare state.
