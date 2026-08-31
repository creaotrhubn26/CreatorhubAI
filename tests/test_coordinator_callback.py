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
        self.assertEqual(
            failure,
            {"event": "cache_validation_failed", "reason": "cache_not_ready"},
        )
        self.assertNotIn(str(document), stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
