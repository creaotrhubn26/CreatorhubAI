import base64
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from docker.runpod import cache_manifest


def encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


class CacheManifestTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "models"
        self.root.mkdir(mode=0o700)
        self.volume_id = "rp5asg2b9x"
        self.build_id = "r2-abcdef012345"
        self.contents = {
            "model": b"verified model bytes",
            "mmproj": b"verified projector bytes",
            "draft": b"verified draft bytes",
        }
        self.hashes = {
            kind: hashlib.sha256(content).hexdigest()
            for kind, content in self.contents.items()
        }
        for expected in cache_manifest._expectations(self.hashes):
            (self.root / expected.name).write_bytes(self.contents[expected.kind])
        private_key = Ed25519PrivateKey.generate()
        self.signing_key = private_key
        self.private_key = encode(
            private_key.private_bytes(
                encoding=serialization.Encoding.Raw,
                format=serialization.PrivateFormat.Raw,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )
        self.public_key = encode(
            private_key.public_key().public_bytes(
                encoding=serialization.Encoding.Raw,
                format=serialization.PublicFormat.Raw,
            )
        )

    def tearDown(self):
        os.chmod(self.root, 0o700)
        for path in self.root.iterdir():
            if path.is_file() and not path.is_symlink():
                path.chmod(0o600)
        self.temporary.cleanup()

    def publish(self):
        return cache_manifest.publish(
            self.root,
            self.volume_id,
            self.build_id,
            self.hashes,
            self.private_key,
        )

    def write_receipts(self):
        receipt_root = Path(self.temporary.name) / "receipts"
        receipt_root.mkdir(mode=0o700, exist_ok=True)
        for expected in cache_manifest._expectations(self.hashes):
            metadata = (self.root / expected.name).stat()
            value = {
                "schemaVersion": 1,
                "path": expected.name,
                "sha256": expected.sha256,
                "bytes": metadata.st_size,
                "device": metadata.st_dev,
                "inode": metadata.st_ino,
                "mtimeNs": metadata.st_mtime_ns,
                "ctimeNs": metadata.st_ctime_ns,
            }
            receipt = receipt_root / f"{expected.kind}.json"
            receipt.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
            receipt.chmod(0o600)
        return receipt_root

    def verify(self, **changes):
        return cache_manifest.verify(
            self.root,
            changes.get("volume_id", self.volume_id),
            changes.get("build_id", self.build_id),
            changes.get("hashes", self.hashes),
            changes.get("public_key", self.public_key),
        )

    def rewrite_manifest(self, value):
        os.chmod(self.root, 0o700)
        path = self.root / cache_manifest.MANIFEST_NAME
        path.chmod(0o600)
        path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")
        path.chmod(0o444)
        os.chmod(self.root, 0o555)

    def test_publish_signs_atomically_and_verify_never_hashes_artifact_bytes(self):
        manifest = self.publish()

        self.assertEqual(self.root.stat().st_mode & 0o777, 0o555)
        self.assertEqual(
            (self.root / cache_manifest.MANIFEST_NAME).stat().st_mode & 0o777,
            0o444,
        )
        for expected in cache_manifest._expectations(self.hashes):
            path = self.root / expected.name
            self.assertEqual(path.stat().st_mode & 0o777, 0o444)
            artifact = next(
                item for item in manifest["signed"]["artifacts"] if item["kind"] == expected.kind
            )
            self.assertEqual(artifact["bytes"], len(self.contents[expected.kind]))
        self.assertEqual(list(self.root.glob(".cache-ready.json.*.tmp")), [])

        with mock.patch.object(
            cache_manifest,
            "_hash_and_seal_artifact",
            side_effect=AssertionError("GPU verification must not hash artifacts"),
        ):
            verified = self.verify()

        self.assertEqual(verified, manifest)

    def test_prepare_then_coordinator_sign_then_install_is_the_cloud_fast_path(self):
        signed = cache_manifest.prepare(
            self.root,
            self.volume_id,
            self.build_id,
            self.hashes,
        )
        self.assertFalse((self.root / cache_manifest.MANIFEST_NAME).exists())
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)
        manifest = {
            "signed": signed,
            "signature": {
                "algorithm": "ed25519",
                "keyId": hashlib.sha256(
                    self.signing_key.public_key().public_bytes(
                        encoding=serialization.Encoding.Raw,
                        format=serialization.PublicFormat.Raw,
                    )
                ).hexdigest(),
                "value": encode(
                    self.signing_key.sign(cache_manifest.canonical_json_bytes(signed))
                ),
            },
        }

        installed = cache_manifest.install(
            self.root,
            self.volume_id,
            self.build_id,
            self.hashes,
            self.public_key,
            manifest,
        )
        with mock.patch.object(
            cache_manifest,
            "_hash_and_seal_artifact",
            side_effect=AssertionError("GPU verification must not hash artifacts"),
        ):
            verified = self.verify()

        self.assertEqual(installed, manifest)
        self.assertEqual(verified, manifest)

    def test_ephemeral_receipts_avoid_a_second_artifact_hash_and_seal_exact_inodes(self):
        receipt_root = self.write_receipts()
        with mock.patch.object(
            cache_manifest,
            "_hash_and_seal_artifact",
            side_effect=AssertionError("receipted publication must not hash twice"),
        ):
            signed = cache_manifest.prepare(
                self.root,
                self.volume_id,
                self.build_id,
                self.hashes,
                receipt_root,
            )

        self.assertEqual([item["kind"] for item in signed["artifacts"]], [
            "model",
            "mmproj",
            "draft",
        ])
        for expected in cache_manifest._expectations(self.hashes):
            self.assertEqual((self.root / expected.name).stat().st_mode & 0o777, 0o444)

    def test_receipted_publication_rejects_artifact_or_receipt_tampering(self):
        receipt_root = self.write_receipts()
        model = self.root / cache_manifest._expectations(self.hashes)[0].name
        model.write_bytes(b"changed after verification")
        with self.assertRaisesRegex(cache_manifest.CacheManifestError, "changed"):
            cache_manifest.prepare(
                self.root,
                self.volume_id,
                self.build_id,
                self.hashes,
                receipt_root,
            )

        model.write_bytes(self.contents["model"])
        receipt_root = self.write_receipts()
        receipt = receipt_root / "model.json"
        value = json.loads(receipt.read_text(encoding="utf-8"))
        # device/inode/ctime are excluded from the cross-process comparison
        # (network volumes report them unstably), so mtime is the tamper signal.
        value["mtimeNs"] += 1
        receipt.write_text(json.dumps(value) + "\n")
        receipt.chmod(0o600)
        with self.assertRaisesRegex(cache_manifest.CacheManifestError, "changed"):
            cache_manifest.prepare(
                self.root,
                self.volume_id,
                self.build_id,
                self.hashes,
                receipt_root,
            )

    def test_tampered_payload_signature_and_wrong_public_key_fail_closed(self):
        manifest = self.publish()
        manifest["signed"]["artifacts"][0]["bytes"] += 1
        self.rewrite_manifest(manifest)

        with self.assertRaisesRegex(cache_manifest.CacheManifestError, "signature"):
            self.verify()

        other = Ed25519PrivateKey.generate().public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
        with self.assertRaisesRegex(cache_manifest.CacheManifestError, "signer"):
            self.verify(public_key=encode(other))

    def test_volume_build_and_exact_artifact_hashes_are_bound(self):
        self.publish()

        with self.assertRaisesRegex(cache_manifest.CacheManifestError, "identity"):
            self.verify(volume_id="other-volume")
        with self.assertRaisesRegex(cache_manifest.CacheManifestError, "identity"):
            self.verify(build_id="r2-000000000000")
        changed = dict(self.hashes)
        changed["draft"] = "d" * 64
        with self.assertRaisesRegex(cache_manifest.CacheManifestError, "artifact"):
            self.verify(hashes=changed)

    def test_missing_truncated_writable_symlink_and_hardlink_artifacts_are_rejected(self):
        self.publish()
        model = next(
            self.root / expected.name
            for expected in cache_manifest._expectations(self.hashes)
            if expected.kind == "model"
        )

        os.chmod(self.root, 0o700)
        model.chmod(0o644)
        os.chmod(self.root, 0o555)
        with self.assertRaisesRegex(cache_manifest.CacheManifestError, "sealed"):
            self.verify()

        os.chmod(self.root, 0o700)
        model.chmod(0o600)
        model.write_bytes(b"x")
        model.chmod(0o444)
        os.chmod(self.root, 0o555)
        with self.assertRaisesRegex(cache_manifest.CacheManifestError, "size"):
            self.verify()

        os.chmod(self.root, 0o700)
        model.unlink()
        model.symlink_to(self.root / cache_manifest.MANIFEST_NAME)
        os.chmod(self.root, 0o555)
        with self.assertRaises(cache_manifest.CacheManifestError):
            self.verify()

        os.chmod(self.root, 0o700)
        model.unlink()
        source = self.root / cache_manifest.MANIFEST_NAME
        os.link(source, model)
        os.chmod(self.root, 0o555)
        with self.assertRaises(cache_manifest.CacheManifestError):
            self.verify()

    def test_manifest_symlink_duplicate_fields_and_oversize_are_rejected(self):
        self.publish()
        manifest_path = self.root / cache_manifest.MANIFEST_NAME
        os.chmod(self.root, 0o700)
        manifest_path.unlink()
        manifest_path.symlink_to(next(self.root.glob("model.*.gguf")))
        os.chmod(self.root, 0o555)
        with self.assertRaises(cache_manifest.CacheManifestError):
            self.verify()

        os.chmod(self.root, 0o700)
        manifest_path.unlink()
        manifest_path.write_text('{"signed":{},"signed":{},"signature":{}}\n')
        manifest_path.chmod(0o444)
        os.chmod(self.root, 0o555)
        with self.assertRaisesRegex(cache_manifest.CacheManifestError, "duplicate"):
            self.verify()

        os.chmod(self.root, 0o700)
        manifest_path.chmod(0o600)
        manifest_path.write_bytes(b"{" + b" " * cache_manifest.MAX_MANIFEST_BYTES + b"}")
        manifest_path.chmod(0o444)
        os.chmod(self.root, 0o555)
        with self.assertRaises(cache_manifest.CacheManifestError):
            self.verify()

    def test_invalid_checksum_never_publishes_or_seals(self):
        next(self.root.glob("model.*.gguf")).write_bytes(b"wrong bytes")

        with self.assertRaisesRegex(cache_manifest.CacheManifestError, "checksum"):
            self.publish()

        self.assertFalse((self.root / cache_manifest.MANIFEST_NAME).exists())
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)

    def test_failed_atomic_replace_preserves_previous_manifest_and_unsealed_state(self):
        first = self.publish()
        previous = (self.root / cache_manifest.MANIFEST_NAME).read_bytes()
        os.chmod(self.root, 0o700)
        for expected in cache_manifest._expectations(self.hashes):
            (self.root / expected.name).chmod(0o600)

        original_replace = os.replace

        def fail_manifest_replace(source, destination, *args, **kwargs):
            if destination == cache_manifest.MANIFEST_NAME:
                raise OSError("simulated atomic publication failure")
            return original_replace(source, destination, *args, **kwargs)

        with mock.patch.object(cache_manifest.os, "replace", side_effect=fail_manifest_replace):
            with self.assertRaisesRegex(OSError, "simulated"):
                self.publish()

        self.assertEqual((self.root / cache_manifest.MANIFEST_NAME).read_bytes(), previous)
        self.assertEqual(first["signed"]["volumeId"], self.volume_id)
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)
        self.assertEqual(list(self.root.glob(".cache-ready.json.*.tmp")), [])

    def test_cli_requires_private_key_only_for_publish_and_public_key_only_for_verify(self):
        arguments = [
            "cache_manifest.py",
            "publish",
            "--root",
            str(self.root),
            "--volume-id",
            self.volume_id,
            "--build-id",
            self.build_id,
            "--model-sha256",
            self.hashes["model"],
            "--mmproj-sha256",
            self.hashes["mmproj"],
            "--draft-sha256",
            self.hashes["draft"],
        ]
        with (
            mock.patch("sys.argv", arguments),
            mock.patch.dict(
                os.environ,
                {"GLIMMER_CACHE_SIGNING_PRIVATE_KEY": self.private_key},
                clear=True,
            ),
        ):
            self.assertEqual(cache_manifest.main(), 0)

        arguments[1] = "verify"
        with (
            mock.patch("sys.argv", arguments),
            mock.patch.dict(
                os.environ,
                {"GLIMMER_CACHE_SIGNING_PUBLIC_KEY": self.public_key},
                clear=True,
            ),
        ):
            self.assertEqual(cache_manifest.main(), 0)


if __name__ == "__main__":
    unittest.main()
