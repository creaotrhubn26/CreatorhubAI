# Retrieval architecture decision (2026-09-07)

Glimmer's retrieval-augmented pipeline has three layers, each with measured
recall in `tests/test_retrieval_eval.py`:

| Layer | Mechanism | Eval result |
|---|---|---|
| Code | tree-sitter symbol index (cache keyed on HEAD+dirty+parser versions) | recall 1.00 |
| Docs/ADR | identifier-aware BM25 (`glimmer_semantic.bm25_rank`) | recall@3 1.00 |
| Experience | verified repository memory (observation floor + half-life decay) | ordering exact |

## Decision: no embeddings for now

Semantic embeddings were considered for the docs layer. Deferred because:

1. The measured gap they would close is currently zero: identifier-aware
   tokenization (camelCase/snake_case sub-words) plus BM25 ranking scores
   1.00 on the eval set, including the partial-phrase queries exact-token
   matching missed.
2. Code retrieval is deliberately lexical/structural — identifiers are
   exact, and agentic grep+read outperforms vector search on source.
3. Embeddings add a model dependency in the Pod, an index build step, and
   nondeterminism to a pipeline whose tests are otherwise exact.

## Re-open trigger

Add failing cases to `DocsSearchEval.CASES` as they are found in real use.
If recall@3 drops below 0.9 and the misses are semantic (synonyms, cross-
language phrasing) rather than tokenization bugs, revisit embeddings for
the DOCS layer only (llama-server can serve them Pod-side).
