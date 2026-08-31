import base64
import hashlib
import json
import os
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from docker.runpod import cache_manifest

ROOT = Path(__file__).resolve().parent.parent
ENTRYPOINT = ROOT / "docker" / "runpod" / "entrypoint.sh"
BOOTSTRAP_STATUS = ROOT / "docker" / "runpod" / "bootstrap_status.py"
CACHE_MANIFEST = ROOT / "docker" / "runpod" / "cache_manifest.py"
LEASE_ID = "12345678-1234-4234-9234-123456789abc"


class EntrypointStaticContractTests(unittest.TestCase):
    def test_listener_and_cleanup_are_installed_before_artifact_downloads(self):
        source = ENTRYPOINT.read_text(encoding="utf-8")
        worker_start = source.index("/opt/glimmer/runpod_worker.py")
        first_download = source.index("run_download --url")
        self.assertLess(source.index("trap cleanup EXIT"), first_download)
        self.assertLess(worker_start, first_download)
        self.assertLess(source.index('python3 - "$MODEL_KEY" "$MODEL_CONFIG"'), worker_start)
        self.assertLess(source.index('export GLIMMER_API_KEY_FILE="$MODEL_KEY"'), worker_start)
        self.assertLess(source.index('export GLIMMER_MODEL_CONFIG="$MODEL_CONFIG"'), worker_start)
        self.assertLess(source.index("export GLIMMER_URL="), worker_start)
        self.assertIn('local pids=("$DOWNLOAD_PID" "$LLAMA_PID" "$WORKER_PID")', source)
        self.assertIn('kill -KILL "$pid"', source)
        self.assertIn('"workerState") == "bootstrapping"', source)
        self.assertIn('MODEL_PATH="$MODEL_ROOT/model.$GLIMMER_MODEL_SHA256.gguf"', source)
        self.assertIn('MMPROJ_PATH="$MODEL_ROOT/mmproj.$GLIMMER_MMPROJ_SHA256.gguf"', source)
        self.assertIn('DFLASH_PATH="$MODEL_ROOT/dflash.$GLIMMER_DFLASH_SHA256.gguf"', source)
        self.assertIn('PREWARM_ONLY="${GLIMMER_PREWARM_ONLY:-0}"', source)
        self.assertIn('REQUIRE_READY_CACHE="${GLIMMER_REQUIRE_READY_CACHE:-0}"', source)
        self.assertIn('python3 "$CACHE_MANIFEST_TOOL" verify', source)
        self.assertIn('GLIMMER_CACHE_SIGNING_PRIVATE_KEY="$CACHE_SIGNING_PRIVATE_KEY"', source)
        self.assertIn("BOOTSTRAP_FAILURE_CODE=cache_not_ready", source)
        self.assertIn('BOOTSTRAP_STATUS_FILE="$RECOVERY_ROOT/bootstrap/$GLIMMER_LEASE_ID/status.json"', source)
        self.assertLess(
            source.index("docker/runpod/healthcheck.py"),
            source.index('touch "$READY_MARKER"'),
        )
        subprocess.run(["bash", "-n", ENTRYPOINT], check=True)


class EntrypointBehaviorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.events = self.root / "events.log"
        self.process = None
        private_key = Ed25519PrivateKey.generate()
        self.private_key = base64.urlsafe_b64encode(
            private_key.private_bytes(
                encoding=serialization.Encoding.Raw,
                format=serialization.PrivateFormat.Raw,
                encryption_algorithm=serialization.NoEncryption(),
            )
        ).decode("ascii").rstrip("=")
        self.public_key = base64.urlsafe_b64encode(
            private_key.public_key().public_bytes(
                encoding=serialization.Encoding.Raw,
                format=serialization.PublicFormat.Raw,
            )
        ).decode("ascii").rstrip("=")

    def tearDown(self):
        if self.process is not None and self.process.poll() is None:
            self.process.kill()
            self.process.wait(timeout=5)
        self.temporary.cleanup()

    @staticmethod
    def _write_executable(path, source):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source, encoding="utf-8")
        path.chmod(0o755)

    def _prepare(
        self,
        download_mode,
        worker_mode="hold",
        prewarm=False,
        expected_build_id="r2-abcdef012345",
        preexisting_marker=False,
        require_ready=False,
        ready_cache=False,
        omit_artifact_urls=False,
    ):
        state = self.root / "state"
        models = self.root / "models"
        recovery = self.root / "recovery"
        app = self.root / "opt" / "glimmer"
        bin_root = self.root / "bin"
        source = ENTRYPOINT.read_text(encoding="utf-8")
        replacements = {
            "STATE_ROOT=/run/glimmer-worker": f"STATE_ROOT={shlex.quote(str(state))}",
            "MODEL_ROOT=/workspace/models": f"MODEL_ROOT={shlex.quote(str(models))}",
            "/workspace/recovery": str(recovery),
            "/opt/glimmer": str(app),
            "sleep 5": "sleep 0.3",
        }
        for old, new in replacements.items():
            self.assertIn(old, source)
            source = source.replace(old, new)
        script = self.root / "entrypoint.sh"
        self._write_executable(script, source)
        self._write_executable(
            app / "docker" / "runpod" / "bootstrap_status.py",
            BOOTSTRAP_STATUS.read_text(encoding="utf-8"),
        )
        self._write_executable(
            app / "docker" / "runpod" / "cache_manifest.py",
            CACHE_MANIFEST.read_text(encoding="utf-8"),
        )
        if preexisting_marker:
            state.mkdir(parents=True, exist_ok=True)
            (state / "model.ready").write_text("stale", encoding="utf-8")

        self._write_executable(
            bin_root / "gosu",
            '#!/usr/bin/env bash\nset -euo pipefail\nshift\nexec "$@"\n',
        )
        self._write_executable(
            bin_root / "install",
            """#!/usr/bin/env bash
set -euo pipefail
mode=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -d) shift ;;
    -o|-g) shift 2 ;;
    -m) mode="$2"; shift 2 ;;
    *) mkdir -p "$1"; if [ -n "$mode" ]; then chmod "$mode" "$1"; fi; shift ;;
  esac
done
""",
        )
        self._write_executable(bin_root / "chown", "#!/usr/bin/env bash\nexit 0\n")
        self._write_executable(
            bin_root / "ps",
            """#!/usr/bin/env bash
set -euo pipefail
pid="${@: -1}"
if grep -Eq "^(worker_exit|download_exit|download_term):$pid$" "$TEST_EVENTS" 2>/dev/null; then
  echo Z
else
  echo S
fi
""",
        )
        self._write_executable(
            bin_root / "python3",
            """#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = "-c" ]; then
  case "${2:-}" in
    *127.0.0.1:4318/v1/health*) grep -q '^worker_listening:' "$TEST_EVENTS"; exit ;;
  esac
fi
exec "$TEST_REAL_PYTHON" "$@"
""",
        )

        self._write_executable(
            app / "runpod_worker.py",
            """#!/usr/bin/env python3
import json
import os
import signal
import time
from pathlib import Path

events = os.environ["TEST_EVENTS"]
def record(value):
    with open(events, "a", encoding="utf-8") as output:
        output.write(value + "\\n")
def stop(_signal, _frame):
    record(f"worker_term:{os.getpid()}")
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
key = Path(os.environ.get("GLIMMER_API_KEY_FILE", ""))
config = Path(os.environ.get("GLIMMER_MODEL_CONFIG", ""))
valid_environment = False
if key.is_file() and config.is_file() and os.environ.get("GLIMMER_URL") == "http://127.0.0.1:8080":
    value = json.loads(config.read_text(encoding="utf-8"))
    valid_environment = value["models"][0]["apiKeyFile"] == str(key)
record(f"worker_env_ready:{int(valid_environment)}")
record(f"worker_marker_at_start:{int((key.parent / 'model.ready').exists())}")
record(f"worker_listening:{os.getpid()}")
worker_mode = os.environ["TEST_WORKER_MODE"]
if worker_mode == "exit_during_download":
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if Path(events).exists() and "download_start:" in Path(events).read_text(encoding="utf-8"):
            break
        time.sleep(0.02)
    else:
        record(f"worker_download_wait_timeout:{os.getpid()}")
        raise SystemExit(10)
    record(f"worker_exit:{os.getpid()}")
    raise SystemExit(9)
if worker_mode == "exit_during_llama":
    while "llama_start:" not in Path(events).read_text(encoding="utf-8"):
        time.sleep(0.02)
    record(f"worker_exit:{os.getpid()}")
    raise SystemExit(9)
while True:
    time.sleep(0.1)
""",
        )
        self._write_executable(
            app / "docker" / "runpod" / "fetch_artifact.py",
            """#!/usr/bin/env python3
import os
import signal
import sys
import time
from pathlib import Path

events = os.environ["TEST_EVENTS"]
output = Path(sys.argv[sys.argv.index("--output") + 1])
def record(value):
    with open(events, "a", encoding="utf-8") as stream:
        stream.write(value + "\\n")
def stop(_signal, _frame):
    record(f"download_term:{os.getpid()}")
    raise SystemExit(143)
mode = os.environ["TEST_DOWNLOAD_MODE"]
signal.signal(signal.SIGTERM, signal.SIG_IGN if mode == "ignore" else stop)
record(f"download_start:{os.getpid()}:{output.name}")
record(f"download_private_key:{int(bool(os.environ.get('GLIMMER_CACHE_SIGNING_PRIVATE_KEY')))}")
if mode in {"hold", "ignore"}:
    while True:
        time.sleep(0.1)
if mode == "checksum_failure":
    raise SystemExit(20)
if mode == "download_failure":
    raise SystemExit(21)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_bytes(b"fixture")
record(f"download_exit:{os.getpid()}")
""",
        )
        self._write_executable(
            app / "bin" / "llama-server",
            """#!/usr/bin/env python3
import os
import signal
import time

events = os.environ["TEST_EVENTS"]
def record(value):
    with open(events, "a", encoding="utf-8") as output:
        output.write(value + "\\n")
def stop(_signal, _frame):
    record(f"llama_term:{os.getpid()}")
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
record(f"llama_start:{os.getpid()}")
while True:
    time.sleep(0.1)
""",
        )
        self._write_executable(
            app / "docker" / "runpod" / "healthcheck.py",
            """#!/usr/bin/env python3
import os
from pathlib import Path

events = Path(os.environ["TEST_EVENTS"])
if os.environ["TEST_WORKER_MODE"] == "exit_during_llama":
    raise SystemExit(1)
raise SystemExit(0 if "llama_start:" in events.read_text(encoding="utf-8") else 1)
""",
        )

        fixture_digest = hashlib.sha256(b"fixture").hexdigest()
        hashes = {
            "model": fixture_digest if require_ready else "a" * 64,
            "mmproj": fixture_digest if require_ready else "b" * 64,
            "draft": fixture_digest if require_ready else "c" * 64,
        }
        environment = {
            **os.environ,
            "PATH": f"{bin_root}:{os.environ.get('PATH', '')}",
            "TEST_EVENTS": str(self.events),
            "TEST_REAL_PYTHON": sys.executable,
            "TEST_DOWNLOAD_MODE": download_mode,
            "TEST_WORKER_MODE": worker_mode,
            "GLIMMER_WORKER_BOOTSTRAP_TOKEN": "fixture-bootstrap",
            "GLIMMER_MODEL_URL": "https://artifacts.example/model.gguf",
            "GLIMMER_MODEL_SHA256": hashes["model"],
            "GLIMMER_MMPROJ_URL": "https://artifacts.example/mmproj.gguf",
            "GLIMMER_MMPROJ_SHA256": hashes["mmproj"],
            "GLIMMER_DFLASH_URL": "https://artifacts.example/dflash.gguf",
            "GLIMMER_DFLASH_SHA256": hashes["draft"],
            "GLIMMER_ARTIFACT_HOSTS": "artifacts.example",
            "GLIMMER_CONTEXT_TOKENS": "65536",
            "GLIMMER_LEASE_ID": LEASE_ID,
            "GLIMMER_WORKER_BUILD_ID": "r2-abcdef012345",
        }
        if prewarm:
            environment["GLIMMER_PREWARM_ONLY"] = "1"
            environment["GLIMMER_PREWARM_EXPECTED_BUILD_ID"] = expected_build_id
            environment.pop("GLIMMER_WORKER_BOOTSTRAP_TOKEN")
        if require_ready:
            environment["GLIMMER_REQUIRE_READY_CACHE"] = "1"
            environment["GLIMMER_CACHE_VOLUME_ID"] = "rp5asg2b9x"
            if prewarm:
                environment["GLIMMER_CACHE_SIGNING_PRIVATE_KEY"] = self.private_key
            else:
                environment["GLIMMER_CACHE_SIGNING_PUBLIC_KEY"] = self.public_key
        if omit_artifact_urls:
            for name in (
                "GLIMMER_MODEL_URL",
                "GLIMMER_MMPROJ_URL",
                "GLIMMER_DFLASH_URL",
                "GLIMMER_ARTIFACT_HOSTS",
            ):
                environment.pop(name)
        if ready_cache:
            self.assertTrue(require_ready and not prewarm)
            models.mkdir(parents=True, exist_ok=True, mode=0o700)
            for expected in cache_manifest._expectations(hashes):
                (models / expected.name).write_bytes(b"fixture")
            cache_manifest.publish(
                models,
                "rp5asg2b9x",
                "r2-abcdef012345",
                hashes,
                self.private_key,
            )
        self.process = subprocess.Popen(
            ["bash", str(script)],
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        return state

    def _wait_for(self, expected, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            events = self.events.read_text(encoding="utf-8") if self.events.exists() else ""
            if expected(events):
                return events.splitlines()
            if self.process.poll() is not None:
                stdout, stderr = self.process.communicate()
                self.fail(f"entrypoint exited early ({self.process.returncode}): {stdout} {stderr}")
            time.sleep(0.02)
        self.fail("timed out waiting for entrypoint fixture event")

    def _terminate(self):
        self.process.send_signal(signal.SIGTERM)
        self.process.communicate(timeout=8)
        self.assertEqual(self.process.returncode, 143)

    def test_listener_precedes_download_and_interrupt_kills_both_processes(self):
        self._prepare("hold")
        events = self._wait_for(lambda value: "download_start:" in value)
        listener_index = next(
            i for i, value in enumerate(events) if value.startswith("worker_listening:")
        )
        download_index = next(
            i for i, value in enumerate(events) if value.startswith("download_start:")
        )
        self.assertLess(listener_index, download_index)
        self.assertIn("worker_env_ready:1", events)
        self.assertIn("worker_marker_at_start:0", events)

        self._terminate()

        final_events = self.events.read_text(encoding="utf-8")
        self.assertIn("worker_term:", final_events)
        self.assertIn("download_term:", final_events)
        status = json.loads(
            (
                self.root / "recovery" / "bootstrap" / LEASE_ID / "status.json"
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(status["failureCode"], "bootstrap_interrupted")
        self.assertEqual(status["exitCode"], 143)
        self.assertEqual(status["artifact"]["kind"], "model")
        self.assertNotIn("fixture-bootstrap", json.dumps(status))
        self.assertNotIn("artifacts.example", json.dumps(status))

    def test_ready_boot_sequence_cleanup_kills_llama_and_worker(self):
        state = self._prepare("complete")
        events = self._wait_for(
            lambda value: value.count("download_start:") == 3 and "llama_start:" in value
        )
        self.assertLess(
            next(i for i, value in enumerate(events) if value.startswith("worker_listening:")),
            next(i for i, value in enumerate(events) if value.startswith("download_start:")),
        )
        self._wait_for(lambda _value: (state / "model.ready").exists())

        self._terminate()

        final_events = self.events.read_text(encoding="utf-8")
        self.assertIn("worker_term:", final_events)
        self.assertIn("llama_term:", final_events)
        status = json.loads(
            (
                self.root / "recovery" / "bootstrap" / LEASE_ID / "status.json"
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(status["stage"], "ready")
        self.assertEqual(status["outcome"], "ready")

    def test_cpu_prewarm_rejects_a_mismatched_build_before_download_or_ready_marker(self):
        state = self._prepare(
            "complete",
            prewarm=True,
            expected_build_id="r2-000000000000",
            preexisting_marker=True,
        )
        stdout, stderr = self.process.communicate(timeout=8)

        self.assertEqual(self.process.returncode, 2, (stdout, stderr))
        self.assertEqual(stdout, "")
        events = self.events.read_text(encoding="utf-8") if self.events.exists() else ""
        self.assertNotIn("download_start:", events)
        self.assertNotIn("worker_listening:", events)
        self.assertNotIn("llama_start:", events)
        self.assertFalse((state / "model.ready").exists())
        status_path = self.root / "recovery" / "bootstrap" / LEASE_ID / "status.json"
        status = json.loads(status_path.read_text(encoding="utf-8"))
        self.assertEqual(status["failureCode"], "configuration_invalid")
        self.assertEqual(status["exitCode"], 2)

    def test_cpu_prewarm_downloads_all_artifacts_without_worker_llama_or_bootstrap_token(self):
        self._prepare("complete", prewarm=True)
        stdout, stderr = self.process.communicate(timeout=8)

        self.assertEqual(self.process.returncode, 0, (stdout, stderr))
        events = self.events.read_text(encoding="utf-8")
        self.assertEqual(events.count("download_start:"), 3)
        self.assertNotIn("worker_listening:", events)
        self.assertNotIn("llama_start:", events)
        status_path = self.root / "recovery" / "bootstrap" / LEASE_ID / "status.json"
        status = json.loads(status_path.read_text(encoding="utf-8"))
        self.assertEqual(status["stage"], "ready")
        self.assertEqual(status["outcome"], "ready")
        self.assertEqual(stdout, f"GLIMMER_PREWARM_READY {LEASE_ID}\n")

    def test_ready_cache_cpu_prewarm_is_the_only_writer_and_seals_signed_artifacts(self):
        self._prepare("complete", prewarm=True, require_ready=True)
        stdout, stderr = self.process.communicate(timeout=8)

        self.assertEqual(self.process.returncode, 0, (stdout, stderr))
        events = self.events.read_text(encoding="utf-8")
        self.assertEqual(events.count("download_start:"), 3)
        self.assertNotIn("worker_listening:", events)
        self.assertNotIn("llama_start:", events)
        self.assertNotIn("download_private_key:1", events)
        models = self.root / "models"
        self.assertEqual(models.stat().st_mode & 0o777, 0o555)
        self.assertEqual((models / "cache-ready.json").stat().st_mode & 0o777, 0o444)
        fixture_digest = hashlib.sha256(b"fixture").hexdigest()
        hashes = {kind: fixture_digest for kind in ("model", "mmproj", "draft")}
        verified = cache_manifest.verify(
            models,
            "rp5asg2b9x",
            "r2-abcdef012345",
            hashes,
            self.public_key,
        )
        self.assertEqual([item["kind"] for item in verified["signed"]["artifacts"]], [
            "model",
            "mmproj",
            "draft",
        ])
        self.assertIn('{"event":"cache_manifest_published"}', stdout)
        self.assertTrue(stdout.endswith(f"GLIMMER_PREWARM_READY {LEASE_ID}\n"))

    def test_ready_cache_gpu_fast_path_needs_no_urls_and_never_invokes_downloader(self):
        state = self._prepare(
            "download_failure",
            require_ready=True,
            ready_cache=True,
            omit_artifact_urls=True,
        )
        events = self._wait_for(lambda value: "llama_start:" in value)

        self.assertIn("worker_listening:", "\n".join(events))
        self.assertNotIn("download_start:", "\n".join(events))
        self._wait_for(lambda _value: (state / "model.ready").exists())
        self._terminate()

        status = json.loads(
            (
                self.root / "recovery" / "bootstrap" / LEASE_ID / "status.json"
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(status["stage"], "ready")
        self.assertEqual(status["outcome"], "ready")

    def test_ready_cache_gpu_missing_manifest_fails_closed_without_download_or_model(self):
        self._prepare(
            "complete",
            require_ready=True,
            omit_artifact_urls=True,
        )
        stdout, stderr = self.process.communicate(timeout=8)

        self.assertEqual(self.process.returncode, 22, (stdout, stderr))
        events = self.events.read_text(encoding="utf-8")
        self.assertIn("worker_listening:", events)
        self.assertNotIn("download_start:", events)
        self.assertNotIn("llama_start:", events)
        status = json.loads(
            (
                self.root / "recovery" / "bootstrap" / LEASE_ID / "status.json"
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(status["failureCode"], "cache_not_ready")
        self.assertEqual(status["exitCode"], 22)
        self.assertIn('"reason":"cache_not_ready"', stderr)

    def test_artifact_failures_are_mapped_to_allowlisted_diagnostics(self):
        for mode, expected_code, expected_exit in (
            ("checksum_failure", "artifact_checksum_failed", 20),
            ("download_failure", "artifact_download_failed", 21),
        ):
            with self.subTest(mode=mode):
                self._prepare(mode)
                stdout, stderr = self.process.communicate(timeout=8)
                self.assertEqual(self.process.returncode, expected_exit, (stdout, stderr))
                status_path = (
                    self.root / "recovery" / "bootstrap" / LEASE_ID / "status.json"
                )
                status = json.loads(status_path.read_text(encoding="utf-8"))
                self.assertEqual(status["stage"], "failed")
                self.assertEqual(status["failureCode"], expected_code)
                self.assertEqual(status["exitCode"], expected_exit)
                self.process = None
                status_path.unlink()

    def test_cleanup_force_kills_a_downloader_that_ignores_term(self):
        self._prepare("ignore")
        self._wait_for(lambda value: "download_start:" in value)

        started = time.monotonic()
        self._terminate()

        self.assertLess(time.monotonic() - started, 3)
        final_events = self.events.read_text(encoding="utf-8")
        self.assertIn("worker_term:", final_events)
        self.assertNotIn("download_term:", final_events)

    def test_worker_death_during_download_stops_the_downloader_and_exits_five(self):
        self._prepare("hold", worker_mode="exit_during_download")
        stdout, stderr = self.process.communicate(timeout=5)

        self.assertEqual(self.process.returncode, 5, (stdout, stderr))
        final_events = self.events.read_text(encoding="utf-8")
        self.assertIn("download_start:", final_events)
        self.assertIn("worker_exit:", final_events)
        self.assertIn("download_term:", final_events)
        status = json.loads(
            (
                self.root / "recovery" / "bootstrap" / LEASE_ID / "status.json"
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(status["failureCode"], "worker_start_failed")
        self.assertEqual(status["exitCode"], 5)

    def test_worker_death_during_llama_readiness_stops_llama_and_exits_five(self):
        self._prepare("complete", worker_mode="exit_during_llama")
        stdout, stderr = self.process.communicate(timeout=6)

        self.assertEqual(self.process.returncode, 5, (stdout, stderr))
        final_events = self.events.read_text(encoding="utf-8")
        self.assertIn("llama_start:", final_events)
        self.assertIn("worker_exit:", final_events)
        self.assertIn("llama_term:", final_events)
        status = json.loads(
            (
                self.root / "recovery" / "bootstrap" / LEASE_ID / "status.json"
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(status["failureCode"], "worker_start_failed")
        self.assertEqual(status["exitCode"], 5)


if __name__ == "__main__":
    unittest.main()
