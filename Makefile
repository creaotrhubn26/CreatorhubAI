PYTHON ?= python3
VENV_BIN ?= .venv/bin
RUFF ?= $(if $(wildcard $(VENV_BIN)/ruff),$(VENV_BIN)/ruff,ruff)
MYPY ?= $(if $(wildcard $(VENV_BIN)/mypy),$(VENV_BIN)/mypy,mypy)

PYTHON_FILES := \
	glimmer-agent.py \
	glimmer-engineer.py \
	glimmer-eval.py \
	glimmer-metrics.py \
	glimmer-v2.py \
	glimmer-visual.py \
	glimmer_events.py \
	glimmer_journal.py \
	glimmer_models.py \
	glimmer_memory.py \
	glimmer_quality.py \
	glimmer_remote.py \
	glimmer_semantic.py \
	glimmer_verification.py \
	docker/runpod/bootstrap_status.py \
	docker/runpod/fetch_artifact.py \
	runpod_worker.py

RUNPOD_TESTS := \
	tests.test_glimmer_remote \
	tests.test_bootstrap_status \
	tests.test_runpod_worker \
	tests.test_fetch_artifact \
	tests.test_runpod_entrypoint

.PHONY: quality lint typecheck compile selfcheck remote-test image-contract

quality: lint typecheck compile selfcheck remote-test image-contract

lint:
	$(RUFF) check $(PYTHON_FILES)

typecheck:
	$(MYPY) glimmer_events.py glimmer_journal.py glimmer_models.py glimmer_memory.py glimmer_remote.py

compile:
	$(PYTHON) -m compileall -q $(PYTHON_FILES)

selfcheck:
	$(PYTHON) glimmer_events.py
	$(PYTHON) glimmer_journal.py --selfcheck
	$(PYTHON) glimmer_models.py
	$(PYTHON) glimmer_memory.py
	$(PYTHON) glimmer_quality.py
	$(PYTHON) glimmer_semantic.py
	$(PYTHON) glimmer_verification.py
	$(PYTHON) glimmer-engineer.py --streaming-transport-selfcheck
	$(PYTHON) glimmer-engineer.py --github-cli-selfcheck
	$(PYTHON) glimmer-engineer.py --task-report-selfcheck
	$(PYTHON) glimmer-engineer.py --model-provider-selfcheck
	$(PYTHON) glimmer-engineer.py --semantic-tools-selfcheck
	$(PYTHON) glimmer-engineer.py --mcp-permissions-selfcheck
	$(PYTHON) glimmer-v2.py --architect-risk-selfcheck
	$(PYTHON) glimmer-v2.py --quality-gates-selfcheck
	$(PYTHON) glimmer-v2.py --skills-selfcheck
	$(PYTHON) glimmer-visual.py --selfcheck
	$(PYTHON) glimmer-metrics.py --selfcheck
	$(PYTHON) glimmer-eval.py --selfcheck

remote-test:
	$(PYTHON) -m unittest $(RUNPOD_TESTS)

image-contract:
	$(PYTHON) scripts/verify-runpod-workflow.py
	scripts/verify-runpod-image.sh
