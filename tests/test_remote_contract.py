"""Parity tests for the remote task contract.

The wire fixture is shared with the gateway repository
(fixtures/task-contract-remote/cases.json on main); the gateway asserts
TaskContract -> contract and this module asserts contract -> argv.
"""
import json
import unittest
from pathlib import Path

from glimmer_remote import (
    RemoteContractError,
    build_contract_args,
    parse_remote_task_contract,
)

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "task-contract-remote-cases.json"


class RemoteContractParity(unittest.TestCase):
    def test_fixture_cases_map_to_expected_args(self):
        cases = json.loads(FIXTURE.read_text())["cases"]
        self.assertGreaterEqual(len(cases), 3)
        for case in cases:
            with self.subTest(case["name"]):
                contract = parse_remote_task_contract(case["contract"])
                self.assertEqual(build_contract_args(contract), case["expectedArgs"])

    def test_contract_round_trips_through_as_dict(self):
        cases = json.loads(FIXTURE.read_text())["cases"]
        for case in cases:
            with self.subTest(case["name"]):
                contract = parse_remote_task_contract(case["contract"])
                self.assertEqual(contract.as_dict(), case["contract"])

    def test_absent_contract_keeps_legacy_standard_verification(self):
        self.assertEqual(build_contract_args(None), ["--verification-level", "standard"])

    def test_unknown_keys_and_values_fail_closed(self):
        with self.assertRaises(RemoteContractError):
            parse_remote_task_contract({"mode": "deploy"})
        with self.assertRaises(RemoteContractError):
            parse_remote_task_contract({"unknown": 1})
        with self.assertRaises(RemoteContractError):
            parse_remote_task_contract({"verification": ["rm -rf /"]})
        with self.assertRaises(RemoteContractError):
            parse_remote_task_contract({"scopePaths": ["../escape"]})
        with self.assertRaises(RemoteContractError):
            parse_remote_task_contract({"scopeArea": "-oops"})
        with self.assertRaises(RemoteContractError):
            parse_remote_task_contract({"qualityGates": {"customerReadinessRequired": False}})


if __name__ == "__main__":
    unittest.main()


class WorkspacePatchTest(unittest.TestCase):
    def test_uncommitted_changes_become_a_checkpoint_patch(self):
        import subprocess
        import tempfile

        from runpod_worker import WorkerService

        with tempfile.TemporaryDirectory() as scratch:
            workspace = Path(scratch) / "ws"
            session = Path(scratch) / "session"
            workspace.mkdir()
            session.mkdir()
            git = lambda *args: subprocess.run(  # noqa: E731
                ["git", "-C", str(workspace), *args], check=True, capture_output=True
            )
            git("init", "-q", "-b", "glimmer/patch-test")
            (workspace / "a.txt").write_text("one\n")
            git("add", "-A")
            git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base")
            (workspace / "a.txt").write_text("two\n")
            (workspace / "new.txt").write_text("created\n")

            WorkerService._workspace_patch(object(), workspace, session)

            patch = (session / "workspace-changes.patch").read_bytes().decode()
            self.assertIn("new.txt", patch)
            self.assertIn("+two", patch)

    def test_clean_workspace_writes_no_patch(self):
        import subprocess
        import tempfile

        from runpod_worker import WorkerService

        with tempfile.TemporaryDirectory() as scratch:
            workspace = Path(scratch) / "ws"
            session = Path(scratch) / "session"
            workspace.mkdir()
            session.mkdir()
            subprocess.run(
                ["git", "-C", str(workspace), "init", "-q"], check=True, capture_output=True
            )
            (workspace / "a.txt").write_text("one\n")
            subprocess.run(
                ["git", "-C", str(workspace), "add", "-A"], check=True, capture_output=True
            )
            subprocess.run(
                [
                    "git", "-C", str(workspace),
                    "-c", "user.email=t@t", "-c", "user.name=t",
                    "commit", "-q", "-m", "base",
                ],
                check=True,
                capture_output=True,
            )

            WorkerService._workspace_patch(object(), workspace, session)

            self.assertFalse((session / "workspace-changes.patch").exists())


class VerificationDependencyInstallTest(unittest.TestCase):
    def _runner(self):
        from runpod_worker import ProcessJobRunner

        return ProcessJobRunner.__new__(ProcessJobRunner)

    def _manifest(self, verification):
        contract = parse_remote_task_contract(
            {"verification": verification} if verification else {}
        )

        class Manifest:
            pass

        manifest = Manifest()
        manifest.contract = contract
        return manifest

    def test_installs_from_each_committed_lockfile_with_fake_npm(self):
        import os
        import stat
        import tempfile

        with tempfile.TemporaryDirectory() as scratch:
            workspace = Path(scratch) / "ws"
            (workspace / "frontend").mkdir(parents=True)
            (workspace / "package-lock.json").write_text("{}")
            (workspace / "frontend" / "package-lock.json").write_text("{}")
            fake_bin = Path(scratch) / "bin"
            fake_bin.mkdir()
            marker = Path(scratch) / "calls.log"
            npm = fake_bin / "npm"
            npm.write_text(f'#!/bin/sh\necho "$PWD $@" >> {marker}\n')
            npm.chmod(npm.stat().st_mode | stat.S_IEXEC)
            log = open(Path(scratch) / "log", "ab", buffering=0)
            previous = os.environ["PATH"]
            os.environ["PATH"] = f"{fake_bin}:{previous}"
            try:
                self._runner()._install_verification_dependencies(
                    workspace, self._manifest(["frontend-typecheck"]), log
                )
            finally:
                os.environ["PATH"] = previous
                log.close()
            calls = marker.read_text().strip().splitlines()
            self.assertEqual(len(calls), 2)
            self.assertIn("ci --no-audit --no-fund", calls[0])
            self.assertTrue(calls[1].split(" ")[0].endswith("/frontend"))

    def test_skips_install_without_verification(self):
        import tempfile

        with tempfile.TemporaryDirectory() as scratch:
            workspace = Path(scratch) / "ws"
            workspace.mkdir()
            (workspace / "package-lock.json").write_text("{}")
            log = open(Path(scratch) / "log", "ab", buffering=0)
            try:
                # No npm on PATH needed: the guard returns before any spawn.
                self._runner()._install_verification_dependencies(
                    workspace, self._manifest([]), log
                )
            finally:
                log.close()
            self.assertEqual((Path(scratch) / "log").read_bytes(), b"")
