#!/usr/bin/env bash
set -euo pipefail

REPO="/Users/danielqazi/Creatorhubn-monorepo"
BASE="origin/main"
WORKTREE_ROOT="/Users/danielqazi"

if [[ $# -lt 1 ]]; then
    echo "Usage:"
    echo "  new-glimmer-task.sh <task-name>"
    echo
    echo "Example:"
    echo "  new-glimmer-task.sh role-room-story-logic"
    exit 1
fi

RAW_NAME="$1"

# Safe branch/worktree slug
SLUG="$(
    printf '%s' "$RAW_NAME" |
    tr '[:upper:]' '[:lower:]' |
    sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//'
)"

if [[ -z "$SLUG" ]]; then
    echo "ERROR: Could not create a valid task slug."
    exit 1
fi

STAMP="$(date '+%Y%m%d-%H%M%S')"

BRANCH="glimmer/${SLUG}-${STAMP}"
WORKTREE="${WORKTREE_ROOT}/glimmer-${SLUG}-${STAMP}"

echo "========================================"
echo " GLIMMER NEW TASK"
echo "========================================"
echo
echo "Repository: $REPO"
echo "Task:       $RAW_NAME"
echo

cd "$REPO"

echo "→ Fetching latest GitHub state..."
git fetch origin --prune

REMOTE_SHA="$(git rev-parse "$BASE")"

echo
echo "Latest origin/main:"
git log -1 --oneline "$BASE"

echo
echo "SHA:"
echo "$REMOTE_SHA"

# Ensure target branch does not already exist.
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    echo
    echo "ERROR: Branch already exists:"
    echo "  $BRANCH"
    exit 1
fi

# Ensure target worktree directory does not already exist.
if [[ -e "$WORKTREE" ]]; then
    echo
    echo "ERROR: Worktree path already exists:"
    echo "  $WORKTREE"
    exit 1
fi

echo
echo "→ Creating isolated branch:"
echo "  $BRANCH"

echo
echo "→ Creating isolated worktree:"
echo "  $WORKTREE"

git worktree add \
    --no-track \
    -b "$BRANCH" \
    "$WORKTREE" \
    "$BASE"

cd "$WORKTREE"

HEAD_SHA="$(git rev-parse HEAD)"
CURRENT_BRANCH="$(git branch --show-current)"
STATUS="$(git status --porcelain)"

echo
echo "========================================"
echo " VERIFYING BASELINE"
echo "========================================"

echo
echo "Branch:"
echo "$CURRENT_BRANCH"

echo
echo "HEAD:"
echo "$HEAD_SHA"

echo
echo "origin/main:"
echo "$REMOTE_SHA"

if [[ "$HEAD_SHA" != "$REMOTE_SHA" ]]; then
    echo
    echo "ERROR: HEAD does not match fetched origin/main."
    exit 1
fi

if [[ -n "$STATUS" ]]; then
    echo
    echo "ERROR: New worktree is unexpectedly dirty:"
    echo "$STATUS"
    exit 1
fi

UPSTREAM="$(
    git rev-parse \
        --abbrev-ref \
        '@{upstream}' \
        2>/dev/null || true
)"

if [[ -n "$UPSTREAM" ]]; then
    echo
    echo "ERROR: Branch unexpectedly has upstream:"
    echo "  $UPSTREAM"
    exit 1
fi

echo
echo "✓ HEAD matches latest fetched origin/main"
echo "✓ Working tree clean"
echo "✓ Dedicated Glimmer branch"
echo "✓ No upstream configured"

echo
echo "========================================"
echo " READY"
echo "========================================"
echo
echo "Branch:"
echo "  $BRANCH"
echo
echo "Workspace:"
echo "  $WORKTREE"
echo
echo "Baseline:"
echo "  $REMOTE_SHA"
echo
echo "Start Glimmer server with:"
echo
printf 'GLIMMER_AGENT_MODE=write \\\n'
printf '  ~/AI/muse-glimmer/start-glimmer-agent.sh \\\n'
printf '  %q\n' "$WORKTREE"

echo
echo "Run engineering agent with:"
echo
printf '~/AI/muse-glimmer/glimmer-engineer.py \\\n'
printf '  --workspace %q \\\n' "$WORKTREE"
printf '  "YOUR ENGINEERING TASK HERE"\n'
echo
