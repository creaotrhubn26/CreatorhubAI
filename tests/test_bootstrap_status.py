import json
import os
import tempfile
import threading
import unittest
from pathlib import Path

from docker.runpod import bootstrap_status

LEASE_ID = "12345678-1234-4234-9234-123456789abc"


class BootstrapStatusTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.recovery = self.root / "recovery"
        self.recovery.mkdir(mode=0o700)
        self.path = self.recovery / "bootstrap" / LEASE_ID / "status.json"

    def tearDown(self):
        self.temporary.cleanup()

    def test_atomic_status_is_private_durable_and_public_projection_omits_lease(self):
        bootstrap_status.initialize(self.path, LEASE_ID)
        bootstrap_status.transition(
            self.path,
            LEASE_ID,
            "artifact_downloading",
            artifact={
                "kind": "model",
                "phase": "downloading",
                "bytesCompleted": 256,
                "bytesTotal": 1024,
            },
        )

        stored = bootstrap_status.read(self.path, LEASE_ID)
        public = bootstrap_status.read_public(self.path, LEASE_ID)
        self.assertEqual(stored["leaseId"], LEASE_ID)
        self.assertEqual(stored["schemaVersion"], 1)
        self.assertNotIn("leaseId", public)
        self.assertNotIn("schemaVersion", public)
        self.assertEqual(public["artifact"]["bytesCompleted"], 256)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.path.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.path.parent.parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(list(self.path.parent.glob(".status.*.tmp")), [])

    def test_failure_preserves_last_artifact_without_free_form_detail(self):
        bootstrap_status.initialize(self.path, LEASE_ID)
        bootstrap_status.transition(
            self.path,
            LEASE_ID,
            "artifact_verifying",
            artifact={"kind": "draft", "phase": "verifying", "bytesCompleted": 42},
        )
        failed = bootstrap_status.transition(
            self.path,
            LEASE_ID,
            "failed",
            "failed",
            failure_code="artifact_checksum_failed",
            exit_code=20,
            preserve_artifact=True,
        )

        self.assertEqual(failed["artifact"]["phase"], "verifying")
        self.assertEqual(failed["failureCode"], "artifact_checksum_failed")
        serialized = json.dumps(failed)
        self.assertNotIn("https://", serialized)
        self.assertNotIn("token", serialized.lower())
        with self.assertRaises(bootstrap_status.BootstrapStatusError):
            bootstrap_status.validate_status({**failed, "detail": "raw failure"}, LEASE_ID)

    def test_rejects_a_bootstrap_update_older_than_its_stage_start(self):
        bootstrap_status.initialize(self.path, LEASE_ID)
        current = bootstrap_status.read(self.path, LEASE_ID)
        with self.assertRaises(bootstrap_status.BootstrapStatusError):
            bootstrap_status.validate_status(
                {
                    **current,
                    "stageStartedAt": "2026-08-29T10:00:01.000Z",
                    "updatedAt": "2026-08-29T10:00:00.000Z",
                },
                LEASE_ID,
            )

    def test_parallel_leases_do_not_clobber_and_concurrent_updates_remain_valid(self):
        other_lease = "abcdef01-2345-4567-89ab-cdef01234567"
        other_path = self.recovery / "bootstrap" / other_lease / "status.json"
        bootstrap_status.initialize(self.path, LEASE_ID)
        bootstrap_status.initialize(other_path, other_lease)
        failures = []

        def update(offset):
            try:
                bootstrap_status.transition(
                    self.path,
                    LEASE_ID,
                    "artifact_downloading",
                    artifact={
                        "kind": "model",
                        "phase": "downloading",
                        "bytesCompleted": offset,
                        "bytesTotal": 1024,
                    },
                )
            except BaseException as exc:
                failures.append(exc)

        threads = [threading.Thread(target=update, args=(offset,)) for offset in range(32)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=3)

        self.assertEqual(failures, [])
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(bootstrap_status.read(other_path, other_lease)["stage"], "initializing")
        self.assertEqual(bootstrap_status.read(self.path, LEASE_ID)["stage"], "artifact_downloading")

    def test_atomic_health_read_does_not_wait_for_a_stalled_writer_lock(self):
        bootstrap_status.initialize(self.path, LEASE_ID)
        result = []
        with bootstrap_status._locked_status_directory(self.path, LEASE_ID):
            reader = threading.Thread(
                target=lambda: result.append(bootstrap_status.read_public(self.path, LEASE_ID))
            )
            reader.start()
            reader.join(timeout=1)

        self.assertFalse(reader.is_alive())
        self.assertEqual(result[0]["stage"], "initializing")

    def test_symlink_hardlink_fifo_and_malformed_status_are_never_read(self):
        bootstrap_status.initialize(self.path, LEASE_ID)
        victim = self.root / "victim"
        victim.write_text("secret-token", encoding="utf-8")

        self.path.unlink()
        self.path.symlink_to(victim)
        with self.assertRaises(OSError):
            bootstrap_status.read(self.path, LEASE_ID)
        self.path.unlink()

        os.link(victim, self.path)
        with self.assertRaises(bootstrap_status.BootstrapStatusError):
            bootstrap_status.read(self.path, LEASE_ID)
        self.path.unlink()

        os.mkfifo(self.path, 0o600)
        with self.assertRaises(bootstrap_status.BootstrapStatusError):
            bootstrap_status.read(self.path, LEASE_ID)
        self.path.unlink()

        self.path.write_text('{"detail":"secret-token"}', encoding="utf-8")
        with self.assertRaises(bootstrap_status.BootstrapStatusError):
            bootstrap_status.read(self.path, LEASE_ID)

    def test_rejects_path_traversal_and_a_symlinked_bootstrap_root(self):
        with self.assertRaises(bootstrap_status.BootstrapStatusError):
            bootstrap_status.initialize(
                self.recovery / "bootstrap" / ".." / LEASE_ID / "status.json", LEASE_ID
            )

        victim = self.root / "elsewhere"
        victim.mkdir()
        (self.recovery / "bootstrap").symlink_to(victim)
        with self.assertRaises(OSError):
            bootstrap_status.initialize(self.path, LEASE_ID)
        self.assertEqual(list(victim.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
