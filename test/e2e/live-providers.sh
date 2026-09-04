#!/usr/bin/env bash
# test/e2e/live-providers.sh — bring up / tear down the two TEST-ONLY live
# providers that J11 (live-provider discovery in e2e.test.mjs) probes.
#
# J11's LIVE_CANDIDATES cover six conventional ports. Four of them are this
# machine's STANDING servers — ollama :11434, llama-swap :8080, sglang :8888,
# llama-server :25000 — and this script never touches them. The other two are
# disposable, standing up only for J11's live-coverage:
#
#   live-lmstudio  :1234   llmster — LM Studio's official headless daemon —
#                            serving the ~/.lmstudio/models catalog
#                            (OpenAI /v1/* plus the native /api/v1/models
#                            that the lmstudio discovery backend parses).
#   live-vllm      :8000   docker vllm/vllm-openai:latest serving
#                            Qwen/Qwen2.5-VL-3B-Instruct from the local
#                            Hugging Face cache (HF_HUB_OFFLINE=1 — no
#                            download). Sized for a shared GPU: the host's
#                            sglang already holds most of the VRAM, so vLLM
#                            caps itself at 11% of total memory and no
#                            multimodal budget.
#
# Usage:
#   live-providers.sh up       start both (idempotent)
#   live-providers.sh down     stop both (idempotent; the vLLM container is
#                              STOPPED, not removed, for a fast re-up)
#   live-providers.sh status   print each provider's state
#
# First use on a fresh machine: `docker pull vllm/vllm-openai:latest`,
# `lms get` a model into ~/.lmstudio/models (or rely on the bundled
# embedding model), and install llmster (lmstudio.ai/install.sh).
set -euo pipefail

VLLM_CONTAINER="modelspoke-vllm-e2e"
VLLM_IMAGE="vllm/vllm-openai:latest"
VLLM_MODEL="Qwen/Qwen2.5-VL-3B-Instruct"
VLLM_PORT=8000
LMS_PORT=1234
LMS="${LMS:-$(command -v lms 2>/dev/null || echo "$HOME/.lmstudio/bin/lms")}"

port_up() { # port -> 0 when something answers /v1/models on 127.0.0.1
  curl -s -m 2 -o /dev/null "http://127.0.0.1:$1/v1/models"
}

wait_port() { # port seconds label
  local port="$1" deadline=$(( SECONDS + $2 ))
  while ! port_up "$port"; do
    if (( SECONDS >= deadline )); then
      echo "live-providers: $3 did not come up on :$port in time" >&2
      return 1
    fi
    sleep 5
  done
}

# ---------- vLLM (:8000, docker) -------------------------------------------

vllm_up() {
  if port_up "$VLLM_PORT"; then
    echo "vllm      : already up on :$VLLM_PORT"
    return
  fi
  local state
  state="$(docker ps -a --filter "name=^${VLLM_CONTAINER}$" --format '{{.State}}' 2>/dev/null || true)"
  if [[ -z "$state" ]]; then
    echo "vllm      : starting container $VLLM_CONTAINER ($VLLM_IMAGE, $VLLM_MODEL)"
    docker run -d --name "$VLLM_CONTAINER" \
      --gpus all \
      -p "${VLLM_PORT}:8000" \
      -v "$HOME/.cache/huggingface:/root/.cache/huggingface:ro" \
      -e HF_HUB_OFFLINE=1 \
      -e HF_HUB_DISABLE_TELEMETRY=1 \
      "$VLLM_IMAGE" \
      --model "$VLLM_MODEL" \
      --gpu-memory-utilization 0.11 \
      --max-model-len 4096 \
      --enforce-eager \
      --limit-mm-per-prompt '{"image":0,"video":0}' >/dev/null
  else
    echo "vllm      : starting existing container $VLLM_CONTAINER (state: $state)"
    docker start "$VLLM_CONTAINER" >/dev/null
  fi
  # Engine init + weight load takes well over a minute on a cold start.
  wait_port "$VLLM_PORT" 300 "vLLM"
  echo "vllm      : up on :$VLLM_PORT"
}

vllm_down() {
  if port_up "$VLLM_PORT"; then
    docker stop "$VLLM_CONTAINER" >/dev/null 2>&1 || true
    # Give the port a moment to drain.
    for _ in 1 2 3 4 5; do port_up "$VLLM_PORT" || break; sleep 2; done
  fi
  if docker ps -a --filter "name=^${VLLM_CONTAINER}$" -q | grep -q .; then
    echo "vllm      : stopped (container $VLLM_CONTAINER kept for fast re-up)"
  else
    echo "vllm      : already down (no container $VLLM_CONTAINER)"
  fi
}

vllm_status() {
  local state
  state="$(docker ps -a --filter "name=^${VLLM_CONTAINER}$" --format '{{.State}}' 2>/dev/null || true)"
  if port_up "$VLLM_PORT"; then
    echo "vllm      : UP on :$VLLM_PORT (container $VLLM_CONTAINER)"
  else
    echo "vllm      : DOWN (container: ${state:-absent})"
  fi
}

# ---------- LM Studio / llmster (:1234) -------------------------------------

lms_up() {
  if port_up "$LMS_PORT"; then
    echo "lmstudio  : already up on :$LMS_PORT"
    return
  fi
  "$LMS" daemon up >/dev/null
  "$LMS" server start --port "$LMS_PORT" >/dev/null
  wait_port "$LMS_PORT" 120 "llmster"
  echo "lmstudio  : up on :$LMS_PORT"
}

lms_down() {
  # Both stops are idempotent no-ops when already stopped — attempt both and
  # report the resulting port state instead of parsing status prose.
  "$LMS" server stop >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5; do port_up "$LMS_PORT" || break; sleep 2; done
  "$LMS" daemon down >/dev/null 2>&1 || true
  if port_up "$LMS_PORT"; then
    echo "lmstudio  : still answering :$LMS_PORT — check 'lms server status'"
  else
    echo "lmstudio  : down (server stopped, daemon down)"
  fi
}

lms_status() {
  if port_up "$LMS_PORT"; then
    echo "lmstudio  : UP on :$LMS_PORT"
  else
    echo "lmstudio  : DOWN"
  fi
}

# ---------- dispatch ---------------------------------------------------------

case "${1:-}" in
  up)
    vllm_up
    lms_up
    ;;
  down)
    lms_down
    vllm_down
    ;;
  status)
    vllm_status
    lms_status
    ;;
  *)
    echo "usage: $0 {up|down|status}" >&2
    exit 2
    ;;
esac
