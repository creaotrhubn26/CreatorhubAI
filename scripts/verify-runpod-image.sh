#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="$ROOT/docker/runpod/image-lock.json"
IMAGE="${1:-}"
EXPECTED_SOURCE_COMMIT="${2:-}"
EXPECTED_BUILD_ID="${3:-}"
cd "$ROOT"

python3 - "$LOCK" Dockerfile.runpod requirements-runpod.txt <<'PY'
import json
import pathlib
import re
import sys

lock = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
dockerfile = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8")
requirements = pathlib.Path(sys.argv[3]).read_text(encoding="utf-8")
digest = re.compile(r"^[^\s]+@sha256:[a-f0-9]{64}$")
assert lock["schemaVersion"] == 1
assert lock["platform"] == "linux/amd64"
assert lock["ubuntuSnapshot"] == "20260828T000000Z"
assert digest.fullmatch(lock["buildBase"])
assert digest.fullmatch(lock["runtimeBase"])
assert re.fullmatch(r"[a-f0-9]{40}", lock["llamaCppCommit"])
assert lock["buildBase"] in dockerfile
assert lock["runtimeBase"] in dockerfile
assert lock["llamaCppCommit"] in dockerfile
assert "--require-hashes" in dockerfile
expected_packages = {
    "cryptography": "49.0.0",
    "cffi": "2.1.1",
    "pycparser": "3.0",
    "typing-extensions": "4.16.0",
    "tree-sitter": "0.25.2",
    "tree-sitter-python": "0.25.0",
    "tree-sitter-javascript": "0.25.0",
    "tree-sitter-typescript": "0.23.2",
    "tree-sitter-rust": "0.24.2",
}
assert lock["pythonPackages"] == expected_packages
assert requirements.count("--hash=sha256:") == len(expected_packages)
for package, version in expected_packages.items():
    assert f"{package}=={version}" in requirements
assert "COPY ." not in dockerfile
assert "GLIMMER_WORKER_BOOTSTRAP_TOKEN" not in dockerfile
snapshot = pathlib.Path("docker/runpod/jammy-snapshot.sources.list").read_text(encoding="utf-8")
assert snapshot.count("20260828T000000Z") == 3
assert "jammy-security" in snapshot
print("RunPod image contract: PASS")
PY

python3 -m unittest \
  tests.test_glimmer_remote \
  tests.test_bootstrap_status \
  tests.test_cache_manifest \
  tests.test_coordinator_callback \
  tests.test_runpod_worker \
  tests.test_fetch_artifact \
  tests.test_runpod_entrypoint

if [ -z "$IMAGE" ]; then
  echo "RunPod image runtime check: SKIPPED (pass an already built image tag)"
  exit 0
fi

docker image inspect "$IMAGE" >/dev/null
PROTOCOL="$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "no.creatorhub.glimmer.protocol"}}')"
test "$PROTOCOL" = "2"
SOURCE_COMMIT="$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
BUILD_ID="$(docker image inspect "$IMAGE" --format '{{index .Config.Labels "no.creatorhub.glimmer.worker-build"}}')"
[[ "$SOURCE_COMMIT" =~ ^[a-f0-9]{40}$ ]]
[[ "$BUILD_ID" =~ ^r2-[a-f0-9]{12}$ ]]
if [ -n "$EXPECTED_SOURCE_COMMIT" ]; then
  test "$SOURCE_COMMIT" = "$EXPECTED_SOURCE_COMMIT"
fi
if [ -n "$EXPECTED_BUILD_ID" ]; then
  test "$BUILD_ID" = "$EXPECTED_BUILD_ID"
fi
docker run --rm --platform linux/amd64 --entrypoint python3 "$IMAGE" \
  -c 'from importlib.metadata import version; from tree_sitter import Language, Parser; import cryptography, glimmer_remote, runpod_worker, tree_sitter_javascript, tree_sitter_python, tree_sitter_rust, tree_sitter_typescript; from docker.runpod import bootstrap_status, cache_manifest, coordinator_callback; assert bootstrap_status.STATUS_SCHEMA_VERSION == 1; assert cache_manifest.CACHE_SCHEMA_VERSION == 1; assert coordinator_callback.MAX_MANIFEST_BYTES == 16384; assert cryptography.__version__ == "49.0.0"; assert {name: version(name) for name in ("typing-extensions", "tree-sitter", "tree-sitter-python", "tree-sitter-javascript", "tree-sitter-typescript", "tree-sitter-rust")} == {"typing-extensions":"4.16.0", "tree-sitter":"0.25.2", "tree-sitter-python":"0.25.0", "tree-sitter-javascript":"0.25.0", "tree-sitter-typescript":"0.23.2", "tree-sitter-rust":"0.24.2"}; samples=((tree_sitter_python.language,b"x = 1\n"),(tree_sitter_javascript.language,b"const x = 1;"),(tree_sitter_typescript.language_typescript,b"const x: number = 1;"),(tree_sitter_typescript.language_tsx,b"const x = <div />;"),(tree_sitter_rust.language,b"fn main() {}")); assert all(not Parser(Language(grammar())).parse(source).root_node.has_error for grammar, source in samples)'
echo "RunPod image runtime check: PASS"
