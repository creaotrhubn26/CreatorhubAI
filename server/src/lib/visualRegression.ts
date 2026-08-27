import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import type {
  VisualManifest,
  VisualRegressionBaseline,
  VisualRegressionComparison,
  VisualRegressionEvidence,
  VisualRegressionReport,
} from "@glimmer/shared";
import { sessionsDir } from "../config.js";

const SAFE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SAFE_CHANGE_SET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const SCREENSHOT_RE = /^[A-Za-z0-9x-]{1,180}\.png$/;
const BASELINE_SCREENSHOT_RE = /^baseline-[a-f0-9]{16}-[A-Za-z0-9x-]{1,180}\.png$/;
const DIFF_SCREENSHOT_RE = /^diff-[a-f0-9]{16}-[A-Za-z0-9x-]{1,180}\.png$/;
const MAX_PNG_BYTES = 50 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const MAX_CAPTURES = 50;
const MAX_BASELINE_BYTES = 200 * 1024 * 1024;
export const DEFAULT_VISUAL_DIFFERENCE_THRESHOLD = 0.01;
export const DEFAULT_VISUAL_PIXEL_TOLERANCE = 16;

const mutationTails = new Map<string, Promise<void>>();

export class VisualRegressionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertSessionId(value: string): string {
  if (!SAFE_SESSION_ID_RE.test(value)) {
    throw new VisualRegressionError("session not found", 404);
  }
  return value;
}

function assertChangeSetId(value: string): string {
  if (!SAFE_CHANGE_SET_ID_RE.test(value)) {
    throw new VisualRegressionError("change set not found", 404);
  }
  return value;
}

function regressionRoot(sessionId: string, changeSetId: string): string {
  return path.join(
    sessionsDir(),
    assertSessionId(sessionId),
    "visual",
    "regression",
    assertChangeSetId(changeSetId),
  );
}

function captureKey(viewport: string, state: string): string {
  return `${viewport}\0${state}`;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  mutationTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (mutationTails.get(key) === tail) mutationTails.delete(key);
  }
}

async function atomicBytes(file: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { mode: 0o600 });
    const handle = await fs.open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    try {
      const directory = await fs.open(path.dirname(file), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // The file itself is durable on filesystems that do not permit directory fsync.
    }
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await atomicBytes(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function boundedPngDimensions(bytes: Buffer): { width: number; height: number } {
  const signature = "89504e470d0a1a0a";
  if (
    bytes.length < 24 ||
    bytes.subarray(0, 8).toString("hex") !== signature ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    throw new VisualRegressionError("screenshot is not a readable PNG image", 409);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width * height > MAX_PIXELS) {
    throw new VisualRegressionError("screenshot dimensions exceed the visual gate limit", 409);
  }
  return { width, height };
}

async function pngFromFile(file: string): Promise<{ bytes: Buffer; png: PNG; mtimeMs: number }> {
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new VisualRegressionError("screenshot is unavailable", 409);
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PNG_BYTES) {
    throw new VisualRegressionError("screenshot must be a bounded regular PNG file", 409);
  }
  const bytes = await fs.readFile(file);
  const dimensions = boundedPngDimensions(bytes);
  let png: PNG;
  try {
    png = PNG.sync.read(bytes);
  } catch {
    throw new VisualRegressionError("screenshot is not a readable PNG image", 409);
  }
  if (png.width !== dimensions.width || png.height !== dimensions.height) {
    throw new VisualRegressionError("screenshot dimensions are inconsistent", 409);
  }
  return { bytes, png, mtimeMs: stat.mtimeMs };
}

function currentScreenshotPath(sessionId: string, screenshot: string): string {
  if (!SCREENSHOT_RE.test(screenshot)) {
    throw new VisualRegressionError("visual manifest screenshot name is invalid", 409);
  }
  const visualRoot = path.resolve(sessionsDir(), assertSessionId(sessionId), "visual");
  const resolved = path.resolve(visualRoot, screenshot);
  if (!contains(visualRoot, resolved) || path.dirname(resolved) !== visualRoot) {
    throw new VisualRegressionError("visual manifest screenshot path is invalid", 409);
  }
  return resolved;
}

function capturedManifestEntries(manifest: VisualManifest) {
  if (
    !manifest ||
    manifest.status !== "pass" ||
    typeof manifest.route !== "string" ||
    !manifest.route ||
    manifest.route.length > 2_048 ||
    !Array.isArray(manifest.captures) ||
    !manifest.captures.length ||
    manifest.captures.length > MAX_CAPTURES
  ) {
    throw new VisualRegressionError(
      "a complete Visual Verification run is required before capturing a baseline",
      409,
    );
  }
  const entries = manifest.captures.map((capture) => {
    const state = capture.state ?? "initial";
    if (
      capture.status !== "captured" ||
      !capture.screenshot ||
      typeof capture.viewport !== "string" ||
      !capture.viewport ||
      capture.viewport.length > 100 ||
      typeof state !== "string" ||
      !state ||
      state.length > 100
    ) {
      throw new VisualRegressionError(
        "every baseline viewport and state must have a captured screenshot",
        409,
      );
    }
    return { ...capture, state, screenshot: capture.screenshot };
  });
  const keys = new Set(entries.map((entry) => captureKey(entry.viewport, entry.state)));
  if (keys.size !== entries.length) {
    throw new VisualRegressionError("visual manifest contains duplicate viewport states", 409);
  }
  return entries;
}

export async function captureVisualRegressionBaseline(
  sessionId: string,
  changeSetId: string,
  manifest: VisualManifest,
): Promise<VisualRegressionBaseline> {
  const key = `${assertSessionId(sessionId)}/${assertChangeSetId(changeSetId)}`;
  return withMutation(key, async () => {
    const root = regressionRoot(sessionId, changeSetId);
    const captures = [];
    let baselineBytes = 0;
    for (const capture of capturedManifestEntries(manifest)) {
      const current = await pngFromFile(currentScreenshotPath(sessionId, capture.screenshot));
      baselineBytes += current.bytes.length;
      if (baselineBytes > MAX_BASELINE_BYTES) {
        throw new VisualRegressionError("visual baseline exceeds the storage limit", 409);
      }
      const hash = sha256(current.bytes);
      const baselineScreenshot = `baseline-${hash.slice(0, 16)}-${capture.screenshot}`;
      const target = path.join(root, "baseline", baselineScreenshot);
      try {
        await fs.access(target);
      } catch {
        await atomicBytes(target, current.bytes);
      }
      captures.push({
        viewport: capture.viewport,
        state: capture.state,
        sourceScreenshot: capture.screenshot,
        baselineScreenshot,
        sha256: hash,
        width: current.png.width,
        height: current.png.height,
      });
    }
    const baseline: VisualRegressionBaseline = {
      version: 1,
      id: randomUUID(),
      sessionId,
      changeSetId,
      route: manifest.route,
      createdAt: new Date().toISOString(),
      differenceThreshold: DEFAULT_VISUAL_DIFFERENCE_THRESHOLD,
      pixelTolerance: DEFAULT_VISUAL_PIXEL_TOLERANCE,
      captures,
    };
    await atomicJson(path.join(root, "baseline.json"), baseline);
    return baseline;
  });
}

function validBaseline(value: unknown): value is VisualRegressionBaseline {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const baseline = value as VisualRegressionBaseline;
  if (
    baseline.version !== 1 ||
    !SAFE_CHANGE_SET_ID_RE.test(baseline.id) ||
    !SAFE_SESSION_ID_RE.test(baseline.sessionId) ||
    !SAFE_CHANGE_SET_ID_RE.test(baseline.changeSetId) ||
    typeof baseline.route !== "string" ||
    !baseline.route ||
    baseline.route.length > 2_048 ||
    typeof baseline.createdAt !== "string" ||
    !Number.isFinite(Date.parse(baseline.createdAt)) ||
    typeof baseline.differenceThreshold !== "number" ||
    baseline.differenceThreshold < 0 ||
    baseline.differenceThreshold > 1 ||
    !Number.isInteger(baseline.pixelTolerance) ||
    baseline.pixelTolerance < 0 ||
    baseline.pixelTolerance > 255 ||
    !Array.isArray(baseline.captures) ||
    !baseline.captures.length ||
    baseline.captures.length > MAX_CAPTURES
  ) {
    return false;
  }
  const keys = new Set<string>();
  for (const capture of baseline.captures) {
    const key = captureKey(capture.viewport, capture.state);
    if (
      !capture.viewport ||
      capture.viewport.length > 100 ||
      !capture.state ||
      capture.state.length > 100 ||
      keys.has(key) ||
      !SCREENSHOT_RE.test(capture.sourceScreenshot) ||
      !BASELINE_SCREENSHOT_RE.test(capture.baselineScreenshot) ||
      !/^[a-f0-9]{64}$/.test(capture.sha256) ||
      !Number.isInteger(capture.width) ||
      capture.width <= 0 ||
      !Number.isInteger(capture.height) ||
      capture.height <= 0 ||
      capture.width * capture.height > MAX_PIXELS
    ) {
      return false;
    }
    keys.add(key);
  }
  return true;
}

function validReport(value: unknown): value is VisualRegressionReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as VisualRegressionReport;
  if (
    report.version !== 1 ||
    !SAFE_SESSION_ID_RE.test(report.sessionId) ||
    !SAFE_CHANGE_SET_ID_RE.test(report.changeSetId) ||
    typeof report.route !== "string" ||
    !report.route ||
    report.route.length > 2_048 ||
    !SAFE_CHANGE_SET_ID_RE.test(report.baselineId) ||
    typeof report.baselineCreatedAt !== "string" ||
    !Number.isFinite(Date.parse(report.baselineCreatedAt)) ||
    typeof report.createdAt !== "string" ||
    !Number.isFinite(Date.parse(report.createdAt)) ||
    (report.status !== "passed" && report.status !== "failed") ||
    typeof report.differenceThreshold !== "number" ||
    report.differenceThreshold < 0 ||
    report.differenceThreshold > 1 ||
    !Number.isInteger(report.pixelTolerance) ||
    report.pixelTolerance < 0 ||
    report.pixelTolerance > 255 ||
    typeof report.summary !== "string" ||
    !report.summary ||
    report.summary.length > 1_000 ||
    !Array.isArray(report.comparisons) ||
    !report.comparisons.length ||
    report.comparisons.length > MAX_CAPTURES
  ) {
    return false;
  }
  return report.comparisons.every(
    (comparison) =>
      typeof comparison.viewport === "string" &&
      comparison.viewport.length > 0 &&
      comparison.viewport.length <= 100 &&
      typeof comparison.state === "string" &&
      comparison.state.length > 0 &&
      comparison.state.length <= 100 &&
      (comparison.currentScreenshot === null || SCREENSHOT_RE.test(comparison.currentScreenshot)) &&
      BASELINE_SCREENSHOT_RE.test(comparison.baselineScreenshot) &&
      (comparison.diffScreenshot === null || DIFF_SCREENSHOT_RE.test(comparison.diffScreenshot)) &&
      ["passed", "failed", "missing-current", "stale-current", "dimension-mismatch"].includes(
        comparison.status,
      ) &&
      Number.isInteger(comparison.width) &&
      comparison.width > 0 &&
      Number.isInteger(comparison.height) &&
      comparison.height > 0 &&
      comparison.width * comparison.height <= MAX_PIXELS &&
      Number.isInteger(comparison.changedPixels) &&
      comparison.changedPixels >= 0 &&
      Number.isInteger(comparison.totalPixels) &&
      comparison.totalPixels > 0 &&
      comparison.changedPixels <= comparison.totalPixels &&
      typeof comparison.differenceRatio === "number" &&
      comparison.differenceRatio >= 0 &&
      comparison.differenceRatio <= 1 &&
      typeof comparison.differenceThreshold === "number" &&
      comparison.differenceThreshold >= 0 &&
      comparison.differenceThreshold <= 1 &&
      (comparison.message === undefined ||
        (typeof comparison.message === "string" && comparison.message.length <= 500)),
  );
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5 * 1024 * 1024) {
      throw new VisualRegressionError("visual regression evidence is invalid", 409);
    }
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    if (error instanceof VisualRegressionError) throw error;
    throw new VisualRegressionError("visual regression evidence is invalid", 409);
  }
}

export async function readVisualRegressionBaseline(
  sessionId: string,
  changeSetId: string,
): Promise<VisualRegressionBaseline | null> {
  const value = await readJson(path.join(regressionRoot(sessionId, changeSetId), "baseline.json"));
  if (value === null) return null;
  if (!validBaseline(value) || value.sessionId !== sessionId || value.changeSetId !== changeSetId) {
    throw new VisualRegressionError("visual baseline is invalid", 409);
  }
  return value;
}

export async function readVisualRegressionReport(
  sessionId: string,
  changeSetId: string,
): Promise<VisualRegressionReport | null> {
  const value = await readJson(path.join(regressionRoot(sessionId, changeSetId), "report.json"));
  if (value === null) return null;
  if (!validReport(value) || value.sessionId !== sessionId || value.changeSetId !== changeSetId) {
    throw new VisualRegressionError("visual regression report is invalid", 409);
  }
  return value;
}

export async function readVisualRegressionEvidence(
  sessionId: string,
  changeSetId: string,
): Promise<VisualRegressionEvidence> {
  const [baseline, report] = await Promise.all([
    readVisualRegressionBaseline(sessionId, changeSetId),
    readVisualRegressionReport(sessionId, changeSetId),
  ]);
  return {
    baseline,
    report: baseline && report && report.baselineId === baseline.id ? report : null,
  };
}

function diffPng(
  baseline: PNG,
  current: PNG,
  pixelTolerance: number,
): { changedPixels: number; bytes: Buffer } {
  const diff = new PNG({ width: baseline.width, height: baseline.height });
  let changedPixels = 0;
  for (let offset = 0; offset < baseline.data.length; offset += 4) {
    const changed =
      Math.abs(baseline.data[offset] - current.data[offset]) > pixelTolerance ||
      Math.abs(baseline.data[offset + 1] - current.data[offset + 1]) > pixelTolerance ||
      Math.abs(baseline.data[offset + 2] - current.data[offset + 2]) > pixelTolerance ||
      Math.abs(baseline.data[offset + 3] - current.data[offset + 3]) > pixelTolerance;
    if (changed) {
      changedPixels += 1;
      diff.data[offset] = 255;
      diff.data[offset + 1] = 45;
      diff.data[offset + 2] = 145;
      diff.data[offset + 3] = 255;
    } else {
      const gray = Math.round(
        baseline.data[offset] * 0.2126 +
          baseline.data[offset + 1] * 0.7152 +
          baseline.data[offset + 2] * 0.0722,
      );
      diff.data[offset] = gray;
      diff.data[offset + 1] = gray;
      diff.data[offset + 2] = gray;
      diff.data[offset + 3] = 96;
    }
  }
  const bytes = PNG.sync.write(diff);
  if (bytes.length > MAX_PNG_BYTES) {
    throw new VisualRegressionError("visual diff exceeds the storage limit", 409);
  }
  return { changedPixels, bytes };
}

export async function compareVisualRegression(
  sessionId: string,
  changeSetId: string,
  manifest: VisualManifest,
  minimumCapturedAt?: string,
): Promise<VisualRegressionReport | null> {
  const baseline = await readVisualRegressionBaseline(sessionId, changeSetId);
  if (!baseline) return null;
  const key = `${sessionId}/${changeSetId}`;
  return withMutation(key, async () => {
    const root = regressionRoot(sessionId, changeSetId);
    const current = new Map(
      manifest.captures.map((capture) => [
        captureKey(capture.viewport, capture.state ?? "initial"),
        capture,
      ]),
    );
    const comparisons: VisualRegressionComparison[] = [];
    for (const expected of baseline.captures) {
      const capture = current.get(captureKey(expected.viewport, expected.state));
      if (
        baseline.route !== manifest.route ||
        capture?.status !== "captured" ||
        !capture.screenshot
      ) {
        comparisons.push({
          viewport: expected.viewport,
          state: expected.state,
          currentScreenshot: capture?.screenshot ?? null,
          baselineScreenshot: expected.baselineScreenshot,
          diffScreenshot: null,
          status: "missing-current",
          width: expected.width,
          height: expected.height,
          changedPixels: expected.width * expected.height,
          totalPixels: expected.width * expected.height,
          differenceRatio: 1,
          differenceThreshold: baseline.differenceThreshold,
          message:
            baseline.route !== manifest.route
              ? "The captured route no longer matches this change set baseline."
              : "The current viewport/state screenshot is unavailable.",
        });
        continue;
      }
      const baselineImage = await pngFromFile(
        path.join(root, "baseline", expected.baselineScreenshot),
      );
      if (sha256(baselineImage.bytes) !== expected.sha256) {
        throw new VisualRegressionError("visual baseline integrity check failed", 409);
      }
      const currentImage = await pngFromFile(currentScreenshotPath(sessionId, capture.screenshot));
      const minimumCapturedMs = minimumCapturedAt ? Date.parse(minimumCapturedAt) : Number.NaN;
      if (Number.isFinite(minimumCapturedMs) && currentImage.mtimeMs + 1 < minimumCapturedMs) {
        comparisons.push({
          viewport: expected.viewport,
          state: expected.state,
          currentScreenshot: capture.screenshot,
          baselineScreenshot: expected.baselineScreenshot,
          diffScreenshot: null,
          status: "stale-current",
          width: currentImage.png.width,
          height: currentImage.png.height,
          changedPixels: currentImage.png.width * currentImage.png.height,
          totalPixels: currentImage.png.width * currentImage.png.height,
          differenceRatio: 1,
          differenceThreshold: baseline.differenceThreshold,
          message: "Run Visual Verification again after the latest source save.",
        });
        continue;
      }
      if (
        baselineImage.png.width !== currentImage.png.width ||
        baselineImage.png.height !== currentImage.png.height
      ) {
        comparisons.push({
          viewport: expected.viewport,
          state: expected.state,
          currentScreenshot: capture.screenshot,
          baselineScreenshot: expected.baselineScreenshot,
          diffScreenshot: null,
          status: "dimension-mismatch",
          width: currentImage.png.width,
          height: currentImage.png.height,
          changedPixels: currentImage.png.width * currentImage.png.height,
          totalPixels: currentImage.png.width * currentImage.png.height,
          differenceRatio: 1,
          differenceThreshold: baseline.differenceThreshold,
          message: `Image dimensions changed from ${expected.width}×${expected.height} to ${currentImage.png.width}×${currentImage.png.height}.`,
        });
        continue;
      }
      const diff = diffPng(baselineImage.png, currentImage.png, baseline.pixelTolerance);
      const totalPixels = currentImage.png.width * currentImage.png.height;
      const differenceRatio = diff.changedPixels / totalPixels;
      const diffHash = createHash("sha256")
        .update(expected.sha256)
        .update(currentImage.bytes)
        .update(String(baseline.pixelTolerance))
        .digest("hex");
      const diffScreenshot = `diff-${diffHash.slice(0, 16)}-${capture.screenshot}`;
      await atomicBytes(path.join(root, "diffs", diffScreenshot), diff.bytes);
      comparisons.push({
        viewport: expected.viewport,
        state: expected.state,
        currentScreenshot: capture.screenshot,
        baselineScreenshot: expected.baselineScreenshot,
        diffScreenshot,
        status: differenceRatio <= baseline.differenceThreshold ? "passed" : "failed",
        width: currentImage.png.width,
        height: currentImage.png.height,
        changedPixels: diff.changedPixels,
        totalPixels,
        differenceRatio,
        differenceThreshold: baseline.differenceThreshold,
      });
    }
    const failed = comparisons.filter((comparison) => comparison.status !== "passed");
    const report: VisualRegressionReport = {
      version: 1,
      sessionId,
      changeSetId,
      route: manifest.route,
      baselineId: baseline.id,
      baselineCreatedAt: baseline.createdAt,
      createdAt: new Date().toISOString(),
      status: failed.length ? "failed" : "passed",
      differenceThreshold: baseline.differenceThreshold,
      pixelTolerance: baseline.pixelTolerance,
      comparisons,
      summary: failed.length
        ? `${failed.length} of ${comparisons.length} viewport state(s) exceeded the visual regression gate.`
        : `All ${comparisons.length} viewport state(s) stayed within the visual regression threshold.`,
    };
    await atomicJson(path.join(root, "report.json"), report);
    return report;
  });
}

export function visualRegressionImagePath(
  sessionId: string,
  changeSetId: string,
  kind: "baseline" | "diff",
  file: string,
): string | null {
  const valid = kind === "baseline" ? BASELINE_SCREENSHOT_RE : DIFF_SCREENSHOT_RE;
  if (!valid.test(file)) return null;
  const directory = path.resolve(
    regressionRoot(sessionId, changeSetId),
    kind === "baseline" ? "baseline" : "diffs",
  );
  const resolved = path.resolve(directory, file);
  return contains(directory, resolved) && path.dirname(resolved) === directory ? resolved : null;
}
