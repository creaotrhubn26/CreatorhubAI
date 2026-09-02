import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PrewarmError,
  applyCanaryArtifacts,
  ProviderHttpError,
  ProviderTransportError,
  RunPodV2Client,
  buildCreatePodRequest,
  containsExactContainerLogLine,
  extractSseLogEvents,
  parseArguments,
  parseComputeConfig,
  parseCpuCatalog,
  parseExactPod,
  parseNetworkVolume,
  parsePod,
  parseProviderProblemDetails,
  parseRegistryIdentity,
  pollUntilExited,
  readPrivateRegularFile,
  resolveStatePaths,
  runReadOnlyPreflight,
  sanitizeTimelinePayload,
  selectCpuOffer,
  validateOwnedPod,
} from "./runpod-cpu-prewarm.mjs";

const digest = "a".repeat(64);
const image = `registry.example.com/glimmer@sha256:${digest}`;
const configuredImage = `registry.example.com/old@sha256:${"b".repeat(64)}`;
const buildId = "r2-0123456789ab";
const confirmation = "CREATE_EXACTLY_ONE_CAPPED_RUNPOD_CPU_POD";

function argumentsFor(mode) {
  return [
    mode,
    "--image",
    image,
    "--build-id",
    buildId,
    "--max-hourly-usd",
    "0.50",
    "--hard-deadline-seconds",
    "300",
  ];
}

function expectCode(callback, code) {
  assert.throws(callback, (error) => error instanceof PrewarmError && error.code === code);
}

function configuration(stateRoot = "/secure/state") {
  return {
    version: 1,
    enabled: false,
    defaultBackend: "local_process",
    activeProfileId: "production",
    apiKeyFile: path.join(stateRoot, "compute-keys", "runpod.key"),
    profiles: [
      {
        id: "production",
        provider: "runpod",
        cloudType: "SECURE",
        imageDigest: configuredImage,
        containerRegistryAuthId: "registry_credential_1",
        networkVolumeId: "network-volume_1",
        contextTokens: 65_536,
        modelArtifacts: {
          allowedHosts: ["artifacts.example.com"],
          model: {
            url: "https://artifacts.example.com/model.gguf",
            sha256: "1".repeat(64),
          },
          mmproj: {
            url: "https://artifacts.example.com/mmproj.gguf",
            sha256: "2".repeat(64),
          },
          draftModel: {
            url: "https://artifacts.example.com/draft.gguf",
            sha256: "3".repeat(64),
          },
        },
      },
    ],
  };
}

function parsedProfile() {
  const keyPath = "/secure/state/compute-keys/runpod.key";
  return parseComputeConfig(configuration(), keyPath);
}

function selectedCpu() {
  return selectCpuOffer(
    parseCpuCatalog({
      cpus: [
        {
          id: "cpu-expensive",
          vcpu: { min: 1, max: 8 },
          price: { securePerVcpu: 0.2 },
          availability: "HIGH",
          dataCenters: [{ id: "EU-RO-1", availability: "HIGH" }],
        },
        {
          id: "cpu-cheap",
          vcpu: { min: 2, max: 4 },
          price: { securePerVcpu: 0.1 },
          availability: "MEDIUM",
          dataCenters: [{ id: "EU-RO-1", availability: "LOW" }],
        },
      ],
    }),
    "EU-RO-1",
    0.5,
  );
}

function expectedContract() {
  const profile = parsedProfile();
  const volume = parseNetworkVolume(
    {
      id: profile.networkVolumeId,
      name: "models",
      size: 200,
      dataCenter: "EU-RO-1",
      type: "NETWORK",
    },
    profile.networkVolumeId,
  );
  const cpu = selectedCpu();
  const leaseId = "11111111-2222-4333-8444-555555555555";
  const podName = `glimmer-cpu-prewarm-${leaseId}`;
  const request = buildCreatePodRequest({
    profile,
    image,
    buildId,
    leaseId,
    podName,
    cpu,
    volume,
  });
  return { profile, volume, cpu, leaseId, podName, request };
}

function providerPod(expected, overrides = {}) {
  return {
    id: "pod_123",
    name: expected.podName,
    status: "EXITED",
    image: expected.request.image,
    args: "",
    disk: expected.request.disk,
    ports: [],
    env: { ...expected.request.env },
    registry: expected.request.registry,
    cloud: "SECURE",
    dataCenterId: expected.volume.dataCenter,
    cost: expected.cpu.hourlyUsd,
    cpu: { id: expected.cpu.id, vcpuCount: 2, memory: 8 },
    gpu: null,
    mounts: { network: expected.request.mounts.network.map((entry) => ({ ...entry })) },
    globalNetworking: { enabled: false },
    ssh: { proxy: null, direct: null },
    ...overrides,
  };
}

test("argument parser separates read-only preflight from paid execution", () => {
  const preflight = parseArguments(argumentsFor("--preflight"), {});
  assert.equal(preflight.mode, "preflight");
  assert.equal(preflight.execute, false);
  assert.equal(preflight.image, image);

  expectCode(() => parseArguments(argumentsFor("--execute"), {}), "authorization_required");
  const execute = parseArguments(argumentsFor("--execute"), {
    GLIMMER_RUNPOD_CPU_PREWARM: confirmation,
  });
  assert.equal(execute.mode, "execute");

  expectCode(
    () =>
      parseArguments([...argumentsFor("--preflight"), "--execute"], {
        GLIMMER_RUNPOD_CPU_PREWARM: confirmation,
      }),
    "invalid_mode",
  );
  expectCode(
    () => parseArguments(argumentsFor("--preflight").with(2, "latest"), {}),
    "invalid_image",
  );
  expectCode(
    () =>
      parseArguments(
        argumentsFor("--preflight")
          .map((value) => (value === "0.50" ? "1" : value))
          .map((value) => (value === "300" ? "3600" : value)),
        {},
      ),
    "invalid_cost_cap",
  );
});

test("canary arguments require a paired allowlisted HTTPS artifact and hex digest", () => {
  const sha = "a".repeat(64);
  const url = "https://artifacts.example.com/canary/tiny.bin";
  const canary = parseArguments(
    [...argumentsFor("--preflight"), "--canary-artifact-url", url, "--canary-artifact-sha256", sha],
    {},
  );
  assert.deepEqual(canary.canary, { url, sha256: sha });
  assert.equal(parseArguments(argumentsFor("--preflight"), {}).canary, null);

  expectCode(
    () => parseArguments([...argumentsFor("--preflight"), "--canary-artifact-url", url], {}),
    "invalid_canary",
  );
  expectCode(
    () =>
      parseArguments(
        [
          ...argumentsFor("--preflight"),
          "--canary-artifact-url",
          "http://artifacts.example.com/tiny.bin",
          "--canary-artifact-sha256",
          sha,
        ],
        {},
      ),
    "invalid_canary",
  );
  expectCode(
    () =>
      parseArguments(
        [
          ...argumentsFor("--preflight"),
          "--canary-artifact-url",
          url,
          "--canary-artifact-sha256",
          "zz",
        ],
        {},
      ),
    "invalid_canary",
  );

  const profile = parsedProfile();
  const substituted = applyCanaryArtifacts(profile, { url, sha256: sha });
  assert.deepEqual(substituted.artifacts.model, { url, sha256: sha });
  assert.deepEqual(substituted.artifacts.mmproj, { url, sha256: sha });
  assert.deepEqual(substituted.artifacts.draftModel, { url, sha256: sha });
  assert.deepEqual(substituted.artifacts.allowedHosts, profile.artifacts.allowedHosts);
  assert.equal(substituted.registry, profile.registry);
  expectCode(
    () => applyCanaryArtifacts(profile, { url: "https://evil.example.net/tiny.bin", sha256: sha }),
    "invalid_canary",
  );
});

test("state paths are fixed under the state root and ignore config overrides", () => {
  const paths = resolveStatePaths({
    GLIMMER_STATE_ROOT: "/private/state",
    GLIMMER_COMPUTE_CONFIG: "/tmp/untrusted.json",
  });
  assert.equal(paths.configPath, "/private/state/compute.json");
  assert.equal(paths.keyPath, "/private/state/compute-keys/runpod.key");
  expectCode(() => resolveStatePaths({ GLIMMER_STATE_ROOT: "relative" }), "invalid_state_root");
});

test("active profile parser preserves immutable registry, volume and artifacts", () => {
  const profile = parsedProfile();
  assert.equal(profile.id, "production");
  assert.equal(profile.configuredImage, configuredImage);
  assert.equal(profile.registry, "registry_credential_1");
  assert.equal(profile.networkVolumeId, "network-volume_1");
  assert.equal(profile.artifacts.model.sha256, "1".repeat(64));

  const wrongKey = configuration();
  wrongKey.apiKeyFile = "/tmp/key";
  expectCode(
    () => parseComputeConfig(wrongKey, "/secure/state/compute-keys/runpod.key"),
    "invalid_config",
  );
  const queriedArtifact = configuration();
  queriedArtifact.profiles[0].modelArtifacts.model.url =
    "https://artifacts.example.com/model.gguf?token=secret";
  expectCode(
    () => parseComputeConfig(queriedArtifact, "/secure/state/compute-keys/runpod.key"),
    "invalid_config",
  );
});

test("registry response must prove the exact configured identity and contain no secret fields", () => {
  assert.deepEqual(
    parseRegistryIdentity(
      { id: "registry_credential_1", name: "private registry" },
      "registry_credential_1",
    ),
    { id: "registry_credential_1", name: "private registry" },
  );
  expectCode(
    () =>
      parseRegistryIdentity(
        { id: "different_registry", name: "private registry" },
        "registry_credential_1",
      ),
    "invalid_registry",
  );
  expectCode(
    () =>
      parseRegistryIdentity(
        { id: "registry_credential_1", name: "private registry", password: "must-not-exist" },
        "registry_credential_1",
      ),
    "invalid_registry",
  );
});

test("CPU selector ranks exact-data-center availability before price within the ceiling", () => {
  const cpu = selectedCpu();
  assert.equal(cpu.id, "cpu-expensive");
  assert.equal(cpu.hourlyUsd, 0.4);
  assert.equal(cpu.dataCenterAvailability, "HIGH");
  expectCode(
    () =>
      selectCpuOffer(
        parseCpuCatalog({
          cpus: [
            {
              id: "wrong-dc",
              vcpu: { min: 2, max: 2 },
              price: { securePerVcpu: 0.01 },
              availability: "HIGH",
              dataCenters: [{ id: "US-TX-1", availability: "HIGH" }],
            },
          ],
        }),
        "EU-RO-1",
        0.5,
      ),
    "cpu_unavailable",
  );
});

test("create request uses explicit image and exact two-vCPU prewarm contract", () => {
  const expected = expectedContract();
  const request = expected.request;
  assert.equal(request.image, image);
  assert.notEqual(request.image, expected.profile.configuredImage);
  assert.deepEqual(request.cpu, { id: "cpu-expensive", vcpuCount: 2 });
  assert.equal(request.cloud, "SECURE");
  assert.equal(request.disk, 20);
  assert.deepEqual(request.ports, []);
  assert.equal("gpu" in request, false);
  assert.equal(request.registry, expected.profile.registry);
  assert.deepEqual(request.dataCenterIds, [expected.volume.dataCenter]);
  assert.deepEqual(request.mounts.network, [
    { volumeId: expected.profile.networkVolumeId, path: "/workspace" },
  ]);
  assert.equal(request.env.GLIMMER_PREWARM_ONLY, "1");
  assert.equal(request.env.GLIMMER_PREWARM_EXPECTED_BUILD_ID, buildId);
  assert.equal(request.env.GLIMMER_LEASE_ID, expected.leaseId);
  assert.equal(request.startSsh, false);
  assert.equal(request.startJupyter, false);
  assert.equal("globalNetworking" in request, false);
});

test("Pod proof rejects missing no-port evidence, extra env and EXITED over-price", () => {
  const contract = expectedContract();
  const expected = { ...contract, maxHourlyUsd: 0.5 };
  const valid = parsePod(providerPod(contract));
  assert.equal(validateOwnedPod(valid, expected, true), valid);
  assert.equal(parseExactPod(providerPod(contract), "pod_123").id, "pod_123");
  expectCode(() => parseExactPod(providerPod(contract), "pod_other"), "pod_identity_mismatch");

  const renamedImageField = providerPod(contract);
  renamedImageField.imageName = renamedImageField.image;
  delete renamedImageField.image;
  assert.equal(parsePod(renamedImageField).image, contract.request.image);
  expectCode(
    () => parsePod(providerPod(contract, { imageName: "registry.example/conflict:latest" })),
    "invalid_pod",
  );

  const missingPorts = providerPod(contract);
  delete missingPorts.ports;
  expectCode(() => parsePod(missingPorts), "invalid_pod");
  const missingArgs = providerPod(contract);
  delete missingArgs.args;
  expectCode(() => parsePod(missingArgs), "invalid_pod");

  const extraEnvironment = parsePod(
    providerPod(contract, { env: { ...contract.request.env, UNEXPECTED: "1" } }),
  );
  expectCode(() => validateOwnedPod(extraEnvironment, expected, true), "pod_contract_mismatch");
  const overpricedExited = parsePod(providerPod(contract, { cost: 0.51 }));
  expectCode(() => validateOwnedPod(overpricedExited, expected, true), "price_ceiling_exceeded");
  const changedArgs = parsePod(providerPod(contract, { args: "unexpected" }));
  expectCode(() => validateOwnedPod(changedArgs, expected, true), "pod_contract_mismatch");
  const changedDisk = parsePod(providerPod(contract, { disk: 21 }));
  expectCode(() => validateOwnedPod(changedDisk, expected, true), "pod_contract_mismatch");
  const proxyMetadata = parsePod(
    providerPod(contract, { ssh: { proxy: { host: "proxy" }, direct: null } }),
  );
  assert.equal(validateOwnedPod(proxyMetadata, expected, true), proxyMetadata);
  const directSsh = parsePod(
    providerPod(contract, { ssh: { proxy: null, direct: { host: "direct" } } }),
  );
  expectCode(() => validateOwnedPod(directSsh, expected, true), "pod_contract_mismatch");
});

test("SSE parsing requires the exact container marker line across chunks", () => {
  const marker = "GLIMMER_PREWARM_READY 11111111-2222-4333-8444-555555555555";
  const exactFrame = `id: 1\ndata: ${JSON.stringify({
    source: "container",
    line: marker,
    ts: "2026-08-30T00:00:00Z",
  })}\n\n`;
  const first = extractSseLogEvents(exactFrame.slice(0, 30));
  const second = extractSseLogEvents(first.remainder + exactFrame.slice(30));
  assert.equal(containsExactContainerLogLine(second.events, marker), true);
  assert.equal(containsExactContainerLogLine(second.events, `${marker} extra`), false);
  assert.equal(
    containsExactContainerLogLine(
      second.events.map((event) => ({ ...event, source: "system" })),
      marker,
    ),
    false,
  );
});

test("timeline sanitizer removes secret-bearing fields and redacts values", () => {
  const sanitized = sanitizeTimelinePayload({
    token: "secret",
    artifactUrl: "https://example.com/private",
    message: "Bearer rpa_supersecret at https://example.com/path",
    status: "ok",
  });
  assert.equal("token" in sanitized, false);
  assert.equal("artifactUrl" in sanitized, false);
  assert.equal(sanitized.status, "ok");
  assert.equal(sanitized.message.includes("rpa_supersecret"), false);
  assert.equal(sanitized.message.includes("https://"), false);
});

test("bounded Problem Details are strict and redact the active key, URLs and Bearer values", async () => {
  const apiKey = "opaque-active-api-key-value";
  const rawProblem = {
    title: `Bad Request ${apiKey}`,
    status: 400,
    detail: `Could not place https://private.example/path?token=value with Bearer opaque-token`,
    errors: [`credential=${apiKey}`],
  };
  const parsed = parseProviderProblemDetails(rawProblem, 400, [apiKey]);
  assert.ok(parsed);
  const serialized = JSON.stringify(parsed);
  assert.equal(serialized.includes(apiKey), false);
  assert.equal(serialized.includes("https://"), false);
  assert.equal(serialized.includes("opaque-token"), false);

  assert.equal(parseProviderProblemDetails({ ...rawProblem, status: 422 }, 400, [apiKey]), null);
  assert.equal(parseProviderProblemDetails({ ...rawProblem, traceId: "unexpected" }, 400), null);
  assert.equal(
    parseProviderProblemDetails({ ...rawProblem, detail: "x".repeat(2_049) }, 400),
    null,
  );

  let postCount = 0;
  const client = new RunPodV2Client({
    apiKey,
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, "POST");
      postCount += 1;
      return new Response(JSON.stringify(rawProblem), {
        status: 400,
        headers: { "Content-Type": "application/problem+json" },
      });
    },
  });
  await assert.rejects(client.createPodRaw(expectedContract().request), (error) => {
    assert.equal(error instanceof ProviderHttpError, true);
    assert.equal(error.status, 400);
    assert.deepEqual(error.providerProblem, parsed);
    return true;
  });
  assert.equal(postCount, 1);
});

test("malformed and oversized provider problems fall back to generic HTTP errors", async () => {
  const bodies = [
    "{not-json",
    JSON.stringify({ title: "Bad", status: 400, detail: "x".repeat(20_000) }),
  ];
  for (const body of bodies) {
    let postCount = 0;
    const client = new RunPodV2Client({
      apiKey: "opaque-active-api-key-value",
      fetchImpl: async () => {
        postCount += 1;
        return new Response(body, {
          status: 400,
          headers: { "Content-Type": "application/problem+json" },
        });
      },
    });
    await assert.rejects(client.createPodRaw(expectedContract().request), (error) => {
      assert.equal(error instanceof ProviderHttpError, true);
      assert.equal(error.status, 400);
      assert.equal(error.providerProblem, null);
      return true;
    });
    assert.equal(postCount, 1);
  }
});

test("Pod polling tolerates one bounded transient GET failure without another create", async () => {
  const expected = { ...expectedContract(), maxHourlyUsd: 0.5 };
  const exited = parsePod(providerPod(expected));
  const events = [];
  let getCalls = 0;
  const result = await pollUntilExited(
    {
      async getPod() {
        getCalls += 1;
        if (getCalls === 1) throw new ProviderTransportError("get Pod");
        return exited;
      },
    },
    exited.id,
    expected,
    performance.now() + 5_000,
    new AbortController().signal,
    { add: (event, payload) => events.push({ event, ...payload }) },
  );

  assert.equal(result, exited);
  assert.equal(getCalls, 2);
  assert.deepEqual(
    events.map(({ event }) => event),
    ["pod_poll_transport_retry", "pod_status"],
  );
  assert.equal(events[0].consecutiveFailure, 1);
});

test("Pod polling fails closed after three consecutive transient GET failures", async () => {
  const expected = { ...expectedContract(), maxHourlyUsd: 0.5 };
  const events = [];
  let getCalls = 0;

  await assert.rejects(
    pollUntilExited(
      {
        async getPod() {
          getCalls += 1;
          throw new ProviderTransportError("get Pod");
        },
      },
      "pod_123",
      expected,
      performance.now() + 5_000,
      new AbortController().signal,
      { add: (event, payload) => events.push({ event, ...payload }) },
    ),
    (error) => error instanceof ProviderTransportError,
  );

  assert.equal(getCalls, 3);
  assert.deepEqual(
    events.map(({ event }) => event),
    ["pod_poll_transport_retry", "pod_poll_transport_retry"],
  );
});

test("private file reader rejects symlinks, hardlinks and group-readable files", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-prewarm-test-"));
  context.after(async () => fs.rm(directory, { recursive: true, force: true }));
  await fs.chmod(directory, 0o700);

  const privateFile = path.join(directory, "private");
  await fs.writeFile(privateFile, "value", { mode: 0o600 });
  assert.equal((await readPrivateRegularFile(privateFile, "test file", 100)).toString(), "value");

  const symbolicLink = path.join(directory, "symbolic");
  await fs.symlink(privateFile, symbolicLink);
  await assert.rejects(
    readPrivateRegularFile(symbolicLink, "test file", 100),
    (error) => error instanceof PrewarmError && error.code === "unsafe_filesystem",
  );

  const hardLink = path.join(directory, "hard");
  await fs.link(privateFile, hardLink);
  await assert.rejects(
    readPrivateRegularFile(privateFile, "test file", 100),
    (error) => error instanceof PrewarmError && error.code === "unsafe_filesystem",
  );
  await fs.unlink(hardLink);

  await fs.chmod(privateFile, 0o640);
  await assert.rejects(
    readPrivateRegularFile(privateFile, "test file", 100),
    (error) => error instanceof PrewarmError && error.code === "unsafe_permissions",
  );
});

test("read-only preflight uses authenticated GETs only and writes a private sanitized result", async (context) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-preflight-test-"));
  context.after(async () => fs.rm(stateRoot, { recursive: true, force: true }));
  await fs.chmod(stateRoot, 0o700);
  const keyDirectory = path.join(stateRoot, "compute-keys");
  await fs.mkdir(keyDirectory, { mode: 0o700 });
  const key = "rpa_unit_test_secret";
  await fs.writeFile(path.join(keyDirectory, "runpod.key"), `${key}\n`, { mode: 0o600 });
  await fs.writeFile(
    path.join(stateRoot, "compute.json"),
    `${JSON.stringify(configuration(stateRoot))}\n`,
    { mode: 0o600 },
  );

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({
      url,
      method: options.method,
      authorization: options.headers.get("Authorization"),
    });
    if (url.endsWith("/v2/pods?includeClusterPods=true")) {
      return Response.json({ pods: [] });
    }
    if (url.endsWith("/v2/registries/registry_credential_1")) {
      return Response.json({ id: "registry_credential_1", name: "private registry" });
    }
    if (url.endsWith("/v2/network-volumes/network-volume_1")) {
      return Response.json({
        id: "network-volume_1",
        name: "models",
        size: 200,
        dataCenter: "EU-RO-1",
        type: "NETWORK",
      });
    }
    if (url.endsWith("/v2/catalog/cpus?include=AVAILABILITY&product=POD&vcpuCount=2")) {
      return Response.json({
        cpus: [
          {
            id: "cpu-secure",
            vcpu: { min: 2, max: 8 },
            price: { securePerVcpu: 0.1 },
            availability: "HIGH",
            dataCenters: [{ id: "EU-RO-1", availability: "HIGH" }],
          },
        ],
      });
    }
    throw new Error("unexpected fake-provider request");
  };

  const exitCode = await runReadOnlyPreflight(argumentsFor("--preflight"), {
    environment: { GLIMMER_STATE_ROOT: stateRoot },
    fetchImpl,
    randomUUID: () => "11111111-2222-4333-8444-555555555555",
  });
  assert.equal(exitCode, 0);
  assert.equal(calls.length, 6);
  assert.equal(
    calls.every((call) => call.method === "GET"),
    true,
  );
  assert.equal(
    calls.some((call) => call.method === "POST" || call.method === "DELETE"),
    false,
  );
  assert.equal(
    calls.every((call) => call.authorization === `Bearer ${key}`),
    true,
  );

  const resultPath = path.join(stateRoot, "runpod-cpu-prewarm-result.json");
  const metadata = await fs.stat(resultPath);
  assert.equal(metadata.mode & 0o777, 0o600);
  const resultText = await fs.readFile(resultPath, "utf8");
  const result = JSON.parse(resultText);
  assert.equal(result.mode, "preflight");
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.preflightValidated, true);
  assert.equal(result.cpu.availability, "HIGH");
  assert.equal(result.cpu.dataCenterAvailability, "HIGH");
  assert.equal(result.cleanup.readOnly, true);
  assert.equal(result.cleanup.providerPodCount, 0);
  assert.equal(resultText.includes(key), false);
  assert.equal(resultText.includes("https://artifacts.example.com"), false);
});

test("registry identity mismatch fails preflight before volume, CPU, or any mutation", async (context) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "glimmer-registry-test-"));
  context.after(async () => fs.rm(stateRoot, { recursive: true, force: true }));
  await fs.chmod(stateRoot, 0o700);
  const keyDirectory = path.join(stateRoot, "compute-keys");
  await fs.mkdir(keyDirectory, { mode: 0o700 });
  await fs.writeFile(path.join(keyDirectory, "runpod.key"), "opaque-active-key\n", { mode: 0o600 });
  await fs.writeFile(
    path.join(stateRoot, "compute.json"),
    `${JSON.stringify(configuration(stateRoot))}\n`,
    { mode: 0o600 },
  );

  const calls = [];
  const exitCode = await runReadOnlyPreflight(argumentsFor("--preflight"), {
    environment: { GLIMMER_STATE_ROOT: stateRoot },
    randomUUID: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      if (url.endsWith("/v2/pods?includeClusterPods=true")) return Response.json({ pods: [] });
      if (url.endsWith("/v2/registries/registry_credential_1")) {
        return Response.json({ id: "different_registry", name: "wrong registry" });
      }
      throw new Error("preflight continued after registry mismatch");
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(calls.length, 3);
  assert.equal(
    calls.every((call) => call.method === "GET"),
    true,
  );
  assert.equal(
    calls.filter((call) => call.url.endsWith("/v2/registries/registry_credential_1")).length,
    1,
  );
  assert.equal(
    calls.some((call) => call.method === "POST" || call.method === "DELETE"),
    false,
  );
  const result = JSON.parse(
    await fs.readFile(path.join(stateRoot, "runpod-cpu-prewarm-result.json"), "utf8"),
  );
  assert.equal(result.outcome, "failed");
  assert.equal(result.preflightValidated, false);
  assert.equal(result.failure.code, "invalid_registry");
});
