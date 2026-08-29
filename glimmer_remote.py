#!/usr/bin/env python3
"""Versioned, bounded contracts for Glimmer remote execution.

This module is deliberately independent of the HTTP server.  Both the RunPod
worker and the Control Center fixtures use the same canonical JSON, signature,
manifest, and encrypted-checkpoint rules.  Secrets are accepted as bytes and
are never represented in public dataclasses or error messages.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import PurePosixPath
from typing import Any, Dict, Mapping, Optional, Sequence, Tuple

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

SCHEMA_VERSION = 1
MAX_MANIFEST_BYTES = 128 * 1024
MAX_INPUT_BYTES = 1024 * 1024 * 1024
MAX_INPUT_PARTS = 256
MAX_PART_BYTES = 8 * 1024 * 1024
CHECKPOINT_CHUNK_BYTES = 4 * 1024 * 1024

SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SAFE_BRANCH = re.compile(r"^glimmer/[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$")
HEX_SHA256 = re.compile(r"^[a-f0-9]{64}$")
GIT_SHA = re.compile(r"^[a-f0-9]{40}(?:[a-f0-9]{24})?$")
IDEMPOTENCY_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


class RemoteContractError(ValueError):
    """A public, secret-free contract validation failure."""


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _require_dict(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise RemoteContractError(f"{label} must be an object")
    return value


def _closed_keys(value: Mapping[str, Any], allowed: Sequence[str], label: str) -> None:
    extras = sorted(set(value) - set(allowed))
    if extras:
        raise RemoteContractError(f"{label} contains unsupported fields")


def _bounded_text(value: Any, label: str, maximum: int, minimum: int = 1) -> str:
    if not isinstance(value, str):
        raise RemoteContractError(f"{label} must be a string")
    if len(value) < minimum or len(value) > maximum or "\x00" in value:
        raise RemoteContractError(f"{label} has an invalid length")
    return value


def _safe_id(value: Any, label: str) -> str:
    text = _bounded_text(value, label, 128)
    if not SAFE_ID.fullmatch(text) or text in {".", ".."}:
        raise RemoteContractError(f"{label} is invalid")
    return text


def _iso8601(value: Any, label: str) -> str:
    text = _bounded_text(value, label, 64)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise RemoteContractError(f"{label} must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise RemoteContractError(f"{label} must include a timezone")
    return text


def _positive_int(value: Any, label: str, maximum: int, minimum: int = 1) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum or value > maximum:
        raise RemoteContractError(f"{label} must be between {minimum} and {maximum}")
    return value


def normalize_relative_path(value: Any, label: str = "path") -> str:
    text = _bounded_text(value, label, 4096)
    if "\\" in text or text.startswith("/"):
        raise RemoteContractError(f"{label} must be a normalized relative path")
    parsed = PurePosixPath(text)
    if any(part in {"", ".", ".."} for part in parsed.parts) or str(parsed) != text:
        raise RemoteContractError(f"{label} must be a normalized relative path")
    return text


@dataclass(frozen=True)
class RemoteInputV1:
    format: str
    parts: int
    bytes: int
    sha256: str

    def as_dict(self) -> Dict[str, Any]:
        return {
            "format": self.format,
            "parts": self.parts,
            "bytes": self.bytes,
            "sha256": self.sha256,
        }


@dataclass(frozen=True)
class RemoteJobManifestV1:
    instance_id: str
    session_id: str
    job_id: str
    repository_fingerprint: str
    baseline_sha: str
    branch: str
    objective: str
    context_tokens: int
    max_repairs: int
    timeout_seconds: int
    created_at: str
    input: RemoteInputV1

    def as_dict(self) -> Dict[str, Any]:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "instanceId": self.instance_id,
            "sessionId": self.session_id,
            "jobId": self.job_id,
            "repositoryFingerprint": self.repository_fingerprint,
            "baselineSha": self.baseline_sha,
            "branch": self.branch,
            "objective": self.objective,
            "contextTokens": self.context_tokens,
            "maxRepairs": self.max_repairs,
            "timeoutSeconds": self.timeout_seconds,
            "createdAt": self.created_at,
            "input": self.input.as_dict(),
        }


def parse_remote_job_manifest(value: Any) -> RemoteJobManifestV1:
    raw = _require_dict(value, "manifest")
    _closed_keys(
        raw,
        (
            "schemaVersion",
            "instanceId",
            "sessionId",
            "jobId",
            "repositoryFingerprint",
            "baselineSha",
            "branch",
            "objective",
            "contextTokens",
            "maxRepairs",
            "timeoutSeconds",
            "createdAt",
            "input",
        ),
        "manifest",
    )
    if raw.get("schemaVersion") != SCHEMA_VERSION:
        raise RemoteContractError("manifest schemaVersion is unsupported")
    encoded = canonical_json_bytes(raw)
    if len(encoded) > MAX_MANIFEST_BYTES:
        raise RemoteContractError("manifest exceeds the safe size limit")

    input_raw = _require_dict(raw.get("input"), "manifest.input")
    _closed_keys(input_raw, ("format", "parts", "bytes", "sha256"), "manifest.input")
    if input_raw.get("format") != "git_bundle":
        raise RemoteContractError("manifest.input.format must be git_bundle")
    parts = _positive_int(input_raw.get("parts"), "manifest.input.parts", MAX_INPUT_PARTS)
    byte_length = _positive_int(
        input_raw.get("bytes"), "manifest.input.bytes", MAX_INPUT_BYTES
    )
    digest = _bounded_text(input_raw.get("sha256"), "manifest.input.sha256", 64, 64)
    if not HEX_SHA256.fullmatch(digest):
        raise RemoteContractError("manifest.input.sha256 is invalid")
    if parts * MAX_PART_BYTES < byte_length:
        raise RemoteContractError("manifest.input.parts cannot contain the declared byte length")

    repository_fingerprint = _bounded_text(
        raw.get("repositoryFingerprint"), "manifest.repositoryFingerprint", 64, 64
    )
    if not HEX_SHA256.fullmatch(repository_fingerprint):
        raise RemoteContractError("manifest.repositoryFingerprint is invalid")
    baseline_sha = _bounded_text(raw.get("baselineSha"), "manifest.baselineSha", 64, 40)
    if not GIT_SHA.fullmatch(baseline_sha):
        raise RemoteContractError("manifest.baselineSha is invalid")
    branch = _bounded_text(raw.get("branch"), "manifest.branch", 198)
    if not SAFE_BRANCH.fullmatch(branch) or ".." in branch.split("/"):
        raise RemoteContractError("manifest.branch must be a glimmer/* branch")
    context_tokens = raw.get("contextTokens")
    if context_tokens not in (65_536, 131_072):
        raise RemoteContractError("manifest.contextTokens must be 65536 or 131072")

    return RemoteJobManifestV1(
        instance_id=_safe_id(raw.get("instanceId"), "manifest.instanceId"),
        session_id=_safe_id(raw.get("sessionId"), "manifest.sessionId"),
        job_id=_safe_id(raw.get("jobId"), "manifest.jobId"),
        repository_fingerprint=repository_fingerprint,
        baseline_sha=baseline_sha,
        branch=branch,
        objective=_bounded_text(raw.get("objective"), "manifest.objective", 20_000),
        context_tokens=context_tokens,
        max_repairs=_positive_int(raw.get("maxRepairs"), "manifest.maxRepairs", 5, 0),
        timeout_seconds=_positive_int(
            raw.get("timeoutSeconds"), "manifest.timeoutSeconds", 7_200, 60
        ),
        created_at=_iso8601(raw.get("createdAt"), "manifest.createdAt"),
        input=RemoteInputV1("git_bundle", parts, byte_length, digest),
    )


def parse_json_body(data: bytes, maximum: int = MAX_MANIFEST_BYTES) -> Any:
    if not data or len(data) > maximum:
        raise RemoteContractError("request body has an invalid size")
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RemoteContractError("request body must be valid UTF-8 JSON") from exc


def validate_idempotency_key(value: Any) -> str:
    text = _bounded_text(value, "idempotency key", 128)
    if not IDEMPOTENCY_KEY.fullmatch(text):
        raise RemoteContractError("idempotency key is invalid")
    return text


def request_signature(
    capability: bytes,
    method: str,
    path: str,
    idempotency_key: str,
    body: bytes,
) -> str:
    body_hash = sha256_hex(body)
    signed = "\n".join((method.upper(), path, idempotency_key, body_hash)).encode("utf-8")
    return hmac.new(capability, signed, hashlib.sha256).hexdigest()


def verify_request_signature(
    capability: bytes,
    supplied: Any,
    method: str,
    path: str,
    idempotency_key: str,
    body: bytes,
) -> bool:
    if not isinstance(supplied, str):
        return False
    value = supplied[7:] if supplied.startswith("sha256=") else supplied
    if not HEX_SHA256.fullmatch(value):
        return False
    expected = request_signature(capability, method, path, idempotency_key, body)
    return hmac.compare_digest(value, expected)


def encode_secret(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def decode_secret(value: Any, label: str, expected_bytes: int = 32) -> bytes:
    text = _bounded_text(value, label, 256)
    try:
        decoded = base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (ValueError, TypeError) as exc:
        raise RemoteContractError(f"{label} is invalid") from exc
    if len(decoded) != expected_bytes:
        raise RemoteContractError(f"{label} is invalid")
    return decoded


def encrypt_checkpoint(
    key: bytes,
    plaintext: bytes,
    metadata: Mapping[str, Any],
    nonce: Optional[bytes] = None,
) -> Tuple[bytes, str]:
    if len(key) != 32:
        raise RemoteContractError("checkpoint key must contain 32 bytes")
    if len(plaintext) > MAX_INPUT_BYTES:
        raise RemoteContractError("checkpoint exceeds the safe size limit")
    nonce_value = nonce if nonce is not None else __import__("os").urandom(12)
    if len(nonce_value) != 12:
        raise RemoteContractError("checkpoint nonce must contain 12 bytes")
    aad = canonical_json_bytes(dict(metadata))
    ciphertext = AESGCM(key).encrypt(nonce_value, plaintext, aad)
    envelope = b"GLMR1" + nonce_value + len(aad).to_bytes(4, "big") + aad + ciphertext
    return envelope, sha256_hex(envelope)


def decrypt_checkpoint(key: bytes, envelope: bytes, metadata: Mapping[str, Any]) -> bytes:
    if len(key) != 32 or len(envelope) < 5 + 12 + 4 + 16 or not envelope.startswith(b"GLMR1"):
        raise RemoteContractError("encrypted checkpoint is invalid")
    nonce = envelope[5:17]
    aad_length = int.from_bytes(envelope[17:21], "big")
    if aad_length > MAX_MANIFEST_BYTES or 21 + aad_length + 16 > len(envelope):
        raise RemoteContractError("encrypted checkpoint is invalid")
    stored_aad = envelope[21 : 21 + aad_length]
    expected_aad = canonical_json_bytes(dict(metadata))
    if not hmac.compare_digest(stored_aad, expected_aad):
        raise RemoteContractError("checkpoint metadata does not match")
    try:
        return AESGCM(key).decrypt(nonce, envelope[21 + aad_length :], expected_aad)
    except InvalidTag as exc:
        raise RemoteContractError("checkpoint authentication failed") from exc


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
