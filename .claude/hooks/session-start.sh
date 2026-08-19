#!/usr/bin/env bash
# SessionStart hook for FB_AI.
# Goal: every session (local or Claude Code on the web) can immediately run
# `npm run typecheck` and `npm test`, with the project's Claude plugins present.
set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$PROJECT_DIR"

status="deps ready"

# Idempotent: only install when node_modules is missing or older than the lockfile.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  if npm install --no-audit --no-fund >/tmp/fb-ai-npm-install.log 2>&1; then
    touch node_modules
    status="deps installed"
  else
    status="deps install FAILED (see /tmp/fb-ai-npm-install.log)"
  fi
fi

# Make node_modules/.bin available to plain shell commands for the whole session.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$PROJECT_DIR/node_modules/.bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi

# Plugin fallback. `.claude/settings.json` already declares the marketplaces and
# plugins; this only covers the case where that declarative install has not run
# yet (e.g. headless sessions). Best-effort and time-boxed — never block startup.
plugins="deps only"
if command -v claude >/dev/null 2>&1; then
  if ! claude plugin list 2>/dev/null | grep -q 'superpowers@superpowers-dev'; then
    {
      for mkt in obra/superpowers anthropics/claude-code anthropics/skills; do
        timeout 120 claude plugin marketplace add "$mkt" || true
      done
      for p in superpowers@superpowers-dev \
               feature-dev@claude-code-plugins \
               code-review@claude-code-plugins \
               commit-commands@claude-code-plugins \
               security-guidance@claude-code-plugins \
               claude-api@anthropic-agent-skills; do
        timeout 120 claude plugin install "$p" || true
      done
    } >/tmp/fb-ai-plugin-install.log 2>&1 || true
    plugins="plugins bootstrapped (active from next session)"
  else
    plugins="plugins ready"
  fi
fi

node_version="$(node --version 2>/dev/null || echo 'node MISSING')"

# Stdout from a SessionStart hook is injected into the session context: keep it short.
cat <<EOF
FB_AI session ready — node $node_version, $status, $plugins.
Checks: npm run typecheck | npm test (vitest + node:test) | npm run dev:dashboard
Spec lives in .kiro/specs/fb-ai/ (requirements.md, design.md, tasks.md). See CLAUDE.md.
EOF
