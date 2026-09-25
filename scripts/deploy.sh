#!/usr/bin/env bash
# Run checks, then deploy. With STRICT_DEPLOY=1 (set it in .env), also
# refuse to deploy anything that isn't exactly origin/main.
#
# Strict mode is opt-in because self-hosters usually carry local edits to
# wrangler.jsonc (bucket name, crons) and deploy from a dirty tree. For the
# maintainer's own instance it is on:
#
# The production worker was once deployed from a checkout that didn't match
# main, and two finished commits (paged `read`, history snapshots) sat on a
# laptop for weeks while everyone assumed they were live. This refuses to
# deploy anything that isn't exactly origin/main with passing checks.
#
# Escape hatch for testing a branch: ALLOW_BRANCH_DEPLOY=1 npm run deploy
# (prints a loud warning; redeploy main afterwards).
#
# Account: set CLOUDFLARE_ACCOUNT_ID in .env (gitignored) if your login can
# see more than one account. Extra args pass through to wrangler, e.g.
#   npm run deploy -- --config wrangler.duvland.jsonc
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")

if [ "${STRICT_DEPLOY:-}" != "1" ]; then
  : # not strict: checks only
elif [ "${ALLOW_BRANCH_DEPLOY:-}" != "1" ]; then
  git fetch -q origin main
  if [ "$branch" != "main" ]; then
    echo "✗ On '$branch', not main. Merge first, or ALLOW_BRANCH_DEPLOY=1 to override." >&2
    exit 1
  fi
  if [ -n "$(git status --porcelain)" ]; then
    echo "✗ Working tree has uncommitted changes." >&2
    git status --short >&2
    exit 1
  fi
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    echo "✗ HEAD is not origin/main. Push or pull first:" >&2
    git log --oneline origin/main..HEAD | sed 's/^/  ahead:  /' >&2
    git log --oneline HEAD..origin/main | sed 's/^/  behind: /' >&2
    exit 1
  fi
else
  echo "⚠ ALLOW_BRANCH_DEPLOY=1: deploying '$branch' @ $(git rev-parse --short HEAD). Redeploy main when done." >&2
fi

npm run typecheck
npm run lint
npm run test:unit

npx wrangler deploy --message "$(git rev-parse --short HEAD 2>/dev/null || echo local) ($branch)" "$@"
