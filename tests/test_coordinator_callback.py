import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from docker.runpod import coordinator_callback


JOB_ID = "12345678-1234-4123-8123-123456789abc"
ENDPOINT = f"https://coordinator.example/v1/jobs/{JOB_ID}/callback"
TOKEN = "T" * 43


class FakeResponse:
    status = 200
    headers = {"Content-Length": "17"}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit):
        return b'{"accepted":true}'


class FakeOpener:
    def __init__(self):
        self.calls = []

    def open(self, callback, timeout):
        self.calls.append((callback, timeout))
        return FakeResponse()


class CoordinatorCallbackTests(unittest.TestCase):
    def test_configuration_requires_a_canonical_https_job_callback(self):
        self.assertEqual(
            coordinator_callback.validate_configuration(ENDPOINT, TOKEN),
            (ENDPOINT, TOKEN),
        )
        for endpoint in (
            ENDPOINT.replace("https://", "http://"),
            ENDPOINT + "?secret=1",
            ENDPOINT.replace("/callback", "/other"),
        ):
            with self.assertRaises(coordinator_callback.CallbackError):
                coordinator_callback.validate_configuration(endpoint, TOKEN)
        with self.assertRaises(coordinator_callback.CallbackError):
            coordinator_callback.validate_configuration(ENDPOINT, "short")

    def test_send_is_bounded_no_redirect_and_keeps_token_out_of_the_body(self):
        opener = FakeOpener()
        with (
            mock.patch.object(
                coordinator_callback.request,
                "build_opener",
                return_value=opener,
            ) as build_opener,
            mock.patch.object(
                coordinator_callback.ssl,
                "create_default_context",
                return_value=mock.sentinel.context,
            ),
        ):
            result = coordinator_callback.send(
                {"schemaVersion": 1, "type": "heartbeat"},
                attempts=1,
                endpoint=ENDPOINT,
                token=TOKEN,
            )

        self.assertEqual(result, {"accepted": True})
        self.assertEqual(len(opener.calls), 1)
        sent, timeout = opener.calls[0]
        self.assertEqual(timeout, 10)
        self.assertEqual(sent.get_header("Authorization"), f"Bearer {TOKEN}")
        self.assertNotIn(TOKEN.encode(), sent.data)
        self.assertTrue(
            any(
                isinstance(handler, coordinator_callback._NoRedirect)
                for handler in build_opener.call_args.args
            )
        )

    def test_cache_progress_cli_sends_one_bounded_secret_free_snapshot(self):
        with tempfile.TemporaryDirectory() as temporary:
            status = Path(temporary) / "status.json"
            status.write_text(
                json.dumps(
                    {
                        "stage": "artifact_downloading",
                        "outcome": "in_progress",
                        "stageStartedAt": "2026-09-01T10:00:00.000Z",
                        "updatedAt": "2026-09-01T10:00:01.000Z",
                        "artifact": {
                            "kind": "model",
                            "phase": "downloading",
                            "bytesCompleted": 1024,
                            "bytesTotal": 2048,
                        },
                    }
                ),
                encoding="utf-8",
            )
            arguments = [
                "coordinator_callback.py",
                "cache-progress",
                "--status",
                str(status),
                "--cache-key",
                "a" * 64,
            ]
            with (
                mock.patch("sys.argv", arguments),
                mock.patch.object(
                    coordinator_callback, "send", return_value={"accepted": True}
                ) as send,
            ):
                self.assertEqual(coordinator_callback.main(), 0)

        payload = send.call_args.args[0]
        self.assertEqual(send.call_args.kwargs, {"attempts": 1})
        self.assertEqual(payload["type"], "cache_progress")
        self.assertEqual(payload["progress"]["artifact"]["bytesCompleted"], 1024)
        self.assertNotIn("leaseId", json.dumps(payload))

    def test_cache_progress_rejects_private_or_unbounded_status_fields(self):
        with tempfile.TemporaryDirectory() as temporary:
            status = Path(temporary) / "status.json"
            status.write_text(
                json.dumps(
                    {
                        "stage": "artifact_downloading",
                        "outcome": "in_progress",
                        "stageStartedAt": "2026-09-01T10:00:00.000Z",
                        "updatedAt": "2026-09-01T10:00:01.000Z",
                        "leaseId": JOB_ID,
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaises(coordinator_callback.CallbackError):
                coordinator_callback._progress_document(status)

    def test_cache_failed_cli_uses_allowlisted_code_and_one_attempt(self):
        arguments = [
            "coordinator_callback.py",
            "cache-failed",
            "--cache-key",
            "b" * 64,
            "--failure-code",
            "artifact_download_failed",
        ]
        with (
            mock.patch("sys.argv", arguments),
            mock.patch.object(
                coordinator_callback, "send", return_value={"accepted": True}
            ) as send,
        ):
            self.assertEqual(coordinator_callback.main(), 0)

        self.assertEqual(send.call_args.args[0]["failureCode"], "artifact_download_failed")
        self.assertEqual(send.call_args.kwargs, {"attempts": 1})

    def test_install_cli_turns_invalid_json_into_a_sanitized_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            document = Path(temporary) / "document.json"
            document.write_text("{", encoding="utf-8")
            arguments = [
                "cache_manifest.py",
                "install",
                "--root",
                temporary,
                "--volume-id",
                "volume-1",
                "--build-id",
                "r2-abcdef012345",
                "--model-sha256",
                "a" * 64,
                "--mmproj-sha256",
                "b" * 64,
                "--draft-sha256",
                "c" * 64,
                "--document",
                str(document),
            ]
            stderr = io.StringIO()
            from docker.runpod import cache_manifest

            with mock.patch("sys.argv", arguments), mock.patch("sys.stderr", stderr):
                result = cache_manifest.main()

        self.assertEqual(result, 30)
        failure = json.loads(stderr.getvalue())
        self.assertEqual(failure["event"], "cache_validation_failed")
        self.assertEqual(failure["reason"], "cache_not_ready")
        # The bounded detail names the failing step without echoing input.
        self.assertTrue(failure["detail"].startswith("JSONDecodeError:"))
        self.assertLessEqual(len(failure["detail"]), 200)
        self.assertEqual(set(failure), {"event", "reason", "detail"})
        self.assertNotIn(str(document), stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
