#!/usr/bin/env python3
"""Authenticated, retry-safe HTTP worker for one remote Glimmer job.

The RunPod HTTP proxy is public.  This server therefore treats the proxy as
transport only: a bootstrap bearer is rotated once, every later request uses a
new capability, every mutation is HMAC signed and idempotent, and request
bodies are bounded before parsing or writing.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import queue
import re
import secrets
import signal
import stat
import subprocess
import sys
import tarfile
import threading
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, Mapping, Optional, Tuple

from docker.runpod import bootstrap_status
from docker.runpod.coordinator_callback import (
    CallbackError,
)
from docker.runpod.coordinator_callback import (
    send as send_coordinator_callback,
)
from docker.runpod.coordinator_callback import (
    validate_configuration as validate_callback_configuration,
)
from glimmer_remote import (
    CHECKPOINT_CHUNK_BYTES,
    MAX_MANIFEST_BYTES,
    MAX_PART_BYTES,
    RemoteContractError,
    RemoteJobManifestV1,
    canonical_json_bytes,
    decode_secret,
    encode_secret,
    encrypt_checkpoint,
    parse_json_body,
    parse_remote_job_manifest,
    sha256_hex,
    utc_now,
    validate_idempotency_key,
    verify_request_signature,
)

WORKER_PORT = 4318
MAX_JSON_BODY = 128 * 1024
MAX_IDEMPOTENCY_RECORDS = 512
MAX_CONCURRENT_REQUESTS = 16
PART_ROUTE = re.compile(r"^/v1/jobs/([A-Za-z0-9._-]+)/input/([0-9]{1,3})$")
JOB_ROUTE = re.compile(r"^/v1/jobs/([A-Za-z0-9._-]+)$")
START_ROUTE = re.compile(r"^/v1/jobs/([A-Za-z0-9._-]+)/start$")
CANCEL_ROUTE = re.compile(r"^/v1/jobs/([A-Za-z0-9._-]+)/cancel$")
CHECKPOINT_ROUTE = re.compile(r"^/v1/jobs/([A-Za-z0-9._-]+)/checkpoints/([0-9]{1,6})$")
ACK_ROUTE = re.compile(r"^/v1/jobs/([A-Za-z0-9._-]+)/checkpoints/([0-9]{1,6})/ack$")


class WorkerError(RuntimeError):
    def __init__(self, message: str, status: int = HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.status = int(status)


class CoordinatorActivityReporter:
    """Serialize worker activity callbacks without delaying the worker API."""

    def __init__(self, endpoint: str, token: str) -> None:
        self.endpoint, self.token = validate_callback_configuration(endpoint, token)
        self.events: queue.SimpleQueue[str] = queue.SimpleQueue()
        threading.Thread(
            target=self._run,
            name="glimmer-coordinator-activity",
            daemon=True,
        ).start()

    def __call__(self, worker_state: str) -> None:
        if worker_state not in {"ready", "busy"}:
            raise ValueError("worker activity state is invalid")
        self.events.put(worker_state)

    def _run(self) -> None:
        while True:
            worker_state = self.events.get()
            try:
                send_coordinator_callback(
                    {
                        "schemaVersion": 1,
                        "type": "heartbeat",
                        "observedAt": utc_now(),
                        "workerState": worker_state,
                    },
                    attempts=3,
                    endpoint=self.endpoint,
                    token=self.token,
                )
            except CallbackError:
                # The independent watchdog and hard deadline remain authoritative.
                # A transient callback failure must not corrupt the remote result.
                continue


def _atomic_write(path: Path, data: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _read_json(path: Path) -> Dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("persisted state must be an object")
    return value


def _bearer(value: Optional[str]) -> Optional[str]:
    if not value or not value.startswith("Bearer "):
        return None
    token = value[7:]
    if not token or len(token) > 512 or any(char.isspace() for char in token):
        return None
    return token


def _token_matches(token: Optional[str], secret: bytes) -> bool:
    if token is None:
        return False
    supplied = token.encode("utf-8", errors="strict")
    return hmac.compare_digest(supplied, secret)


@dataclass
class RunningProcess:
    process: subprocess.Popen[bytes]
    log_handle: Any


class ProcessJobRunner:
    """Fixed-executable runner.  No manifest field becomes a command."""

    def __init__(self, orchestrator_root: Path, python: str = sys.executable):
        self.orchestrator_root = orchestrator_root.resolve()
        self.python = python

    @staticmethod
    def _run_checked(argv: list[str], cwd: Path) -> None:
        try:
            subprocess.run(
                argv,
                cwd=cwd,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=120,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise WorkerError(
                "remote repository preparation failed", HTTPStatus.UNPROCESSABLE_ENTITY
            ) from exc

    def _prepare_workspace(self, job_dir: Path, manifest: RemoteJobManifestV1) -> Path:
        bundle = job_dir / "input.bundle"
        workspace = job_dir / "workspace"
        if workspace.exists():
            raise WorkerError("remote workspace already exists", HTTPStatus.CONFLICT)
        self._run_checked(["git", "clone", "--quiet", str(bundle), str(workspace)], job_dir)
        self._run_checked(
            ["git", "cat-file", "-e", f"{manifest.baseline_sha}^{{commit}}"], workspace
        )
        self._run_checked(
            ["git", "switch", "--quiet", "--create", manifest.branch, manifest.baseline_sha],
            workspace,
        )
        return workspace

    def start(
        self,
        job_dir: Path,
        manifest: RemoteJobManifestV1,
        completed: Callable[[int, Path, Path], None],
    ) -> RunningProcess:
        workspace = self._prepare_workspace(job_dir, manifest)
        session_dir = job_dir / "sessions" / manifest.session_id
        log_path = job_dir / "orchestrator.log"
        log_handle = open(log_path, "ab", buffering=0)
        orchestrator = self.orchestrator_root / "glimmer-v2.py"
        if not orchestrator.is_file():
            log_handle.close()
            raise WorkerError("bundled orchestrator is unavailable", HTTPStatus.SERVICE_UNAVAILABLE)
        manifest_path = job_dir / "remote-manifest.json"
        _atomic_write(manifest_path, canonical_json_bytes(manifest.as_dict()))
        checkpoint_sink = job_dir / "remote-checkpoints"
        checkpoint_sink.mkdir(mode=0o700)
        argv = [
            self.python,
            str(orchestrator),
            "--workspace",
            str(workspace),
            "--engineer",
            str(self.orchestrator_root / "glimmer-engineer.py"),
            "--session-id",
            manifest.session_id,
            "--max-repairs",
            str(manifest.max_repairs),
            "--timeout",
            str(manifest.timeout_seconds),
            "--remote-manifest",
            str(manifest_path),
            "--verification-level",
            "standard",
            "--auto-approve",
            "--",
            manifest.objective,
        ]
        inherited_environment = {
            key: value
            for key, value in os.environ.items()
            if key
            not in {
                "GLIMMER_COORDINATOR_CALLBACK_TOKEN",
                "GLIMMER_WORKER_BOOTSTRAP_TOKEN",
                "RUNPOD_API_KEY",
                "CACHE_SIGNING_PRIVATE_KEY",
                "JOB_ENCRYPTION_KEY",
                "INGEST_TOKEN",
                "WATCHDOG_INGEST_TOKEN",
            }
        }
        environment = {
            **inherited_environment,
            "GLIMMER_CTX": str(manifest.context_tokens),
            "GLIMMER_STATE_ROOT": str(job_dir),
            "GLIMMER_SESSION_ID": manifest.session_id,
            "GLIMMER_TOOLS_URL": "http://127.0.0.1:8080/tools",
            "GLIMMER_REMOTE_CHECKPOINT_DIR": str(checkpoint_sink),
        }
        try:
            process = subprocess.Popen(
                argv,
                cwd=self.orchestrator_root,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        except OSError as exc:
            log_handle.close()
            raise WorkerError(
                "remote orchestrator could not start", HTTPStatus.SERVICE_UNAVAILABLE
            ) from exc

        def monitor() -> None:
            code = process.wait()
            log_handle.close()
            completed(code, workspace, session_dir)

        threading.Thread(target=monitor, name=f"glimmer-job-{manifest.job_id}", daemon=True).start()
        return RunningProcess(process=process, log_handle=log_handle)

    def cancel(self, running: RunningProcess) -> None:
        if running.process.poll() is not None:
            return
        try:
            os.killpg(running.process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return


class WorkerService:
    def __init__(
        self,
        state_root: Path,
        recovery_root: Path,
        bootstrap_token: str,
        build_id: str,
        context_tokens: int,
        model_ready: Callable[[], bool],
        runner: Optional[ProcessJobRunner] = None,
        bootstrap_status_path: Optional[Path] = None,
        bootstrap_lease_id: Optional[str] = None,
        activity_callback: Optional[Callable[[str], None]] = None,
    ) -> None:
        if not bootstrap_token or len(bootstrap_token) > 512:
            raise ValueError("worker bootstrap token is required")
        if context_tokens not in (65_536, 131_072):
            raise ValueError("worker context must be 65536 or 131072")
        self.state_root = state_root.resolve()
        self.recovery_root = recovery_root.resolve()
        self.state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.recovery_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.build_id = build_id[:128]
        self.context_tokens = context_tokens
        self.model_ready = model_ready
        self.runner = runner or ProcessJobRunner(Path(__file__).resolve().parent)
        self.bootstrap_status_path = bootstrap_status_path
        self.bootstrap_lease_id = bootstrap_lease_id
        self.activity_callback = activity_callback
        self.bootstrap = bootstrap_token.encode("utf-8")
        self.bootstrap_hash = hashlib.sha256(self.bootstrap).hexdigest()
        self.capability: Optional[bytes] = None
        self.checkpoint_key: Optional[bytes] = None
        self.controller_instance_id: Optional[str] = None
        self.handshake_key: Optional[str] = None
        self.jobs: Dict[str, Dict[str, Any]] = {}
        self.running: Dict[str, RunningProcess] = {}
        self.idempotency: Dict[str, Dict[str, Any]] = {}
        self.lock = threading.RLock()
        self._load_secret_state()
        self._load_jobs()

    def _notify_activity(self, worker_state: str) -> None:
        if self.activity_callback is None:
            return
        try:
            self.activity_callback(worker_state)
        except Exception:
            # Activity reporting is an availability signal, never result data.
            return

    @property
    def secret_path(self) -> Path:
        return self.state_root / "worker-secret.json"

    def _load_secret_state(self) -> None:
        try:
            raw = _read_json(self.secret_path)
            if raw.get("schemaVersion") != 1 or raw.get("bootstrapHash") != self.bootstrap_hash:
                raise ValueError("worker secret state does not match this Pod")
            self.capability = decode_secret(raw.get("capability"), "stored capability")
            self.checkpoint_key = decode_secret(raw.get("checkpointKey"), "stored checkpoint key")
            controller = raw.get("controllerInstanceId")
            handshake_key = raw.get("handshakeKey")
            if not isinstance(controller, str) or not isinstance(handshake_key, str):
                raise ValueError("worker secret state is incomplete")
            self.controller_instance_id = controller
            self.handshake_key = handshake_key
        except FileNotFoundError:
            return

    def _save_secret_state(self) -> None:
        if not self.capability or not self.checkpoint_key or not self.controller_instance_id:
            raise RuntimeError("worker handshake state is incomplete")
        payload = {
            "schemaVersion": 1,
            "bootstrapHash": self.bootstrap_hash,
            "capability": encode_secret(self.capability),
            "checkpointKey": encode_secret(self.checkpoint_key),
            "controllerInstanceId": self.controller_instance_id,
            "handshakeKey": self.handshake_key,
        }
        _atomic_write(self.secret_path, canonical_json_bytes(payload))

    def _load_jobs(self) -> None:
        jobs_root = self.state_root / "jobs"
        if not jobs_root.exists():
            return
        for state_path in jobs_root.glob("*/state.json"):
            try:
                raw = _read_json(state_path)
                manifest = parse_remote_job_manifest(raw.get("manifest"))
                if raw.get("jobId") != manifest.job_id:
                    continue
                if raw.get("state") == "running":
                    raw["state"] = "interrupted"
                    raw["detail"] = "worker restarted while the remote process was running"
                    raw["updatedAt"] = utc_now()
                    _atomic_write(state_path, canonical_json_bytes(raw))
                self.jobs[manifest.job_id] = raw
            except (OSError, ValueError, RemoteContractError):
                continue

    def health(self) -> Dict[str, Any]:
        model_ready = bool(self.model_ready())
        ready = model_ready and self.capability is not None
        active = next(
            (
                job_id
                for job_id, state in self.jobs.items()
                if state.get("state") in {"created", "uploading", "running", "cancelling"}
            ),
            None,
        )
        return {
            "schemaVersion": 2,
            "buildId": self.build_id,
            "ready": ready,
            "model": {"ready": model_ready, "contextTokens": self.context_tokens},
            "workerState": "bootstrapping" if not ready else ("busy" if active else "ready"),
            "bootstrap": self._bootstrap_health(),
        }

    def _bootstrap_health(self) -> Dict[str, Any]:
        try:
            if self.bootstrap_status_path is None or self.bootstrap_lease_id is None:
                raise bootstrap_status.BootstrapStatusError(
                    "bootstrap status is not configured"
                )
            return bootstrap_status.read_public(
                self.bootstrap_status_path, self.bootstrap_lease_id
            )
        except (OSError, bootstrap_status.BootstrapStatusError):
            now = bootstrap_status.utc_now()
            return {
                "stage": "failed",
                "outcome": "failed",
                "stageStartedAt": now,
                "updatedAt": now,
                "failureCode": "status_persistence_failed",
                "exitCode": 6,
            }

    def register_idempotency(self, key: str, method: str, path: str, body: bytes) -> None:
        fingerprint = sha256_hex(
            b"\n".join((method.upper().encode("ascii"), path.encode("ascii"), body))
        )
        with self.lock:
            previous = self.idempotency.get(key)
            if previous is not None:
                if previous.get("fingerprint") != fingerprint:
                    raise WorkerError(
                        "idempotency key was reused for a different mutation",
                        HTTPStatus.CONFLICT,
                    )
                return
            if len(self.idempotency) >= MAX_IDEMPOTENCY_RECORDS:
                self.idempotency.pop(next(iter(self.idempotency)))
            self.idempotency[key] = {"fingerprint": fingerprint}

    def bootstrap_authorized(self, authorization: Optional[str]) -> bool:
        return _token_matches(_bearer(authorization), self.bootstrap)

    def authorized(self, authorization: Optional[str]) -> bool:
        capability = self.capability
        return bool(capability and _token_matches(_bearer(authorization), capability))

    def handshake(
        self,
        authorization: Optional[str],
        idempotency_key: str,
        body: Mapping[str, Any],
    ) -> Dict[str, Any]:
        key = validate_idempotency_key(idempotency_key)
        controller = body.get("controllerInstanceId")
        nonce = body.get("nonce")
        if (
            not isinstance(controller, str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", controller)
            or not isinstance(nonce, str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", nonce)
            or set(body) != {"controllerInstanceId", "nonce"}
        ):
            raise WorkerError("handshake body is invalid")
        with self.lock:
            if not self.bootstrap_authorized(authorization):
                raise WorkerError("worker authentication failed", HTTPStatus.UNAUTHORIZED)
            if self.capability is not None:
                if self.handshake_key != key or self.controller_instance_id != controller:
                    raise WorkerError("worker bootstrap was already consumed", HTTPStatus.CONFLICT)
            else:
                self.capability = encode_secret(secrets.token_bytes(32)).encode("ascii")
                self.checkpoint_key = secrets.token_bytes(32)
                self.controller_instance_id = controller
                self.handshake_key = key
                self._save_secret_state()
            return {
                "schemaVersion": 1,
                "buildId": self.build_id,
                "capability": self.capability.decode("ascii"),
                "checkpointKey": encode_secret(self.checkpoint_key),
                "contextTokens": self.context_tokens,
            }

    def signing_key(self) -> bytes:
        if self.capability is None:
            raise WorkerError("worker handshake is required", HTTPStatus.PRECONDITION_REQUIRED)
        return self.capability

    def _job_dir(self, job_id: str) -> Path:
        return self.state_root / "jobs" / job_id

    def _save_job(self, state: Dict[str, Any]) -> None:
        state["updatedAt"] = utc_now()
        _atomic_write(self._job_dir(state["jobId"]) / "state.json", canonical_json_bytes(state))

    def _public_job(self, state: Mapping[str, Any]) -> Dict[str, Any]:
        manifest = state["manifest"]
        checkpoints = []
        for item in state.get("checkpoints", []):
            checkpoints.append(
                {
                    "sequence": item["sequence"],
                    "bytes": item["bytes"],
                    "sha256": item["sha256"],
                    "plaintextSha256": item["plaintextSha256"],
                    "kind": item["kind"],
                    "final": item["final"],
                    "acknowledged": item.get("acknowledged", False),
                }
            )
        return {
            "schemaVersion": 1,
            "jobId": state["jobId"],
            "sessionId": manifest["sessionId"],
            "state": state["state"],
            "receivedParts": len(state.get("receivedParts", {})),
            "expectedParts": manifest["input"]["parts"],
            "receivedBytes": state.get("receivedBytes", 0),
            "expectedBytes": manifest["input"]["bytes"],
            "createdAt": state["createdAt"],
            "updatedAt": state["updatedAt"],
            "checkpoints": checkpoints,
            **({"exitCode": state["exitCode"]} if "exitCode" in state else {}),
            **({"detail": state["detail"]} if "detail" in state else {}),
        }

    def create_job(self, manifest_value: Any) -> Dict[str, Any]:
        manifest = parse_remote_job_manifest(manifest_value)
        with self.lock:
            if self.controller_instance_id != manifest.instance_id:
                raise WorkerError(
                    "manifest instance does not own this worker", HTTPStatus.FORBIDDEN
                )
            existing = self.jobs.get(manifest.job_id)
            if existing:
                if canonical_json_bytes(existing["manifest"]) != canonical_json_bytes(
                    manifest.as_dict()
                ):
                    raise WorkerError(
                        "job id already exists with a different manifest", HTTPStatus.CONFLICT
                    )
                return self._public_job(existing)
            for state in self.jobs.values():
                if state.get("state") in {"created", "uploading", "running", "cancelling"}:
                    raise WorkerError("the worker already has an active job", HTTPStatus.CONFLICT)
            state: Dict[str, Any] = {
                "schemaVersion": 1,
                "jobId": manifest.job_id,
                "manifest": manifest.as_dict(),
                "state": "created",
                "receivedParts": {},
                "receivedBytes": 0,
                "checkpoints": [],
                "createdAt": utc_now(),
                "updatedAt": utc_now(),
            }
            self.jobs[manifest.job_id] = state
            self._save_job(state)
            return self._public_job(state)

    def upload_part(
        self, job_id: str, part: int, body: bytes, supplied_sha256: str
    ) -> Dict[str, Any]:
        if len(body) == 0 or len(body) > MAX_PART_BYTES:
            raise WorkerError("input part has an invalid size", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
        if not re.fullmatch(r"[a-f0-9]{64}", supplied_sha256 or ""):
            raise WorkerError("input part checksum is invalid")
        actual = sha256_hex(body)
        if not hmac.compare_digest(actual, supplied_sha256):
            raise WorkerError("input part checksum does not match", HTTPStatus.UNPROCESSABLE_ENTITY)
        with self.lock:
            state = self.jobs.get(job_id)
            if not state:
                raise WorkerError("remote job was not found", HTTPStatus.NOT_FOUND)
            if state["state"] not in {"created", "uploading"}:
                raise WorkerError("remote job no longer accepts input", HTTPStatus.CONFLICT)
            expected_parts = state["manifest"]["input"]["parts"]
            if part < 0 or part >= expected_parts:
                raise WorkerError("input part index is out of range")
            key = str(part)
            previous = state["receivedParts"].get(key)
            if previous:
                if previous["sha256"] != actual or previous["bytes"] != len(body):
                    raise WorkerError(
                        "input part conflicts with the stored part", HTTPStatus.CONFLICT
                    )
                return self._public_job(state)
            new_total = int(state["receivedBytes"]) + len(body)
            if new_total > state["manifest"]["input"]["bytes"]:
                raise WorkerError("uploaded input exceeds the declared size", HTTPStatus.CONFLICT)
            part_path = self._job_dir(job_id) / "parts" / f"part-{part:06d}.bin"
            _atomic_write(part_path, body)
            state["receivedParts"][key] = {"sha256": actual, "bytes": len(body)}
            state["receivedBytes"] = new_total
            state["state"] = "uploading"
            self._save_job(state)
            return self._public_job(state)

    def _assemble_input(self, state: Dict[str, Any]) -> Path:
        manifest = parse_remote_job_manifest(state["manifest"])
        if len(state["receivedParts"]) != manifest.input.parts:
            raise WorkerError("not all input parts have been uploaded", HTTPStatus.CONFLICT)
        target = self._job_dir(manifest.job_id) / "input.bundle"
        temporary = target.with_suffix(".assembling")
        digest = hashlib.sha256()
        total = 0
        with open(temporary, "wb") as output:
            for part in range(manifest.input.parts):
                source = self._job_dir(manifest.job_id) / "parts" / f"part-{part:06d}.bin"
                try:
                    data = source.read_bytes()
                except OSError as exc:
                    raise WorkerError(
                        "an uploaded input part is unavailable", HTTPStatus.CONFLICT
                    ) from exc
                digest.update(data)
                total += len(data)
                output.write(data)
            output.flush()
            os.fsync(output.fileno())
        if total != manifest.input.bytes or not hmac.compare_digest(
            digest.hexdigest(), manifest.input.sha256
        ):
            temporary.unlink(missing_ok=True)
            raise WorkerError(
                "assembled input does not match the manifest", HTTPStatus.UNPROCESSABLE_ENTITY
            )
        os.replace(temporary, target)
        return target

    def start_job(self, job_id: str) -> Dict[str, Any]:
        with self.lock:
            state = self.jobs.get(job_id)
            if not state:
                raise WorkerError("remote job was not found", HTTPStatus.NOT_FOUND)
            if state["state"] == "running":
                return self._public_job(state)
            if state["state"] not in {"created", "uploading"}:
                raise WorkerError(
                    "remote job cannot be started in its current state", HTTPStatus.CONFLICT
                )
            if not self.model_ready():
                raise WorkerError("worker model is not ready", HTTPStatus.SERVICE_UNAVAILABLE)
            self._assemble_input(state)
            manifest = parse_remote_job_manifest(state["manifest"])
            running = self.runner.start(
                self._job_dir(job_id),
                manifest,
                lambda code, workspace, session: self._complete_job(
                    manifest.job_id, code, workspace, session
                ),
            )
            self.running[job_id] = running
            state["state"] = "running"
            state["startedAt"] = utc_now()
            self._save_job(state)
            result = self._public_job(state)
        self._notify_activity("busy")
        return result

    def _result_archive(
        self, job_id: str, workspace: Path, session_dir: Path, exit_code: int
    ) -> Path:
        job_dir = self._job_dir(job_id)
        metadata_path = job_dir / "result.json"
        result: Dict[str, Any] = {
            "schemaVersion": 1,
            "jobId": job_id,
            "exitCode": exit_code,
            "completedAt": utc_now(),
        }
        try:
            head = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=workspace,
                check=True,
                capture_output=True,
                text=True,
                timeout=10,
            ).stdout.strip()
            if re.fullmatch(r"[a-f0-9]{40,64}", head):
                result["resultCommit"] = head
        except (OSError, subprocess.SubprocessError):
            pass
        _atomic_write(metadata_path, canonical_json_bytes(result))
        archive = job_dir / "result.tar"
        with tarfile.open(archive, "w", format=tarfile.PAX_FORMAT) as output:
            output.add(metadata_path, arcname="result.json", recursive=False)
            if session_dir.is_dir():
                for path in sorted(session_dir.rglob("*")):
                    if path.is_symlink() or not path.is_file():
                        continue
                    relative = path.relative_to(session_dir)
                    if len(str(relative)) > 4096 or path.stat().st_size > 64 * 1024 * 1024:
                        continue
                    output.add(path, arcname=str(Path("session") / relative), recursive=False)
        return archive

    def _write_checkpoints(self, state: Dict[str, Any], artifact: Path) -> None:
        if self.checkpoint_key is None:
            raise RuntimeError("checkpoint key is unavailable")
        checkpoint_dir = self.recovery_root / state["jobId"]
        checkpoint_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        state["checkpoints"] = []
        size = artifact.stat().st_size
        sequence = 0
        with open(artifact, "rb") as source:
            while True:
                plaintext = source.read(CHECKPOINT_CHUNK_BYTES)
                if not plaintext:
                    break
                final = source.tell() == size
                metadata = {
                    "schemaVersion": 1,
                    "jobId": state["jobId"],
                    "sessionId": state["manifest"]["sessionId"],
                    "sequence": sequence,
                    "kind": "result",
                    "final": final,
                    "plaintextSha256": sha256_hex(plaintext),
                }
                encrypted, digest = encrypt_checkpoint(self.checkpoint_key, plaintext, metadata)
                target = checkpoint_dir / f"checkpoint-{sequence:06d}.bin"
                _atomic_write(target, encrypted)
                state["checkpoints"].append(
                    {
                        **metadata,
                        "bytes": len(encrypted),
                        "sha256": digest,
                        "acknowledged": False,
                    }
                )
                sequence += 1
        if sequence == 0:
            raise RuntimeError("result archive was empty")

    def _complete_job(
        self, job_id: str, exit_code: int, workspace: Path, session_dir: Path
    ) -> None:
        try:
            artifact = self._result_archive(job_id, workspace, session_dir, exit_code)
            with self.lock:
                state = self.jobs[job_id]
                self._write_checkpoints(state, artifact)
                state["exitCode"] = exit_code
                state["state"] = "succeeded" if exit_code == 0 else "failed"
                state["completedAt"] = utc_now()
                self.running.pop(job_id, None)
                self._save_job(state)
        except Exception:
            with self.lock:
                state = self.jobs.get(job_id)
                if state:
                    state["state"] = "failed"
                    state["detail"] = "remote result checkpoint could not be created"
                    state["exitCode"] = exit_code
                    self.running.pop(job_id, None)
                    self._save_job(state)
        finally:
            self._notify_activity("ready")

    def job_status(self, job_id: str) -> Dict[str, Any]:
        with self.lock:
            state = self.jobs.get(job_id)
            if not state:
                raise WorkerError("remote job was not found", HTTPStatus.NOT_FOUND)
            return self._public_job(state)

    def checkpoint(self, job_id: str, sequence: int) -> Tuple[bytes, Dict[str, Any]]:
        with self.lock:
            state = self.jobs.get(job_id)
            if not state:
                raise WorkerError("remote job was not found", HTTPStatus.NOT_FOUND)
            item = next(
                (entry for entry in state.get("checkpoints", []) if entry["sequence"] == sequence),
                None,
            )
            if not item or item.get("acknowledged"):
                raise WorkerError("remote checkpoint was not found", HTTPStatus.NOT_FOUND)
            target = self.recovery_root / job_id / f"checkpoint-{sequence:06d}.bin"
            try:
                data = target.read_bytes()
            except OSError as exc:
                raise WorkerError("remote checkpoint was not found", HTTPStatus.NOT_FOUND) from exc
            if len(data) != item["bytes"] or not hmac.compare_digest(
                sha256_hex(data), item["sha256"]
            ):
                raise WorkerError("remote checkpoint integrity check failed", HTTPStatus.CONFLICT)
            return data, dict(item)

    def acknowledge_checkpoint(
        self, job_id: str, sequence: int, supplied_sha256: Any
    ) -> Dict[str, Any]:
        if not isinstance(supplied_sha256, str) or not re.fullmatch(
            r"[a-f0-9]{64}", supplied_sha256
        ):
            raise WorkerError("checkpoint acknowledgement checksum is invalid")
        with self.lock:
            state = self.jobs.get(job_id)
            if not state:
                raise WorkerError("remote job was not found", HTTPStatus.NOT_FOUND)
            item = next(
                (entry for entry in state.get("checkpoints", []) if entry["sequence"] == sequence),
                None,
            )
            if not item:
                raise WorkerError("remote checkpoint was not found", HTTPStatus.NOT_FOUND)
            if not hmac.compare_digest(item["sha256"], supplied_sha256):
                raise WorkerError(
                    "checkpoint acknowledgement checksum does not match", HTTPStatus.CONFLICT
                )
            target = self.recovery_root / job_id / f"checkpoint-{sequence:06d}.bin"
            target.unlink(missing_ok=True)
            item["acknowledged"] = True
            item["acknowledgedAt"] = utc_now()
            self._save_job(state)
            return self._public_job(state)

    def cancel_job(self, job_id: str) -> Dict[str, Any]:
        notify_ready = False
        with self.lock:
            state = self.jobs.get(job_id)
            if not state:
                raise WorkerError("remote job was not found", HTTPStatus.NOT_FOUND)
            if state["state"] in {"cancelled", "succeeded", "failed", "interrupted"}:
                return self._public_job(state)
            running = self.running.get(job_id)
            if running:
                self.runner.cancel(running)
                state["state"] = "cancelling"
            else:
                state["state"] = "cancelled"
                state["completedAt"] = utc_now()
                notify_ready = True
            self._save_job(state)
            result = self._public_job(state)
        if notify_ready:
            self._notify_activity("ready")
        return result


class WorkerRequestHandler(BaseHTTPRequestHandler):
    server_version = "GlimmerWorker/1"
    sys_version = ""

    @property
    def service(self) -> WorkerService:
        return self.server.service  # type: ignore[attr-defined,no-any-return]

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _send_json(self, status: int, value: Mapping[str, Any]) -> None:
        data = canonical_json_bytes(dict(value))
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _send_error(self, error: Exception) -> None:
        if isinstance(error, WorkerError):
            status, message = error.status, str(error)
        elif isinstance(error, RemoteContractError):
            status, message = HTTPStatus.BAD_REQUEST, str(error)
        else:
            status, message = HTTPStatus.INTERNAL_SERVER_ERROR, "worker request failed"
        self._send_json(int(status), {"error": message})

    def _body(self, maximum: int) -> bytes:
        if self.headers.get("Transfer-Encoding"):
            raise WorkerError("streamed request bodies are unsupported", HTTPStatus.LENGTH_REQUIRED)
        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length or "")
        except ValueError as exc:
            raise WorkerError("Content-Length is required", HTTPStatus.LENGTH_REQUIRED) from exc
        if length <= 0 or length > maximum:
            raise WorkerError(
                "request body exceeds the safe size limit", HTTPStatus.REQUEST_ENTITY_TOO_LARGE
            )
        data = self.rfile.read(length)
        if len(data) != length:
            raise WorkerError("request body ended early")
        return data

    def _require_auth(self) -> bytes:
        if not self.service.authorized(self.headers.get("Authorization")):
            raise WorkerError("worker authentication failed", HTTPStatus.UNAUTHORIZED)
        return self.service.signing_key()

    def _require_mutation(self, body: bytes) -> str:
        capability = self._require_auth()
        key = validate_idempotency_key(self.headers.get("Idempotency-Key"))
        if not verify_request_signature(
            capability,
            self.headers.get("X-Glimmer-Signature"),
            self.command,
            self.path,
            key,
            body,
        ):
            raise WorkerError("worker request signature is invalid", HTTPStatus.FORBIDDEN)
        self.service.register_idempotency(key, self.command, self.path, body)
        return key

    def do_GET(self) -> None:
        try:
            if self.path == "/v1/health":
                # Public probes omit Authorization. If a controller supplies
                # one, readiness must also prove the rotated capability.
                if self.headers.get("Authorization") and not self.service.authorized(
                    self.headers.get("Authorization")
                ):
                    raise WorkerError("worker authentication failed", HTTPStatus.UNAUTHORIZED)
                self._send_json(HTTPStatus.OK, self.service.health())
                return
            self._require_auth()
            checkpoint_match = CHECKPOINT_ROUTE.fullmatch(self.path)
            if checkpoint_match:
                data, metadata = self.service.checkpoint(
                    checkpoint_match.group(1), int(checkpoint_match.group(2))
                )
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Checkpoint-SHA256", metadata["sha256"])
                self.end_headers()
                self.wfile.write(data)
                return
            job_match = JOB_ROUTE.fullmatch(self.path)
            if job_match:
                self._send_json(HTTPStatus.OK, self.service.job_status(job_match.group(1)))
                return
            raise WorkerError("worker route was not found", HTTPStatus.NOT_FOUND)
        except Exception as error:
            self._send_error(error)

    def do_POST(self) -> None:
        try:
            body = self._body(MAX_JSON_BODY)
            if self.path == "/v1/handshake":
                idempotency = validate_idempotency_key(self.headers.get("Idempotency-Key"))
                response = self.service.handshake(
                    self.headers.get("Authorization"),
                    idempotency,
                    parse_json_body(body, MAX_JSON_BODY),
                )
                self._send_json(HTTPStatus.OK, response)
                return
            self._require_mutation(body)
            if self.path == "/v1/jobs":
                response = self.service.create_job(parse_json_body(body, MAX_MANIFEST_BYTES))
                self._send_json(HTTPStatus.CREATED, response)
                return
            start_match = START_ROUTE.fullmatch(self.path)
            if start_match:
                if parse_json_body(body, MAX_JSON_BODY) != {}:
                    raise WorkerError("start body must be an empty object")
                self._send_json(HTTPStatus.ACCEPTED, self.service.start_job(start_match.group(1)))
                return
            cancel_match = CANCEL_ROUTE.fullmatch(self.path)
            if cancel_match:
                if parse_json_body(body, MAX_JSON_BODY) != {}:
                    raise WorkerError("cancel body must be an empty object")
                self._send_json(HTTPStatus.ACCEPTED, self.service.cancel_job(cancel_match.group(1)))
                return
            ack_match = ACK_ROUTE.fullmatch(self.path)
            if ack_match:
                payload = parse_json_body(body, MAX_JSON_BODY)
                if not isinstance(payload, dict) or set(payload) != {"sha256"}:
                    raise WorkerError("checkpoint acknowledgement body is invalid")
                response = self.service.acknowledge_checkpoint(
                    ack_match.group(1), int(ack_match.group(2)), payload["sha256"]
                )
                self._send_json(HTTPStatus.OK, response)
                return
            raise WorkerError("worker route was not found", HTTPStatus.NOT_FOUND)
        except Exception as error:
            self._send_error(error)

    def do_PUT(self) -> None:
        try:
            part_match = PART_ROUTE.fullmatch(self.path)
            if not part_match:
                raise WorkerError("worker route was not found", HTTPStatus.NOT_FOUND)
            body = self._body(MAX_PART_BYTES)
            self._require_mutation(body)
            response = self.service.upload_part(
                part_match.group(1),
                int(part_match.group(2)),
                body,
                self.headers.get("X-Chunk-SHA256", ""),
            )
            self._send_json(HTTPStatus.OK, response)
        except Exception as error:
            self._send_error(error)


class GlimmerWorkerServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: Tuple[str, int], service: WorkerService):
        self._request_slots = threading.BoundedSemaphore(MAX_CONCURRENT_REQUESTS)
        super().__init__(address, WorkerRequestHandler)
        self.service = service

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self._request_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._request_slots.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._request_slots.release()


def _model_ready(url: str, ready_marker: Path) -> bool:
    from urllib.error import HTTPError, URLError
    from urllib.request import Request, urlopen

    try:
        marker = ready_marker.lstat()
        if not stat.S_ISREG(marker.st_mode) or marker.st_nlink != 1:
            return False
        with urlopen(Request(url, headers={"Accept": "application/json"}), timeout=2) as response:
            return 200 <= response.status < 300
    except (FileNotFoundError, HTTPError, URLError, TimeoutError, OSError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Muse Glimmer RunPod worker")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=WORKER_PORT)
    parser.add_argument("--state-root", default="/run/glimmer-worker")
    parser.add_argument("--recovery-root", default="/workspace/recovery")
    parser.add_argument("--health-url", default="http://127.0.0.1:8080/health")
    parser.add_argument("--ready-marker", default="/run/glimmer-worker/model.ready")
    args = parser.parse_args()
    if args.host != "0.0.0.0" or args.port != WORKER_PORT:
        raise SystemExit("production worker must bind 0.0.0.0:4318")
    bootstrap = os.environ.pop("GLIMMER_WORKER_BOOTSTRAP_TOKEN", "")
    build_id = os.environ.get("GLIMMER_WORKER_BUILD_ID", "unverified")
    context = int(os.environ.get("GLIMMER_CONTEXT_TOKENS", "65536"))
    bootstrap_status_file = os.environ.pop("GLIMMER_BOOTSTRAP_STATUS_FILE", "")
    bootstrap_lease_id = os.environ.pop("GLIMMER_LEASE_ID", "")
    require_coordinator = os.environ.get("GLIMMER_REQUIRE_COORDINATOR_CALLBACK") == "1"
    callback_endpoint = os.environ.pop("GLIMMER_COORDINATOR_CALLBACK_URL", "")
    callback_token = os.environ.pop("GLIMMER_COORDINATOR_CALLBACK_TOKEN", "")
    try:
        activity_callback = (
            CoordinatorActivityReporter(callback_endpoint, callback_token)
            if require_coordinator
            else None
        )
    except CallbackError as exc:
        raise SystemExit("coordinator callback configuration is invalid") from exc
    if not bootstrap_status_file or not bootstrap_lease_id:
        raise SystemExit("bootstrap diagnostics are required")
    service = WorkerService(
        Path(args.state_root),
        Path(args.recovery_root),
        bootstrap,
        build_id,
        context,
        lambda: _model_ready(args.health_url, Path(args.ready_marker)),
        bootstrap_status_path=Path(bootstrap_status_file),
        bootstrap_lease_id=bootstrap_lease_id,
        activity_callback=activity_callback,
    )
    server = GlimmerWorkerServer((args.host, args.port), service)
    print(canonical_json_bytes({"event": "worker_listening", "port": args.port}).decode("utf-8"))
    server.serve_forever(poll_interval=0.5)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
