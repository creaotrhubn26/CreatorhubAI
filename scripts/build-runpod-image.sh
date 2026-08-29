#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="$ROOT/docker/runpod/image-lock.json"
OUT="$ROOT/artifacts/runpod-image.json"

cd "$ROOT"
test -f "$LOCK"
git diff --quiet -- .
git diff --cached --quiet -- .
test -z "$(git ls-files --others --exclude-standard)"

SOURCE_COMMIT="$(git rev-parse HEAD)"
BUILD_ID="r2-${SOURCE_COMMIT:0:12}"
TAG="${GLIMMER_RUNPOD_IMAGE_TAG:-glimmer-runpod-worker:$BUILD_ID}"

IFS=$'\t' read -r BUILD_BASE RUNTIME_BASE LLAMA_COMMIT < <(python3 - "$LOCK" <<'PY'
import json
import re
import sys

lock = json.load(open(sys.argv[1], encoding="utf-8"))
if lock.get("schemaVersion") != 1 or lock.get("platform") != "linux/amd64":
    raise SystemExit("invalid RunPod image lock")
digest = re.compile(r"^[^\s]+@sha256:[a-f0-9]{64}$")
commit = re.compile(r"^[a-f0-9]{40}$")
for key in ("buildBase", "runtimeBase"):
    if not digest.fullmatch(lock.get(key, "")):
        raise SystemExit(f"{key} is not digest pinned")
if not commit.fullmatch(lock.get("llamaCppCommit", "")):
    raise SystemExit("llamaCppCommit is not pinned")
print("\t".join((lock["buildBase"], lock["runtimeBase"], lock["llamaCppCommit"])))
PY
)

docker buildx build \
  --platform linux/amd64 \
  --file Dockerfile.runpod \
  --tag "$TAG" \
  --load \
  --provenance=mode=max \
  --sbom=true \
  --build-arg "BUILD_BASE=$BUILD_BASE" \
  --build-arg "RUNTIME_BASE=$RUNTIME_BASE" \
  --build-arg "LLAMA_CPP_COMMIT=$LLAMA_COMMIT" \
  --build-arg "SOURCE_COMMIT=$SOURCE_COMMIT" \
  --build-arg "BUILD_ID=$BUILD_ID" \
  .

IMAGE_ID="$(docker image inspect "$TAG" --format '{{.Id}}')"
mkdir -p "$(dirname "$OUT")"
python3 - "$OUT" "$TAG" "$IMAGE_ID" "$SOURCE_COMMIT" "$BUILD_ID" "$LOCK" <<'PY'
import hashlib
import json
import pathlib
import sys

out, tag, image_id, source_commit, build_id, lock = sys.argv[1:]
lock_bytes = pathlib.Path(lock).read_bytes()
payload = {
    "schemaVersion": 1,
    "tag": tag,
    "imageId": image_id,
    "sourceCommit": source_commit,
    "buildId": build_id,
    "imageLockSha256": hashlib.sha256(lock_bytes).hexdigest(),
}
pathlib.Path(out).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

echo "RunPod image ready: $TAG ($IMAGE_ID)"
echo "Provenance: $OUT"
