const LEASE_PREFIX = "lease:";
const LAST_SWEEP_KEY = "meta:last-sweep";
const MAX_BODY_BYTES = 8 * 1024;
const MAX_LEASES = 100;
const SIGNATURE_WINDOW_MS = 120_000;
const MAX_HARD_DEADLINE_MS = 86_700_000;
const SAFE_ID = /^[A-Za-z0-9._-]{1,191}$/;
const HEX_SIGNATURE = /^v1=([a-f0-9]{64})$/;

function json(value, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errorResponse(status, code) {
  return json({ error: code }, status);
}

function bytesFromHex(value) {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function signingKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

async function authorized(request, env, body, nowMs) {
  if (typeof env.INGEST_TOKEN !== "string" || env.INGEST_TOKEN.length < 32) return false;
  const timestamp = request.headers.get("X-Glimmer-Timestamp") ?? "";
  const signatureMatch = (request.headers.get("X-Glimmer-Signature") ?? "").match(HEX_SIGNATURE);
  if (!/^\d{13}$/.test(timestamp) || !signatureMatch) return false;
  const timestampMs = Number(timestamp);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(nowMs - timestampMs) > SIGNATURE_WINDOW_MS) {
    return false;
  }
  const url = new URL(request.url);
  if (url.search || url.hash) return false;
  const message = `${request.method}\n${url.pathname}\n${timestamp}\n${body}`;
  return crypto.subtle.verify(
    "HMAC",
    await signingKey(env.INGEST_TOKEN),
    bytesFromHex(signatureMatch[1]),
    new TextEncoder().encode(message),
  );
}

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key));
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseLease(value, nowMs) {
  const required = [
    "schemaVersion",
    "leaseId",
    "ownerInstanceId",
    "podName",
    "hardDeadlineAt",
    "lastHeartbeatAt",
    "maxHourlyUsd",
  ];
  if (!exactKeys(value, required, ["podId"])) throw new Error("INVALID_LEASE_SHAPE");
  if (
    value.schemaVersion !== 1 ||
    !SAFE_ID.test(value.leaseId) ||
    !SAFE_ID.test(value.ownerInstanceId) ||
    !SAFE_ID.test(value.podName) ||
    (value.podId !== undefined && !SAFE_ID.test(value.podId)) ||
    !validTimestamp(value.hardDeadlineAt) ||
    !validTimestamp(value.lastHeartbeatAt) ||
    typeof value.maxHourlyUsd !== "number" ||
    !Number.isFinite(value.maxHourlyUsd) ||
    value.maxHourlyUsd < 0.1 ||
    value.maxHourlyUsd > 100
  ) {
    throw new Error("INVALID_LEASE_VALUE");
  }
  const deadlineMs = Date.parse(value.hardDeadlineAt);
  const heartbeatMs = Date.parse(value.lastHeartbeatAt);
  if (deadlineMs > nowMs + MAX_HARD_DEADLINE_MS || heartbeatMs > nowMs + SIGNATURE_WINDOW_MS) {
    throw new Error("INVALID_LEASE_TIME");
  }
  return { ...value };
}

function unchangedLeaseIdentity(previous, next) {
  return (
    previous.leaseId === next.leaseId &&
    previous.ownerInstanceId === next.ownerInstanceId &&
    previous.podName === next.podName &&
    previous.hardDeadlineAt === next.hardDeadlineAt &&
    previous.maxHourlyUsd === next.maxHourlyUsd &&
    (!previous.podId || previous.podId === next.podId)
  );
}

function leaseKey(leaseId) {
  return `${LEASE_PREFIX}${leaseId}`;
}

async function readBody(request) {
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("BODY_TOO_LARGE");
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("BODY_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function watchdogConfig(env) {
  const staleAfterSeconds = Number(env.STALE_AFTER_SECONDS ?? 180);
  const apiBaseUrl = new URL(env.RUNPOD_API_BASE_URL ?? "https://rest.runpod.io/v1");
  if (
    !Number.isInteger(staleAfterSeconds) ||
    staleAfterSeconds < 120 ||
    staleAfterSeconds > 600 ||
    apiBaseUrl.protocol !== "https:" ||
    apiBaseUrl.username ||
    apiBaseUrl.password ||
    apiBaseUrl.search ||
    apiBaseUrl.hash ||
    typeof env.RUNPOD_API_KEY !== "string" ||
    env.RUNPOD_API_KEY.length < 16
  ) {
    throw new Error("INVALID_WATCHDOG_CONFIG");
  }
  return {
    staleAfterMs: staleAfterSeconds * 1_000,
    apiBaseUrl: apiBaseUrl.toString().replace(/\/+$/, ""),
  };
}

async function runPodRequest(env, path, init = {}) {
  const { apiBaseUrl } = watchdogConfig(env);
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.RUNPOD_API_KEY}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`RUNPOD_HTTP_${response.status}`);
  if (response.status === 204) return {};
  const declared = Number(response.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declared) && declared > 2 * 1024 * 1024) {
    throw new Error("RUNPOD_RESPONSE_TOO_LARGE");
  }
  const reader = response.body?.getReader();
  const chunks = [];
  let total = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("RUNPOD_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  return text ? JSON.parse(text) : {};
}

function podRate(pod) {
  const raw = pod?.adjustedCostPerHr ?? pod?.costPerHr;
  const rate = typeof raw === "string" ? Number(raw) : raw;
  return typeof rate === "number" && Number.isFinite(rate) && rate >= 0 ? rate : null;
}

async function findPod(env, lease) {
  if (lease.podId) return runPodRequest(env, `/pods/${encodeURIComponent(lease.podId)}`);
  const pods = await runPodRequest(env, "/pods");
  if (!Array.isArray(pods)) throw new Error("RUNPOD_POD_LIST_INVALID");
  const matches = pods.filter((pod) => pod?.name === lease.podName);
  if (matches.length > 1) throw new Error("RUNPOD_POD_NAME_AMBIGUOUS");
  return matches[0] ?? null;
}

function terminationReason(lease, pod, nowMs, staleAfterMs) {
  if (pod?.desiredStatus === "TERMINATED") return "already-terminated";
  if (pod?.desiredStatus !== "RUNNING") return "provider-state-not-running";
  if (pod?.name !== lease.podName) return "pod-identity-mismatch";
  if (lease.podId && pod?.id !== lease.podId) return "pod-identity-mismatch";
  if (pod?.gpu?.count !== 1) return "gpu-count-policy";
  const rate = podRate(pod);
  if (rate === null) return "provider-rate-unavailable";
  if (rate > lease.maxHourlyUsd) return "provider-rate-ceiling";
  if (nowMs >= Date.parse(lease.hardDeadlineAt)) return "hard-deadline";
  if (nowMs - Date.parse(lease.lastHeartbeatAt) >= staleAfterMs) return "heartbeat-stale";
  return null;
}

async function listLeaseKeys(namespace) {
  const names = [];
  let cursor;
  do {
    const page = await namespace.list({
      prefix: LEASE_PREFIX,
      limit: MAX_LEASES,
      ...(cursor ? { cursor } : {}),
    });
    names.push(...page.keys.map((key) => key.name));
    if (names.length > MAX_LEASES) throw new Error("LEASE_LIMIT_EXCEEDED");
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return names;
}

export async function sweep(env, nowMs = Date.now()) {
  const { staleAfterMs } = watchdogConfig(env);
  const result = { checked: 0, terminationRequests: 0, errors: [] };
  try {
    const keys = await listLeaseKeys(env.LEASES);
    for (const key of keys) {
      result.checked += 1;
      try {
        const raw = await env.LEASES.get(key, "json");
        const lease = parseLease(raw, nowMs);
        const pod = await findPod(env, lease);
        if (!pod || pod.desiredStatus === "TERMINATED") {
          await env.LEASES.delete(key);
          continue;
        }
        const reason = terminationReason(lease, pod, nowMs, staleAfterMs);
        if (!reason) continue;
        const podId = lease.podId ?? pod.id;
        if (!SAFE_ID.test(podId ?? "")) throw new Error("RUNPOD_POD_ID_INVALID");
        const deletion = await runPodRequest(env, `/pods/${encodeURIComponent(podId)}`, {
          method: "DELETE",
        });
        result.terminationRequests += 1;
        if (deletion === null) await env.LEASES.delete(key);
      } catch (error) {
        result.errors.push(error instanceof Error ? error.message : "LEASE_SWEEP_FAILED");
      }
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : "SWEEP_FAILED");
  }
  const status = {
    schemaVersion: 1,
    sweptAt: new Date(nowMs).toISOString(),
    ok: result.errors.length === 0,
    checked: result.checked,
    terminationRequests: result.terminationRequests,
    errorCodes: [...new Set(result.errors)].slice(0, 20),
  };
  await env.LEASES.put(LAST_SWEEP_KEY, JSON.stringify(status), { expirationTtl: 86_400 });
  return status;
}

async function handleStatus(env, nowMs) {
  const lastSweep = await env.LEASES.get(LAST_SWEEP_KEY, "json");
  const sweptAtMs = lastSweep?.sweptAt ? Date.parse(lastSweep.sweptAt) : Number.NaN;
  const ready = Boolean(
    lastSweep?.ok && Number.isFinite(sweptAtMs) && nowMs - sweptAtMs <= 300_000,
  );
  return json({
    service: "glimmer-compute-watchdog",
    schemaVersion: 1,
    ready,
    checkedAt: new Date(nowMs).toISOString(),
    lastSweepAt: Number.isFinite(sweptAtMs) ? new Date(sweptAtMs).toISOString() : null,
    staleAfterSeconds: Number(env.STALE_AFTER_SECONDS ?? 180),
  });
}

async function handleUpsert(request, env, body, leaseId, nowMs) {
  let parsed;
  try {
    parsed = parseLease(JSON.parse(body), nowMs);
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : "INVALID_LEASE");
  }
  if (parsed.leaseId !== leaseId) return errorResponse(409, "LEASE_ID_MISMATCH");
  const key = leaseKey(leaseId);
  const existingRaw = await env.LEASES.get(key, "json");
  if (existingRaw) {
    let existing;
    try {
      existing = parseLease(existingRaw, nowMs);
    } catch {
      return errorResponse(409, "STORED_LEASE_INVALID");
    }
    if (!unchangedLeaseIdentity(existing, parsed))
      return errorResponse(409, "LEASE_IDENTITY_CHANGED");
    if (Date.parse(parsed.lastHeartbeatAt) < Date.parse(existing.lastHeartbeatAt)) {
      return errorResponse(409, "HEARTBEAT_REGRESSION");
    }
  }
  const deadlineTtl = Math.ceil((Date.parse(parsed.hardDeadlineAt) - nowMs) / 1_000) + 86_400;
  await env.LEASES.put(key, JSON.stringify(parsed), {
    expirationTtl: Math.max(3_600, deadlineTtl),
  });
  return json(
    { accepted: true, leaseId, storedAt: new Date(nowMs).toISOString() },
    existingRaw ? 200 : 201,
  );
}

async function handleRequest(request, env) {
  const nowMs = Date.now();
  const bodyResult = await readBody(request).then(
    (body) => ({ body }),
    (error) => ({ error }),
  );
  if ("error" in bodyResult) {
    return errorResponse(
      413,
      bodyResult.error instanceof Error ? bodyResult.error.message : "BODY_TOO_LARGE",
    );
  }
  const { body } = bodyResult;
  if (!(await authorized(request, env, body, nowMs))) return errorResponse(401, "UNAUTHORIZED");
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/v1/status") return handleStatus(env, nowMs);
  const match = url.pathname.match(/^\/v1\/leases\/([A-Za-z0-9._-]{1,191})$/);
  if (!match) return errorResponse(404, "NOT_FOUND");
  if (request.method === "PUT") return handleUpsert(request, env, body, match[1], nowMs);
  if (request.method === "DELETE") {
    await env.LEASES.delete(leaseKey(match[1]));
    return json({ deleted: true, leaseId: match[1] });
  }
  return errorResponse(405, "METHOD_NOT_ALLOWED");
}

export default {
  fetch: handleRequest,
  scheduled(_controller, env, context) {
    context.waitUntil(sweep(env));
  },
};
