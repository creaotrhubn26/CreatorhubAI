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
