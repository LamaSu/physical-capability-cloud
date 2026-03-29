#!/bin/bash
# Spark Brain — runs on DGX Spark, uses Claude Code credentials
# Polls PCC for chat messages, calls Claude, relays tool calls to OT-2 executor
#
# Usage: spark-brain.sh [--kernel kernel-nanoclaw] [--interval 5]
#
# Requires:
#   - claude CLI (Claude Code) with valid credentials
#   - PCC_API_KEY env var
#   - curl, jq

set -euo pipefail

KERNEL_ID="${1:-kernel-nanoclaw}"
PCC_BASE="${PCC_BASE:-https://capability.network}"
PCC_API_KEY="${PCC_API_KEY:?Set PCC_API_KEY}"
POLL_INTERVAL="${POLL_INTERVAL:-5}"
MAX_TOOL_WAIT=30  # seconds to wait for tool result

log() { echo "[$(date +%H:%M:%S)] $*"; }

pcc() {
    local method="$1" path="$2"
    shift 2
    curl -s -X "$method" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $PCC_API_KEY" \
        -H "User-Agent: PCC-Spark-Brain/1.0" \
        "$@" "${PCC_BASE}${path}"
}

# ── Tool definitions for Claude ─────────────────────────────────────────
# These match what the OT-2 executor can handle

TOOLS_JSON='[
  {"name":"ot2_health","description":"Get OT-2 health status","input_schema":{"type":"object","properties":{}}},
  {"name":"ot2_pipettes","description":"Get attached pipettes","input_schema":{"type":"object","properties":{}}},
  {"name":"ot2_modules","description":"Get attached modules","input_schema":{"type":"object","properties":{}}},
  {"name":"ot2_deck_calibration","description":"Get deck calibration status","input_schema":{"type":"object","properties":{}}},
  {"name":"ot2_protocols_list","description":"List uploaded protocols","input_schema":{"type":"object","properties":{}}},
  {"name":"ot2_protocol_upload","description":"Upload a Python protocol","input_schema":{"type":"object","properties":{"filename":{"type":"string"},"content":{"type":"string"}},"required":["filename","content"]}},
  {"name":"ot2_runs_list","description":"List runs","input_schema":{"type":"object","properties":{}}},
  {"name":"ot2_run_create","description":"Create a run from protocol","input_schema":{"type":"object","properties":{"protocolId":{"type":"string"}},"required":["protocolId"]}},
  {"name":"ot2_run_action","description":"Control a run (play/pause/stop)","input_schema":{"type":"object","properties":{"runId":{"type":"string"},"action":{"type":"string","enum":["play","pause","stop"]}},"required":["runId","action"]}},
  {"name":"ot2_run_status","description":"Get run status","input_schema":{"type":"object","properties":{"runId":{"type":"string"}},"required":["runId"]}},
  {"name":"ot2_lights","description":"Control deck lights","input_schema":{"type":"object","properties":{"on":{"type":"boolean"}},"required":["on"]}},
  {"name":"ot2_home","description":"Home robot axes","input_schema":{"type":"object","properties":{"axes":{"type":"array","items":{"type":"string"}}}}},
  {"name":"ot2_identify","description":"Blink lights to identify","input_schema":{"type":"object","properties":{"seconds":{"type":"integer"}}}},
  {"name":"ot2_shell","description":"Run shell command on OT-2","input_schema":{"type":"object","properties":{"command":{"type":"string"},"timeout":{"type":"integer"}},"required":["command"]}},
  {"name":"ot2_camera_snapshot","description":"Take a camera snapshot","input_schema":{"type":"object","properties":{}}}
]'

SYSTEM_PROMPT="You are the PCC OT-2 Brain controlling an Opentrons OT-2 liquid handler.
Robot: falling-bush. Pipettes: P20 Multi Gen2 (left), P1000 Single Gen2 (right).
You have tools to control the robot. Each tool call is relayed through PCC to the robot.
Be concise. Report results clearly. If something fails, diagnose and retry if safe."

# ── Relay a tool call through PCC ───────────────────────────────────────

relay_tool_call() {
    local scope_id="$1" tool_name="$2" tool_args="$3"

    # Post tool call to PCC
    local response
    response=$(pcc POST "/api/ot2/tool-call" \
        -d "{\"kernelId\":\"$KERNEL_ID\",\"scopeId\":\"$scope_id\",\"toolName\":\"$tool_name\",\"toolArgs\":$tool_args}")

    local call_id
    call_id=$(echo "$response" | jq -r '.id // .call.id // "unknown"')

    if [ "$call_id" = "unknown" ] || [ "$call_id" = "null" ]; then
        echo "{\"error\": \"Failed to relay tool call: $response\"}"
        return
    fi

    # Poll for result
    local waited=0
    while [ $waited -lt $MAX_TOOL_WAIT ]; do
        local result
        result=$(pcc GET "/api/ot2/tool-result/$call_id")
        local status
        status=$(echo "$result" | jq -r '.status // "pending"')

        if [ "$status" = "completed" ]; then
            echo "$result" | jq -r '.result // "{}"'
            return
        elif [ "$status" = "failed" ]; then
            echo "$result" | jq -r '.error // "tool call failed"'
            return
        elif [ "$status" = "rejected" ]; then
            echo "{\"error\": \"Tool call rejected by scope enforcement\", \"reason\": $(echo "$result" | jq '.reason // "unknown"')}"
            return
        fi

        sleep 2
        waited=$((waited + 2))
    done

    echo "{\"error\": \"Tool call timed out after ${MAX_TOOL_WAIT}s\"}"
}

# ── Process a user message with Claude ──────────────────────────────────

process_message() {
    local msg_id="$1" content="$2"
    log "Processing message $msg_id: ${content:0:100}"

    # Use claude CLI with the message + tools
    # Claude Code's -p flag runs a single prompt
    local response
    response=$(echo "$content" | claude -p \
        --system "$SYSTEM_PROMPT" \
        --output-format json \
        2>/dev/null || echo '{"error":"claude failed"}')

    # For now, use simple text mode (tool use via CLI is complex)
    # TODO: implement proper tool-use loop with claude API

    # Post response back
    pcc POST "/api/ot2/chat/respond" \
        -d "{\"messageId\":\"$msg_id\",\"response\":$(echo "$response" | jq -Rs .)}" > /dev/null

    log "Response sent for $msg_id"
}

# ── Main Loop ───────────────────────────────────────────────────────────

main() {
    log "Spark Brain starting. Kernel: $KERNEL_ID, PCC: $PCC_BASE"

    # Verify PCC connection
    local kernels
    kernels=$(pcc GET "/api/kernels/$KERNEL_ID")
    if echo "$kernels" | jq -e '.error' > /dev/null 2>&1; then
        log "WARNING: Kernel $KERNEL_ID not found on PCC. Creating..."
        pcc POST "/api/kernels" \
            -d "{\"id\":\"$KERNEL_ID\",\"name\":\"NanoClaw Lab\",\"physicalAddress\":\"Frontier Tower\"}" > /dev/null
    fi

    log "Polling for chat messages every ${POLL_INTERVAL}s..."

    while true; do
        # Poll for pending chat messages
        local msgs
        msgs=$(pcc GET "/api/ot2/chat/pending?kernelId=$KERNEL_ID" 2>/dev/null || echo '{"messages":[]}')

        local count
        count=$(echo "$msgs" | jq '.messages | length' 2>/dev/null || echo 0)

        if [ "$count" -gt 0 ]; then
            echo "$msgs" | jq -c '.messages[]' | while read -r msg; do
                local msg_id content
                msg_id=$(echo "$msg" | jq -r '.id')
                content=$(echo "$msg" | jq -r '.content')
                process_message "$msg_id" "$content"
            done
        fi

        sleep "$POLL_INTERVAL"
    done
}

main "$@"
