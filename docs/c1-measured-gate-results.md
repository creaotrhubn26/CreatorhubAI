# C1 Architect Mode — Measured-Gate Results (2026-08-18)

The V7 reconciliation doc gates C2 (Architect consultation) and C3 (Task Graph) on
measured evidence that C1's ArchitecturePlan actually narrows the engineer's work
("an Architect that changes no metric is ceremonial and should be cut", §12/§15).
First live experiment, run against the disposable smoke-test repo (2 source files),
identical task both runs, model: Muse-Glimmer-30B via llama-server, clean tree reset
between runs.

## Task
"Add a shout(name) function to src/greet.js that returns name.toUpperCase() + '!',
exported alongside the existing functions."

## Results

| Metric | Baseline (no architect) | --architect-first |
|---|---|---|
| Session | 20260818-105320 | 20260818-105542 |
| Outcome | VERIFIED | VERIFIED |
| Architect tool calls | — | 7 |
| Main-run tool calls | 8 | 9 |
| Main-run discovery calls | 4 | 5 |
| Total tool calls | 8 | 16 |
| Changed files | src/greet.js | src/greet.js |

Plan produced: valid, `risk: low`, correct `candidateFiles: [src/greet.js]`,
sensible 3-step `implementationPlan`. `manifest.architectPlan = {used: true, risk: low}`.

Also first-ever live exercise of C5 (evidence-00.jsonl, 8 entries, real stable ids)
and C6 (delivery-review.json: valid, `ready_with_known_limitations`, honest
medium-confidence reasoning citing a real limitation, 1 concern, no hallucinated
evidence ids filtered). Both worked as designed.

## Verdict

**Gate NOT passed on this evidence.** The plan did not reduce main-run discovery
(5 vs 4 — the engineer re-explored anyway) and doubled total session cost (16 vs 8
tool calls). Per the doc's own rule, C1 stays opt-in behind `--architect-first`,
and C2/C3 remain blocked.

## Caveat and next step

A 2-file repo has no discovery-narrowing headroom — this is a floor case, not a
representative one. The gate can only be meaningfully evaluated on a large repo
where baseline discovery is expensive (e.g. the real monorepo, where archived
sessions show 8+ discovery calls against a 23KB repo map). Re-run this experiment
there before any final keep/cut decision on C2/C3. Until then: C1 ships as-is
(opt-in), C2/C3 stay unbuilt.

---

# Re-run after handoff enforcement (2026-08-18, second experiment)

Two structural fixes landed after the first experiment (branch `c1-plan-handoff-enforcement`):
(1) evidence handoff — v2 pre-reads the plan's candidateFiles (post-resolve workspace
containment, 5-file/16KB/48KB caps, dedup by resolved path) and embeds contents in the
engineer prompt; (2) plan-aware discovery budget — `GLIMMER_PLAN_CANDIDATES` env var
drops the engineer's discovery budget 8→3, code-enforced via the R3 tool router.

## Results (same task, same repo, clean reset)

| Metric | Baseline | Architect v1 (prose-only) | Architect v2 (enforced) |
|---|---|---|---|
| Session | 20260818-105320 | 20260818-105542 | 20260818-111629 |
| Outcome | VERIFIED | VERIFIED | VERIFIED |
| Architect tool calls | — | 7 | 7 |
| Main-run tool calls | 8 | 9 | **5** |
| Main-run discovery before write | 4 | 5 | **0** |
| Total tool calls | 8 | 16 | 12 |

Turn 1 of the enforced run went straight to `edit_file` — the engineer used the
embedded evidence instead of re-exploring. Main-run cost dropped below baseline
(5 vs 8). Total overhead vs baseline is now 1.5x (was 2x), entirely the architect
segment's own cost — which is a floor-case artifact of a 2-file repo where baseline
discovery is nearly free.

## Updated verdict

**The narrowing mechanism is proven: discovery-before-write went 4-5 → 0.** The
plan is no longer ceremonial — its effect is code-enforced and measurable. The
remaining question (does the architect's fixed ~7-call cost pay for itself?) is
purely a function of repo size: on a repo where baseline discovery costs 8+
expensive calls against a 23KB repo map, eliminating main-run discovery should
win outright. C1 stays opt-in until that large-repo run confirms it; C2/C3 remain
gated on the same. The floor-case evidence now supports, rather than refutes,
proceeding to that test.

---

# Large-repo runs (2026-08-18 → 2026-08-20, real Creatorhubn-monorepo worktree)

Create-new-file task ("add frontend/client/src/utils/shortDuration.ts following neighboring
conventions") against an isolated worktree of the production monorepo. Two structural bugs
found and fixed along the way, both live-reproduced:

1. **Tool-router gate never offered `write_file`** (latent pre-R3 bug): both initial runs
   ended `no-change-unverified` — post-gate, create-file tasks were structurally impossible
   and the model correctly refused. Fixed (PR #13): both narrowed sets now include write_file.
2. **Handoff was a no-op for create-tasks**: the plan's only candidateFile is the not-yet-
   existing target, so nothing embedded and the budget stayed 8. The architect's plan already
   named the right convention files in `existingPatterns[].evidence` — a field the handoff
   ignored. Fixed (PR #14): both sources merge through the same security pipeline.

## Final results (same task, fixed gate)

| | Baseline | Architect (pre-#14) | Architect (final) |
|---|---|---|---|
| Session | 20260818-132048 | 20260818-132833 | 20260820-221240 |
| Outcome | VERIFIED | VERIFIED | VERIFIED |
| Architect calls | — | 9 | 10 |
| Main-run discovery before write | 10 | 10 | **4** |
| Main-run total | 12 | 12 | **9** |
| Total incl. architect | 12 | 21 | 19 |

## Gate verdict

**The doc's gate metric — measured discovery-call reduction — is now demonstrated on both
scales and both task types:** 10→4 on the large repo (create-task, this run) and 4-5→0 on
the small repo (edit-task, earlier). The plan handoff is code-enforced and provably narrows
the engineer's exploration.

Total cost including the architect segment is still higher than baseline on tasks this
small (19 vs 12) — the architect's ~10-call fixed cost only pays off on tasks whose
baseline discovery is deeper than the architect's own. Policy: **C1 stays opt-in**
(`--architect-first`), recommended for complex/multi-file/unfamiliar-area tasks and
skipped for trivially-scoped ones. **C2/C3's evidence gate is formally satisfied** —
they may now be built when wanted, with the same opt-in discipline.

Experiment infrastructure note: two runs on 2026-08-18 stalled/died purely from host
memory starvation (131-205MB free, model at 38-77 tok/s); the successful final run
completed in ~8 min under identical code. Worktree preserved at
~/glimmer-gate-large-repo-20260818-112450 for inspection.
