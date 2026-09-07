"""Insight-based loop detection: near-identical failing tool calls trigger
one visible nudge; healthy variation and success never do."""
import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _sentinel():
    spec = importlib.util.spec_from_file_location("ge_loop", ROOT / "glimmer-engineer.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["ge_loop"] = module
    spec.loader.exec_module(module)
    return module.LoopSentinel()


FAILING = "npm error: Cannot find module 'left-pad'\nnpm ERR! code MODULE_NOT_FOUND"


class LoopSentinelTest(unittest.TestCase):
    def test_three_near_identical_failures_trigger_one_nudge(self):
        sentinel = _sentinel()
        nudges = []
        for attempt in range(4):
            nudge = sentinel.observe(
                "run_shell",
                {"command": f"npm run test -- --attempt {attempt}"},
                FAILING,
            )
            if nudge:
                nudges.append((attempt, nudge))
        self.assertEqual(len(nudges), 1, nudges)
        self.assertEqual(nudges[0][0], 2)  # third call completes the pattern
        self.assertIn("LOOP DETECTED", nudges[0][1])
        self.assertIn("3 times", nudges[0][1])

    def test_successful_repeats_never_nudge(self):
        sentinel = _sentinel()
        for _ in range(6):
            self.assertIsNone(
                sentinel.observe("read_file", {"path": "src/app.ts"}, "export const x = 1;")
            )

    def test_genuinely_different_approaches_never_nudge(self):
        sentinel = _sentinel()
        calls = [
            ("run_shell", {"command": "npm run test"}, FAILING),
            ("read_file", {"path": "package.json"}, '{"name": "x"}'),
            ("run_shell", {"command": "git log --oneline -5"}, "error: unknown revision"),
            ("edit_file", {"path": "src/app.ts", "diff": "..."}, "applied"),
        ]
        for tool, arguments, content in calls:
            self.assertIsNone(sentinel.observe(tool, arguments, content))

    def test_different_failures_on_same_tool_never_nudge(self):
        sentinel = _sentinel()
        self.assertIsNone(sentinel.observe("run_shell", {"command": "npm run test"}, FAILING))
        self.assertIsNone(
            sentinel.observe(
                "run_shell",
                {"command": "npx tsc -p tsconfig.json"},
                "error TS2304: Cannot find name 'foo' in checker.ts",
            )
        )
        self.assertIsNone(
            sentinel.observe(
                "run_shell",
                {"command": "npm run lint"},
                "error: 3 problems (3 errors, 0 warnings) no-unused-vars",
            )
        )


if __name__ == "__main__":
    unittest.main()
