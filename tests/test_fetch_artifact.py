import hashlib
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from docker.runpod import bootstrap_status, fetch_artifact

LEASE_ID = "12345678-1234-4234-9234-123456789abc"


class FakeResponse:
    def __init__(self, status, headers, chunks):
        self.status = status
        self.headers = headers
        self.chunks = list(chunks)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _size):
        if not self.chunks:
            return b""
        value = self.chunks.pop(0)
        if isinstance(value, BaseException):
            raise value
        return value


class QueueOpener:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []

    def open(self, artifact_request, timeout):
        self.requests.append((artifact_request, timeout))
        return self.responses.pop(0)


class BlockingResponse(FakeResponse):
    def __init__(self, content, entered, release):
        super().__init__(200, {"Content-Length": str(len(content))}, [])
        self.content = content
        self.entered = entered
        self.release = release
        self.sent = False

    def read(self, _size):
        if self.sent:
            return b""
        self.entered.set()
        if not self.release.wait(timeout=3):
            raise TimeoutError("blocking response was not released")
        self.sent = True
        return self.content


class ShortWriteFile:
    def __init__(self, handle):
        self.handle = handle

    def __enter__(self):
        self.handle.__enter__()
        return self

    def __exit__(self, *args):
        return self.handle.__exit__(*args)

    def __getattr__(self, name):
        return getattr(self.handle, name)

    def write(self, data):
        return self.handle.write(data[:1])


class FetchArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.target = self.root / "model.gguf"
        self.url = "https://artifacts.example/model.gguf"
        self.hosts = {"artifacts.example"}

    def tearDown(self):
        self.temporary.cleanup()

    def fetch_with(self, opener, expected_sha256, reporter=None):
        with (
            mock.patch.object(fetch_artifact, "validate_url", return_value=self.url),
            mock.patch.object(fetch_artifact.request, "build_opener", return_value=opener),
        ):
            fetch_artifact.fetch(
                self.url,
                expected_sha256,
                self.target,
                self.hosts,
                reporter=reporter,
            )

    def test_interruption_preserves_checksum_bound_partial_and_resumes(self):
        content = b"hello world"
        expected = hashlib.sha256(content).hexdigest()
        first = QueueOpener(
            FakeResponse(
                200,
                {"Content-Length": str(len(content))},
                [content[:4], OSError("connection interrupted")],
            )
        )
        with self.assertRaisesRegex(OSError, "connection interrupted"):
            self.fetch_with(first, expected)

        partial = fetch_artifact.partial_path(self.target, expected)
        self.assertEqual(partial.read_bytes(), content[:4])
        self.assertFalse(self.target.exists())

        remaining = content[4:]
        second = QueueOpener(
            FakeResponse(
                206,
                {
                    "Content-Length": str(len(remaining)),
                    "Content-Range": f"bytes 4-{len(content) - 1}/{len(content)}",
                },
                [remaining],
            )
        )
        self.fetch_with(second, expected)

        self.assertEqual(
            second.requests[0][0].get_header("Range"),
            "bytes=4-",
        )
        self.assertEqual(self.target.read_bytes(), content)
        self.assertFalse(partial.exists())
        self.assertEqual(self.target.stat().st_mode & 0o777, 0o600)

    def test_resume_and_periodic_fsync_emit_only_bounded_structured_progress(self):
        content = b"abcdefghij"
        expected = hashlib.sha256(content).hexdigest()
        partial = fetch_artifact.partial_path(self.target, expected)
        partial.write_bytes(content[:3])
        remaining = content[3:]
        opener = QueueOpener(
            FakeResponse(
                206,
                {
                    "Content-Length": str(len(remaining)),
                    "Content-Range": f"bytes 3-{len(content) - 1}/{len(content)}",
                },
                [remaining[:3], remaining[3:]],
            )
        )
        progress = []

        with (
            mock.patch.object(fetch_artifact, "SYNC_INTERVAL_BYTES", 3),
            mock.patch.object(
                fetch_artifact, "_seed_digest", wraps=fetch_artifact._seed_digest
            ) as seed_digest,
        ):
            self.fetch_with(
                opener,
                expected,
                reporter=lambda phase, completed, total: progress.append(
                    (phase, completed, total)
                ),
            )

        self.assertEqual(progress[0], ("locking", None, None))
        self.assertIn(("resuming", 3, None), progress)
        self.assertIn(("downloading", 3, 10), progress)
        self.assertIn(("downloading", 6, 10), progress)
        self.assertEqual(progress[-2], ("verifying", 10, 10))
        self.assertEqual(progress[-1], ("complete", 10, 10))
        self.assertEqual(seed_digest.call_count, 2)
        self.assertTrue(
            all(
                phase in {"locking", "resuming", "downloading", "verifying", "complete"}
                and (completed is None or type(completed) is int)
                and (total is None or type(total) is int)
                for phase, completed, total in progress
            )
        )

    def test_cache_hit_reports_cached_without_network_request(self):
        content = b"verified cache"
        expected = hashlib.sha256(content).hexdigest()
        self.target.write_bytes(content)
        opener = QueueOpener()
        progress = []

        self.fetch_with(opener, expected, reporter=lambda *event: progress.append(event))

        self.assertEqual(opener.requests, [])
        self.assertEqual(progress, [("locking", None, None), ("cached", None, None)])

    def test_cli_persists_complete_artifact_progress_without_url_or_checksum(self):
        content = b"status-integrated artifact"
        expected = hashlib.sha256(content).hexdigest()
        opener = QueueOpener(FakeResponse(200, {"Content-Length": str(len(content))}, [content]))
        recovery = self.root / "recovery"
        recovery.mkdir(mode=0o700)
        status_path = recovery / "bootstrap" / LEASE_ID / "status.json"
        bootstrap_status.initialize(status_path, LEASE_ID)
        arguments = [
            "fetch_artifact.py",
            "--url",
            self.url,
            "--sha256",
            expected,
            "--output",
            str(self.target),
            "--allowed-host",
            "artifacts.example",
            "--status-file",
            str(status_path),
            "--lease-id",
            LEASE_ID,
            "--artifact-kind",
            "draft",
        ]

        with (
            mock.patch.object(fetch_artifact, "validate_url", return_value=self.url),
            mock.patch.object(fetch_artifact.request, "build_opener", return_value=opener),
            mock.patch("sys.argv", arguments),
        ):
            self.assertEqual(fetch_artifact.main(), 0)

        status = bootstrap_status.read(status_path, LEASE_ID)
        self.assertEqual(status["stage"], "artifact_verifying")
        self.assertEqual(
            status["artifact"],
            {
                "kind": "draft",
                "phase": "complete",
                "bytesCompleted": len(content),
                "bytesTotal": len(content),
            },
        )
        serialized = json.dumps(status)
        self.assertNotIn(self.url, serialized)
        self.assertNotIn(expected, serialized)

    def test_legacy_pid_partial_is_preserved_when_liveness_cannot_be_proven(self):
        content = b"new artifact"
        expected = hashlib.sha256(content).hexdigest()
        legacy = self.root / f".{self.target.name}.{os.getpid()}.partial"
        legacy.write_bytes(b"stale")
        opener = QueueOpener(FakeResponse(200, {"Content-Length": str(len(content))}, [content]))

        self.fetch_with(opener, expected)

        self.assertTrue(legacy.exists())
        self.assertEqual(self.target.read_bytes(), content)

    def test_bad_content_range_discards_partial(self):
        content = b"checksum-bound content"
        expected = hashlib.sha256(content).hexdigest()
        partial = fetch_artifact.partial_path(self.target, expected)
        partial.write_bytes(content[:5])
        remainder = content[5:]
        opener = QueueOpener(
            FakeResponse(
                206,
                {
                    "Content-Length": str(len(remainder)),
                    "Content-Range": f"bytes 4-{len(content) - 1}/{len(content)}",
                },
                [remainder],
            )
        )

        with self.assertRaisesRegex(ValueError, "Content-Range"):
            self.fetch_with(opener, expected)

        self.assertFalse(partial.exists())
        self.assertFalse(self.target.exists())

    def test_resume_rejects_server_that_ignores_range(self):
        content = b"range response"
        expected = hashlib.sha256(content).hexdigest()
        partial = fetch_artifact.partial_path(self.target, expected)
        partial.write_bytes(content[:3])
        opener = QueueOpener(FakeResponse(200, {"Content-Length": str(len(content))}, [content]))

        with self.assertRaisesRegex(ValueError, "ignored"):
            self.fetch_with(opener, expected)

        self.assertEqual(opener.requests[0][0].get_header("Range"), "bytes=3-")
        self.assertFalse(partial.exists())
        self.assertFalse(self.target.exists())

    def test_final_checksum_mismatch_discards_partial(self):
        expected = hashlib.sha256(b"expected").hexdigest()
        wrong = b"unexpected"
        opener = QueueOpener(FakeResponse(200, {"Content-Length": str(len(wrong))}, [wrong]))

        with mock.patch.object(
            fetch_artifact, "_seed_digest", wraps=fetch_artifact._seed_digest
        ) as seed_digest:
            with self.assertRaisesRegex(ValueError, "checksum"):
                self.fetch_with(opener, expected)

        self.assertEqual(seed_digest.call_count, 2)
        self.assertFalse(fetch_artifact.partial_path(self.target, expected).exists())
        self.assertFalse(self.target.exists())

    def test_complete_partial_is_promoted_without_another_request(self):
        content = b"already complete"
        expected = hashlib.sha256(content).hexdigest()
        partial = fetch_artifact.partial_path(self.target, expected)
        partial.write_bytes(content)
        opener = QueueOpener()

        with mock.patch.object(
            fetch_artifact, "_seed_digest", wraps=fetch_artifact._seed_digest
        ) as seed_digest:
            self.fetch_with(opener, expected)

        self.assertEqual(opener.requests, [])
        seed_digest.assert_called_once()
        self.assertEqual(self.target.read_bytes(), content)
        self.assertFalse(partial.exists())

    def test_complete_partial_path_swap_after_hash_is_never_published(self):
        content = b"already complete and verified"
        replacement = b"unverified replacement"
        expected = hashlib.sha256(content).hexdigest()
        partial = fetch_artifact.partial_path(self.target, expected)
        partial.write_bytes(content)
        opener = QueueOpener()
        original_seed_digest = fetch_artifact._seed_digest

        def hash_then_swap(output):
            result = original_seed_digest(output)
            partial.unlink()
            partial.write_bytes(replacement)
            return result

        with mock.patch.object(
            fetch_artifact, "_seed_digest", side_effect=hash_then_swap
        ) as seed_digest:
            with self.assertRaisesRegex(ValueError, "pathname changed"):
                self.fetch_with(opener, expected)

        self.assertEqual(opener.requests, [])
        seed_digest.assert_called_once()
        self.assertFalse(self.target.exists())
        self.assertEqual(partial.read_bytes(), replacement)

    def test_completion_by_another_process_while_waiting_for_lock_is_accepted(self):
        content = b"completed by peer"
        expected = hashlib.sha256(content).hexdigest()
        opener = QueueOpener()
        original_open = fetch_artifact._open_locked_partial

        def complete_then_lock(path):
            self.target.write_bytes(content)
            return original_open(path)

        with (
            mock.patch.object(fetch_artifact, "validate_url", return_value=self.url),
            mock.patch.object(fetch_artifact.request, "build_opener", return_value=opener),
            mock.patch.object(
                fetch_artifact, "_open_locked_partial", side_effect=complete_then_lock
            ),
        ):
            fetch_artifact.fetch(self.url, expected, self.target, self.hosts)

        self.assertEqual(opener.requests, [])
        self.assertEqual(self.target.read_bytes(), content)
        self.assertFalse(fetch_artifact.partial_path(self.target, expected).exists())

    def test_two_fetchers_share_the_stable_target_lock_and_only_download_once(self):
        content = b"one verified artifact"
        expected = hashlib.sha256(content).hexdigest()
        entered = threading.Event()
        release = threading.Event()
        opener = QueueOpener(BlockingResponse(content, entered, release))
        failures = []

        def run_fetch():
            try:
                fetch_artifact.fetch(self.url, expected, self.target, self.hosts)
            except BaseException as exc:
                failures.append(exc)

        with (
            mock.patch.object(fetch_artifact, "validate_url", return_value=self.url),
            mock.patch.object(fetch_artifact.request, "build_opener", return_value=opener),
        ):
            first = threading.Thread(target=run_fetch)
            second = threading.Thread(target=run_fetch)
            first.start()
            self.assertTrue(entered.wait(timeout=2))
            second.start()
            time.sleep(0.05)
            self.assertTrue(second.is_alive())
            self.assertEqual(len(opener.requests), 1)
            release.set()
            first.join(timeout=3)
            second.join(timeout=3)

        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(len(opener.requests), 1)
        self.assertEqual(self.target.read_bytes(), content)

    def test_changed_partial_path_is_never_published(self):
        content = b"verified locked inode"
        replacement = b"unverified replacement"
        expected = hashlib.sha256(content).hexdigest()
        partial = fetch_artifact.partial_path(self.target, expected)

        class SwappingResponse(FakeResponse):
            def read(inner_self, size):
                value = super().read(size)
                if not value and not partial.exists():
                    partial.write_bytes(replacement)
                elif not value:
                    partial.unlink()
                    partial.write_bytes(replacement)
                return value

        opener = QueueOpener(
            SwappingResponse(200, {"Content-Length": str(len(content))}, [content])
        )

        with self.assertRaisesRegex(ValueError, "pathname changed"):
            self.fetch_with(opener, expected)

        self.assertFalse(self.target.exists())
        self.assertEqual(partial.read_bytes(), replacement)

    def test_unbuffered_short_writes_are_retried_before_publication(self):
        content = b"short writes must not truncate verified bytes"
        expected = hashlib.sha256(content).hexdigest()
        opener = QueueOpener(FakeResponse(200, {"Content-Length": str(len(content))}, [content]))
        original_open = fetch_artifact._open_locked_partial

        def short_open(path, *, nonblocking=False):
            return ShortWriteFile(original_open(path, nonblocking=nonblocking))

        with mock.patch.object(fetch_artifact, "_open_locked_partial", side_effect=short_open):
            self.fetch_with(opener, expected)

        self.assertEqual(self.target.read_bytes(), content)

    def test_symlink_target_and_partial_are_rejected_without_touching_victim(self):
        victim = self.root / "victim"
        victim.write_bytes(b"private")
        expected = hashlib.sha256(victim.read_bytes()).hexdigest()
        self.target.symlink_to(victim)

        with self.assertRaisesRegex(ValueError, "private regular file"):
            self.fetch_with(QueueOpener(), expected)
        self.assertEqual(victim.read_bytes(), b"private")

        self.target.unlink()
        partial = fetch_artifact.partial_path(self.target, expected)
        partial.symlink_to(victim)
        with self.assertRaises(OSError):
            self.fetch_with(QueueOpener(), expected)
        self.assertEqual(victim.read_bytes(), b"private")

    def test_fifo_target_is_rejected_without_blocking(self):
        os.mkfifo(self.target, 0o600)

        started = time.monotonic()
        with self.assertRaisesRegex(ValueError, "private regular file"):
            self.fetch_with(QueueOpener(), "a" * 64)

        self.assertLess(time.monotonic() - started, 1)

    def test_obsolete_cleanup_ignores_directories_and_hardlinks(self):
        expected = "a" * 64
        obsolete = "b" * 64
        directory = self.root / f".{self.target.name}.{obsolete}.partial"
        directory.mkdir()
        victim = self.root / "hardlink-victim"
        victim.write_bytes(b"keep")
        hardlink = self.root / f".{self.target.name}.123.partial"
        os.link(victim, hardlink)

        with fetch_artifact._open_target_lock(self.target):
            fetch_artifact._clean_obsolete_partials(self.target, expected)

        self.assertTrue(directory.is_dir())
        self.assertTrue(hardlink.exists())
        self.assertEqual(victim.read_bytes(), b"keep")

    def test_obsolete_cleanup_never_unlinks_an_actively_locked_partial(self):
        expected = "a" * 64
        obsolete = "b" * 64
        partial = fetch_artifact.partial_path(self.target, obsolete)

        with fetch_artifact._open_target_lock(self.target):
            with fetch_artifact._open_locked_partial(partial):
                fetch_artifact._clean_obsolete_partials(self.target, expected)
                self.assertTrue(partial.exists())
            fetch_artifact._clean_obsolete_partials(self.target, expected)

        self.assertFalse(partial.exists())

    def test_declared_oversize_response_is_rejected_before_streaming(self):
        content = b"12345"
        expected = hashlib.sha256(content).hexdigest()
        opener = QueueOpener(FakeResponse(200, {"Content-Length": str(len(content))}, [content]))

        with mock.patch.object(fetch_artifact, "MAX_ARTIFACT_BYTES", 4):
            with self.assertRaisesRegex(ValueError, "safe size"):
                self.fetch_with(opener, expected)

        self.assertFalse(fetch_artifact.partial_path(self.target, expected).exists())
        self.assertFalse(self.target.exists())


if __name__ == "__main__":
    unittest.main()
