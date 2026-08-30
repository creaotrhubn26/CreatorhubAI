import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RemoteJobManifestV1 } from "@glimmer/shared";
import {
  WorkerClient,
  WorkerProtocolError,
  canonicalJsonBytes,
  decryptWorkerCheckpoint,
  parseWorkerHealth,
  workerBaseUrlForPod,
  workerRequestSignature,
} from "./workerClient.js";

const CAPABILITY = "C".repeat(43);
const CHECKPOINT_KEY = "D".repeat(43);

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function health(ready: boolean) {
  return {
    schemaVersion: 1,
    buildId: "sha256:image-build",
    ready,
    model: { ready: true, contextTokens: 65_536 },
    workerState: ready ? "ready" : "bootstrapping",
  };
}

function status(state = "created") {
  return {
    schemaVersion: 1,
    jobId: "job-1",
    sessionId: "session-1",
    state,
    receivedParts: 0,
    expectedParts: 1,
    receivedBytes: 0,
    expectedBytes: 6,
    createdAt: "2026-08-29T10:00:00Z",
    updatedAt: "2026-08-29T10:00:01Z",
    checkpoints: [],
  };
}

const manifest: RemoteJobManifestV1 = {
  schemaVersion: 1,
  instanceId: "development",
  sessionId: "session-1",
  jobId: "job-1",
  repositoryFingerprint: "a".repeat(64),
  baselineSha: "b".repeat(40),
  branch: "glimmer/job-1",
  objective: "Implement the bounded change",
  contextTokens: 65_536,
  maxRepairs: 2,
  timeoutSeconds: 1_200,
  createdAt: "2026-08-29T10:00:00Z",
  input: { format: "git_bundle", parts: 1, bytes: 6, sha256: "c".repeat(64) },
};

describe("WorkerClient", () => {
  it("uses the fixed RunPod HTTPS proxy origin and rejects unsafe Pod ids", () => {
    expect(workerBaseUrlForPod("pod_ABC-123")).toBe("https://pod_ABC-123-4318.proxy.runpod.net");
    expect(() => workerBaseUrlForPod("pod.example.com/escape")).toThrow(WorkerProtocolError);
    expect(() => new WorkerClient({ baseUrl: "https://pod.proxy.runpod.net/path" })).toThrow(
      /origin-only HTTPS/,
    );
  });

  it("matches the Python HMAC signature vector and canonical JSON ordering", () => {
    expect(new TextDecoder().decode(canonicalJsonBytes({ z: 1, a: { y: 2, b: 3 } }))).toBe(
      '{"a":{"b":3,"y":2},"z":1}',
    );
    expect(
      workerRequestSignature(
        "A".repeat(43),
        "POST",
        "/v1/jobs",
        "job-create-1",
        new TextEncoder().encode('{"a":1}'),
      ),
    ).toBe("12ed61075167e7c11868f0f4dd2a5af46ba65a547637696560627ca214ffd06b");
  });

  it("rejects extra health fields instead of trusting an expanded response", () => {
    expect(() => parseWorkerHealth({ ...health(true), capability: CAPABILITY })).toThrow(
      /unsupported or missing fields/,
    );
  });

  it("accepts the bounded health V2 bootstrap diagnostic and preserves V1 compatibility", () => {
    expect(parseWorkerHealth(health(false))).toMatchObject({ protocolVersion: 1 });
    expect(
      parseWorkerHealth({
        ...health(false),
        schemaVersion: 2,
        bootstrap: {
          stage: "artifact_downloading",
          outcome: "in_progress",
          stageStartedAt: "2026-08-29T10:00:00Z",
          updatedAt: "2026-08-29T10:00:01Z",
          artifact: {
            kind: "model",
            phase: "downloading",
            bytesCompleted: 268_435_456,
            bytesTotal: 19_700_000_000,
          },
        },
      }),
    ).toMatchObject({
      protocolVersion: 2,
      ready: false,
      bootstrap: {
        stage: "artifact_downloading",
        artifact: { kind: "model", bytesCompleted: 268_435_456 },
      },
    });
  });

  it("rejects forged or unbounded health V2 diagnostics", () => {
    const base = {
      ...health(true),
      schemaVersion: 2,
      bootstrap: {
        stage: "artifact_downloading",
        outcome: "in_progress",
        stageStartedAt: "2026-08-29T10:00:00Z",
        updatedAt: "2026-08-29T10:00:01Z",
        artifact: {
          kind: "model",
          phase: "downloading",
          bytesCompleted: 20,
          bytesTotal: 10,
        },
      },
    };
    expect(() => parseWorkerHealth(base)).toThrow(/byte progress/);
    expect(() =>
      parseWorkerHealth({
        ...base,
        bootstrap: { ...base.bootstrap, artifact: undefined, secret: "not allowed" },
      }),
    ).toThrow(/unsupported or missing fields/);
    expect(() =>
      parseWorkerHealth({
        ...base,
        bootstrap: {
          ...base.bootstrap,
          artifact: { ...base.bootstrap.artifact, bytesCompleted: 5 },
        },
      }),
    ).toThrow(/readiness conflicts/);
    expect(
      parseWorkerHealth({
        ...health(false),
        schemaVersion: 2,
        bootstrap: {
          stage: "ready",
          outcome: "ready",
          stageStartedAt: "2026-08-29T10:00:00Z",
          updatedAt: "2026-08-29T10:00:01Z",
        },
      }),
    ).toMatchObject({ ready: false, workerState: "bootstrapping" });
    expect(() =>
      parseWorkerHealth({
        ...health(false),
        schemaVersion: 2,
        bootstrap: {
          stage: "failed",
          outcome: "failed",
          stageStartedAt: "2026-08-29T10:00:00Z",
          updatedAt: "2026-08-29T10:00:01Z",
          failureCode: "unexpected_failure",
        },
      }),
    ).toThrow(/exit code is missing/);
  });

  it("performs the bootstrap and signed job flow against a stateful fake worker", async () => {
    let rotated = false;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const requestPath = new URL(String(_url)).pathname;
      expect(init?.redirect).toBe("error");
      const headers = new Headers(init?.headers);
      if (requestPath === "/v1/health") {
        expect(headers.get("authorization")).toBe(rotated ? `Bearer ${CAPABILITY}` : null);
        return json(health(rotated));
      }
      if (requestPath === "/v1/handshake") {
        expect(headers.get("authorization")).toBe(`Bearer ${"B".repeat(43)}`);
        expect(headers.get("idempotency-key")).toBe("handshake-1");
        rotated = true;
        return json({
          schemaVersion: 1,
          buildId: "sha256:image-build",
          capability: CAPABILITY,
          checkpointKey: CHECKPOINT_KEY,
          contextTokens: 65_536,
        });
      }
      if (requestPath === "/v1/jobs") {
        const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
        const expected = workerRequestSignature(CAPABILITY, "POST", requestPath, "create-1", body);
        expect(headers.get("authorization")).toBe(`Bearer ${CAPABILITY}`);
        expect(headers.get("x-glimmer-signature")).toBe(`sha256=${expected}`);
        return json(status(), 201);
      }
      throw new Error(`unexpected fake worker request ${requestPath}`);
    }) as typeof fetch;
    const client = new WorkerClient({
      baseUrl: "http://127.0.0.1:4318",
      allowLoopbackHttp: true,
      fetchImpl,
    });
    await expect(client.health()).resolves.toMatchObject({ ready: false });
    const handshake = await client.handshake({
      bootstrapToken: "B".repeat(43),
      controllerInstanceId: "development",
      nonce: "N".repeat(32),
      idempotencyKey: "handshake-1",
    });
    expect(handshake).toMatchObject({ capability: CAPABILITY, checkpointKey: CHECKPOINT_KEY });
    await expect(client.health(handshake.capability)).resolves.toMatchObject({ ready: true });
    await expect(client.createJob(manifest, CAPABILITY, "create-1")).resolves.toMatchObject({
      jobId: "job-1",
      state: "created",
    });
  });

  it("honors a shorter per-request readiness deadline and rejects invalid deadlines", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          }),
      ) as typeof fetch;
      const client = new WorkerClient({
        baseUrl: "http://127.0.0.1:4318",
        allowLoopbackHttp: true,
        fetchImpl,
        timeoutMs: 10_000,
      });

      const timedOut = expect(client.health(undefined, { timeoutMs: 25 })).rejects.toThrow(
        /timed out/,
      );
      await vi.advanceTimersByTimeAsync(25);
      await timedOut;
      await expect(client.health(undefined, { timeoutMs: 0 })).rejects.toThrow(/must be positive/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds and verifies encrypted checkpoint transport bytes", async () => {
    const checkpoint = new TextEncoder().encode("GLMR1-encrypted-checkpoint");
    const digest = createHash("sha256").update(checkpoint).digest("hex");
    const client = new WorkerClient({
      baseUrl: "http://127.0.0.1:4318",
      allowLoopbackHttp: true,
      fetchImpl: vi.fn(
        async () =>
          new Response(checkpoint, {
            status: 200,
            headers: { "X-Checkpoint-SHA256": digest },
          }),
      ) as typeof fetch,
    });
    await expect(client.checkpoint("job-1", 0, CAPABILITY)).resolves.toMatchObject({
      sha256: digest,
    });

    const tampered = new WorkerClient({
      baseUrl: "http://127.0.0.1:4318",
      allowLoopbackHttp: true,
      fetchImpl: vi.fn(
        async () =>
          new Response(checkpoint, {
            status: 200,
            headers: { "X-Checkpoint-SHA256": "0".repeat(64) },
          }),
      ) as typeof fetch,
    });
    await expect(tampered.checkpoint("job-1", 0, CAPABILITY)).rejects.toThrow(
      /digest does not match/,
    );
  });

  it("decrypts the deterministic Python AES-GCM checkpoint fixture and rejects AAD replay", () => {
    const key = "a2tra2tra2tra2tra2tra2tra2tra2tra2tra2tra2s";
    const envelope = Buffer.from(
      "R0xNUjFubm5ubm5ubm5ubm4AAAC6eyJmaW5hbCI6dHJ1ZSwiam9iSWQiOiJqb2ItMSIsImtpbmQiOiJyZXN1bHQiLCJwbGFpbnRleHRTaGEyNTYiOiIyNWQ1MzE4OTYxMmMyNmE1N2YyYTVmMGFiODcyYjgzYTJhMjRhNzQ4NTNjZjE1Nzg5YWNhMGI0OTRiMjgzNWZhIiwic2NoZW1hVmVyc2lvbiI6MSwic2VxdWVuY2UiOjAsInNlc3Npb25JZCI6InNlc3Npb24tMSJ98F6L3H6U5rEpR2A07MDCoGmGJ5Xo7oWvX0csqOnzPss=",
      "base64",
    );
    const metadata = {
      schemaVersion: 1 as const,
      jobId: "job-1",
      sessionId: "session-1",
      sequence: 0,
      kind: "result" as const,
      final: true,
      plaintextSha256: "25d53189612c26a57f2a5f0ab872b83a2a24a74853cf15789aca0b494b2835fa",
    };
    expect(new TextDecoder().decode(decryptWorkerCheckpoint(key, envelope, metadata))).toBe(
      "hello checkpoint",
    );
    expect(() =>
      decryptWorkerCheckpoint(key, envelope, { ...metadata, sessionId: "session-replay" }),
    ).toThrow(/metadata does not match/);
  });
});
