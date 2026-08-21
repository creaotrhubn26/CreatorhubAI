---
name: creatorhub-typecheck
areas: frontend
filetypes: .ts, .tsx
---
# CreatorHub frontend typecheck

Verification for `frontend/**` changes is `tsc --noEmit`, run as:

    npm --prefix frontend run typecheck

This is a large, long-running TypeScript project. The trusted v2.1
wrapper already runs this as authoritative post-edit verification with a
raised Node heap (`GLIMMER_NODE_HEAP_MB`, default 12288MB via
`--max-old-space-size` — see `start-glimmer-agent.sh`) because the
default Node heap limit is not enough for a full project typecheck here.

Do NOT run this yourself (or any other broad typecheck/lint/test/build)
from inside an engineering session — v2 owns verification. Narrow,
single-file diagnostic commands are fine when you need a quick signal.
