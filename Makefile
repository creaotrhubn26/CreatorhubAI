PYTHON ?= python3
RUFF ?= ruff
MYPY ?= mypy

PYTHON_FILES := \
	glimmer-agent.py \
	glimmer-engineer.py \
	glimmer-eval.py \
	glimmer-metrics.py \
	glimmer-v2.py \
	glimmer-visual.py \
	glimmer_events.py \
	glimmer_journal.py \
	glimmer_models.py

.PHONY: quality lint typecheck compile selfcheck

quality: lint typecheck compile selfcheck

lint:
	$(RUFF) check $(PYTHON_FILES)

typecheck:
	$(MYPY) glimmer_events.py glimmer_journal.py glimmer_models.py

compile:
	$(PYTHON) -m compileall -q $(PYTHON_FILES)

selfcheck:
	$(PYTHON) glimmer_events.py
	$(PYTHON) glimmer_journal.py --selfcheck
	$(PYTHON) glimmer_models.py
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
