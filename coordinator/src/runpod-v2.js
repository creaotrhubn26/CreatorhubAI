const DEFAULT_BASE_URL = "https://api.runpod.io/v2";
const DEFAULT_TIMEOUT_MS = 15_000;
const CREATE_TIMEOUT_MS = 60_000;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_PODS = 1_000;
const MAX_CPUS = 256;
const VCPU_COUNT = 2;
const CPU_DISK_GB = 20;
const GPU_DISK_GB = 50;
const NETWORK_MOUNT_PATH = "/workspace";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;
const REGISTRY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,190}$/;
const CPU_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GPU_ID = /^[A-Za-z0-9][A-Za-z0-9 ._()+/-]{0,127}$/;
const DATA_CENTER_ID = /^[A-Z0-9][A-Z0-9-]{1,31}$/;
const IMMUTABLE_IMAGE = /^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/;
const ENVIRONMENT_KEY = /^[A-Z][A-Z0-9_]{0,127}$/;
const POD_STATUSES = new Set([
  "CREATED",
  "PROVISIONING",
  "STARTING",
  "RUNNING",
  "STOPPING",
  "STOPPED",
  "EXITED",
  "ERROR",
  "TERMINATED",
  "DELETING",
]);
const AVAILABILITY_LEVELS = new Set(["NONE", "LOW", "MEDIUM", "HIGH"]);
const IN_STOCK_AVAILABILITY = new Set(["LOW", "MEDIUM", "HIGH"]);
const NETWORK_VOLUME_TYPES = new Set(["STANDARD", "HIGH_PERFORMANCE"]);
const AVAILABILITY_RANK = Object.freeze({ HIGH: 0, MEDIUM: 1, LOW: 2 });

export const RUNPOD_V2_DEFAULT_BASE_URL = DEFAULT_BASE_URL;
export const RUNPOD_V2_MAX_JSON_BYTES = MAX_JSON_BYTES;

export class RunPodV2Error extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RunPodV2Error";
    this.code = code;
    this.ambiguousCreate = false;
  }
}

export class RunPodV2HttpError extends RunPodV2Error {
  constructor(operation, status) {
    super("RUNPOD_HTTP_ERROR", `RunPod ${operation} returned HTTP ${status}`);
    this.name = "RunPodV2HttpError";
    this.operation = operation;
    this.status = status;
  }
}

export class RunPodV2TransportError extends RunPodV2Error {
  constructor(operation, ambiguous = false) {
    super(
      ambiguous ? "RUNPOD_POST_RESULT_AMBIGUOUS" : "RUNPOD_TRANSPORT_ERROR",
      ambiguous
        ? `RunPod ${operation} may have completed without a usable response`
        : `RunPod ${operation} did not return a usable response`,
    );
    this.name = "RunPodV2TransportError";
    this.operation = operation;
    this.ambiguous = ambiguous;
    this.ambiguousCreate = ambiguous;
  }
}

function fail(code, message) {
  throw new RunPodV2Error(code, message);
}

function object(value, code, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${label} must be an object`);
  }
  return value;
}

function boundedText(value, code, label, maximum) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    fail(code, `${label} must be a bounded string`);
  }
  return value;
}

function finiteNumber(value, code, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(code, `${label} must be a bounded finite number`);
  }
  return value;
}

function integer(value, code, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = finiteNumber(value, code, label, minimum, maximum);
  if (!Number.isInteger(parsed)) fail(code, `${label} must be an integer`);
  return parsed;
}

function safeId(value, code, label) {
  const parsed = boundedText(value, code, label, 191);
  if (!SAFE_ID.test(parsed)) fail(code, `${label} is invalid`);
  return parsed;
}

function validateBaseUrl(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    fail("INVALID_RUNPOD_CONFIG", "RunPod API base URL is invalid");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("INVALID_RUNPOD_CONFIG", "RunPod API base URL is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    fail("INVALID_RUNPOD_CONFIG", "RunPod API base URL is invalid");
  }
  if (parsed.pathname.includes("//") || /%2f|%5c/i.test(parsed.pathname)) {
    fail("INVALID_RUNPOD_CONFIG", "RunPod API base URL path is invalid");
  }
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
  return `${parsed.origin}${pathname}`;
}

export function validateRunPodV2Configuration({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (
    typeof apiKey !== "string" ||
    apiKey.length < 16 ||
    apiKey.length > 4_096 ||
    !/^[\x21-\x7e]+$/.test(apiKey)
  ) {
    fail("INVALID_RUNPOD_CONFIG", "RunPod API key is invalid");
  }
  if (typeof fetchImpl !== "function") {
    fail("INVALID_RUNPOD_CONFIG", "RunPod fetch implementation is unavailable");
  }
  return { apiKey, baseUrl: validateBaseUrl(baseUrl), fetchImpl };
}

function validateRegistryId(value) {
  const parsed = boundedText(value, "INVALID_CREATE_REQUEST", "registry id", 191);
  if (!REGISTRY_ID.test(parsed)) {
    fail("INVALID_CREATE_REQUEST", "registry id is invalid");
  }
  return parsed;
}

function validateDataCenterId(value, code = "INVALID_CREATE_REQUEST") {
  const parsed = boundedText(value, code, "data center id", 32);
  if (!DATA_CENTER_ID.test(parsed)) fail(code, "data center id is invalid");
  return parsed;
}

function validateImage(value) {
  const parsed = boundedText(value, "INVALID_CREATE_REQUEST", "image", 512);
  if (!IMMUTABLE_IMAGE.test(parsed)) {
    fail("INVALID_CREATE_REQUEST", "image must be an immutable sha256 OCI reference");
  }
  return parsed;
}

function validateEnvironment(value) {
  const raw = object(value, "INVALID_CREATE_REQUEST", "environment");
  const entries = Object.entries(raw);
  if (entries.length > 64) fail("INVALID_CREATE_REQUEST", "environment has too many entries");
  const result = {};
  for (const [key, entry] of entries) {
    if (!ENVIRONMENT_KEY.test(key) || typeof entry !== "string" || entry.length > 8_192) {
      fail("INVALID_CREATE_REQUEST", "environment contains an invalid entry");
    }
    result[key] = entry;
  }
  return result;
}

function sharedCreateRequest(input, disk, ports) {
  const raw = object(input, "INVALID_CREATE_REQUEST", "create request input");
  const podName = safeId(raw.podName, "INVALID_CREATE_REQUEST", "pod name");
  const networkVolumeId = safeId(
    raw.networkVolumeId,
    "INVALID_CREATE_REQUEST",
    "network volume id",
  );
  return {
    name: podName,
    image: validateImage(raw.image),
    args: "",
    disk,
    ports,
    env: validateEnvironment(raw.environment),
    registry: validateRegistryId(raw.registryId),
    cloud: "SECURE",
    dataCenterIds: [validateDataCenterId(raw.dataCenterId)],
    mounts: {
      network: [{ volumeId: networkVolumeId, path: NETWORK_MOUNT_PATH }],
    },
    globalNetworking: false,
    startJupyter: false,
    startSsh: false,
  };
}

function exactKeys(value, required) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === required.length && required.every((key) => keys.includes(key));
}

export function buildCpuCachePodRequest(input) {
  const request = sharedCreateRequest(input, CPU_DISK_GB, []);
  const cpuId = boundedText(input.cpuId, "INVALID_CREATE_REQUEST", "CPU id", 128);
  if (!CPU_ID.test(cpuId)) fail("INVALID_CREATE_REQUEST", "CPU id is invalid");
  return {
    ...request,
    cpu: { id: cpuId, vcpuCount: VCPU_COUNT },
  };
}

export function buildGpuWorkerPodRequest(input) {
  const request = sharedCreateRequest(input, GPU_DISK_GB, ["4318/http"]);
  const gpuTypeId = boundedText(input.gpuTypeId, "INVALID_CREATE_REQUEST", "GPU type id", 128);
  if (!GPU_ID.test(gpuTypeId)) fail("INVALID_CREATE_REQUEST", "GPU type id is invalid");
  return {
    ...request,
    gpu: { id: gpuTypeId, count: 1 },
  };
}

export const buildCpuCacheCreateRequest = buildCpuCachePodRequest;
export const buildGpuWorkerCreateRequest = buildGpuWorkerPodRequest;

export function validateRunPodV2CreateRequest(value) {
  const raw = object(value, "INVALID_CREATE_REQUEST", "Pod create request");
  const commonKeys = [
    "name",
    "image",
    "args",
    "disk",
    "ports",
    "env",
    "registry",
    "cloud",
    "dataCenterIds",
    "mounts",
    "globalNetworking",
    "startJupyter",
    "startSsh",
  ];
  const hasCpu = raw.cpu !== undefined;
  const hasGpu = raw.gpu !== undefined;
  if (
    hasCpu === hasGpu ||
    !exactKeys(raw, [...commonKeys, hasCpu ? "cpu" : "gpu"]) ||
    raw.args !== "" ||
    raw.cloud !== "SECURE" ||
    raw.globalNetworking !== false ||
    raw.startJupyter !== false ||
    raw.startSsh !== false ||
    !Array.isArray(raw.dataCenterIds) ||
    raw.dataCenterIds.length !== 1 ||
    !exactKeys(raw.mounts, ["network"]) ||
    !Array.isArray(raw.mounts.network) ||
    raw.mounts.network.length !== 1 ||
    !exactKeys(raw.mounts.network[0], ["volumeId", "path"]) ||
    raw.mounts.network[0].path !== NETWORK_MOUNT_PATH
  ) {
    fail("INVALID_CREATE_REQUEST", "Pod create request has an invalid shape");
  }
  const input = {
    podName: raw.name,
    image: raw.image,
    registryId: raw.registry,
    networkVolumeId: raw.mounts.network[0].volumeId,
    dataCenterId: raw.dataCenterIds[0],
    environment: raw.env,
  };
  if (hasCpu) {
    if (
      raw.disk !== CPU_DISK_GB ||
      !Array.isArray(raw.ports) ||
      raw.ports.length !== 0 ||
      !exactKeys(raw.cpu, ["id", "vcpuCount"]) ||
      raw.cpu.vcpuCount !== VCPU_COUNT
    ) {
      fail("INVALID_CREATE_REQUEST", "CPU Pod create request has an invalid shape");
    }
    return buildCpuCachePodRequest({ ...input, cpuId: raw.cpu.id });
  }
  if (
    raw.disk !== GPU_DISK_GB ||
    !Array.isArray(raw.ports) ||
    raw.ports.length !== 1 ||
    raw.ports[0] !== "4318/http" ||
    !exactKeys(raw.gpu, ["id", "count"]) ||
    raw.gpu.count !== 1
  ) {
    fail("INVALID_CREATE_REQUEST", "GPU Pod create request has an invalid shape");
  }
  return buildGpuWorkerPodRequest({ ...input, gpuTypeId: raw.gpu.id });
}

function parseNetworkMount(value) {
  const raw = object(value, "INVALID_POD", "Pod network mount");
  const volumeId = safeId(raw.volumeId, "INVALID_POD", "Pod network volume id");
  const path = boundedText(raw.path, "INVALID_POD", "Pod network mount path", 512);
  const segments = path.split("/");
  if (!path.startsWith("/") || path.includes("//") || segments.includes("..")) {
    fail("INVALID_POD", "Pod network mount path is invalid");
  }
  return { volumeId, path };
}

function parseCpu(value) {
  const raw = object(value, "INVALID_POD", "Pod CPU");
  const id = boundedText(raw.id, "INVALID_POD", "Pod CPU id", 128);
  if (!CPU_ID.test(id)) fail("INVALID_POD", "Pod CPU id is invalid");
  const cpu = {
    id,
    vcpuCount: integer(raw.vcpuCount, "INVALID_POD", "Pod vCPU count", 1, 1_024),
  };
  if (raw.memory !== undefined) {
    cpu.memory = finiteNumber(raw.memory, "INVALID_POD", "Pod CPU memory", 0, 100_000_000);
  }
  return cpu;
}

function parseGpu(value) {
  const raw = object(value, "INVALID_POD", "Pod GPU");
  const id = boundedText(raw.id, "INVALID_POD", "Pod GPU id", 128);
  if (!GPU_ID.test(id)) fail("INVALID_POD", "Pod GPU id is invalid");
  const gpu = {
    id,
    count: integer(raw.count, "INVALID_POD", "Pod GPU count", 1, 64),
  };
  if (raw.memory !== undefined) {
    gpu.memory = finiteNumber(raw.memory, "INVALID_POD", "Pod GPU memory", 0, 100_000_000);
  }
  return gpu;
}

export function parseRunPodV2Pod(value) {
  const raw = object(value, "INVALID_POD", "Pod");
  const id = safeId(raw.id, "INVALID_POD", "Pod id");
  const name = safeId(raw.name, "INVALID_POD", "Pod name");
  const status = boundedText(raw.status, "INVALID_POD", "Pod status", 32);
  if (!POD_STATUSES.has(status)) fail("INVALID_POD", "Pod status is invalid");
  const cloud = boundedText(raw.cloud, "INVALID_POD", "Pod cloud", 16);
  if (cloud !== "SECURE" && cloud !== "COMMUNITY") {
    fail("INVALID_POD", "Pod cloud is invalid");
  }

  const cpu = raw.cpu === undefined || raw.cpu === null ? null : parseCpu(raw.cpu);
  const gpu = raw.gpu === undefined || raw.gpu === null ? null : parseGpu(raw.gpu);
  if ((cpu === null) === (gpu === null)) {
    fail("INVALID_POD", "Pod must report exactly one CPU or GPU allocation");
  }

  const mounts = object(raw.mounts, "INVALID_POD", "Pod mounts");
  const network = mounts.network ?? [];
  if (!Array.isArray(network) || network.length > 4) {
    fail("INVALID_POD", "Pod network mounts are invalid");
  }
  let dataCenterId = null;
  if (raw.dataCenterId !== null && raw.dataCenterId !== undefined) {
    dataCenterId = validateDataCenterId(raw.dataCenterId, "INVALID_POD");
  }
  return {
    id,
    name,
    status,
    cloud,
    cost: finiteNumber(raw.cost, "INVALID_POD", "Pod hourly cost", 0, 100_000),
    dataCenterId,
    cpu,
    gpu,
    mounts: { network: network.map(parseNetworkMount) },
  };
}

export function parseRunPodV2PodList(value) {
  const raw = object(value, "INVALID_POD_LIST", "Pod list response");
  if (!Array.isArray(raw.pods) || raw.pods.length > MAX_PODS) {
    fail("INVALID_POD_LIST", "Pod list has an invalid size");
  }
  const pods = raw.pods.map(parseRunPodV2Pod);
  if (new Set(pods.map((pod) => pod.id)).size !== pods.length) {
    fail("INVALID_POD_LIST", "Pod list contains duplicate identities");
  }
  return pods;
}

export function parseRunPodV2NetworkVolume(value, expectedId) {
  const raw = object(value, "INVALID_NETWORK_VOLUME", "network volume");
  const expected = safeId(expectedId, "INVALID_NETWORK_VOLUME", "expected network volume id");
  const id = safeId(raw.id, "INVALID_NETWORK_VOLUME", "network volume id");
  if (id !== expected) {
    fail("INVALID_NETWORK_VOLUME", "network volume identity does not match the request");
  }
  const type = boundedText(raw.type, "INVALID_NETWORK_VOLUME", "network volume type", 64);
  if (!NETWORK_VOLUME_TYPES.has(type)) {
    fail("INVALID_NETWORK_VOLUME", "network volume type is invalid");
  }
  return {
    id,
    dataCenterId: validateDataCenterId(raw.dataCenter, "INVALID_NETWORK_VOLUME"),
    sizeGb: integer(raw.size, "INVALID_NETWORK_VOLUME", "network volume size", 1, 1_000_000),
    type,
  };
}

export function parseRunPodV2Registry(value, expectedId) {
  const raw = object(value, "INVALID_REGISTRY", "registry credential");
  if (Object.keys(raw).some((key) => key !== "id" && key !== "name")) {
    fail("INVALID_REGISTRY", "registry response contains unexpected fields");
  }
  const expected = boundedText(expectedId, "INVALID_REGISTRY", "expected registry id", 191);
  const id = boundedText(raw.id, "INVALID_REGISTRY", "registry id", 191);
  if (!REGISTRY_ID.test(expected) || !REGISTRY_ID.test(id) || id !== expected) {
    fail("INVALID_REGISTRY", "registry identity does not match the request");
  }
  return {
    id,
    name: boundedText(raw.name, "INVALID_REGISTRY", "registry name", 191),
  };
}

export function parseRunPodV2CpuCatalog(value) {
  const raw = object(value, "INVALID_CPU_CATALOG", "CPU catalog response");
  if (!Array.isArray(raw.cpus) || raw.cpus.length > MAX_CPUS) {
    fail("INVALID_CPU_CATALOG", "CPU catalog has an invalid size");
  }
  const cpus = raw.cpus.map((entry) => {
    const cpu = object(entry, "INVALID_CPU_CATALOG", "CPU catalog entry");
    const id = boundedText(cpu.id, "INVALID_CPU_CATALOG", "CPU id", 128);
    if (!CPU_ID.test(id)) fail("INVALID_CPU_CATALOG", "CPU id is invalid");
    const vcpu = object(cpu.vcpu, "INVALID_CPU_CATALOG", "CPU vCPU range");
    const minimumVcpu = integer(vcpu.min, "INVALID_CPU_CATALOG", "minimum vCPU", 1, 1_024);
    const maximumVcpu = integer(vcpu.max, "INVALID_CPU_CATALOG", "maximum vCPU", 1, 1_024);
    if (minimumVcpu > maximumVcpu) {
      fail("INVALID_CPU_CATALOG", "CPU vCPU range is invalid");
    }
    const price = object(cpu.price, "INVALID_CPU_CATALOG", "CPU price");
    const securePerVcpu = finiteNumber(
      price.securePerVcpu,
      "INVALID_CPU_CATALOG",
      "Secure CPU price",
      Number.MIN_VALUE,
      10_000,
    );
    const dataCenters = cpu.dataCenters ?? [];
    if (!Array.isArray(dataCenters) || dataCenters.length > 256) {
      fail("INVALID_CPU_CATALOG", "CPU data center availability is invalid");
    }
    const parsedDataCenters = dataCenters.map((candidate) => {
      const center = object(candidate, "INVALID_CPU_CATALOG", "CPU data center availability");
      const availability = boundedText(
        center.availability,
        "INVALID_CPU_CATALOG",
        "CPU availability",
        16,
      );
      if (!AVAILABILITY_LEVELS.has(availability)) {
        fail("INVALID_CPU_CATALOG", "CPU availability is invalid");
      }
      return {
        id: validateDataCenterId(center.id, "INVALID_CPU_CATALOG"),
        availability,
      };
    });
    if (new Set(parsedDataCenters.map((center) => center.id)).size !== parsedDataCenters.length) {
      fail("INVALID_CPU_CATALOG", "CPU data center availability contains duplicates");
    }
    const availability = boundedText(
      cpu.availability,
      "INVALID_CPU_CATALOG",
      "CPU global availability",
      16,
    );
    if (!AVAILABILITY_LEVELS.has(availability)) {
      fail("INVALID_CPU_CATALOG", "CPU global availability is invalid");
    }
    return {
      id,
      minimumVcpu,
      maximumVcpu,
      securePerVcpu,
      availability,
      dataCenters: parsedDataCenters,
    };
  });
  if (new Set(cpus.map((cpu) => cpu.id)).size !== cpus.length) {
    fail("INVALID_CPU_CATALOG", "CPU catalog contains duplicate identities");
  }
  return cpus;
}

function compareAscii(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function selectRunPodV2CpuOffer(cpus, { dataCenterId, maxHourlyUsd } = {}) {
  if (!Array.isArray(cpus) || cpus.length > MAX_CPUS) {
    fail("INVALID_CPU_SELECTION", "CPU candidates are invalid");
  }
  const dataCenter = validateDataCenterId(dataCenterId, "INVALID_CPU_SELECTION");
  const ceiling = finiteNumber(
    maxHourlyUsd,
    "INVALID_CPU_SELECTION",
    "CPU hourly ceiling",
    Number.MIN_VALUE,
    100,
  );
  const candidates = cpus
    .flatMap((cpu) => {
      if (
        !cpu ||
        typeof cpu !== "object" ||
        cpu.minimumVcpu > VCPU_COUNT ||
        cpu.maximumVcpu < VCPU_COUNT ||
        !IN_STOCK_AVAILABILITY.has(cpu.availability)
      ) {
        return [];
      }
      const exactCenter = cpu.dataCenters?.find((center) => center.id === dataCenter);
      if (!exactCenter || !IN_STOCK_AVAILABILITY.has(exactCenter.availability)) return [];
      const hourlyUsd = cpu.securePerVcpu * VCPU_COUNT;
      if (!Number.isFinite(hourlyUsd) || hourlyUsd <= 0 || hourlyUsd > ceiling) return [];
      return [
        {
          ...cpu,
          vcpuCount: VCPU_COUNT,
          hourlyUsd,
          dataCenterId: dataCenter,
          dataCenterAvailability: exactCenter.availability,
        },
      ];
    })
    .sort(
      (left, right) =>
        AVAILABILITY_RANK[left.dataCenterAvailability] -
          AVAILABILITY_RANK[right.dataCenterAvailability] ||
        left.hourlyUsd - right.hourlyUsd ||
        AVAILABILITY_RANK[left.availability] - AVAILABILITY_RANK[right.availability] ||
        compareAscii(left.id, right.id),
    );
  if (!candidates.length) {
    fail(
      "CPU_UNAVAILABLE",
      "no two-vCPU Secure CPU offer is available at the volume data center within the ceiling",
    );
  }
  return candidates[0];
}

export const selectCpuOffer = selectRunPodV2CpuOffer;

async function readResponseBytes(response, maximumBytes) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined && contentLength !== "") {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > maximumBytes) {
      fail("RESPONSE_TOO_LARGE", "RunPod response exceeds the safe size limit");
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      fail("RESPONSE_TOO_LARGE", "RunPod response exceeds the safe size limit");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function linkedAbortController(signal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}

function validatePodAgainstCreateRequest(pod, request, maxHourlyUsd) {
  const network = request.mounts.network;
  const expectedDataCenterId = request.dataCenterIds[0];
  if (
    pod.name !== request.name ||
    pod.cloud !== request.cloud ||
    (pod.dataCenterId !== null && pod.dataCenterId !== expectedDataCenterId) ||
    pod.mounts.network.length !== 1 ||
    pod.mounts.network[0].volumeId !== network[0].volumeId ||
    pod.mounts.network[0].path !== NETWORK_MOUNT_PATH ||
    (request.cpu &&
      (!pod.cpu || pod.gpu || pod.cpu.id !== request.cpu.id || pod.cpu.vcpuCount !== VCPU_COUNT)) ||
    (request.gpu && (!pod.gpu || pod.cpu || pod.gpu.id !== request.gpu.id || pod.gpu.count !== 1))
  ) {
    fail("POD_CONTRACT_MISMATCH", "created Pod does not match the requested identity");
  }
  if (maxHourlyUsd !== undefined) {
    const ceiling = finiteNumber(
      maxHourlyUsd,
      "INVALID_CREATE_REQUEST",
      "hourly ceiling",
      Number.MIN_VALUE,
      100,
    );
    if (pod.cost > ceiling) {
      fail("PRICE_CEILING_EXCEEDED", "created Pod exceeds the explicit hourly ceiling");
    }
  }
  return pod;
}

export class RunPodV2Client {
  constructor(configuration) {
    const parsed = validateRunPodV2Configuration(configuration);
    this.apiKey = parsed.apiKey;
    this.baseUrl = parsed.baseUrl;
    this.fetchImpl = parsed.fetchImpl;
  }

  async requestJson(operation, requestPath, options = {}) {
    const method = options.method ?? "GET";
    const timeout = linkedAbortController(
      options.signal,
      options.timeoutMs ?? (method === "POST" ? CREATE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS),
    );
    let body;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
        timeout.dispose();
        fail("INVALID_CREATE_REQUEST", "RunPod request exceeds the safe size limit");
      }
    }
    try {
      let response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${requestPath}`, {
          method,
          headers: new Headers({
            Accept: "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          }),
          body,
          signal: timeout.signal,
          redirect: "error",
        });
      } catch {
        throw new RunPodV2TransportError(operation, method === "POST");
      }
      if (!response || !Number.isInteger(response.status) || !response.headers) {
        throw new RunPodV2TransportError(operation, method === "POST");
      }
      if (options.nullOn404 && response.status === 404) return null;
      const expectedStatuses = options.expectedStatuses ?? [200];
      if (!expectedStatuses.includes(response.status)) {
        throw new RunPodV2HttpError(operation, response.status);
      }
      if (response.status === 204) return null;
      let bytes;
      try {
        bytes = await readResponseBytes(response, MAX_JSON_BYTES);
      } catch (error) {
        if (method === "POST") throw new RunPodV2TransportError(operation, true);
        throw error;
      }
      if (!bytes.byteLength) {
        if (method === "POST") throw new RunPodV2TransportError(operation, true);
        fail("INVALID_PROVIDER_JSON", "RunPod returned an empty JSON response");
      }
      try {
        return JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        if (method === "POST") throw new RunPodV2TransportError(operation, true);
        fail("INVALID_PROVIDER_JSON", "RunPod returned invalid JSON");
      }
    } finally {
      timeout.dispose();
    }
  }

  async getNetworkVolume(volumeId, options = {}) {
    const id = safeId(volumeId, "INVALID_NETWORK_VOLUME", "network volume id");
    return parseRunPodV2NetworkVolume(
      await this.requestJson(
        "network volume lookup",
        `/network-volumes/${encodeURIComponent(id)}`,
        options,
      ),
      id,
    );
  }

  async getRegistry(registryId, options = {}) {
    const id = boundedText(registryId, "INVALID_REGISTRY", "registry id", 191);
    if (!REGISTRY_ID.test(id)) fail("INVALID_REGISTRY", "registry id is invalid");
    return parseRunPodV2Registry(
      await this.requestJson("registry lookup", `/registries/${encodeURIComponent(id)}`, options),
      id,
    );
  }

  async listPods(options = {}) {
    return parseRunPodV2PodList(
      await this.requestJson("Pod list", "/pods?includeClusterPods=true", options),
    );
  }

  async findPodByExactName(podName, options = {}) {
    const name = safeId(podName, "INVALID_POD_NAME", "Pod name");
    const matches = (await this.listPods(options)).filter((pod) => pod.name === name);
    if (matches.length > 1) {
      fail("DUPLICATE_POD_NAME", "more than one Pod has the exact recovery name");
    }
    return matches[0] ?? null;
  }

  async listCpuTypes(options = {}) {
    return parseRunPodV2CpuCatalog(
      await this.requestJson(
        "CPU catalog lookup",
        "/catalog/cpus?include=AVAILABILITY&product=POD&vcpuCount=2",
        options,
      ),
    );
  }

  async getPod(podId, options = {}) {
    const id = safeId(podId, "INVALID_POD_ID", "Pod id");
    const response = await this.requestJson("Pod lookup", `/pods/${encodeURIComponent(id)}`, {
      ...options,
      nullOn404: true,
    });
    if (response === null) return null;
    const pod = parseRunPodV2Pod(response);
    if (pod.id !== id) {
      fail("POD_IDENTITY_MISMATCH", "RunPod returned a Pod other than the exact requested id");
    }
    return pod;
  }

  async deletePod(podId, options = {}) {
    const id = safeId(podId, "INVALID_POD_ID", "Pod id");
    await this.requestJson("Pod deletion", `/pods/${encodeURIComponent(id)}`, {
      ...options,
      method: "DELETE",
      expectedStatuses: [204],
      nullOn404: true,
    });
  }

  async createPod(request, options = {}) {
    const raw = validateRunPodV2CreateRequest(request);
    const response = await this.requestJson("Pod creation", "/pods", {
      method: "POST",
      body: raw,
      expectedStatuses: [201],
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    try {
      return validatePodAgainstCreateRequest(parseRunPodV2Pod(response), raw, options.maxHourlyUsd);
    } catch (error) {
      // A 201 response proves the mutation was accepted even when its body is
      // incomplete or violates the pinned contract. The caller must recover by
      // exact name and must never issue a second create.
      if (error instanceof RunPodV2Error) {
        error.ambiguousCreate = true;
        throw error;
      }
      throw new RunPodV2TransportError("Pod creation", true);
    }
  }
}

export { RunPodV2Error as RunPodError };
