#!/usr/bin/env bash
#
# Deploy wizard for OpsPilot: the steps only a human can do to take this repo
# from "checked out" to "live on Vercel." Generated with the /wizard skill.
#
# Everything above the "STAGES" marker is the wizard library: do not hand-edit
# it. Author the per-step stages below the marker.

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Wizard library: delightful, consistent UX, identical across every wizard.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

# Author sets this at the top of the stages section.
TOTAL_STAGES=0

_STAGE_INDEX=0
ENV_FILE="${ENV_FILE:-.env.local}"
WRITTEN_SECRET=() # secret or config NAMEs set this run, GitHub or Vercel
SKIPPED=()        # things we couldn't do, or the human chose to skip

# _clear wipes the terminal so only the current step is on screen. No-op when
# output isn't a terminal, so piped logs stay readable.
_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

# banner "Title" shows the opening frame: what this wizard does.
banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '%s  You drive the browser and the CLI prompts; this wizard tells you\n' "$DIM"
  printf '  exactly what to do and runs the commands. Stop any time with Ctrl-C\n'
  printf '  and re-run later, since it checks what is already done.%s\n' "$RESET"
  pause "Ready to start?"
}

# stage "Name" clears the screen, then announces a stage and shows progress.
# Clearing keeps only the current step on screen.
stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' \
    "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

# say "..." prints a plain instruction line.
say()  { printf '  %s\n' "$1"; }
# step "..." is a numbered-feeling action the human takes in the browser.
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }
ok()   { printf '  %s✓ %s%s\n' "$GREEN" "$1" "$RESET"; }
fail() { printf '  %s✗ %s%s\n' "$RED" "$1" "$RESET"; }

# open_url URL opens it in the human's browser, cross-platform incl. WSL.
open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  { if   command -v wslview     >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open        >/dev/null 2>&1; then open "$url"
    else warn "couldn't open a browser; visit it manually: $url"; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser, so visit it manually: $url"
}

# pause "msg" waits for the human to confirm they've done the manual part.
pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

# confirm "question" is a y/N gate; returns success on yes.
confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

# _existing KEY: current value of KEY in ENV_FILE, if any.
_existing() {
  [[ -f "$ENV_FILE" ]] || return 1
  local line; line=$(grep -E "^${1}=" "$ENV_FILE" | tail -n1) || return 1
  printf '%s' "${line#*=}"
}

# ask KEY "Prompt" reads a value into $KEY. Offers the existing .env value as
# a default on re-runs (Enter keeps it). Visible input (non-secret).
ask() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current: %s]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$current" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -r input || true
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# ask_secret KEY "Prompt" is like ask, but input is hidden and never echoed.
ask_secret() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -rs input || true
  printf '\n'
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# finish clears, then shows a closing summary of everything configured.
finish() {
  _clear
  printf '\n%s%s  ✓ Deploy wizard finished%s\n' "$BOLD" "$GREEN" "$RESET"
  (( ${#WRITTEN_SECRET[@]} )) && note "set ${#WRITTEN_SECRET[@]} value(s): ${WRITTEN_SECRET[*]}"
  if (( ${#SKIPPED[@]} )); then
    printf '\n'; warn "still to do, or intentionally skipped:"
    for s in "${SKIPPED[@]}"; do note "  - $s"; done
  fi
  printf '\n'
}

# ──────────────────────────────────────────────────────────────────────────
# STAGES: author this section. One stage() per step the human takes.
# ──────────────────────────────────────────────────────────────────────────

TOTAL_STAGES=7

# Repo-specific constants. Change these if the target project or team moves.
VERCEL_PROJECT="opspilot"
VERCEL_TEAM="donsuavvys-projects"
AWS_VARS=(AWS_ANTHROPIC_ACCESS_KEY_ID AWS_ANTHROPIC_SECRET_ACCESS_KEY AWS_ANTHROPIC_REGION)

# _dotenv_local KEY: reads KEY from .env.local with grep, quotes stripped.
# Read-only. Never prints the value it finds.
_dotenv_local() {
  local key="$1" line val
  [[ -f .env.local ]] || return 1
  line=$(grep -E "^${key}=" .env.local | tail -n1) || return 1
  val="${line#*=}"
  val="${val%\"}"; val="${val#\"}"
  val="${val%\'}"; val="${val#\'}"
  printf '%s' "$val"
}

# _gh_secret_exists NAME: true if a repo secret with this name is already set.
# `gh secret list` never prints values, only names and update times.
_gh_secret_exists() {
  gh secret list 2>/dev/null | awk '{print $1}' | grep -qx "$1"
}

# _vercel_env_exists NAME ENV: true if NAME is already set for ENV in the
# linked project. Best-effort table scraping since `vercel env ls` has no
# --json output in every CLI version; verify against your installed version
# if this misses a match.
_vercel_env_exists() {
  vercel env ls "$2" 2>/dev/null | awk '{print $1}' | grep -qx "$1"
}

# _vercel_env_set NAME VALUE ENV [--sensitive]: adds NAME to ENV, or updates
# it if already present. Value goes over stdin, never as a CLI argument, so
# it never appears in shell history or `ps`.
_vercel_env_set() {
  local name="$1" value="$2" env="$3"; shift 3
  local extra=("$@")
  local verb write_ok=1
  if _vercel_env_exists "$name" "$env"; then
    note "$name already exists for $env."
    if ! confirm "Overwrite it with the new value?"; then
      SKIPPED+=("Vercel env $name/$env (kept existing value)")
      return 0
    fi
    verb="update"
  else
    verb="add"
  fi
  # Branch on array length rather than expanding "${extra[@]}" directly: an
  # empty array under `set -u` is safe in modern bash but not guaranteed on
  # every bash a human might run this with (macOS ships bash 3.2).
  local vercel_output=""
  if (( ${#extra[@]} )); then
    vercel_output=$(printf '%s' "$value" | vercel env "$verb" "$name" "$env" "${extra[@]}" 2>&1) || write_ok=0
  else
    vercel_output=$(printf '%s' "$value" | vercel env "$verb" "$name" "$env" 2>&1) || write_ok=0
  fi
  if [[ "$verb" == "update" ]]; then
    if (( write_ok )); then
      WRITTEN_SECRET+=("$name")
      ok "updated $name for $env"
    else
      fail "could not update $name; set it by hand: vercel env update $name $env"
      # vercel's own output never echoes the piped value back, so this is safe.
      [[ -n "$vercel_output" ]] && note "  $vercel_output"
      SKIPPED+=("Vercel env $name/$env (update failed)")
    fi
    return 0
  fi
  if (( write_ok )); then
    WRITTEN_SECRET+=("$name")
    ok "added $name for $env"
  else
    fail "could not add $name; set it by hand: vercel env add $name $env"
    [[ -n "$vercel_output" ]] && note "  $vercel_output"
    SKIPPED+=("Vercel env $name/$env (add failed)")
  fi
}

banner "OpsPilot: deploy to Vercel + Neon"

# ── Stage 1: preflight ─────────────────────────────────────────────────────
stage "Preflight"
say "Checking the tools this wizard drives, and that .env.local has local"
say "Bedrock credentials to copy into GitHub and Vercel."
for cmd in gh vercel npm openssl curl git; do
  if command -v "$cmd" >/dev/null 2>&1; then
    ok "$cmd found"
  else
    warn "$cmd not found on PATH; stages that need it will be skipped"
    SKIPPED+=("install $cmd before re-running this wizard")
  fi
done
if [[ -f .env.local ]]; then
  ok ".env.local found"
  for var in "${AWS_VARS[@]}"; do
    preflight_value=$(_dotenv_local "$var" || true)
    if [[ -n "$preflight_value" ]]; then
      ok "$var is set in .env.local"
    else
      warn "$var is missing from .env.local; stage 2 and stage 4 will ask you to skip it"
    fi
  done
else
  warn ".env.local not found; copy .env.example first if you need local Bedrock creds"
fi
pause "Continue?"

# ── Stage 2: GitHub Actions secrets for the eval gate ──────────────────────
stage "GitHub secrets for the Evals CI gate"
say "The Evals workflow (.github/workflows/evals.yml) needs the same three"
say "Bedrock credentials as production, as repository secrets. Read from"
say ".env.local, set with --body, never printed."
if command -v gh >/dev/null 2>&1; then
  for var in "${AWS_VARS[@]}"; do
    value=$(_dotenv_local "$var" || true)
    if [[ -z "$value" ]]; then
      warn "$var not found in .env.local; skipping"
      SKIPPED+=("GitHub secret $var (no value in .env.local)")
      continue
    fi
    if _gh_secret_exists "$var"; then
      note "GitHub secret $var already exists."
      if ! confirm "Overwrite it with the .env.local value?"; then
        SKIPPED+=("GitHub secret $var (kept existing value)")
        continue
      fi
    else
      if ! confirm "Set GitHub secret $var from .env.local?"; then
        SKIPPED+=("GitHub secret $var (not set)")
        continue
      fi
    fi
    gh_output=""
    if gh_output=$(gh secret set "$var" --body "$value" 2>&1); then
      WRITTEN_SECRET+=("$var")
      ok "set GitHub secret $var"
    else
      fail "gh secret set failed for $var; is 'gh auth status' logged in for this repo?"
      # gh's own output never echoes the --body value back, so this is safe to show.
      [[ -n "$gh_output" ]] && note "  $gh_output"
      SKIPPED+=("GitHub secret $var (gh command failed)")
    fi
  done
else
  warn "gh not found; set these by hand once it's installed:"
  for var in "${AWS_VARS[@]}"; do
    note "  gh secret set $var --body \"<value from .env.local>\""
    SKIPPED+=("GitHub secret $var (gh not installed)")
  done
fi
pause "Continue?"

# ── Stage 3: link the Vercel project ────────────────────────────────────────
stage "Link the Vercel project"
say "Links this directory to the '$VERCEL_PROJECT' project under the"
say "'$VERCEL_TEAM' team, creating it if it doesn't exist yet."
do_link=1
if [[ -f .vercel/project.json ]]; then
  note "Already linked: $(cat .vercel/project.json)"
  if ! confirm "Re-link anyway?"; then
    do_link=0
    SKIPPED+=("vercel link (already linked)")
  fi
fi
if (( do_link )); then
  if command -v vercel >/dev/null 2>&1; then
    if vercel link --yes --project="$VERCEL_PROJECT" --scope="$VERCEL_TEAM"; then
      ok "linked to $VERCEL_TEAM/$VERCEL_PROJECT"
    else
      warn "non-interactive link failed; some CLI versions need the interactive flow instead"
      say "Run this by hand and pick (or create) '$VERCEL_PROJECT' under '$VERCEL_TEAM':"
      note "  vercel link"
      if confirm "Run it interactively now?"; then
        vercel link || warn "vercel link did not complete; re-run this wizard once it's linked"
      else
        SKIPPED+=("vercel link (run it by hand: vercel link)")
      fi
    fi
  else
    warn "vercel CLI not found; install it (npm i -g vercel) and re-run"
    SKIPPED+=("vercel link (CLI not installed)")
  fi
fi
pause "Continue?"

# ── Stage 4: production environment variables ───────────────────────────────
stage "Production environment variables"
say "Sets every environment variable the deployed app reads. Values marked"
say "secret never appear on screen."
say "No public-model variable exists to set: the public demo's model is the"
say "constant DEMO_MODEL in src/app/api/agent/run/route.ts, hardcoded to"
say "\"haiku\" rather than read from the environment."

NEON_DATABASE_URL=""
if command -v vercel >/dev/null 2>&1; then
  say "Neon: open your project's dashboard and copy the pooled connection"
  say "string (the one with '-pooler' in the hostname)."
  open_url "https://console.neon.tech"
  ask_secret NEON_DATABASE_URL "Paste the Neon pooled connection string:"
  if [[ -n "$NEON_DATABASE_URL" ]]; then
    _vercel_env_set DATABASE_URL "$NEON_DATABASE_URL" production --sensitive
  else
    warn "no value entered; skipping DATABASE_URL"
    SKIPPED+=("Vercel env DATABASE_URL/production (no value entered)")
  fi

  for var in "${AWS_VARS[@]}"; do
    value=$(_dotenv_local "$var" || true)
    if [[ -z "$value" ]]; then
      warn "$var not found in .env.local; skipping"
      SKIPPED+=("Vercel env $var/production (no value in .env.local)")
      continue
    fi
    if confirm "Set Vercel production env $var from .env.local?"; then
      _vercel_env_set "$var" "$value" production --sensitive
    else
      SKIPPED+=("Vercel env $var/production (not set)")
    fi
  done

  ask OPSPILOT_DAILY_BUDGET_USD_INPUT "Daily spend cap in USD [default 5]:"
  OPSPILOT_DAILY_BUDGET_USD_INPUT="${OPSPILOT_DAILY_BUDGET_USD_INPUT:-5}"
  _vercel_env_set OPSPILOT_DAILY_BUDGET_USD "$OPSPILOT_DAILY_BUDGET_USD_INPUT" production

  ask OPSPILOT_RUNS_PER_MINUTE_INPUT "Runs per minute, per sandbox [default 10]:"
  OPSPILOT_RUNS_PER_MINUTE_INPUT="${OPSPILOT_RUNS_PER_MINUTE_INPUT:-10}"
  _vercel_env_set OPSPILOT_RUNS_PER_MINUTE "$OPSPILOT_RUNS_PER_MINUTE_INPUT" production

  note "OPSPILOT_GLOBAL_RUNS_PER_MINUTE is new: the same check across every"
  note "sandbox combined, so it should be a multiple of the per-sandbox limit"
  note "above, not equal to it. The code default is 20; CI sets 24 for the"
  note "eval suite; 30 leaves production room for visitors and a suite at once."
  ask OPSPILOT_GLOBAL_RUNS_PER_MINUTE_INPUT "Runs per minute, across all sandboxes [suggested 30, code default 20]:"
  OPSPILOT_GLOBAL_RUNS_PER_MINUTE_INPUT="${OPSPILOT_GLOBAL_RUNS_PER_MINUTE_INPUT:-30}"
  _vercel_env_set OPSPILOT_GLOBAL_RUNS_PER_MINUTE "$OPSPILOT_GLOBAL_RUNS_PER_MINUTE_INPUT" production

  ask OPSPILOT_KILL_SWITCH_INPUT "Kill switch on at launch? true/false [default false]:"
  OPSPILOT_KILL_SWITCH_INPUT="${OPSPILOT_KILL_SWITCH_INPUT:-false}"
  _vercel_env_set OPSPILOT_KILL_SWITCH "$OPSPILOT_KILL_SWITCH_INPUT" production

  if confirm "Generate CRON_SECRET with openssl rand -hex 32?"; then
    CRON_SECRET_VALUE=$(openssl rand -hex 32)
    warn "This is shown once. Save it now: it authorizes manual cron calls"
    warn "documented in docs/RUNBOOK.md, and this wizard will not show it again."
    printf '  %s%s%s\n' "$BOLD" "$CRON_SECRET_VALUE" "$RESET"
    pause "Saved it? Press Enter to continue."
    _vercel_env_set CRON_SECRET "$CRON_SECRET_VALUE" production --sensitive
  else
    SKIPPED+=("Vercel env CRON_SECRET/production (not generated)")
  fi
else
  warn "vercel CLI not found; install it and re-run this stage"
  SKIPPED+=("Vercel production env vars (CLI not installed)")
fi
pause "Continue?"

# ── Stage 5: migrate and seed the Neon database ─────────────────────────────
stage "Migrate and seed the Neon database"
say "Runs the schema migration, then the deterministic Beacon Analytics seed,"
say "against Neon rather than local Docker Postgres."
note "Both read DATABASE_URL from the environment first and .env.local"
note "second, so setting it on the command line here doesn't touch your"
note "local dev config."
if [[ -z "${NEON_DATABASE_URL:-}" ]]; then
  ask_secret NEON_DATABASE_URL "Paste the Neon pooled connection string again:"
fi
if [[ -z "$NEON_DATABASE_URL" ]]; then
  warn "no Neon connection string available; skipping migrate + seed"
  SKIPPED+=("db:migrate and db:seed against Neon (no connection string)")
else
  if [[ ! -d node_modules ]]; then
    warn "node_modules not found; run 'npm ci' before continuing"
  fi
  if confirm "Run 'npm run db:migrate' against Neon now?"; then
    if DATABASE_URL="$NEON_DATABASE_URL" npm run db:migrate; then
      ok "migrated"
    else
      fail "migration failed; fix it and re-run this stage before seeding"
      SKIPPED+=("db:migrate against Neon (failed, see output above)")
    fi
  else
    SKIPPED+=("db:migrate against Neon (skipped)")
  fi
  say "db:seed is idempotent: it deletes the demo workspace and re-seeds it,"
  say "so running it again before a demo is expected, not risky."
  if confirm "Run 'npm run db:seed' against Neon now?"; then
    if DATABASE_URL="$NEON_DATABASE_URL" npm run db:seed; then
      ok "seeded"
    else
      fail "seed failed; see output above"
      SKIPPED+=("db:seed against Neon (failed, see output above)")
    fi
  else
    SKIPPED+=("db:seed against Neon (skipped)")
  fi
fi
pause "Continue?"

# ── Stage 6: deploy to production ───────────────────────────────────────────
stage "Deploy to production"
say "Builds and deploys the linked project to production."
DEPLOY_URL=""
if command -v vercel >/dev/null 2>&1; then
  if confirm "Run 'vercel deploy --prod' now?"; then
    DEPLOY_OUTPUT=""
    if DEPLOY_OUTPUT=$(vercel deploy --prod 2>&1); then
      printf '%s\n' "$DEPLOY_OUTPUT"
      DEPLOY_URL=$(printf '%s' "$DEPLOY_OUTPUT" | grep -Eo 'https://[a-zA-Z0-9.-]+\.vercel\.app' | tail -n1)
      if [[ -n "$DEPLOY_URL" ]]; then
        ok "deployed: $DEPLOY_URL"
      else
        warn "deploy finished but no URL was found in its output; check 'vercel ls' for it"
      fi
    else
      printf '%s\n' "$DEPLOY_OUTPUT"
      fail "vercel deploy --prod failed; see output above"
      SKIPPED+=("vercel deploy --prod (failed, see output above)")
    fi
  else
    SKIPPED+=("vercel deploy --prod (skipped)")
  fi
else
  warn "vercel CLI not found; install it and run 'vercel deploy --prod' by hand"
  SKIPPED+=("vercel deploy --prod (CLI not installed)")
fi
pause "Continue?"

# ── Stage 7: smoke test ──────────────────────────────────────────────────────
stage "Smoke test"
if [[ -z "$DEPLOY_URL" ]]; then
  ask DEPLOY_URL "No deploy URL captured. Paste the production URL to smoke-test it (or leave blank to skip):"
fi
if [[ -n "$DEPLOY_URL" ]]; then
  say "Checking $DEPLOY_URL/api/health ..."
  if command -v curl >/dev/null 2>&1; then
    HTTP_STATUS=$(curl -s -o /tmp/opspilot-health.json -w '%{http_code}' "$DEPLOY_URL/api/health" || echo "000")
    printf '  HTTP status: %s\n' "$HTTP_STATUS"
    if [[ -f /tmp/opspilot-health.json ]]; then
      cat /tmp/opspilot-health.json
      printf '\n'
      rm -f /tmp/opspilot-health.json
    fi
    if [[ "$HTTP_STATUS" == "200" ]]; then
      ok "health check returned 200"
    elif [[ "$HTTP_STATUS" == "503" ]]; then
      warn "health check returned 503: something is down, or the kill switch is on"
    else
      warn "health check returned $HTTP_STATUS; see docs/RUNBOOK.md's model-outage section"
    fi
  else
    warn "curl not found; check by hand: $DEPLOY_URL/api/health"
  fi
  printf '\n'
  ok "landing page: $DEPLOY_URL"
else
  warn "no URL to smoke-test; run this stage again once you have one"
  SKIPPED+=("smoke test (no deploy URL)")
fi

finish
