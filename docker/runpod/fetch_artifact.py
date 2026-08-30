#!/usr/bin/env python3
"""Resume one allowlisted HTTPS artifact and verify its SHA-256."""

from __future__ import annotations

import argparse
import errno
import fcntl
import hashlib
import hmac
import ipaddress
import os
import re
import signal
import socket
import ssl
import stat
import sys
from pathlib import Path
from typing import Any, BinaryIO, Callable, Optional, Tuple
from urllib import error, parse, request

try:
    from .bootstrap_status import BootstrapStatusError, transition
except ImportError:  # Direct execution inside the worker image.
    from bootstrap_status import BootstrapStatusError, transition

MAX_ARTIFACT_BYTES = 32 * 1024 * 1024 * 1024
CHUNK_BYTES = 1024 * 1024
SYNC_INTERVAL_BYTES = 256 * 1024 * 1024
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
CONTENT_RANGE_PATTERN = re.compile(r"^bytes ([0-9]+)-([0-9]+)/([0-9]+)$")
ProgressReporter = Callable[[str, Optional[int], Optional[int]], None]


class ArtifactIntegrityError(ValueError):
    """The remote response cannot safely extend the local partial."""


class SafeRedirect(request.HTTPRedirectHandler):
    def __init__(self, allowed_hosts: set[str]):
        self.allowed_hosts = allowed_hosts

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_url(newurl, self.allowed_hosts)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def validate_url(value: str, allowed_hosts: set[str]) -> str:
    parsed = parse.urlsplit(value)
    host = (parsed.hostname or "").lower()
    if (
        parsed.scheme != "https"
        or not host
        or parsed.username
        or parsed.password
        or parsed.fragment
        or host not in allowed_hosts
    ):
        raise ValueError("artifact URL is outside the HTTPS host allowlist")
    for result in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM):
        address = ipaddress.ip_address(result[4][0])
        if not address.is_global:
            raise ValueError("artifact host resolved to a non-public address")
    return value


def partial_path(target: Path, expected_sha256: str) -> Path:
    """Bind resumable bytes to both the destination and expected content."""
    return target.with_name(f".{target.name}.{expected_sha256}.partial")


def target_lock_path(target: Path) -> Path:
    """Return the stable lock shared by every writer for one final pathname."""
    return target.with_name(f".{target.name}.lock")


def _digest_file(path: Path) -> Tuple[str, int]:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    flags |= getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError:
        raise
    except OSError as exc:
        raise ValueError("artifact path must be a private regular file") from exc
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise ValueError("artifact path must be a private regular file")
        source = os.fdopen(descriptor, "rb")
    except BaseException:
        os.close(descriptor)
        raise
    digest = hashlib.sha256()
    total = 0
    with source:
        for chunk in iter(lambda: source.read(CHUNK_BYTES), b""):
            total += len(chunk)
            digest.update(chunk)
    return digest.hexdigest(), total


def _target_matches(target: Path, expected_sha256: str) -> bool:
    try:
        digest, _ = _digest_file(target)
    except FileNotFoundError:
        return False
    return hmac.compare_digest(digest, expected_sha256)


def _clean_obsolete_partials(target: Path, expected_sha256: str) -> None:
    """Remove only unlocked checksum partials while the target lock is held.

    Legacy PID partials did not carry a cooperative lock, so their liveness
    cannot be proven across Pod namespaces. They are deliberately preserved.
    """
    prefix = f".{target.name}."
    suffix = ".partial"
    try:
        candidates = target.parent.iterdir()
    except FileNotFoundError:
        return
    for candidate in candidates:
        name = candidate.name
        if not name.startswith(prefix) or not name.endswith(suffix):
            continue
        token = name[len(prefix) : -len(suffix)]
        obsolete_checksum = bool(SHA256_PATTERN.fullmatch(token)) and token != expected_sha256
        if not obsolete_checksum:
            continue
        try:
            with _open_locked_partial(candidate, nonblocking=True) as partial:
                _unlink_locked_path_if_same(candidate, partial)
        except (FileNotFoundError, OSError, ValueError):
            continue


def _open_private_lock(path: Path, label: str, *, nonblocking: bool = False) -> BinaryIO:
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, 0o600)
    try:
        operation = fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0)
        fcntl.flock(descriptor, operation)
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise ValueError(f"artifact {label} must be a private regular file")
        os.fchmod(descriptor, 0o600)
        return os.fdopen(descriptor, "r+b", buffering=0)
    except BaseException:
        os.close(descriptor)
        raise


def _open_locked_partial(path: Path, *, nonblocking: bool = False) -> BinaryIO:
    return _open_private_lock(path, "partial", nonblocking=nonblocking)


def _open_target_lock(target: Path) -> BinaryIO:
    return _open_private_lock(target_lock_path(target), "lock")


def _seed_digest(partial: BinaryIO) -> Tuple[Any, int]:
    digest = hashlib.sha256()
    total = 0
    partial.seek(0)
    while True:
        chunk = partial.read(CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        digest.update(chunk)
    partial.seek(0, os.SEEK_END)
    return digest, total


def _unlink_locked_path_if_same(path: Path, partial: BinaryIO) -> None:
    """Remove only a pathname that still names the locked file descriptor."""
    try:
        path_metadata = path.lstat()
        descriptor_metadata = os.fstat(partial.fileno())
        if (
            path_metadata.st_dev == descriptor_metadata.st_dev
            and path_metadata.st_ino == descriptor_metadata.st_ino
        ):
            path.unlink(missing_ok=True)
    except FileNotFoundError:
        return


def _locked_path_is_same(path: Path, partial: BinaryIO) -> bool:
    """Return whether a pathname still identifies the verified locked inode."""
    try:
        path_metadata = path.lstat()
        descriptor_metadata = os.fstat(partial.fileno())
    except (FileNotFoundError, OSError):
        return False
    return (
        path_metadata.st_dev == descriptor_metadata.st_dev
        and path_metadata.st_ino == descriptor_metadata.st_ino
        and stat.S_ISREG(path_metadata.st_mode)
        and path_metadata.st_nlink == 1
    )


def _write_all(output: BinaryIO, data: bytes) -> None:
    """Write every byte even when the unbuffered file descriptor short-writes."""
    remaining = memoryview(data)
    while remaining:
        written = output.write(remaining)
        if written is None or written <= 0:
            raise OSError("artifact partial write made no progress")
        remaining = remaining[written:]


def _parse_content_length(value: Optional[str]) -> Optional[int]:
    if value is None:
        return None
    if not re.fullmatch(r"[0-9]+", value):
        raise ArtifactIntegrityError("artifact Content-Length is invalid")
    return int(value)


def _validate_response(response: Any, offset: int) -> Optional[int]:
    status_code = getattr(response, "status", None)
    if status_code is None:
        status_code = response.getcode()
    content_length = _parse_content_length(response.headers.get("Content-Length"))
    content_range = response.headers.get("Content-Range")

    if status_code == 200:
        if offset != 0:
            raise ArtifactIntegrityError("artifact server ignored the resume range")
        if content_range is not None:
            raise ArtifactIntegrityError("full artifact response included Content-Range")
        if content_length is not None and content_length > MAX_ARTIFACT_BYTES:
            raise ArtifactIntegrityError("artifact exceeds the safe size limit")
        return content_length

    if status_code != 206:
        raise ArtifactIntegrityError("artifact server returned an unexpected status")
    match = CONTENT_RANGE_PATTERN.fullmatch(content_range or "")
    if match is None:
        raise ArtifactIntegrityError("artifact Content-Range is invalid")
    start, end, total = (int(value) for value in match.groups())
    if start != offset or end < start or end + 1 != total:
        raise ArtifactIntegrityError("artifact Content-Range does not match the requested range")
    if total > MAX_ARTIFACT_BYTES:
        raise ArtifactIntegrityError("artifact exceeds the safe size limit")
    expected_bytes = end - start + 1
    if content_length is not None and content_length != expected_bytes:
        raise ArtifactIntegrityError("artifact range length is inconsistent")
    return expected_bytes


def _sync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        try:
            os.fsync(descriptor)
        except OSError as exc:
            if exc.errno not in {errno.EINVAL, errno.ENOTSUP, errno.EROFS}:
                raise
    finally:
        os.close(descriptor)


def _report(
    reporter: Optional[ProgressReporter],
    phase: str,
    completed: Optional[int] = None,
    total: Optional[int] = None,
) -> None:
    if reporter is not None:
        reporter(phase, completed, total)


def fetch(
    url: str,
    expected_sha256: str,
    target: Path,
    allowed_hosts: set[str],
    reporter: Optional[ProgressReporter] = None,
) -> None:
    if not SHA256_PATTERN.fullmatch(expected_sha256):
        raise ValueError("artifact SHA-256 is invalid")
    validate_url(url, allowed_hosts)
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = partial_path(target, expected_sha256)
    opener = request.build_opener(
        SafeRedirect(allowed_hosts),
        request.HTTPSHandler(context=ssl.create_default_context()),
    )

    # The stable target lock serializes the fast path, obsolete cleanup, every
    # checksum-specific partial, and publication. The production entrypoint
    # additionally uses checksum-addressed final names so rolling versions
    # never compete for one pathname after this function returns.
    _report(reporter, "locking")
    with _open_target_lock(target):
        if _target_matches(target, expected_sha256):
            _report(reporter, "cached")
            return
        _clean_obsolete_partials(target, expected_sha256)
        with _open_locked_partial(temporary) as output:
            try:
                if _target_matches(target, expected_sha256):
                    _unlink_locked_path_if_same(temporary, output)
                    _report(reporter, "cached")
                    return
                digest, offset = _seed_digest(output)
                downloaded_total = offset
                if offset > MAX_ARTIFACT_BYTES:
                    raise ArtifactIntegrityError("artifact partial exceeds the safe size limit")
                existing_partial_verified = bool(offset) and hmac.compare_digest(
                    digest.hexdigest(), expected_sha256
                )
                if not existing_partial_verified:
                    if offset:
                        _report(reporter, "resuming", offset)
                    artifact_request = request.Request(
                        url,
                        headers={
                            "User-Agent": "glimmer-worker/1",
                            "Accept-Encoding": "identity",
                            "Range": f"bytes={offset}-",
                        },
                    )
                    try:
                        response_context = opener.open(artifact_request, timeout=30)
                    except error.HTTPError as exc:
                        if offset and exc.code == 416:
                            raise ArtifactIntegrityError(
                                "artifact resume range was rejected"
                            ) from exc
                        raise
                    with response_context as response:
                        expected_response_bytes = _validate_response(response, offset)
                        expected_total = (
                            offset + expected_response_bytes
                            if expected_response_bytes is not None
                            else None
                        )
                        _report(reporter, "downloading", offset, expected_total)
                        response_bytes = 0
                        unsynced_bytes = 0
                        total = offset
                        while True:
                            chunk = response.read(CHUNK_BYTES)
                            if not chunk:
                                break
                            response_bytes += len(chunk)
                            total += len(chunk)
                            downloaded_total = total
                            if total > MAX_ARTIFACT_BYTES:
                                raise ArtifactIntegrityError("artifact exceeds the safe size limit")
                            if (
                                expected_response_bytes is not None
                                and response_bytes > expected_response_bytes
                            ):
                                raise ArtifactIntegrityError(
                                    "artifact response exceeded its declared range"
                                )
                            digest.update(chunk)
                            _write_all(output, chunk)
                            unsynced_bytes += len(chunk)
                            if unsynced_bytes >= SYNC_INTERVAL_BYTES:
                                output.flush()
                                os.fsync(output.fileno())
                                _report(reporter, "downloading", total, expected_total)
                                unsynced_bytes = 0
                        if (
                            expected_response_bytes is not None
                            and response_bytes != expected_response_bytes
                        ):
                            raise OSError("artifact download ended before the declared range")
                output.flush()
                os.fsync(output.fileno())
                _report(reporter, "verifying", downloaded_total, downloaded_total)
                if existing_partial_verified:
                    final_digest, final_size = digest, offset
                else:
                    final_digest, final_size = _seed_digest(output)
                if final_size > MAX_ARTIFACT_BYTES or not hmac.compare_digest(
                    final_digest.hexdigest(), expected_sha256
                ):
                    raise ArtifactIntegrityError("artifact checksum does not match")
                if not _locked_path_is_same(temporary, output):
                    raise ArtifactIntegrityError("artifact partial pathname changed")
                os.replace(temporary, target)
                _sync_directory(target.parent)
                _report(reporter, "complete", final_size, final_size)
            except ArtifactIntegrityError:
                _unlink_locked_path_if_same(temporary, output)
                raise
            except BaseException:
                try:
                    output.flush()
                    os.fsync(output.fileno())
                except OSError:
                    pass
                raise


def _interrupt_download(signum: int, _frame: Any) -> None:
    raise InterruptedError(f"artifact download interrupted by signal {signum}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--allowed-host", action="append", required=True)
    parser.add_argument("--status-file")
    parser.add_argument("--lease-id")
    parser.add_argument("--artifact-kind", choices=("model", "mmproj", "draft"))
    args = parser.parse_args()
    hosts = {value.strip().lower() for value in args.allowed_host if value.strip()}
    status_arguments = (args.status_file, args.lease_id, args.artifact_kind)
    if any(status_arguments) and not all(status_arguments):
        parser.error("status-file, lease-id, and artifact-kind must be supplied together")
    reporter: Optional[ProgressReporter] = None
    if all(status_arguments):

        def report(phase: str, completed: Optional[int], total: Optional[int]) -> None:
            stage = {
                "locking": "artifact_preparing",
                "cached": "artifact_preparing",
                "resuming": "artifact_preparing",
                "downloading": "artifact_downloading",
                "verifying": "artifact_verifying",
                "complete": "artifact_verifying",
            }[phase]
            artifact: dict[str, Any] = {"kind": args.artifact_kind, "phase": phase}
            if completed is not None:
                artifact["bytesCompleted"] = completed
            if total is not None:
                artifact["bytesTotal"] = total
            try:
                transition(
                    Path(args.status_file),
                    args.lease_id,
                    stage,
                    artifact=artifact,
                )
            except (OSError, BootstrapStatusError) as exc:
                raise BootstrapStatusError("bootstrap status update failed") from exc

        reporter = report
    signal.signal(signal.SIGTERM, _interrupt_download)
    signal.signal(signal.SIGINT, _interrupt_download)
    try:
        fetch(args.url, args.sha256.lower(), Path(args.output), hosts, reporter=reporter)
    except BootstrapStatusError:
        print('{"event":"startup_failed","reason":"status_persistence_failed"}', file=sys.stderr)
        return 6
    except ArtifactIntegrityError:
        print('{"event":"startup_failed","reason":"artifact_checksum_failed"}', file=sys.stderr)
        return 20
    except Exception:
        print('{"event":"startup_failed","reason":"artifact_download_failed"}', file=sys.stderr)
        return 21
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
