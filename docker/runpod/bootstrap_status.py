#!/usr/bin/env python3
"""Persist and expose bounded, secret-free RunPod bootstrap diagnostics."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import secrets
import stat
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, Mapping, Optional

STATUS_SCHEMA_VERSION = 1
MAX_STATUS_BYTES = 16 * 1024
MAX_ARTIFACT_BYTES = 32 * 1024 * 1024 * 1024
LEASE_ID_PATTERN = re.compile(
    r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"
)
TIMESTAMP_PATTERN = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$"
)
STAGES = {
    "initializing",
    "worker_starting",
    "worker_listening",
    "artifact_preparing",
    "artifact_downloading",
    "artifact_verifying",
    "model_starting",
    "model_healthcheck",
    "ready",
    "failed",
}
OUTCOMES = {"in_progress", "ready", "failed"}
ARTIFACT_KINDS = {"model", "mmproj", "draft"}
ARTIFACT_PHASES = {
    "locking",
    "cached",
    "resuming",
    "downloading",
    "verifying",
    "complete",
}
FAILURE_CODES = {
    "configuration_invalid",
    "status_persistence_failed",
    "worker_start_failed",
    "artifact_download_failed",
    "artifact_checksum_failed",
    "model_start_failed",
    "model_healthcheck_failed",
    "bootstrap_interrupted",
    "unexpected_failure",
}
FILE_KEYS = {
    "schemaVersion",
    "leaseId",
    "stage",
    "outcome",
    "stageStartedAt",
    "updatedAt",
    "artifact",
    "failureCode",
    "exitCode",
}
PUBLIC_KEYS = FILE_KEYS - {"schemaVersion", "leaseId"}


class BootstrapStatusError(ValueError):
    """The bootstrap status path or payload violated its bounded contract."""


def utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not TIMESTAMP_PATTERN.fullmatch(value):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def _validate_lease_id(lease_id: str) -> str:
    if not LEASE_ID_PATTERN.fullmatch(lease_id):
        raise BootstrapStatusError("bootstrap lease id is invalid")
    return lease_id


def _validate_artifact(value: Any) -> Dict[str, Any]:
    if not isinstance(value, Mapping):
        raise BootstrapStatusError("bootstrap artifact status must be an object")
    allowed = {"kind", "phase", "bytesCompleted", "bytesTotal"}
    if set(value) - allowed or not {"kind", "phase"}.issubset(value):
        raise BootstrapStatusError("bootstrap artifact status has invalid fields")
    if value["kind"] not in ARTIFACT_KINDS or value["phase"] not in ARTIFACT_PHASES:
        raise BootstrapStatusError("bootstrap artifact status has invalid values")
    artifact: Dict[str, Any] = {"kind": value["kind"], "phase": value["phase"]}
    for key in ("bytesCompleted", "bytesTotal"):
        if key not in value:
            continue
        item = value[key]
        if type(item) is not int or item < 0 or item > MAX_ARTIFACT_BYTES:
            raise BootstrapStatusError("bootstrap artifact byte count is invalid")
        artifact[key] = item
    if artifact.get("bytesCompleted", 0) > artifact.get(
        "bytesTotal", MAX_ARTIFACT_BYTES
    ):
        raise BootstrapStatusError("bootstrap artifact progress is inconsistent")
    return artifact


def validate_status(value: Any, lease_id: str) -> Dict[str, Any]:
    expected_lease = _validate_lease_id(lease_id)
    if not isinstance(value, Mapping) or set(value) - FILE_KEYS:
        raise BootstrapStatusError("bootstrap status has invalid fields")
    required = {
        "schemaVersion",
        "leaseId",
        "stage",
        "outcome",
        "stageStartedAt",
        "updatedAt",
    }
    if not required.issubset(value):
        raise BootstrapStatusError("bootstrap status is incomplete")
    if value["schemaVersion"] != STATUS_SCHEMA_VERSION or value["leaseId"] != expected_lease:
        raise BootstrapStatusError("bootstrap status identity is invalid")
    stage = value["stage"]
    outcome = value["outcome"]
    if stage not in STAGES or outcome not in OUTCOMES:
        raise BootstrapStatusError("bootstrap status has invalid values")
    if not _valid_timestamp(value["stageStartedAt"]) or not _valid_timestamp(value["updatedAt"]):
        raise BootstrapStatusError("bootstrap status timestamp is invalid")
    updated_at = datetime.fromisoformat(value["updatedAt"].replace("Z", "+00:00"))
    stage_started_at = datetime.fromisoformat(
        value["stageStartedAt"].replace("Z", "+00:00")
    )
    if updated_at < stage_started_at:
        raise BootstrapStatusError("bootstrap status timestamps are inconsistent")
    if stage == "ready" or outcome == "ready":
        if stage != "ready" or outcome != "ready":
            raise BootstrapStatusError("bootstrap ready status is inconsistent")
    elif stage == "failed" or outcome == "failed":
        if stage != "failed" or outcome != "failed":
            raise BootstrapStatusError("bootstrap failure status is inconsistent")
    elif outcome != "in_progress":
        raise BootstrapStatusError("bootstrap progress status is inconsistent")

    result: Dict[str, Any] = {
        "schemaVersion": STATUS_SCHEMA_VERSION,
        "leaseId": expected_lease,
        "stage": stage,
        "outcome": outcome,
        "stageStartedAt": value["stageStartedAt"],
        "updatedAt": value["updatedAt"],
    }
    if "artifact" in value:
        if stage not in {
            "artifact_preparing",
            "artifact_downloading",
            "artifact_verifying",
            "failed",
        }:
            raise BootstrapStatusError("bootstrap artifact status is out of stage")
        result["artifact"] = _validate_artifact(value["artifact"])
    elif stage in {"artifact_preparing", "artifact_downloading", "artifact_verifying"}:
        raise BootstrapStatusError("bootstrap artifact status is missing")

    failure_code = value.get("failureCode")
    exit_code = value.get("exitCode")
    if outcome == "failed":
        if failure_code not in FAILURE_CODES:
            raise BootstrapStatusError("bootstrap failure code is invalid")
        result["failureCode"] = failure_code
        if type(exit_code) is not int or not 0 <= exit_code <= 255:
            raise BootstrapStatusError("bootstrap failure exit code is invalid")
        result["exitCode"] = exit_code
    elif failure_code is not None or exit_code is not None:
        raise BootstrapStatusError("bootstrap non-failure included failure fields")
    return result


def public_status(value: Mapping[str, Any], lease_id: str) -> Dict[str, Any]:
    validated = validate_status(value, lease_id)
    return {key: validated[key] for key in PUBLIC_KEYS if key in validated}


def _directory_flags() -> int:
    return (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )


def _open_private_directory(name: str, parent: int, *, create: bool) -> int:
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError:
            pass
    descriptor = os.open(name, _directory_flags(), dir_fd=parent)
    metadata = os.fstat(descriptor)
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != os.geteuid()
        or metadata.st_mode & 0o077
    ):
        os.close(descriptor)
        raise BootstrapStatusError("bootstrap status directory is not private")
    if create:
        os.fchmod(descriptor, 0o700)
    return descriptor


@contextmanager
def _locked_status_directory(
    path: Path, lease_id: str, *, exclusive: Optional[bool] = True
) -> Iterator[int]:
    expected_lease = _validate_lease_id(lease_id)
    if path.name != "status.json" or path.parent.name != expected_lease:
        raise BootstrapStatusError("bootstrap status path is invalid")
    bootstrap_root = path.parent.parent
    if bootstrap_root.name != "bootstrap":
        raise BootstrapStatusError("bootstrap status root is invalid")
    recovery_root = bootstrap_root.parent
    recovery_descriptor = os.open(recovery_root, _directory_flags())
    bootstrap_descriptor = -1
    lease_descriptor = -1
    lock_descriptor = -1
    try:
        metadata = os.fstat(recovery_descriptor)
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or metadata.st_mode & 0o077
        ):
            raise BootstrapStatusError("bootstrap recovery root is not private")
        create = exclusive is not None
        if create:
            os.fchmod(recovery_descriptor, 0o700)
        bootstrap_descriptor = _open_private_directory(
            "bootstrap", recovery_descriptor, create=create
        )
        lease_descriptor = _open_private_directory(
            expected_lease, bootstrap_descriptor, create=create
        )
        if exclusive is not None:
            lock_flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0)
            lock_flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
            lock_descriptor = os.open(
                ".status.lock", lock_flags, 0o600, dir_fd=lease_descriptor
            )
            lock_metadata = os.fstat(lock_descriptor)
            if (
                not stat.S_ISREG(lock_metadata.st_mode)
                or lock_metadata.st_nlink != 1
                or lock_metadata.st_uid != os.geteuid()
                or lock_metadata.st_mode & 0o077
            ):
                raise BootstrapStatusError("bootstrap status lock is not private")
            os.fchmod(lock_descriptor, 0o600)
            operation = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
            fcntl.flock(lock_descriptor, operation)
        yield lease_descriptor
    finally:
        if lock_descriptor >= 0:
            os.close(lock_descriptor)
        if lease_descriptor >= 0:
            os.close(lease_descriptor)
        if bootstrap_descriptor >= 0:
            os.close(bootstrap_descriptor)
        os.close(recovery_descriptor)


def _read_locked(directory: int, lease_id: str) -> Dict[str, Any]:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    descriptor = os.open("status.json", flags, dir_fd=directory)
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or metadata.st_uid != os.geteuid()
            or metadata.st_mode & 0o077
            or metadata.st_size > MAX_STATUS_BYTES
        ):
            raise BootstrapStatusError("bootstrap status file is not private")
        data = bytearray()
        while len(data) <= MAX_STATUS_BYTES:
            chunk = os.read(descriptor, min(4096, MAX_STATUS_BYTES + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > MAX_STATUS_BYTES:
            raise BootstrapStatusError("bootstrap status file is too large")
    finally:
        os.close(descriptor)
    try:
        value = json.loads(bytes(data).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BootstrapStatusError("bootstrap status file is invalid") from exc
    return validate_status(value, lease_id)


def _write_locked(directory: int, value: Mapping[str, Any], lease_id: str) -> None:
    payload = validate_status(value, lease_id)
    data = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"
    if len(data) > MAX_STATUS_BYTES:
        raise BootstrapStatusError("bootstrap status payload is too large")
    temporary = f".status.{secrets.token_hex(8)}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(temporary, flags, 0o600, dir_fd=directory)
    try:
        remaining = memoryview(data)
        while remaining:
            written = os.write(descriptor, remaining)
            if written <= 0:
                raise OSError("bootstrap status write made no progress")
            remaining = remaining[written:]
        os.fsync(descriptor)
        os.replace(temporary, "status.json", src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass


def initialize(path: Path, lease_id: str) -> Dict[str, Any]:
    now = utc_now()
    value = {
        "schemaVersion": STATUS_SCHEMA_VERSION,
        "leaseId": _validate_lease_id(lease_id),
        "stage": "initializing",
        "outcome": "in_progress",
        "stageStartedAt": now,
        "updatedAt": now,
    }
    with _locked_status_directory(path, lease_id) as directory:
        _write_locked(directory, value, lease_id)
    return value


def transition(
    path: Path,
    lease_id: str,
    stage: str,
    outcome: str = "in_progress",
    artifact: Optional[Mapping[str, Any]] = None,
    failure_code: Optional[str] = None,
    exit_code: Optional[int] = None,
    preserve_artifact: bool = False,
) -> Dict[str, Any]:
    with _locked_status_directory(path, lease_id) as directory:
        current = _read_locked(directory, lease_id)
        now = utc_now()
        value: Dict[str, Any] = {
            "schemaVersion": STATUS_SCHEMA_VERSION,
            "leaseId": lease_id,
            "stage": stage,
            "outcome": outcome,
            "stageStartedAt": current["stageStartedAt"] if current["stage"] == stage else now,
            "updatedAt": now,
        }
        if artifact is not None:
            value["artifact"] = dict(artifact)
        elif preserve_artifact and "artifact" in current:
            value["artifact"] = current["artifact"]
        if failure_code is not None:
            value["failureCode"] = failure_code
        if exit_code is not None:
            value["exitCode"] = exit_code
        validated = validate_status(value, lease_id)
        _write_locked(directory, validated, lease_id)
        return validated


def read(path: Path, lease_id: str) -> Dict[str, Any]:
    # Writers publish with one atomic rename, so public health reads need no
    # cooperative lock and cannot be delayed by a failed peer that holds it.
    with _locked_status_directory(path, lease_id, exclusive=None) as directory:
        return _read_locked(directory, lease_id)


def read_public(path: Path, lease_id: str) -> Dict[str, Any]:
    return public_status(read(path, lease_id), lease_id)


def _artifact_from_args(args: argparse.Namespace) -> Optional[Dict[str, Any]]:
    if args.artifact_kind is None and args.artifact_phase is None:
        return None
    if args.artifact_kind is None or args.artifact_phase is None:
        raise BootstrapStatusError("bootstrap artifact arguments are incomplete")
    value: Dict[str, Any] = {"kind": args.artifact_kind, "phase": args.artifact_phase}
    if args.bytes_completed is not None:
        value["bytesCompleted"] = args.bytes_completed
    if args.bytes_total is not None:
        value["bytesTotal"] = args.bytes_total
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", required=True)
    parser.add_argument("--lease-id", required=True)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("initialize")
    update = subparsers.add_parser("update")
    update.add_argument("--stage", choices=sorted(STAGES - {"failed"}), required=True)
    update.add_argument("--outcome", choices=("in_progress", "ready"), default="in_progress")
    update.add_argument("--artifact-kind", choices=sorted(ARTIFACT_KINDS))
    update.add_argument("--artifact-phase", choices=sorted(ARTIFACT_PHASES))
    update.add_argument("--bytes-completed", type=int)
    update.add_argument("--bytes-total", type=int)
    failure = subparsers.add_parser("fail")
    failure.add_argument("--failure-code", choices=sorted(FAILURE_CODES), required=True)
    failure.add_argument("--exit-code", type=int, required=True)
    args = parser.parse_args()
    path = Path(args.path)
    try:
        if args.command == "initialize":
            initialize(path, args.lease_id)
        elif args.command == "update":
            transition(
                path,
                args.lease_id,
                args.stage,
                args.outcome,
                artifact=_artifact_from_args(args),
            )
        else:
            transition(
                path,
                args.lease_id,
                "failed",
                "failed",
                failure_code=args.failure_code,
                exit_code=args.exit_code,
                preserve_artifact=True,
            )
    except (OSError, BootstrapStatusError):
        print('{"event":"startup_failed","reason":"status_persistence_failed"}', file=os.sys.stderr)
        return 6
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
