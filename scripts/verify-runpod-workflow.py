#!/usr/bin/env python3
"""Static fail-closed contract for the manually triggered RunPod image workflow."""

from __future__ import annotations

import pathlib
import re


ROOT = pathlib.Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "runpod-image.yml"
EXPECTED_ACTIONS = {
    "actions/checkout": (
        "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
        "v7.0.0",
        2,
    ),
    "docker/setup-buildx-action": (
        "bb05f3f5519dd87d3ba754cc423b652a5edd6d2c",
        "v4.2.0",
        2,
    ),
    "docker/login-action": (
        "650006c6eb7dba73a995cc03b0b2d7f5ca915bee",
        "v4.2.0",
        1,
    ),
    "docker/build-push-action": (
        "53b7df96c91f9c12dcc8a07bcb9ccacbed38856a",
        "v7.3.0",
        2,
    ),
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"RunPod workflow contract failed: {message}")


def main() -> None:
    text = WORKFLOW.read_text(encoding="utf-8")

    trigger_block = re.search(r"(?m)^on:\n(?P<body>(?:^[ \t].*\n)*)", text)
    require(trigger_block is not None, "workflow trigger block is required")
    triggers = re.findall(r"(?m)^  ([a-zA-Z_]+):", trigger_block.group("body"))
    require(triggers == ["workflow_dispatch"], "workflow must be manual-only")
    require(text.count("      publish_image:\n") == 1, "one publish input is required")
    require(text.count("        type: boolean\n") == 1, "publish input must be boolean")
    require(text.count("        default: false\n") == 1, "publishing must default off")
    require(
        "if: ${{ inputs.publish_image == false }}" in text
        and "if: ${{ inputs.publish_image && github.ref == 'refs/heads/main' }}" in text,
        "validation must be non-publishing and publication must require main",
    )
    require(text.count("runs-on: ubuntu-24.04") == 2, "runner must be explicit")
    require(text.count("timeout-minutes: 90") == 2, "both jobs need a time limit")
    require(text.count("platforms: linux/amd64") == 2, "only linux/amd64 is supported")
    require(text.count("persist-credentials: false") == 2, "checkout credentials must not persist")
    require(text.count("packages: write") == 1, "only the publish job may write packages")
    require(text.count("push: false") == 1, "validation build must never push")
    require(text.count("push: true") == 1, "publication needs one explicit push")
    require(text.count("provenance: mode=max") == 1, "published provenance must be maximal")
    require(text.count("sbom: true") == 1, "published image must contain an SBOM")
    require(
        text.count("cache-to: type=gha,mode=min,scope=${{ env.CACHE_SCOPE }}") == 2,
        "bounded GitHub cache must be shared by both jobs",
    )
    require(
        "IMAGE_REPOSITORY: ghcr.io/${{ github.repository_owner }}/glimmer-runpod-worker"
        in text,
        "registry destination must be repository-owner scoped",
    )
    require(
        text.count("scripts/verify-runpod-image.sh \"$IMAGE_TAG\" \"$SOURCE_COMMIT\" \"$BUILD_ID\"")
        == 2,
        "both modes must verify image identity and runtime",
    )
    secrets = re.findall(r"secrets\.([A-Za-z0-9_]+)", text)
    require(secrets == ["GITHUB_TOKEN"], "only the ephemeral registry token is allowed")
    require("latest" not in text.lower(), "mutable latest tags are forbidden")

    all_uses = re.findall(r"(?m)^\s*uses:\s*([^\s#]+)", text)
    found = re.findall(
        r"(?m)^\s*uses:\s*([^@\s]+)@([a-f0-9]{40})\s+#\s+(v[^\s]+)\s*$",
        text,
    )
    expected_count = sum(item[2] for item in EXPECTED_ACTIONS.values())
    require(len(all_uses) == expected_count, "unexpected action reference")
    require(len(found) == expected_count, "every action must use an immutable SHA")
    for action, (sha, version, count) in EXPECTED_ACTIONS.items():
        require(
            found.count((action, sha, version)) == count,
            f"{action} must be pinned to {version} ({sha}) exactly {count} time(s)",
        )

    print("RunPod image workflow contract: PASS")


if __name__ == "__main__":
    main()
