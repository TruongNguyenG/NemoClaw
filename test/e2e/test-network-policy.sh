#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# =============================================================================
# test-network-policy.sh
# NemoClaw Network Policy E2E Tests
#
# Covers:
#   TC-NET-01: Deny-by-default egress (blocked URL returns 403)
#   TC-NET-02: Whitelisted endpoint access (PyPI reachable)
#   TC-NET-03: Live policy-add without restart (telegram preset)
#   TC-NET-04: policy-add --dry-run (no changes applied)
#   TC-NET-07: Inference exemption + direct provider blocked
#
# Prerequisites:
#   - Docker running
#   - NemoClaw installed (or install.sh available)
#   - NVIDIA_API_KEY for sandbox onboard
# =============================================================================

set -euo pipefail

# ── Overall timeout ──────────────────────────────────────────────────────────
if [ -z "${NEMOCLAW_E2E_NO_TIMEOUT:-}" ]; then
  export NEMOCLAW_E2E_NO_TIMEOUT=1
  TIMEOUT_SECONDS="${NEMOCLAW_E2E_TIMEOUT_SECONDS:-3600}"
  if command -v timeout >/dev/null 2>&1; then
    exec timeout -s TERM "$TIMEOUT_SECONDS" bash "$0" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    exec gtimeout -s TERM "$TIMEOUT_SECONDS" bash "$0" "$@"
  fi
fi

# ── Config ───────────────────────────────────────────────────────────────────
SANDBOX_NAME="e2e-net-policy"
LOG_FILE="test-network-policy-$(date +%Y%m%d-%H%M%S).log"

if command -v gtimeout &>/dev/null; then
  TIMEOUT_CMD="gtimeout"
else
  TIMEOUT_CMD="timeout"
fi

# ── Colors ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0
TOTAL=0

# Log a timestamped message to stdout and the log file.
log() { echo -e "${CYAN}[$(date +%H:%M:%S)]${NC} $*" | tee -a "$LOG_FILE"; }
# Record a passing test assertion.
pass() {
  ((PASS += 1))
  ((TOTAL += 1))
  echo -e "${GREEN}  PASS${NC} $1" | tee -a "$LOG_FILE"
}
# Record a failing test assertion with a reason.
fail() {
  ((FAIL += 1))
  ((TOTAL += 1))
  echo -e "${RED}  FAIL${NC} $1 — $2" | tee -a "$LOG_FILE"
}
# Record a skipped test with a reason.
skip() {
  ((SKIP += 1))
  ((TOTAL += 1))
  echo -e "${YELLOW}  SKIP${NC} $1 — $2" | tee -a "$LOG_FILE"
}

# ── Resolve repo root ────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ── Install NemoClaw if not present ──────────────────────────────────────────
install_nemoclaw() {
  if command -v nemoclaw >/dev/null 2>&1; then
    log "nemoclaw already installed: $(nemoclaw --version 2>/dev/null || echo unknown)"
    return
  fi
  log "=== Installing NemoClaw via install.sh ==="
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
    NVIDIA_API_KEY="${NVIDIA_API_KEY:-nvapi-DUMMY-FOR-INSTALL}" \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    bash "$REPO_ROOT/install.sh" --non-interactive --yes-i-accept-third-party-software \
    2>&1 | tee -a "$LOG_FILE" || true

  if [ -f "$HOME/.bashrc" ]; then
    # shellcheck source=/dev/null
    source "$HOME/.bashrc" 2>/dev/null || true
  fi
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
  fi
  if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    export PATH="$HOME/.local/bin:$PATH"
  fi
}

# ── Pre-flight ───────────────────────────────────────────────────────────────
preflight() {
  log "=== Pre-flight checks ==="
  if ! docker info >/dev/null 2>&1; then
    log "ERROR: Docker is not running."
    exit 1
  fi
  log "Docker is running"
  install_nemoclaw
  log "nemoclaw: $(nemoclaw --version 2>/dev/null || echo unknown)"
  log "Pre-flight complete"
}

# Execute a command inside the sandbox via SSH.
sandbox_exec() {
  local cmd="$1"
  local ssh_cfg
  ssh_cfg="$(mktemp)"
  if ! openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_cfg" 2>/dev/null; then
    log "  [sandbox_exec] Failed to get SSH config"
    rm -f "$ssh_cfg"
    echo ""
    return 1
  fi
  local result ssh_exit=0
  result=$($TIMEOUT_CMD 120 ssh -F "$ssh_cfg" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" "$cmd" 2>&1) || ssh_exit=$?
  rm -f "$ssh_cfg"
  echo "$result"
  return $ssh_exit
}

# ── Onboard sandbox ─────────────────────────────────────────────────────────
setup_sandbox() {
  local api_key="${NVIDIA_API_KEY:-}"
  if [[ -z "$api_key" ]]; then
    log "ERROR: NVIDIA_API_KEY not set"
    exit 1
  fi

  if nemoclaw list 2>/dev/null | grep -q "$SANDBOX_NAME"; then
    log "Removing existing sandbox '$SANDBOX_NAME'..."
    nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
  fi

  log "=== Onboarding sandbox '$SANDBOX_NAME' with restricted policy ==="
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_POLICY_TIER="restricted" \
    $TIMEOUT_CMD 600 nemoclaw onboard --non-interactive --yes-i-accept-third-party-software \
    2>&1 | tee -a "$LOG_FILE" || {
    log "FATAL: Onboard failed"
    exit 1
  }
  log "Sandbox '$SANDBOX_NAME' onboarded with restricted policy"
}

# =============================================================================
# TC-NET-01: Deny-by-default egress
# =============================================================================
test_net_01_deny_default() {
  log "=== TC-NET-01: Deny-by-Default Egress ==="

  local blocked_url="https://example.com/"
  log "  Probing blocked URL from inside sandbox: $blocked_url"

  local response
  response=$(sandbox_exec "curl -s -o /dev/null -w '%{http_code}' --max-time 15 $blocked_url 2>&1") || true

  log "  Response: $response"

  if echo "$response" | grep -qE "403|000"; then
    pass "TC-NET-01: Non-whitelisted URL blocked (status: $response)"
  elif echo "$response" | grep -qE "^[2-3]"; then
    fail "TC-NET-01: Deny default" "Non-whitelisted URL returned success (status: $response)"
  else
    pass "TC-NET-01: Non-whitelisted URL blocked (curl error/refused)"
  fi
}

# =============================================================================
# TC-NET-02: Whitelisted endpoint access
# =============================================================================
test_net_02_whitelist_access() {
  log "=== TC-NET-02: Whitelisted Endpoint Access ==="

  log "  Adding pypi preset for whitelist test..."
  nemoclaw "$SANDBOX_NAME" policy-add pypi --yes 2>&1 | tee -a "$LOG_FILE" || true

  local whitelisted_url="https://pypi.org/simple/"
  log "  Probing whitelisted URL from inside sandbox: $whitelisted_url"

  local response
  response=$(sandbox_exec "curl -s -o /dev/null -w '%{http_code}' --max-time 30 $whitelisted_url 2>&1") || true

  log "  Response: $response"

  if echo "$response" | grep -qE "^[2-3]"; then
    pass "TC-NET-02: Whitelisted endpoint reachable (status: $response)"
  else
    fail "TC-NET-02: Whitelist" "Whitelisted URL not reachable (status: $response)"
  fi
}

# =============================================================================
# TC-NET-03: Live policy-add without restart
# =============================================================================
test_net_03_live_policy_add() {
  log "=== TC-NET-03: Live Policy-Add Without Restart ==="

  local target_url="https://api.telegram.org/"

  log "  Step 1: Verify api.telegram.org is blocked before policy-add..."
  local before
  before=$(sandbox_exec "curl -s -o /dev/null -w '%{http_code}' --max-time 15 $target_url 2>&1") || true
  log "  Before policy-add: $before"

  if echo "$before" | grep -qE "^[2-3]"; then
    skip "TC-NET-03" "api.telegram.org already reachable before policy-add (preset may be pre-applied)"
    return
  fi

  log "  Step 2: Adding telegram preset..."
  nemoclaw "$SANDBOX_NAME" policy-add telegram --yes 2>&1 | tee -a "$LOG_FILE" || true

  sleep 5

  log "  Step 3: Verify api.telegram.org is reachable after policy-add..."
  local after
  after=$(sandbox_exec "curl -s -o /dev/null -w '%{http_code}' --max-time 30 $target_url 2>&1") || true
  log "  After policy-add: $after"

  if echo "$after" | grep -qE "^[2-3]"; then
    pass "TC-NET-03: Endpoint reachable after live policy-add (status: $after)"
  else
    fail "TC-NET-03: Live policy-add" "api.telegram.org still blocked after policy-add (status: $after)"
  fi
}

# =============================================================================
# TC-NET-04: policy-add --dry-run
# =============================================================================
test_net_04_dry_run() {
  log "=== TC-NET-04: Policy-Add --dry-run ==="

  local target_url="https://slack.com/"

  log "  Step 1: Verify slack.com is blocked..."
  local before
  before=$(sandbox_exec "curl -s -o /dev/null -w '%{http_code}' --max-time 15 $target_url 2>&1") || true
  log "  Before dry-run: $before"

  log "  Step 2: Running policy-add --dry-run slack..."
  local dry_output
  dry_output=$(echo "slack" | nemoclaw "$SANDBOX_NAME" policy-add --dry-run 2>&1) || true
  log "  Dry-run output: ${dry_output:0:300}"

  if echo "$dry_output" | grep -qiE "slack\.com|dry.run|no changes"; then
    pass "TC-NET-04: Dry-run printed endpoint info"
  else
    fail "TC-NET-04: Dry-run output" "Expected endpoint info in output: ${dry_output:0:200}"
  fi

  log "  Step 3: Verify slack.com is still blocked after dry-run..."
  local after
  after=$(sandbox_exec "curl -s -o /dev/null -w '%{http_code}' --max-time 15 $target_url 2>&1") || true
  log "  After dry-run: $after"

  if echo "$after" | grep -qE "^[2-3]"; then
    fail "TC-NET-04: Dry-run side effect" "slack.com reachable after dry-run (policy was modified)"
  else
    pass "TC-NET-04: Policy unchanged after dry-run"
  fi
}

# =============================================================================
# TC-NET-07: Inference exemption + direct provider blocked
# =============================================================================
test_net_07_inference_exemption() {
  log "=== TC-NET-07: Inference Exemption + Direct Provider Blocked ==="

  log "  Step 1: Send prompt via inference.local (should succeed)..."
  local inference_response
  inference_response=$(sandbox_exec "curl -s --max-time 60 https://inference.local/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d '{\"model\":\"nvidia/nemotron-3-super-120b-a12b\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: PONG\"}],\"max_tokens\":50}'" 2>&1) || true

  log "  Inference response: ${inference_response:0:200}"

  local content
  content=$(echo "$inference_response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['choices'][0]['message']['content'])" 2>/dev/null) || true

  if [[ -n "$content" ]]; then
    pass "TC-NET-07: Inference via inference.local succeeded"
  else
    fail "TC-NET-07: Inference" "No response from inference.local: ${inference_response:0:200}"
    return
  fi

  log "  Step 2: Attempt direct connection to provider (should be blocked)..."
  local direct_response
  direct_response=$(sandbox_exec "curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://integrate.api.nvidia.com/v1/models 2>&1") || true

  log "  Direct provider response: $direct_response"

  if echo "$direct_response" | grep -qE "403|000"; then
    pass "TC-NET-07: Direct provider access blocked (status: $direct_response)"
  elif echo "$direct_response" | grep -qE "^[2-3]"; then
    fail "TC-NET-07: Direct provider" "Direct access to provider succeeded (should be blocked, status: $direct_response)"
  else
    pass "TC-NET-07: Direct provider access blocked (curl error/refused)"
  fi
}

# ── Teardown ─────────────────────────────────────────────────────────────────
teardown() {
  set +e
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
  set -e
}

# ── Summary ──────────────────────────────────────────────────────────────────
summary() {
  echo ""
  echo "============================================================"
  echo "  Network Policy E2E Results"
  echo "============================================================"
  echo -e "  ${GREEN}PASS: $PASS${NC}"
  echo -e "  ${RED}FAIL: $FAIL${NC}"
  echo -e "  ${YELLOW}SKIP: $SKIP${NC}"
  echo "  TOTAL: $TOTAL"
  echo "============================================================"
  echo "  Log: $LOG_FILE"
  echo "============================================================"
  echo ""

  if [[ $FAIL -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
  echo ""
  echo "============================================================"
  echo "  NemoClaw Network Policy E2E Tests"
  echo "  $(date)"
  echo "============================================================"
  echo ""

  preflight
  setup_sandbox

  test_net_01_deny_default
  test_net_02_whitelist_access
  test_net_03_live_policy_add
  test_net_04_dry_run
  test_net_07_inference_exemption

  trap - EXIT
  teardown
  summary
}

trap teardown EXIT
main "$@"
