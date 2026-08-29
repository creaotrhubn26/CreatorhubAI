# Glimmer evaluation baselines

Stub and live measurements are stored separately. `baseline-*` records the
unmodified orchestrator at `cd2010958f884e406e04142ed16573e16b9c1278`;
`latest-*` records the corresponding post-change run. The full generated
result path is retained in each summary, while this directory contains only
aggregate quality facts and no prompts or repository source.

The committed live measurement is explicitly a one-task smoke comparison,
not the full 28-task live gate. The unchanged baseline timed out at the fixed
600-second limit; the corresponding post-change task passed in 572.77 seconds.
Both summaries therefore retain `qualityGateStatus: incomplete_full_live_suite`
until the complete live matrix is run on model capacity suitable for the gate.

The deterministic suite intentionally contains one rigged false-VERIFIED
fixture. It proves the independent grader catches a verifier/report mismatch;
the gate is therefore no regression from the baseline count, not a fabricated
zero for this test-only case.
