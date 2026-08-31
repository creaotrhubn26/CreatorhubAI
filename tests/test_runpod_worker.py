import hashlib
import http.client
import io
import json
import tarfile
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock
from urllib import request

from docker.runpod import bootstrap_status
from glimmer_remote import decrypt_checkpoint, parse_remote_job_manifest, request_signature
from runpod_worker import (
    GlimmerWorkerServer,
    ProcessJobRunner,
    RunningProcess,
    WorkerError,
    WorkerService,
    _model_ready,
)

LEASE_ID = "12345678-1234-4234-9234-123456789abc"


def manifest(data=b"bundle", **changes):
    payload = {
        "schemaVersion": 1,
        "instanceId": "control-1",
        "sessionId": "session-1",
        "jobId": "job-1",
        "repositoryFingerprint": "a" * 64,
        "baselineSha": "b" * 40,
        "branch": "glimmer/remote-job-1",
        "objective": "Implement the bounded change",
        "contextTokens": 65_536,
        "maxRepairs": 2,
        "timeoutSeconds": 1200,
        "createdAt": "2026-08-29T10:00:00Z",
        "input": {
            "format": "git_bundle",
            "parts": 1,
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        },
    }
    payload.update(changes)
    return payload


class FakeRunner:
    def __init__(self):
        self.started = []
        self.cancelled = False

    def start(self, job_dir, parsed, completed):
        self.started.append((job_dir, parsed))

        def finish():
            time.sleep(0.01)
            workspace = job_dir / "workspace"
            session = job_dir / "session"
            workspace.mkdir(mode=0o700)
            session.mkdir(mode=0o700)
            (session / "task-report.json").write_text('{"version":2}', encoding="utf-8")
            completed(0, workspace, session)

        threading.Thread(target=finish, daemon=True).start()
        return RunningProcess(process=None, log_handle=None)  # type: ignore[arg-type]

    def cancel(self, _running):
        self.cancelled = True


class WorkerServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.runner = FakeRunner()
        self.bootstrap_path = root / "recovery" / "bootstrap" / LEASE_ID / "status.json"
        (root / "recovery").mkdir(mode=0o700)
        bootstrap_status.initialize(self.bootstrap_path, LEASE_ID)
        bootstrap_status.transition(self.bootstrap_path, LEASE_ID, "worker_starting")
        self.service = WorkerService(
            root / "state",
            root / "recovery",
            "bootstrap-secret",
            "build-abc",
            65_536,
            lambda: True,
            runner=self.runner,
            bootstrap_status_path=self.bootstrap_path,
            bootstrap_lease_id=LEASE_ID,
        )

    def tearDown(self):
        self.temporary.cleanup()

    def handshake(self):
        return self.service.handshake(
            "Bearer bootstrap-secret",
            "handshake-1",
            {"controllerInstanceId": "control-1", "nonce": "abcdefghijklmnop"},
        )

    def test_health_is_secret_free_and_handshake_rotates_idempotently(self):
        health = self.service.health()
        self.assertEqual(health["schemaVersion"], 2)
        self.assertFalse(health["ready"])
        self.assertEqual(health["bootstrap"]["stage"], "worker_starting")
        self.assertNotIn("leaseId", health["bootstrap"])
        self.assertNotIn("bootstrap-secret", json.dumps(health))

        first = self.handshake()
        second = self.handshake()
        self.assertEqual(first, second)
        self.assertTrue(self.service.health()["ready"])
        self.assertNotIn("bootstrap-secret", json.dumps(first))
        with self.assertRaisesRegex(WorkerError, "already consumed"):
            self.service.handshake(
                "Bearer bootstrap-secret",
                "different-key",
                {"controllerInstanceId": "control-1", "nonce": "abcdefghijklmnop"},
            )

    def test_tampered_bootstrap_status_is_sanitized_and_never_controls_readiness(self):
        bootstrap_status.transition(
            self.bootstrap_path,
            LEASE_ID,
            "ready",
            "ready",
        )
        reported = self.service.health()
        self.assertEqual(reported["bootstrap"]["stage"], "ready")
        self.assertFalse(reported["ready"])

        self.bootstrap_path.write_text(
            json.dumps({"detail": "bootstrap-secret https://private.invalid"}),
            encoding="utf-8",
        )
        sanitized = self.service.health()
        self.assertEqual(
            sanitized["bootstrap"]["failureCode"], "status_persistence_failed"
        )
        self.assertEqual(sanitized["bootstrap"]["exitCode"], 6)
        self.assertNotIn("bootstrap-secret", json.dumps(sanitized))
        self.assertNotIn("private.invalid", json.dumps(sanitized))

    def test_health_stays_bootstrapping_after_handshake_until_model_is_ready(self):
        ready = False
        root = Path(self.temporary.name)
        service = WorkerService(
            root / "boot-state",
            root / "boot-recovery",
            "boot-token",
            "build-abc",
            65_536,
            lambda: ready,
            runner=self.runner,
        )
        service.handshake(
            "Bearer boot-token",
            "boot-handshake",
            {"controllerInstanceId": "control-1", "nonce": "abcdefghijklmnop"},
        )

        bootstrapping = service.health()
        self.assertFalse(bootstrapping["ready"])
        self.assertFalse(bootstrapping["model"]["ready"])
        self.assertEqual(bootstrapping["workerState"], "bootstrapping")

        service.jobs["early-job"] = {"state": "created"}
        self.assertEqual(service.health()["workerState"], "bootstrapping")

        ready = True
        self.assertEqual(service.health()["workerState"], "busy")
        service.jobs.clear()
        running = service.health()
        self.assertTrue(running["ready"])
        self.assertTrue(running["model"]["ready"])
        self.assertEqual(running["workerState"], "ready")

    def test_start_job_fails_closed_until_model_gate_is_ready(self):
        ready = False
        root = Path(self.temporary.name)
        service = WorkerService(
            root / "guard-state",
            root / "guard-recovery",
            "guard-token",
            "build-abc",
            65_536,
            lambda: ready,
            runner=self.runner,
        )
        service.handshake(
            "Bearer guard-token",
            "guard-handshake",
            {"controllerInstanceId": "control-1", "nonce": "abcdefghijklmnop"},
        )
        body = b"bundle"
        service.create_job(manifest(body))
        service.upload_part("job-1", 0, body, hashlib.sha256(body).hexdigest())

        with self.assertRaisesRegex(WorkerError, "model is not ready") as failure:
            service.start_job("job-1")
        self.assertEqual(failure.exception.status, 503)
        self.assertEqual(service.job_status("job-1")["state"], "uploading")

        ready = True
        self.assertEqual(service.start_job("job-1")["state"], "running")
        deadline = time.time() + 2
        while service.job_status("job-1")["state"] == "running" and time.time() < deadline:
            time.sleep(0.02)
        self.assertEqual(service.job_status("job-1")["state"], "succeeded")

    def test_upload_start_encrypted_checkpoint_and_ack(self):
        handshake = self.handshake()
        body = b"bundle"
        created = self.service.create_job(manifest(body))
        self.assertEqual(created["state"], "created")
        uploaded = self.service.upload_part("job-1", 0, body, hashlib.sha256(body).hexdigest())
        self.assertEqual(uploaded["receivedParts"], 1)
        duplicate = self.service.upload_part("job-1", 0, body, hashlib.sha256(body).hexdigest())
        self.assertEqual(duplicate["receivedParts"], 1)
        self.service.start_job("job-1")

        deadline = time.time() + 2
        status = self.service.job_status("job-1")
        while status["state"] == "running" and time.time() < deadline:
            time.sleep(0.02)
            status = self.service.job_status("job-1")
        self.assertEqual(status["state"], "succeeded")
        self.assertGreaterEqual(len(status["checkpoints"]), 1)

        encrypted, metadata = self.service.checkpoint("job-1", 0)
        key = __import__("base64").urlsafe_b64decode(
            handshake["checkpointKey"] + "=" * (-len(handshake["checkpointKey"]) % 4)
        )
        aad = {
            name: metadata[name]
            for name in (
                "schemaVersion",
                "jobId",
                "sessionId",
                "sequence",
                "kind",
                "final",
                "plaintextSha256",
            )
        }
        plaintext = decrypt_checkpoint(key, encrypted, aad)
        with tarfile.open(fileobj=io.BytesIO(plaintext), mode="r:") as archive:
            self.assertIn("result.json", archive.getnames())
            self.assertIn("session/task-report.json", archive.getnames())
        acknowledged = self.service.acknowledge_checkpoint("job-1", 0, metadata["sha256"])
        self.assertTrue(acknowledged["checkpoints"][0]["acknowledged"])
        with self.assertRaisesRegex(WorkerError, "not found"):
            self.service.checkpoint("job-1", 0)

    def test_reports_busy_then_ready_without_affecting_the_result(self):
        root = Path(self.temporary.name)
        activity = []
        service = WorkerService(
            root / "activity-state",
            root / "activity-recovery",
            "activity-token",
            "build-abc",
            65_536,
            lambda: True,
            runner=self.runner,
            activity_callback=activity.append,
        )
        service.handshake(
            "Bearer activity-token",
            "activity-handshake",
            {"controllerInstanceId": "control-1", "nonce": "abcdefghijklmnop"},
        )
        body = b"bundle"
        service.create_job(manifest(body))
        service.upload_part("job-1", 0, body, hashlib.sha256(body).hexdigest())
        service.start_job("job-1")

        deadline = time.time() + 2
        while service.job_status("job-1")["state"] == "running" and time.time() < deadline:
            time.sleep(0.02)

        self.assertEqual(service.job_status("job-1")["state"], "succeeded")
        self.assertEqual(activity, ["busy", "ready"])

    def test_rejects_bad_parts_and_a_second_active_job(self):
        self.handshake()
        self.service.create_job(manifest())
        with self.assertRaisesRegex(WorkerError, "checksum does not match"):
            self.service.upload_part("job-1", 0, b"bundle", "0" * 64)
        with self.assertRaisesRegex(WorkerError, "active job"):
            self.service.create_job(
                manifest(
                    jobId="job-2",
                    sessionId="session-2",
                    branch="glimmer/remote-job-2",
                )
            )

    def test_idempotency_key_cannot_be_rebound_to_another_mutation(self):
        self.service.register_idempotency("mutation-1", "POST", "/v1/jobs", b"one")
        self.service.register_idempotency("mutation-1", "POST", "/v1/jobs", b"one")
        with self.assertRaisesRegex(WorkerError, "different mutation"):
            self.service.register_idempotency("mutation-1", "POST", "/v1/jobs/job-1/start", b"{}")


class ProcessJobRunnerTests(unittest.TestCase):
    def test_uses_bundled_engineer_and_job_scoped_session_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            orchestrator = root / "orchestrator"
            job_dir = root / "job"
            workspace = job_dir / "workspace"
            orchestrator.mkdir()
            job_dir.mkdir()
            workspace.mkdir()
            for name in ("glimmer-v2.py", "glimmer-engineer.py"):
                (orchestrator / name).write_text("# fixture\n", encoding="utf-8")
            process = mock.Mock()
            process.wait.return_value = 0
            process.pid = 123
            runner = ProcessJobRunner(orchestrator, python="/usr/bin/python3")
            with (
                mock.patch.object(runner, "_prepare_workspace", return_value=workspace),
                mock.patch("runpod_worker.subprocess.Popen", return_value=process) as popen,
                mock.patch.dict(
                    "runpod_worker.os.environ",
                    {
                        "GLIMMER_COORDINATOR_CALLBACK_TOKEN": "secret-callback",
                        "RUNPOD_API_KEY": "secret-provider",
                    },
                    clear=False,
                ),
            ):
                runner.start(
                    job_dir,
                    parse_remote_job_manifest(manifest()),
                    lambda *_: None,
                )
            argv = popen.call_args.args[0]
            environment = popen.call_args.kwargs["env"]
            self.assertEqual(
                argv[argv.index("--engineer") + 1],
                str(orchestrator.resolve() / "glimmer-engineer.py"),
            )
            self.assertEqual(environment["GLIMMER_STATE_ROOT"], str(job_dir))
            self.assertNotIn("GLIMMER_EVENTS_PATH", environment)
            self.assertNotIn("GLIMMER_COORDINATOR_CALLBACK_TOKEN", environment)
            self.assertNotIn("RUNPOD_API_KEY", environment)
            self.assertNotIn("secret-callback", json.dumps(environment))


class ModelReadinessGateTests(unittest.TestCase):
    class HealthyResponse:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def test_shallow_llama_health_cannot_bypass_the_strong_ready_marker(self):
        with tempfile.TemporaryDirectory() as temporary:
            marker = Path(temporary) / "model.ready"
            with mock.patch.object(
                request, "urlopen", return_value=self.HealthyResponse()
            ) as urlopen:
                self.assertFalse(_model_ready("http://127.0.0.1:8080/health", marker))
                urlopen.assert_not_called()

                marker.write_text("", encoding="utf-8")
                self.assertTrue(_model_ready("http://127.0.0.1:8080/health", marker))
                urlopen.assert_called_once()

                marker.unlink()
                marker.symlink_to(Path(temporary) / "missing")
                self.assertFalse(_model_ready("http://127.0.0.1:8080/health", marker))


class WorkerHttpContractTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        bootstrap_path = root / "recovery" / "bootstrap" / LEASE_ID / "status.json"
        (root / "recovery").mkdir(mode=0o700)
        bootstrap_status.initialize(bootstrap_path, LEASE_ID)
        bootstrap_status.transition(bootstrap_path, LEASE_ID, "worker_listening")
        self.service = WorkerService(
            root / "state",
            root / "recovery",
            "bootstrap-secret",
            "build-abc",
            65_536,
            lambda: True,
            runner=FakeRunner(),
            bootstrap_status_path=bootstrap_path,
            bootstrap_lease_id=LEASE_ID,
        )
        self.server = GlimmerWorkerServer(("127.0.0.1", 0), self.service)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary.cleanup()

    def request(self, method, path, body=b"", headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        data = response.read()
        result_headers = dict(response.getheaders())
        connection.close()
        return response.status, result_headers, data

    def test_public_health_then_authenticated_signed_job_create(self):
        status, _, body = self.request("GET", "/v1/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["schemaVersion"], 2)
        self.assertEqual(json.loads(body)["bootstrap"]["stage"], "worker_listening")
        self.assertNotIn(b"secret", body.lower())
        invalid, _, _ = self.request("GET", "/v1/health", headers={"Authorization": "Bearer wrong"})
        self.assertEqual(invalid, 401)

        handshake_body = json.dumps(
            {"controllerInstanceId": "control-1", "nonce": "abcdefghijklmnop"}
        ).encode()
        status, _, response_body = self.request(
            "POST",
            "/v1/handshake",
            handshake_body,
            {
                "Authorization": "Bearer bootstrap-secret",
                "Idempotency-Key": "handshake-1",
                "Content-Type": "application/json",
            },
        )
        self.assertEqual(status, 200)
        capability = json.loads(response_body)["capability"].encode()
        proven, _, _ = self.request(
            "GET",
            "/v1/health",
            headers={"Authorization": f"Bearer {capability.decode()}"},
        )
        self.assertEqual(proven, 200)

        job_body = json.dumps(manifest(), sort_keys=True, separators=(",", ":")).encode()
        unauthorized, _, error = self.request("POST", "/v1/jobs", job_body)
        self.assertEqual(unauthorized, 401)
        self.assertNotIn(b"bootstrap-secret", error)

        idempotency = "job-create-1"
        signature = request_signature(capability, "POST", "/v1/jobs", idempotency, job_body)
        created, _, created_body = self.request(
            "POST",
            "/v1/jobs",
            job_body,
            {
                "Authorization": f"Bearer {capability.decode()}",
                "Idempotency-Key": idempotency,
                "X-Glimmer-Signature": f"sha256={signature}",
                "Content-Type": "application/json",
            },
        )
        self.assertEqual(created, 201, created_body)
        self.assertEqual(json.loads(created_body)["jobId"], "job-1")


if __name__ == "__main__":
    unittest.main()
