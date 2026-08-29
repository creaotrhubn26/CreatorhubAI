import hashlib
import unittest

from glimmer_remote import (
    RemoteContractError,
    decrypt_checkpoint,
    encrypt_checkpoint,
    parse_remote_job_manifest,
    request_signature,
)


def manifest(**changes):
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
            "bytes": 4,
            "sha256": hashlib.sha256(b"data").hexdigest(),
        },
    }
    payload.update(changes)
    return payload


class RemoteManifestTests(unittest.TestCase):
    def test_accepts_the_closed_v1_contract(self):
        parsed = parse_remote_job_manifest(manifest())
        self.assertEqual(parsed.context_tokens, 65_536)
        self.assertEqual(parsed.input.format, "git_bundle")
        self.assertEqual(parsed.as_dict(), manifest())

    def test_rejects_unknown_fields_bad_context_and_non_glimmer_branches(self):
        with self.assertRaisesRegex(RemoteContractError, "unsupported fields"):
            parse_remote_job_manifest(manifest(command=["sh", "-c", "evil"]))
        with self.assertRaisesRegex(RemoteContractError, "65536 or 131072"):
            parse_remote_job_manifest(manifest(contextTokens=200_000))
        with self.assertRaisesRegex(RemoteContractError, r"glimmer/\*"):
            parse_remote_job_manifest(manifest(branch="main"))
        with self.assertRaisesRegex(RemoteContractError, r"glimmer/\*"):
            parse_remote_job_manifest(manifest(branch="glimmer/../../main"))

    def test_rejects_forged_sizes_hashes_and_identifiers(self):
        bad_input = dict(manifest()["input"], parts=1, bytes=20 * 1024 * 1024)
        with self.assertRaisesRegex(RemoteContractError, "cannot contain"):
            parse_remote_job_manifest(manifest(input=bad_input))
        with self.assertRaisesRegex(RemoteContractError, "repositoryFingerprint"):
            parse_remote_job_manifest(manifest(repositoryFingerprint="not-a-hash"))
        with self.assertRaisesRegex(RemoteContractError, "sessionId"):
            parse_remote_job_manifest(manifest(sessionId="../session"))


class CheckpointCryptoTests(unittest.TestCase):
    def test_round_trip_binds_ciphertext_to_metadata(self):
        key = bytes(range(32))
        metadata = {
            "schemaVersion": 1,
            "jobId": "job-1",
            "sessionId": "session-1",
            "sequence": 0,
            "kind": "result",
            "final": True,
            "plaintextSha256": hashlib.sha256(b"checkpoint").hexdigest(),
        }
        envelope, digest = encrypt_checkpoint(key, b"checkpoint", metadata, nonce=b"0" * 12)
        self.assertEqual(hashlib.sha256(envelope).hexdigest(), digest)
        self.assertEqual(decrypt_checkpoint(key, envelope, metadata), b"checkpoint")

        tampered = bytearray(envelope)
        tampered[-1] ^= 1
        with self.assertRaisesRegex(RemoteContractError, "authentication failed"):
            decrypt_checkpoint(key, bytes(tampered), metadata)
        with self.assertRaisesRegex(RemoteContractError, "metadata does not match"):
            decrypt_checkpoint(key, envelope, {**metadata, "sequence": 1})

    def test_request_signature_covers_method_path_idempotency_and_body(self):
        key = b"capability"
        signature = request_signature(key, "POST", "/v1/jobs", "idem-1", b"{}")
        self.assertNotEqual(
            signature,
            request_signature(key, "POST", "/v1/jobs", "idem-2", b"{}"),
        )
        self.assertNotEqual(
            signature,
            request_signature(key, "POST", "/v1/jobs/other", "idem-1", b"{}"),
        )


if __name__ == "__main__":
    unittest.main()
