"""Retrieval evals: measured recall for the three retrieval layers.

"RAG-optimized" is a measurement, not a vibe. These evals pin:
  1. the tree-sitter symbol index (retrieval over code),
  2. docs_search's identifier-aware BM25 ranking (retrieval over docs),
  3. repository memory scoring (retrieval over verified experience).
Each case states the query and the expected hit; recall floors are asserted
so a regression in tokenization, parsing, or scoring fails loudly. The
embeddings decision gates on these numbers (docs/retrieval-decision.md).
"""
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import glimmer_semantic  # noqa: E402
from glimmer_semantic import bm25_rank, split_identifier, tokenize_for_search  # noqa: E402


def _load_engineer():
    spec = importlib.util.spec_from_file_location("ge_eval", ROOT / "glimmer-engineer.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["ge_eval"] = module
    spec.loader.exec_module(module)
    return module


class TokenizerEval(unittest.TestCase):
    def test_identifier_splitting(self):
        self.assertEqual(split_identifier("computeControllerV2"), ["compute", "controller", "v2"])
        self.assertEqual(split_identifier("snake_case_name"), ["snake", "case", "name"])
        self.assertEqual(split_identifier("HTTPServer"), ["http", "server"])
        self.assertIn("controller", tokenize_for_search("computeController.ts"))


class SymbolIndexEval(unittest.TestCase):
    """Recall of the tree-sitter index over a synthetic polyglot workspace."""

    CASES = [
        ("fetchUserProfile", "src/api.js"),
        ("RetryPolicy", "src/policy.py"),
        ("apply_backoff", "src/policy.py"),
        ("CheckoutCart", "src/cart.ts"),
    ]

    def test_symbol_recall_is_total(self):
        with tempfile.TemporaryDirectory() as scratch:
            workspace = Path(scratch)
            (workspace / "src").mkdir()
            (workspace / "src" / "api.js").write_text(
                "export function fetchUserProfile(id) { return id; }\n"
            )
            (workspace / "src" / "policy.py").write_text(
                "class RetryPolicy:\n    pass\n\n\ndef apply_backoff(delay):\n    return delay\n"
            )
            (workspace / "src" / "cart.ts").write_text(
                "export class CheckoutCart { total(): number { return 0; } }\n"
            )
            subprocess.run(
                ["git", "-C", scratch, "init", "-q"], check=True, capture_output=True
            )
            subprocess.run(
                ["git", "-C", scratch, "add", "-A"], check=True, capture_output=True
            )
            subprocess.run(
                [
                    "git", "-C", scratch,
                    "-c", "user.email=t@t", "-c", "user.name=t",
                    "commit", "-q", "-m", "fixture",
                ],
                check=True,
                capture_output=True,
            )
            index = glimmer_semantic.build_repo_index(workspace)
            symbols = {
                (symbol["name"], symbol["path"]) for symbol in index.get("symbols", [])
            }
            hits = sum(1 for name, path in self.CASES if (name, path) in symbols)
            recall = hits / len(self.CASES)
            print(f"[retrieval-eval] symbol index recall: {recall:.2f} ({hits}/{len(self.CASES)})")
            self.assertEqual(recall, 1.0, f"missing symbols: {self.CASES} vs {symbols}")


class DocsSearchEval(unittest.TestCase):
    """Recall@3 for docs_search, including the sub-word queries the old
    exact-token matcher missed."""

    GRAPH = {
        "nodes": [
            {"id": "auth-flow", "type": "doc", "status": "ok",
             "path": "docs/authFlow.md", "title": "AuthFlow token refresh"},
            {"id": "billing", "type": "doc", "status": "ok",
             "path": "docs/billing.md", "title": "Billing invoices and receipts"},
            {"id": "compute", "type": "doc", "status": "ok",
             "path": "docs/computeController.md", "title": "RunPod compute lifecycle"},
            {"id": "design-review", "type": "doc", "status": "ok",
             "path": "docs/designReview.md", "title": "Visual design review gates"},
        ]
    }
    CASES = [
        ("token refresh", "auth-flow"),
        ("auth flow", "auth-flow"),           # sub-words of AuthFlow/authFlow
        ("compute controller", "compute"),    # sub-words of computeController
        ("invoices", "billing"),
        ("runpod lifecycle", "compute"),
        ("design gates", "design-review"),
    ]

    def test_docs_recall_at_3(self):
        engineer = _load_engineer()
        hits = 0
        for query, expected in self.CASES:
            output = engineer._docs_search(query, self.GRAPH, "/nonexistent")
            top3 = output.splitlines()[:3]
            if any(f"node {expected} " in line for line in top3):
                hits += 1
        recall = hits / len(self.CASES)
        print(f"[retrieval-eval] docs_search recall@3: {recall:.2f} ({hits}/{len(self.CASES)})")
        self.assertEqual(recall, 1.0)

    def test_ranking_puts_the_best_match_first(self):
        ranked = bm25_rank(
            "token refresh",
            [(node["id"], f"{node['path']} {node['title']}") for node in self.GRAPH["nodes"]],
        )
        self.assertEqual(ranked[0][0], "auth-flow")


class MemoryScoringEval(unittest.TestCase):
    """Verified-repository-memory retrieval: observation floor and recency
    decay must surface the right entries in the right order."""

    def test_threshold_and_decay_ordering(self):
        import glimmer_memory

        now = datetime.now(timezone.utc)
        with tempfile.TemporaryDirectory() as scratch:
            workspace = Path(scratch)
            subprocess.run(["git", "-C", scratch, "init", "-q"], check=True, capture_output=True)
            state_root = workspace / "state"
            entries = [
                {"kind": "cochange", "key": "fresh-frequent", "count": 6,
                 "lastSeen": now.isoformat()},
                {"kind": "cochange", "key": "stale-frequent", "count": 6,
                 "lastSeen": (now - timedelta(days=365)).isoformat()},
                {"kind": "cochange", "key": "below-floor", "count": 1,
                 "lastSeen": now.isoformat()},
            ]
            memory_file = glimmer_memory.memory_path(workspace, state_root)
            memory_file.parent.mkdir(parents=True, exist_ok=True)
            memory_file.write_text(
                json.dumps({
                    "schemaVersion": glimmer_memory.SCHEMA_VERSION,
                    "repoIdentity": glimmer_memory.repo_identity(workspace),
                    "updatedAt": now.isoformat(),
                    "entries": entries,
                })
            )

            effective = glimmer_memory.effective_entries(workspace, "cochange", state_root)
            keys = [entry["key"] for entry in effective]
            print(f"[retrieval-eval] memory ordering: {keys}")
            self.assertNotIn("below-floor", keys)
            self.assertEqual(keys[0], "fresh-frequent")
            self.assertLess(keys.index("fresh-frequent"), keys.index("stale-frequent"))


if __name__ == "__main__":
    unittest.main()


class ObjectiveClarityEval(unittest.TestCase):
    """Precision/recall of the deterministic clarity assessor. Cases mirror
    real composer inputs in both languages; every verdict is asserted so a
    tokenizer or stopword change fails loudly."""

    VOCAB = {"computecontroller", "auth", "billing", "readme"}
    UNDERSPECIFIED = [
        "fiks dette",
        "fix it",
        "fix this",
        "gjør det bedre",
        "make it better",
    ]
    CLEAR = [
        "Fix the race in computeController.ts",
        "Les README eller package.json og skriv en kort oppsummering",
        "Improve error handling in the auth module",
        "Rydd opp i billing-koden og fjern død kode",
        "Add retry logic to the RunPod client",
    ]

    def test_clarity_verdicts(self):
        from glimmer_semantic import assess_objective_clarity

        wrong = []
        for objective in self.UNDERSPECIFIED:
            verdict = assess_objective_clarity(objective, self.VOCAB)
            if verdict["clarity"] != "underspecified":
                wrong.append((objective, verdict))
        for objective in self.CLEAR:
            verdict = assess_objective_clarity(objective, self.VOCAB)
            if verdict["clarity"] != "clear":
                wrong.append((objective, verdict))
        total = len(self.UNDERSPECIFIED) + len(self.CLEAR)
        print(f"[retrieval-eval] clarity accuracy: {(total - len(wrong))}/{total}")
        self.assertEqual(wrong, [])
