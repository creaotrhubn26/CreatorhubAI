import { describe, expect, it, vi } from "vitest";
import {
  RUNPOD_V2_MAX_JSON_BYTES,
  RunPodError,
  RunPodV2Client,
  RunPodV2HttpError,
  RunPodV2TransportError,
  buildCpuCacheCreateRequest,
  buildGpuCacheCreateRequest,
  buildGpuWorkerCreateRequest,
  parseRunPodV2CpuCatalog,
  parseRunPodV2GpuCatalog,
  parseRunPodV2NetworkVolume,
  parseRunPodV2Pod,
  selectCpuOffer,
  selectGpuOffer,
  toRunPodRestCreateRequest,
  validateRunPodV2Configuration,
  validateRunPodV2CreateRequest,
} from "./runpod-v2.js";

const API_KEY = `rpa_${"k".repeat(48)}`;
const BASE_URL = "https://rest.runpod.test/v1";
const CATALOG_BASE_URL = "https://api.runpod.test/v2";
const IMAGE = `registry.example/glimmer@sha256:${"a".repeat(64)}`;

function expectCode(callback, code) {
  expect(callback).toThrowError(expect.objectContaining({ code }));
}

function commonCreateInput(patch = {}) {
  return {
    podName: "glimmer-cache-job-1",
    image: IMAGE,
    registryId: "registry_1",
    networkVolumeId: "volume_1",
    dataCenterId: "EU-RO-1",
    environment: {
      GLIMMER_JOB_ID: "job-1",
      GLIMMER_CALLBACK_TOKEN: "callback-secret-that-must-not-be-returned",
    },
    ...patch,
  };
}

function cpuRequest(patch = {}) {
  return buildCpuCacheCreateRequest({
    ...commonCreateInput(),
    cpuId: "cpu3c-2-4",
    ...patch,
  });
}

function gpuRequest(patch = {}) {
  return buildGpuWorkerCreateRequest({
    ...commonCreateInput({ podName: "glimmer-gpu-job-1" }),
    gpuTypeId: "NVIDIA H100 80GB HBM3",
    ...patch,
  });
}

function gpuCacheRequest(patch = {}) {
  return buildGpuCacheCreateRequest({
    ...commonCreateInput(),
    gpuTypeId: "NVIDIA L4",
    ...patch,
  });
}

function providerPod(request, patch = {}) {
  return {
    id: "pod_123",
    name: request.name,
    desiredStatus: "RUNNING",
    containerDiskInGb: request.disk,
    containerRegistryAuthId: request.registry,
    costPerHr: request.cpu ? 0.08 : 2.49,
    imageName: request.image,
    machine: {
      dataCenterId: request.dataCenterIds[0],
      secureCloud: request.cloud === "SECURE",
    },
    networkVolume: {
      id: request.mounts.network[0].volumeId,
      name: "Glimmer cache",
      size: 200,
      dataCenterId: request.dataCenterIds[0],
    },
    ports: [...request.ports],
    volumeMountPath: request.mounts.network[0].path,
    ...(request.cpu
      ? { cpuFlavorId: request.cpu.id, vcpuCount: request.cpu.vcpuCount, gpu: null }
      : { cpuFlavorId: null, vcpuCount: 4, gpu: { ...request.gpu, memory: 80 } }),
    // A real provider response can echo environment data. The parser must not
    // retain it in coordinator state or expose it to callers.
    env: { ...request.env },
    ...patch,
  };
}

describe("RunPod v2 configuration", () => {
  it("accepts only HTTPS base URLs without URL credentials, query, or fragment", () => {
    const parsed = validateRunPodV2Configuration({
      apiKey: API_KEY,
      baseUrl: `${BASE_URL}/`,
      catalogBaseUrl: `${CATALOG_BASE_URL}/`,
      fetchImpl: async () => new Response(),
    });
    expect(parsed.baseUrl).toBe(BASE_URL);
    expect(parsed.catalogBaseUrl).toBe(CATALOG_BASE_URL);

    for (const baseUrl of [
      "http://api.runpod.test/v2",
      "https://user:password@api.runpod.test/v2",
      "https://api.runpod.test/v2?key=value",
      "https://api.runpod.test/v2#fragment",
      "https://api.runpod.test/v2//nested",
    ]) {
      expectCode(
        () =>
          validateRunPodV2Configuration({
            apiKey: API_KEY,
            baseUrl,
            catalogBaseUrl: CATALOG_BASE_URL,
            fetchImpl: async () => new Response(),
          }),
        "INVALID_RUNPOD_CONFIG",
      );
    }
    expectCode(
      () =>
        validateRunPodV2Configuration({
          apiKey: "contains whitespace",
          baseUrl: BASE_URL,
          catalogBaseUrl: CATALOG_BASE_URL,
          fetchImpl: async () => new Response(),
        }),
      "INVALID_RUNPOD_CONFIG",
    );
  });
});

describe("RunPod v2 create request builders", () => {
  it("builds the exact bounded Secure CPU cache Pod shape", () => {
    expect(cpuRequest()).toEqual({
      name: "glimmer-cache-job-1",
      image: IMAGE,
      args: "",
      disk: 20,
      ports: [],
      env: commonCreateInput().environment,
      registry: "registry_1",
      cloud: "SECURE",
      dataCenterIds: ["EU-RO-1"],
      mounts: { network: [{ volumeId: "volume_1", path: "/workspace" }] },
      globalNetworking: false,
      startJupyter: false,
      startSsh: false,
      cpu: { id: "cpu3c-2-4", vcpuCount: 2 },
    });
    expect(validateRunPodV2CreateRequest(cpuRequest())).toEqual(cpuRequest());
  });

  it("builds one exact Secure GPU with the worker port and shared volume", () => {
    expect(gpuRequest()).toEqual({
      name: "glimmer-gpu-job-1",
      image: IMAGE,
      args: "",
      disk: 50,
      ports: ["4318/http"],
      env: commonCreateInput().environment,
      registry: "registry_1",
      cloud: "SECURE",
      dataCenterIds: ["EU-RO-1"],
      mounts: { network: [{ volumeId: "volume_1", path: "/workspace" }] },
      globalNetworking: false,
      startJupyter: false,
      startSsh: false,
      gpu: { id: "NVIDIA H100 80GB HBM3", count: 1 },
    });
    expect(validateRunPodV2CreateRequest(gpuRequest())).toEqual(gpuRequest());
  });

  it("builds a bounded one-GPU cache Pod without exposing the worker port", () => {
    expect(gpuCacheRequest()).toEqual({
      name: "glimmer-cache-job-1",
      image: IMAGE,
      args: "",
      disk: 20,
      ports: [],
      env: commonCreateInput().environment,
      registry: "registry_1",
      cloud: "SECURE",
      dataCenterIds: ["EU-RO-1"],
      mounts: { network: [{ volumeId: "volume_1", path: "/workspace" }] },
      globalNetworking: false,
      startJupyter: false,
      startSsh: false,
      gpu: { id: "NVIDIA L4", count: 1 },
    });
    expect(validateRunPodV2CreateRequest(gpuCacheRequest())).toEqual(gpuCacheRequest());
  });

  it("maps the internal request to the documented REST Pod create fields", () => {
    expect(toRunPodRestCreateRequest(cpuRequest())).toEqual({
      name: "glimmer-cache-job-1",
      imageName: IMAGE,
      cloudType: "SECURE",
      computeType: "CPU",
      containerDiskInGb: 20,
      containerRegistryAuthId: "registry_1",
      cpuFlavorIds: ["cpu3c-2-4"],
      cpuFlavorPriority: "custom",
      dataCenterIds: ["EU-RO-1"],
      dataCenterPriority: "custom",
      dockerEntrypoint: [],
      dockerStartCmd: [],
      env: commonCreateInput().environment,
      globalNetworking: false,
      interruptible: false,
      locked: false,
      networkVolumeId: "volume_1",
      ports: [],
      vcpuCount: 2,
      volumeMountPath: "/workspace",
    });
    expect(toRunPodRestCreateRequest(gpuRequest())).toMatchObject({
      computeType: "GPU",
      gpuCount: 1,
      gpuTypeIds: ["NVIDIA H100 80GB HBM3"],
      gpuTypePriority: "custom",
      ports: ["4318/http"],
    });
  });

  it("rejects mutable images, path-like identities, extra fields, and multi-GPU requests", () => {
    expectCode(
      () =>
        buildCpuCacheCreateRequest({ ...commonCreateInput(), image: "image:latest", cpuId: "c" }),
      "INVALID_CREATE_REQUEST",
    );
    expectCode(() => cpuRequest({ networkVolumeId: "../volume" }), "INVALID_CREATE_REQUEST");
    expectCode(
      () => validateRunPodV2CreateRequest({ ...gpuRequest(), unexpected: true }),
      "INVALID_CREATE_REQUEST",
    );
    expectCode(
      () =>
        validateRunPodV2CreateRequest({ ...gpuRequest(), gpu: { ...gpuRequest().gpu, count: 2 } }),
      "INVALID_CREATE_REQUEST",
    );
  });
});

describe("RunPod v2 provider parsing and CPU selection", () => {
  it("parses documented NONE availability without treating it as rentable stock", () => {
    const cpus = parseRunPodV2CpuCatalog({
      cpus: [
        {
          id: "cpu3c",
          vcpu: { min: 2, max: 32 },
          price: { securePerVcpu: 0.03 },
          availability: "NONE",
        },
      ],
    });
    expect(cpus).toEqual([
      {
        id: "cpu3c",
        minimumVcpu: 2,
        maximumVcpu: 32,
        securePerVcpu: 0.03,
        availability: "NONE",
        dataCenters: [],
      },
    ]);
    expectCode(
      () => selectCpuOffer(cpus, { dataCenterId: "EUR-IS-1", maxHourlyUsd: 0.1 }),
      "CPU_UNAVAILABLE",
    );
  });

  it("parses the documented network volume identity and data center", () => {
    expect(
      parseRunPodV2NetworkVolume(
        { id: "volume_1", name: "Glimmer cache", size: 30, dataCenterId: "EUR-IS-1" },
        "volume_1",
      ),
    ).toEqual({
      id: "volume_1",
      dataCenterId: "EUR-IS-1",
      sizeGb: 30,
      name: "Glimmer cache",
    });
  });

  it("returns a secret-free Pod projection and requires exactly one compute type", () => {
    const request = gpuRequest();
    const pod = parseRunPodV2Pod(providerPod(request));
    expect(pod).toMatchObject({
      id: "pod_123",
      name: request.name,
      status: "RUNNING",
      gpu: { id: "NVIDIA H100 80GB HBM3", count: 1 },
      cpu: null,
      mounts: { network: [{ volumeId: "volume_1", path: "/workspace" }] },
    });
    expect(JSON.stringify(pod)).not.toContain("callback-secret");
    expect("env" in pod).toBe(false);

    expectCode(
      () => parseRunPodV2Pod(providerPod(request, { cpuFlavorId: "cpu3c" })),
      "INVALID_POD_ALLOCATION_FIELD",
    );
    expectCode(
      () => parseRunPodV2Pod(providerPod(request, { cpuFlavorId: null, gpu: null })),
      "INVALID_POD_ALLOCATION_FIELD",
    );

    const legacy = providerPod(request);
    legacy.image = legacy.imageName;
    delete legacy.imageName;
    expect(parseRunPodV2Pod(legacy).image).toBe(IMAGE);
    expectCode(
      () => parseRunPodV2Pod(providerPod(request, { image: "registry.example/conflict:latest" })),
      "INVALID_POD_IMAGE_FIELD",
    );
  });

  it("can enumerate an unrelated Pod while optional machine and volume fields are absent", () => {
    const request = cpuRequest();
    const partial = providerPod(request, {
      name: "Unrelated notebook Pod",
      imageName: "runpod/pytorch:latest",
      machine: {},
      networkVolume: null,
      containerRegistryAuthId: null,
      ports: undefined,
    });

    expect(parseRunPodV2Pod(partial)).toMatchObject({
      id: "pod_123",
      name: "Unrelated notebook Pod",
      cloud: null,
      dataCenterId: null,
      image: "runpod/pytorch:latest",
      registryId: null,
      ports: [],
      mounts: { network: [] },
    });
  });

  it("chooses deterministically at the volume data center and under the two-vCPU cap", () => {
    const cpus = parseRunPodV2CpuCatalog({
      cpus: [
        {
          id: "cpu-low-availability",
          vcpu: { min: 2, max: 8 },
          price: { securePerVcpu: 0.01 },
          availability: "HIGH",
          dataCenters: [{ id: "EU-RO-1", availability: "LOW" }],
        },
        {
          id: "cpu-beta",
          vcpu: { min: 1, max: 4 },
          price: { securePerVcpu: 0.04 },
          availability: "HIGH",
          dataCenters: [{ id: "EU-RO-1", availability: "HIGH" }],
        },
        {
          id: "cpu-alpha",
          vcpu: { min: 2, max: 2 },
          price: { securePerVcpu: 0.04 },
          availability: "HIGH",
          dataCenters: [{ id: "EU-RO-1", availability: "HIGH" }],
        },
        {
          id: "cpu-wrong-dc",
          vcpu: { min: 2, max: 2 },
          price: { securePerVcpu: 0.001 },
          availability: "HIGH",
          dataCenters: [{ id: "US-TX-1", availability: "HIGH" }],
        },
      ],
    });
    expect(selectCpuOffer(cpus, { dataCenterId: "EU-RO-1", maxHourlyUsd: 0.1 })).toMatchObject({
      id: "cpu-alpha",
      vcpuCount: 2,
      hourlyUsd: 0.08,
      dataCenterId: "EU-RO-1",
    });
    expectCode(
      () => selectCpuOffer(cpus, { dataCenterId: "EU-RO-1", maxHourlyUsd: 0.01 }),
      "CPU_UNAVAILABLE",
    );
  });
});

describe("RunPod v2 GPU catalog selection", () => {
  const catalog = () =>
    parseRunPodV2GpuCatalog({
      gpus: [
        {
          id: "NVIDIA L4",
          name: "L4",
          memory: 24,
          secure: true,
          price: { secure: 0.49, community: 0.31 },
          availability: "LOW",
          dataCenters: [{ id: "EUR-IS-1", name: "EUR-IS-1", availability: "LOW" }],
        },
        {
          id: "NVIDIA RTX PRO 6000 Blackwell Server Edition",
          name: "RTX PRO 6000",
          memory: 96,
          secure: true,
          price: { secure: 2.09, community: 1.69 },
          availability: "LOW",
          dataCenters: [{ id: "EUR-IS-1", name: "EUR-IS-1", availability: "LOW" }],
        },
        {
          id: "unknown",
          name: "unknown",
          memory: 0,
          secure: false,
          price: { secure: 0, community: 0.2 },
          availability: "NONE",
        },
      ],
    });

  it("selects only the exact Secure GPU in the volume data center under its ceiling", () => {
    expect(
      selectGpuOffer(catalog(), {
        gpuTypeId: "NVIDIA L4",
        dataCenterId: "EUR-IS-1",
        maxHourlyUsd: 0.49,
      }),
    ).toMatchObject({
      id: "NVIDIA L4",
      memoryGb: 24,
      hourlyUsd: 0.49,
      dataCenterId: "EUR-IS-1",
      dataCenterAvailability: "LOW",
    });
  });

  it("parses RunPod's unavailable zero-valued placeholder but never treats it as stock", () => {
    const gpus = catalog();
    expect(gpus.at(-1)).toMatchObject({
      id: "unknown",
      memoryGb: 0,
      secure: false,
      secureHourlyUsd: 0,
      availability: "NONE",
      dataCenters: [],
    });
    expectCode(
      () =>
        selectGpuOffer(gpus, {
          gpuTypeId: "unknown",
          dataCenterId: "EUR-IS-1",
          maxHourlyUsd: 0.49,
        }),
      "GPU_UNAVAILABLE",
    );
  });

  it("fails closed for another GPU, data center, exhausted stock, or insufficient ceiling", () => {
    for (const input of [
      {
        gpuTypeId: "NVIDIA RTX PRO 6000 Blackwell Server Edition",
        dataCenterId: "EUR-IS-1",
        maxHourlyUsd: 0.49,
      },
      { gpuTypeId: "NVIDIA L4", dataCenterId: "US-TX-1", maxHourlyUsd: 0.49 },
      { gpuTypeId: "NVIDIA L4", dataCenterId: "EUR-IS-1", maxHourlyUsd: 0.48 },
    ]) {
      expectCode(() => selectGpuOffer(catalog(), input), "GPU_UNAVAILABLE");
    }
    const unavailable = catalog();
    unavailable[0].dataCenters[0].availability = "NONE";
    expectCode(
      () =>
        selectGpuOffer(unavailable, {
          gpuTypeId: "NVIDIA L4",
          dataCenterId: "EUR-IS-1",
          maxHourlyUsd: 0.49,
        }),
      "GPU_UNAVAILABLE",
    );
  });
});

describe("RunPod v2 HTTP client", () => {
  it("separates documented REST resources from the read-only v2 catalogs", async () => {
    const request = cpuRequest();
    const calls = [];
    const client = new RunPodV2Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      catalogBaseUrl: CATALOG_BASE_URL,
      fetchImpl: async function (url, options) {
        expect(this).toBe(globalThis);
        calls.push({
          url,
          method: options.method,
          authorization: options.headers.get("Authorization"),
          redirect: options.redirect,
        });
        if (url.endsWith("/networkvolumes/volume_1")) {
          return Response.json({
            id: "volume_1",
            name: "Glimmer cache",
            size: 200,
            dataCenterId: "EU-RO-1",
          });
        }
        if (url.endsWith("/containerregistryauth/registry_1")) {
          return Response.json({ id: "registry_1", name: "Glimmer registry" });
        }
        if (url.endsWith("/catalog/cpus?include=AVAILABILITY&product=POD&vcpuCount=2")) {
          return Response.json({
            cpus: [
              {
                id: "cpu3c-2-4",
                vcpu: { min: 2, max: 4 },
                price: { securePerVcpu: 0.04 },
                availability: "HIGH",
                dataCenters: [{ id: "EU-RO-1", availability: "HIGH" }],
              },
            ],
          });
        }
        if (url.endsWith("/catalog/gpus?include=AVAILABILITY&product=POD&count=1&cloud=SECURE")) {
          return Response.json({
            gpus: [
              {
                id: "NVIDIA L4",
                name: "L4",
                memory: 24,
                secure: true,
                price: { secure: 0.49, community: 0.31 },
                availability: "HIGH",
                dataCenters: [{ id: "EU-RO-1", name: "EU Romania", availability: "HIGH" }],
              },
            ],
          });
        }
        if (url.endsWith("/pods?includeMachine=true&includeNetworkVolume=true")) {
          return Response.json([providerPod(request)]);
        }
        if (
          url.endsWith("/pods/pod_123?includeMachine=true&includeNetworkVolume=true") &&
          options.method === "GET"
        ) {
          return Response.json(providerPod(request));
        }
        if (url.endsWith("/pods/pod_123") && options.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        throw new Error("unexpected fake request");
      },
    });

    await expect(client.getNetworkVolume("volume_1")).resolves.toEqual({
      id: "volume_1",
      dataCenterId: "EU-RO-1",
      sizeGb: 200,
      name: "Glimmer cache",
    });
    await expect(client.getRegistry("registry_1")).resolves.toEqual({
      id: "registry_1",
      name: "Glimmer registry",
    });
    await expect(client.listCpuTypes()).resolves.toHaveLength(1);
    await expect(client.listGpuTypes()).resolves.toHaveLength(1);
    await expect(client.findPodByExactName(request.name)).resolves.toMatchObject({ id: "pod_123" });
    await expect(client.getPod("pod_123")).resolves.toMatchObject({ id: "pod_123" });
    await expect(client.deletePod("pod_123")).resolves.toBeUndefined();

    expect(calls.map((call) => call.method)).toEqual([
      "GET",
      "GET",
      "GET",
      "GET",
      "GET",
      "GET",
      "DELETE",
    ]);
    expect(calls.every((call) => call.authorization === `Bearer ${API_KEY}`)).toBe(true);
    expect(calls.every((call) => call.redirect === "manual")).toBe(true);
    expect(calls.slice(0, 2).every((call) => call.url.startsWith(BASE_URL))).toBe(true);
    expect(calls.slice(2, 4).every((call) => call.url.startsWith(CATALOG_BASE_URL))).toBe(true);
    expect(calls.slice(4).every((call) => call.url.startsWith(BASE_URL))).toBe(true);
  });

  it("sends exactly one POST and returns a parsed, secret-free exact Pod", async () => {
    const request = gpuRequest();
    const calls = [];
    const client = new RunPodV2Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return Response.json(providerPod(request), { status: 201 });
      },
    });
    const pod = await client.createPod(request, { maxHourlyUsd: 2.5 });
    expect(pod).toMatchObject({ id: "pod_123", name: request.name, cost: 2.49 });
    expect("env" in pod).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE_URL}/pods`);
    expect(calls[0].options.method).toBe("POST");
    expect(JSON.parse(calls[0].options.body)).toEqual(toRunPodRestCreateRequest(request));
  });

  it("marks an unusable successful create response ambiguous without a second POST", async () => {
    const request = gpuRequest();
    let postCount = 0;
    const client = new RunPodV2Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetchImpl: async () => {
        postCount += 1;
        return Response.json({ id: "pod_123", name: request.name }, { status: 201 });
      },
    });
    await expect(client.createPod(request)).rejects.toMatchObject({
      code: "INVALID_POD_IDENTITY",
      ambiguousCreate: true,
    });
    expect(postCount).toBe(1);
  });

  it("logs only a bounded redacted diagnostic when provider fetch rejects", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const secret = `rpa_${"s".repeat(48)}`;
    const client = new RunPodV2Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetchImpl: async () => {
        throw new TypeError(`fetch rejected ${secret} ${"x".repeat(64)}`);
      },
    });

    await expect(client.listPods()).rejects.toMatchObject({ code: "RUNPOD_TRANSPORT_ERROR" });
    expect(warning).toHaveBeenCalledTimes(1);
    const diagnostic = warning.mock.calls[0].join(" ");
    expect(diagnostic).toContain("TypeError:fetch rejected rpa_[redacted] [redacted]");
    expect(diagnostic).not.toContain(secret);
  });

  it("rejects a create response that does not prove Secure Cloud", async () => {
    const request = gpuRequest();
    const client = new RunPodV2Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetchImpl: async () =>
        Response.json(
          providerPod(request, {
            machine: { dataCenterId: request.dataCenterIds[0], secureCloud: false },
          }),
          { status: 201 },
        ),
    });

    await expect(client.createPod(request)).rejects.toMatchObject({
      code: "POD_CONTRACT_MISMATCH",
      ambiguousCreate: true,
    });
  });

  it("recovers by exact name even when an unrelated Pod fails full validation", async () => {
    const request = cpuRequest();
    const client = new RunPodV2Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetchImpl: async () =>
        Response.json([
          { id: "pod_junk", name: "Unrelated broken Pod", desiredStatus: "RUNNING", costPerHr: -1 },
          providerPod(request, { id: "pod_owned" }),
        ]),
    });
    await expect(client.findPodByExactName(request.name)).resolves.toMatchObject({
      id: "pod_owned",
    });
  });

  it("confirms Pod identity for cleanup even when descriptive fields are malformed", async () => {
    const client = new RunPodV2Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetchImpl: async () =>
        Response.json({
          id: "pod_123",
          name: "glimmer-cache-1",
          desiredStatus: "EXITED",
          costPerHr: "not-a-number",
          gpu: { id: "???" },
        }),
    });
    await expect(client.getPodIdentity("pod_123")).resolves.toEqual({
      id: "pod_123",
      name: "glimmer-cache-1",
      status: "EXITED",
    });
  });

  it("returns null identity for a deleted Pod and rejects a swapped id", async () => {
    let swapped = false;
    const client = new RunPodV2Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetchImpl: async () => {
        if (swapped) {
          return Response.json({ id: "pod_other", name: "x", desiredStatus: "RUNNING" });
        }
        return new Response(null, { status: 404 });
      },
    });
    await expect(client.getPodIdentity("pod_123")).resolves.toBeNull();
    swapped = true;
    await expect(client.getPodIdentity("pod_123")).rejects.toMatchObject({
      code: "POD_IDENTITY_MISMATCH",
    });
  });

  it("rejects duplicate exact names instead of choosing an arbitrary recovery Pod", async () => {
    const request = cpuRequest();
    const client = new RunPodV2Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetchImpl: async () =>
        Response.json([
          providerPod(request, { id: "pod_1" }),
          providerPod(request, { id: "pod_2" }),
        ]),
    });
    await expect(client.findPodByExactName(request.name)).rejects.toMatchObject({
      code: "DUPLICATE_POD_NAME",
    });
  });

  it("enforces the response cap before parsing provider JSON", async () => {
    const client = new RunPodV2Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetchImpl: async () =>
        new Response("{}", {
          headers: { "Content-Length": String(RUNPOD_V2_MAX_JSON_BYTES + 1) },
        }),
    });
    await expect(client.listPods()).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("fails closed on mismatched volume and Pod identities", async () => {
    const request = cpuRequest();
    const volumeClient = new RunPodV2Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetchImpl: async () =>
        Response.json({
          id: "other_volume",
          name: "Other cache",
          size: 200,
          dataCenterId: "EU-RO-1",
        }),
    });
    await expect(volumeClient.getNetworkVolume("volume_1")).rejects.toMatchObject({
      code: "INVALID_NETWORK_VOLUME",
    });

    const podClient = new RunPodV2Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetchImpl: async () => Response.json(providerPod(request, { id: "other_pod" })),
    });
    await expect(podClient.getPod("pod_123")).rejects.toMatchObject({
      code: "POD_IDENTITY_MISMATCH",
    });
  });

  it("keeps transport and HTTP failures secret-free and marks only POST ambiguity", async () => {
    const request = gpuRequest();
    const transportClient = new RunPodV2Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetchImpl: async () => {
        throw new Error(`network failure ${API_KEY} ${request.env.GLIMMER_CALLBACK_TOKEN}`);
      },
    });
    const transportError = await transportClient.createPod(request).catch((error) => error);
    expect(transportError).toBeInstanceOf(RunPodError);
    expect(transportError).toBeInstanceOf(RunPodV2TransportError);
    expect(transportError).toMatchObject({
      code: "RUNPOD_POST_RESULT_AMBIGUOUS",
      ambiguousCreate: true,
    });
    expect(`${transportError.message}${JSON.stringify(transportError)}`).not.toContain(API_KEY);
    expect(`${transportError.message}${JSON.stringify(transportError)}`).not.toContain(
      request.env.GLIMMER_CALLBACK_TOKEN,
    );

    const httpClient = new RunPodV2Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetchImpl: async () =>
        new Response(`provider leaked ${API_KEY} ${request.env.GLIMMER_CALLBACK_TOKEN}`, {
          status: 422,
        }),
    });
    const httpError = await httpClient.createPod(request).catch((error) => error);
    expect(httpError).toBeInstanceOf(RunPodV2HttpError);
    expect(httpError).toMatchObject({
      code: "RUNPOD_HTTP_ERROR",
      status: 422,
      ambiguousCreate: false,
    });
    expect(`${httpError.message}${JSON.stringify(httpError)}`).not.toContain(API_KEY);
    expect(`${httpError.message}${JSON.stringify(httpError)}`).not.toContain(
      request.env.GLIMMER_CALLBACK_TOKEN,
    );
  });

  it("rejects registry responses that might expose stored credentials", async () => {
    const client = new RunPodV2Client({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      fetchImpl: async () =>
        Response.json({ id: "registry_1", name: "registry", password: "provider-secret" }),
    });
    await expect(client.getRegistry("registry_1")).rejects.toMatchObject({
      code: "INVALID_REGISTRY",
    });
  });
});
