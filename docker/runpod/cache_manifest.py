#!/usr/bin/env python3
"""Publish and verify an atomic, signed RunPod model-cache manifest.

The prewarm Pod is the only writer in ready-cache mode.  It performs the
expensive SHA-256 pass once, signs the resulting metadata, and seals the cache.
GPU Pods verify the signature plus immutable filesystem metadata without
reading model bytes again.
"""

from __future__ import annotations

import argparse
import base64
import errno
import hashlib
import json
import os
import re
import secrets
import stat
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Sequence

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

CACHE_SCHEMA_VERSION = 1
MAX_MANIFEST_BYTES = 16 * 1024
MAX_ARTIFACT_BYTES = 32 * 1024 * 1024 * 1024
MAX_RECEIPT_BYTES = 4 * 1024
RECEIPT_SCHEMA_VERSION = 1
CHUNK_BYTES = 1024 * 1024
MANIFEST_NAME = "cache-ready.json"
ARTIFACT_ORDER = ("model", "mmproj", "draft")
ARTIFACT_PREFIX = {"model": "model", "mmproj": "mmproj", "draft": "dflash"}
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
BUILD_ID_PATTERN = re.compile(r"^r2-[a-f0-9]{12}$")
VOLUME_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{1,127}$")
TIMESTAMP_PATTERN = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$"
)


class CacheManifestError(ValueError):
    """The ready-cache contract or its filesystem state is invalid."""


@dataclass(frozen=True)
class ArtifactExpectation:
    kind: str
    sha256: str

    @property
    def name(self) -> str:
        return f"{ARTIFACT_PREFIX[self.kind]}.{self.sha256}.gguf"


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _decode_base64url(value: Any, expected_bytes: int, label: str) -> bytes:
    if not isinstance(value, str) or not value or len(value) > 256:
        raise CacheManifestError(f"{label} is invalid")
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, TypeError) as exc:
        raise CacheManifestError(f"{label} is invalid") from exc
    canonical = base64.urlsafe_b64encode(decoded).decode("ascii").rstrip("=")
    if len(decoded) != expected_bytes or not secrets.compare_digest(canonical, value):
        raise CacheManifestError(f"{label} is invalid")
    return decoded


def _encode_base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _public_bytes(key: Ed25519PublicKey) -> bytes:
    return key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )


def _key_id(public_key: bytes) -> str:
    return hashlib.sha256(public_key).hexdigest()


def _expectations(hashes: Mapping[str, str]) -> tuple[ArtifactExpectation, ...]:
    if set(hashes) != set(ARTIFACT_ORDER):
        raise CacheManifestError("cache artifact set is invalid")
    result = []
    for kind in ARTIFACT_ORDER:
        digest = hashes.get(kind)
        if not isinstance(digest, str) or not SHA256_PATTERN.fullmatch(digest):
            raise CacheManifestError("cache artifact SHA-256 is invalid")
        result.append(ArtifactExpectation(kind, digest))
    return tuple(result)


def _validate_identity(volume_id: str, build_id: str) -> None:
    if not isinstance(volume_id, str) or not VOLUME_ID_PATTERN.fullmatch(volume_id):
        raise CacheManifestError("cache volume identity is invalid")
    if not isinstance(build_id, str) or not BUILD_ID_PATTERN.fullmatch(build_id):
        raise CacheManifestError("cache build identity is invalid")


def _directory_flags() -> int:
    return (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )


def _open_cache_root(root: Path, expected_mode: int) -> int:
    try:
        descriptor = os.open(root, _directory_flags())
    except OSError as exc:
        raise CacheManifestError("cache root is unavailable") from exc
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or stat.S_IMODE(metadata.st_mode) != expected_mode
        ):
            raise CacheManifestError("cache root ownership or mode is invalid")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _artifact_flags() -> int:
    return (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_NONBLOCK", 0)
    )


def _safe_artifact_metadata(descriptor: int, *, sealed: bool) -> os.stat_result:
    metadata = os.fstat(descriptor)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_uid != os.geteuid()
        or metadata.st_size <= 0
        or metadata.st_size > MAX_ARTIFACT_BYTES
    ):
        raise CacheManifestError("cache artifact is not a private regular file")
    if sealed and stat.S_IMODE(metadata.st_mode) != 0o444:
        raise CacheManifestError("cache artifact is not sealed")
    return metadata


def _path_still_names_descriptor(directory: int, name: str, descriptor: int) -> bool:
    try:
        path_metadata = os.stat(name, dir_fd=directory, follow_symlinks=False)
        descriptor_metadata = os.fstat(descriptor)
    except OSError:
        return False
    return (
        stat.S_ISREG(path_metadata.st_mode)
        and path_metadata.st_nlink == 1
        and path_metadata.st_dev == descriptor_metadata.st_dev
        and path_metadata.st_ino == descriptor_metadata.st_ino
    )


def _hash_and_seal_artifact(directory: int, expected: ArtifactExpectation) -> Dict[str, Any]:
    try:
        descriptor = os.open(expected.name, _artifact_flags(), dir_fd=directory)
    except OSError as exc:
        raise CacheManifestError("cache artifact is unavailable") from exc
    try:
        metadata = _safe_artifact_metadata(descriptor, sealed=False)
        digest = hashlib.sha256()
        total = 0
        while True:
            chunk = os.read(descriptor, CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            digest.update(chunk)
        if total != metadata.st_size or not secrets.compare_digest(
            digest.hexdigest(), expected.sha256
        ):
            raise CacheManifestError("cache artifact checksum does not match")
        os.fchown(descriptor, os.geteuid(), os.getegid())
        os.fchmod(descriptor, 0o444)
        os.fsync(descriptor)
        if not _path_still_names_descriptor(directory, expected.name, descriptor):
            raise CacheManifestError("cache artifact pathname changed during publication")
        return {
            "kind": expected.kind,
            "path": expected.name,
            "sha256": expected.sha256,
            "bytes": total,
        }
    finally:
        os.close(descriptor)


def _open_receipt_root(root: Path) -> int:
    try:
        descriptor = os.open(root, _directory_flags())
    except OSError as exc:
        raise CacheManifestError("artifact receipt directory is unavailable") from exc
    metadata = os.fstat(descriptor)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        os.close(descriptor)
        raise CacheManifestError("artifact receipt directory is not private")
    return descriptor


def _read_receipt(directory: int, expected: ArtifactExpectation) -> Dict[str, Any]:
    name = f"{expected.kind}.json"
    try:
        descriptor = os.open(name, _artifact_flags(), dir_fd=directory)
    except OSError as exc:
        raise CacheManifestError("artifact receipt is unavailable") from exc
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or metadata.st_uid != os.geteuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_size <= 0
            or metadata.st_size > MAX_RECEIPT_BYTES
        ):
            raise CacheManifestError("artifact receipt is invalid")
        data = bytearray()
        while len(data) <= MAX_RECEIPT_BYTES:
            chunk = os.read(descriptor, min(4096, MAX_RECEIPT_BYTES + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > MAX_RECEIPT_BYTES:
            raise CacheManifestError("artifact receipt is too large")
        if not _path_still_names_descriptor(directory, name, descriptor):
            raise CacheManifestError("artifact receipt pathname changed")
    finally:
        os.close(descriptor)
    try:
        value = json.loads(bytes(data).decode("utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CacheManifestError("artifact receipt is invalid JSON") from exc
    keys = {
        "schemaVersion",
        "path",
        "sha256",
        "bytes",
        "device",
        "inode",
        "mtimeNs",
        "ctimeNs",
    }
    if not isinstance(value, dict) or set(value) != keys:
        raise CacheManifestError("artifact receipt fields are invalid")
    if (
        value["schemaVersion"] != RECEIPT_SCHEMA_VERSION
        or value["path"] != expected.name
        or value["sha256"] != expected.sha256
    ):
        raise CacheManifestError("artifact receipt identity is invalid")
    for key in ("bytes", "device", "inode", "mtimeNs", "ctimeNs"):
        if type(value[key]) is not int or value[key] < 0:
            raise CacheManifestError("artifact receipt metadata is invalid")
    if value["bytes"] <= 0 or value["bytes"] > MAX_ARTIFACT_BYTES:
        raise CacheManifestError("artifact receipt size is invalid")
    return value


def _seal_receipted_artifact(
    directory: int,
    receipt_directory: int,
    expected: ArtifactExpectation,
) -> Dict[str, Any]:
    receipt = _read_receipt(receipt_directory, expected)
    try:
        descriptor = os.open(expected.name, _artifact_flags(), dir_fd=directory)
    except OSError as exc:
        raise CacheManifestError("cache artifact is unavailable") from exc
    try:
        metadata = _safe_artifact_metadata(descriptor, sealed=False)
        # The receipt was written by the fetch process; sealing happens in a
        # separate process. Network volumes (FUSE/NFS-style) may report
        # different device/inode values per process and update ctime lazily,
        # so only size and mtime are stable cross-process change signals.
        actual = {
            "bytes": metadata.st_size,
            "mtimeNs": metadata.st_mtime_ns,
        }
        if any(receipt[key] != actual[key] for key in actual):
            raise CacheManifestError("artifact changed after checksum verification")
        if not _path_still_names_descriptor(directory, expected.name, descriptor):
            raise CacheManifestError("cache artifact pathname changed before publication")
        os.fchown(descriptor, os.geteuid(), os.getegid())
        os.fchmod(descriptor, 0o444)
        os.fsync(descriptor)
        if not _path_still_names_descriptor(directory, expected.name, descriptor):
            raise CacheManifestError("cache artifact pathname changed during publication")
        return {
            "kind": expected.kind,
            "path": expected.name,
            "sha256": expected.sha256,
            "bytes": metadata.st_size,
        }
    finally:
        os.close(descriptor)


def _sync_directory(descriptor: int) -> None:
    try:
        os.fsync(descriptor)
    except OSError as exc:
        if exc.errno not in {errno.EINVAL, errno.ENOTSUP, errno.EROFS}:
            raise


def _atomic_manifest_write(directory: int, payload: Mapping[str, Any]) -> None:
    data = canonical_json_bytes(payload) + b"\n"
    if len(data) > MAX_MANIFEST_BYTES:
        raise CacheManifestError("cache manifest exceeds the safe size limit")
    temporary = f".{MANIFEST_NAME}.{secrets.token_hex(8)}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(temporary, flags, 0o600, dir_fd=directory)
    try:
        remaining = memoryview(data)
        while remaining:
            written = os.write(descriptor, remaining)
            if written <= 0:
                raise OSError("cache manifest write made no progress")
            remaining = remaining[written:]
        os.fchown(descriptor, os.geteuid(), os.getegid())
        os.fchmod(descriptor, 0o444)
        os.fsync(descriptor)
        os.replace(temporary, MANIFEST_NAME, src_dir_fd=directory, dst_dir_fd=directory)
        _sync_directory(directory)
    finally:
        os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass


def publish(
    root: Path,
    volume_id: str,
    build_id: str,
    hashes: Mapping[str, str],
    private_key_value: str,
    receipt_root: Optional[Path] = None,
) -> Dict[str, Any]:
    """Hash once, sign, atomically publish, and seal a prepared cache."""

    private_raw = _decode_base64url(private_key_value, 32, "cache signing private key")
    try:
        private_key = Ed25519PrivateKey.from_private_bytes(private_raw)
    except ValueError as exc:
        raise CacheManifestError("cache signing private key is invalid") from exc
    public_raw = _public_bytes(private_key.public_key())
    signed = prepare(root, volume_id, build_id, hashes, receipt_root)
    manifest = {
        "signed": signed,
        "signature": {
            "algorithm": "ed25519",
            "keyId": _key_id(public_raw),
            "value": _encode_base64url(private_key.sign(canonical_json_bytes(signed))),
        },
    }
    return install(root, volume_id, build_id, hashes, _encode_base64url(public_raw), manifest)


def prepare(
    root: Path,
    volume_id: str,
    build_id: str,
    hashes: Mapping[str, str],
    receipt_root: Optional[Path] = None,
) -> Dict[str, Any]:
    """Hash every artifact once and return the exact payload the coordinator signs."""

    _validate_identity(volume_id, build_id)
    expectations = _expectations(hashes)
    directory = _open_cache_root(root, 0o700)
    receipt_directory = _open_receipt_root(receipt_root) if receipt_root is not None else -1
    try:
        artifacts = [
            (
                _seal_receipted_artifact(directory, receipt_directory, expectation)
                if receipt_directory >= 0
                else _hash_and_seal_artifact(directory, expectation)
            )
            for expectation in expectations
        ]
        _sync_directory(directory)
        return {
            "schemaVersion": CACHE_SCHEMA_VERSION,
            "volumeId": volume_id,
            "buildId": build_id,
            "createdAt": _utc_now(),
            "artifacts": artifacts,
        }
    finally:
        if receipt_directory >= 0:
            os.close(receipt_directory)
        os.close(directory)


def _reject_duplicate_keys(pairs: Sequence[tuple[str, Any]]) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise CacheManifestError("cache manifest contains duplicate fields")
        result[key] = value
    return result


def _read_manifest(directory: int) -> Dict[str, Any]:
    try:
        descriptor = os.open(MANIFEST_NAME, _artifact_flags(), dir_fd=directory)
    except OSError as exc:
        raise CacheManifestError("cache manifest is unavailable") from exc
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or metadata.st_uid != os.geteuid()
            or stat.S_IMODE(metadata.st_mode) != 0o444
            or metadata.st_size <= 0
            or metadata.st_size > MAX_MANIFEST_BYTES
        ):
            raise CacheManifestError("cache manifest ownership or mode is invalid")
        data = bytearray()
        while len(data) <= MAX_MANIFEST_BYTES:
            chunk = os.read(descriptor, min(4096, MAX_MANIFEST_BYTES + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > MAX_MANIFEST_BYTES:
            raise CacheManifestError("cache manifest exceeds the safe size limit")
        if not _path_still_names_descriptor(directory, MANIFEST_NAME, descriptor):
            raise CacheManifestError("cache manifest pathname changed")
    finally:
        os.close(descriptor)
    try:
        value = json.loads(bytes(data).decode("utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CacheManifestError("cache manifest is invalid JSON") from exc
    if not isinstance(value, dict):
        raise CacheManifestError("cache manifest must be an object")
    return value


def _valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not TIMESTAMP_PATTERN.fullmatch(value):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def _parse_manifest(
    value: Mapping[str, Any], expectations: Sequence[ArtifactExpectation]
) -> tuple[Dict[str, Any], Dict[str, Any]]:
    if not isinstance(value, dict):
        raise CacheManifestError("cache manifest envelope is invalid")
    if set(value) != {"signed", "signature"}:
        raise CacheManifestError("cache manifest envelope is invalid")
    signed = value.get("signed")
    signature = value.get("signature")
    if not isinstance(signed, dict) or set(signed) != {
        "schemaVersion",
        "volumeId",
        "buildId",
        "createdAt",
        "artifacts",
    }:
        raise CacheManifestError("cache manifest signed payload is invalid")
    if not isinstance(signature, dict) or set(signature) != {
        "algorithm",
        "keyId",
        "value",
    }:
        raise CacheManifestError("cache manifest signature is invalid")
    if signed.get("schemaVersion") != CACHE_SCHEMA_VERSION:
        raise CacheManifestError("cache manifest schema version is unsupported")
    if not _valid_timestamp(signed.get("createdAt")):
        raise CacheManifestError("cache manifest timestamp is invalid")
    artifacts = signed.get("artifacts")
    if not isinstance(artifacts, list) or len(artifacts) != len(expectations):
        raise CacheManifestError("cache manifest artifact set is invalid")
    validated_artifacts = []
    for raw, expected in zip(artifacts, expectations):
        if not isinstance(raw, dict) or set(raw) != {
            "kind",
            "path",
            "sha256",
            "bytes",
        }:
            raise CacheManifestError("cache manifest artifact is invalid")
        byte_length = raw.get("bytes")
        if (
            raw.get("kind") != expected.kind
            or raw.get("path") != expected.name
            or raw.get("sha256") != expected.sha256
            or isinstance(byte_length, bool)
            or not isinstance(byte_length, int)
            or byte_length <= 0
            or byte_length > MAX_ARTIFACT_BYTES
        ):
            raise CacheManifestError("cache manifest artifact does not match the request")
        validated_artifacts.append(dict(raw))
    validated_signed = {
        "schemaVersion": CACHE_SCHEMA_VERSION,
        "volumeId": signed.get("volumeId"),
        "buildId": signed.get("buildId"),
        "createdAt": signed.get("createdAt"),
        "artifacts": validated_artifacts,
    }
    return validated_signed, dict(signature)


def _verify_artifact(directory: int, artifact: Mapping[str, Any]) -> None:
    try:
        descriptor = os.open(str(artifact["path"]), _artifact_flags(), dir_fd=directory)
    except OSError as exc:
        raise CacheManifestError("sealed cache artifact is unavailable") from exc
    try:
        metadata = _safe_artifact_metadata(descriptor, sealed=True)
        if metadata.st_size != artifact["bytes"]:
            raise CacheManifestError("sealed cache artifact size does not match")
        if not _path_still_names_descriptor(directory, str(artifact["path"]), descriptor):
            raise CacheManifestError("sealed cache artifact pathname changed")
    finally:
        os.close(descriptor)


def _verify_signature(
    manifest: Mapping[str, Any],
    expectations: Sequence[ArtifactExpectation],
    volume_id: str,
    build_id: str,
    public_key_value: str,
) -> tuple[Dict[str, Any], Dict[str, Any]]:
    public_raw = _decode_base64url(public_key_value, 32, "cache signing public key")
    try:
        public_key = Ed25519PublicKey.from_public_bytes(public_raw)
    except ValueError as exc:
        raise CacheManifestError("cache signing public key is invalid") from exc
    signed, signature = _parse_manifest(manifest, expectations)
    if signed["volumeId"] != volume_id or signed["buildId"] != build_id:
        raise CacheManifestError("cache manifest identity does not match the request")
    if signature.get("algorithm") != "ed25519" or signature.get("keyId") != _key_id(
        public_raw
    ):
        raise CacheManifestError("cache manifest signer is invalid")
    supplied_signature = _decode_base64url(
        signature.get("value"), 64, "cache manifest signature"
    )
    try:
        public_key.verify(supplied_signature, canonical_json_bytes(signed))
    except InvalidSignature as exc:
        raise CacheManifestError("cache manifest signature does not match") from exc
    return signed, signature


def install(
    root: Path,
    volume_id: str,
    build_id: str,
    hashes: Mapping[str, str],
    public_key_value: str,
    manifest: Mapping[str, Any],
) -> Dict[str, Any]:
    """Verify a coordinator-signed document, publish it atomically, and seal the root."""

    _validate_identity(volume_id, build_id)
    expectations = _expectations(hashes)
    directory = _open_cache_root(root, 0o700)
    try:
        signed, signature = _verify_signature(
            manifest, expectations, volume_id, build_id, public_key_value
        )
        for artifact in signed["artifacts"]:
            _verify_artifact(directory, artifact)
        validated = {"signed": signed, "signature": signature}
        _atomic_manifest_write(directory, validated)
        os.fchmod(directory, 0o555)
        _sync_directory(directory)
        return validated
    finally:
        os.close(directory)


def verify(
    root: Path,
    volume_id: str,
    build_id: str,
    hashes: Mapping[str, str],
    public_key_value: str,
) -> Dict[str, Any]:
    """Verify a ready cache using only its small manifest and file metadata."""

    _validate_identity(volume_id, build_id)
    expectations = _expectations(hashes)
    directory = _open_cache_root(root, 0o555)
    try:
        manifest = _read_manifest(directory)
        signed, signature = _verify_signature(
            manifest, expectations, volume_id, build_id, public_key_value
        )
        for artifact in signed["artifacts"]:
            _verify_artifact(directory, artifact)
        return {"signed": signed, "signature": signature}
    finally:
        os.close(directory)


def _hash_arguments(args: argparse.Namespace) -> Dict[str, str]:
    return {
        "model": args.model_sha256.lower(),
        "mmproj": args.mmproj_sha256.lower(),
        "draft": args.draft_sha256.lower(),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("publish", "prepare", "install", "verify"))
    parser.add_argument("--root", required=True)
    parser.add_argument("--volume-id", required=True)
    parser.add_argument("--build-id", required=True)
    parser.add_argument("--model-sha256", required=True)
    parser.add_argument("--mmproj-sha256", required=True)
    parser.add_argument("--draft-sha256", required=True)
    parser.add_argument("--output")
    parser.add_argument("--document")
    parser.add_argument("--receipt-dir")
    args = parser.parse_args()
    try:
        if args.command == "publish":
            publish(
                Path(args.root),
                args.volume_id,
                args.build_id,
                _hash_arguments(args),
                os.environ.get("GLIMMER_CACHE_SIGNING_PRIVATE_KEY", ""),
                Path(args.receipt_dir) if args.receipt_dir else None,
            )
            print('{"event":"cache_manifest_published"}')
        elif args.command == "prepare":
            if not args.output:
                raise CacheManifestError("cache attestation output is required")
            signed = prepare(
                Path(args.root),
                args.volume_id,
                args.build_id,
                _hash_arguments(args),
                Path(args.receipt_dir) if args.receipt_dir else None,
            )
            output = Path(args.output)
            temporary = output.with_name(f".{output.name}.{secrets.token_hex(8)}.tmp")
            temporary.write_bytes(canonical_json_bytes(signed) + b"\n")
            temporary.chmod(0o600)
            os.replace(temporary, output)
            print('{"event":"cache_attestation_prepared"}')
        elif args.command == "install":
            if not args.document:
                raise CacheManifestError("signed cache document is required")
            document_data = Path(args.document).read_bytes()
            if not document_data or len(document_data) > MAX_MANIFEST_BYTES:
                raise CacheManifestError("signed cache document size is invalid")
            document = json.loads(
                document_data.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys
            )
            install(
                Path(args.root),
                args.volume_id,
                args.build_id,
                _hash_arguments(args),
                os.environ.get("GLIMMER_CACHE_SIGNING_PUBLIC_KEY", ""),
                document,
            )
            print('{"event":"cache_manifest_installed"}')
        else:
            verify(
                Path(args.root),
                args.volume_id,
                args.build_id,
                _hash_arguments(args),
                os.environ.get("GLIMMER_CACHE_SIGNING_PUBLIC_KEY", ""),
            )
            print('{"event":"cache_manifest_verified"}')
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, CacheManifestError) as exc:
        event = "cache_publication_failed" if args.command == "publish" else "cache_validation_failed"
        # CacheManifestError messages are fixed literals and OSError carries
        # only errno text for a known path layout; both are safe to surface
        # and required to diagnose a failing step from container logs alone.
        detail = f"{type(exc).__name__}:{exc}"[:200]
        print(
            json.dumps({"event": event, "reason": "cache_not_ready", "detail": detail}),
            file=sys.stderr,
        )
        return 31 if args.command == "publish" else 30
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
