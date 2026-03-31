#!/bin/bash
# Spark PCC Agent — maintains network presence for all managed kernels
#
# Runs on DGX Spark. Responsibilities:
# 1. Announce capabilities to DHT (re-announce every 5 min)
# 2. Register kernels on PCC if missing
# 3. Heartbeat to keep kernels online
# 4. Act as brain for incoming jobs (claude -p)
# 5. Monitor OT-2 executor status
#
# Usage: ./spark-agent.sh [--interval 300]

set -euo pipefail

PCC_BASE="${PCC_BASE:-https://capability.network}"
DHT_ANNOUNCE_INTERVAL="${1:-300}"  # 5 minutes default
ORACLE_URL="http://localhost:4100"

log() { echo "[$(date +%H:%M:%S)] $*"; }

pcc() {
    local method="$1" path="$2"
    shift 2
    curl -s -X "$method" \
        -H "Content-Type: application/json" \
        -H "User-Agent: PCC-Spark-Agent/1.0" \
        "$@" "${PCC_BASE}${path}"
}

# ── Provision API key if needed ─────────────────────────────────────
ensure_api_key() {
    if [ -f ~/.pcc-spark-key ]; then
        PCC_KEY=$(cat ~/.pcc-spark-key)
        log "Using cached API key: ${PCC_KEY:0:20}..."
        return
    fi
    log "Provisioning new API key..."
    PCC_KEY=$(pcc POST "/api/auth/provision" \
        -d '{"email":"spark-agent@capability.network","name":"Spark Agent"}' \
        | jq -r .api_key)
    echo "$PCC_KEY" > ~/.pcc-spark-key
    log "API key provisioned: ${PCC_KEY:0:20}..."
}

pcc_auth() {
    local method="$1" path="$2"
    shift 2
    curl -s -X "$method" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $PCC_KEY" \
        -H "User-Agent: PCC-Spark-Agent/1.0" \
        "$@" "${PCC_BASE}${path}"
}

# ── Register kernels ────────────────────────────────────────────────
register_kernels() {
    log "Registering kernels..."

    # OT-2 NanoClaw
    local exists=$(pcc_auth GET "/api/kernels/kernel-nanoclaw" | jq -r '.kernel.id // empty')
    if [ -z "$exists" ]; then
        pcc_auth POST "/api/kernels" \
            -d '{"id":"kernel-nanoclaw","name":"NanoClaw Lab — OT-2 Liquid Handler","physicalAddress":"Frontier Tower"}' > /dev/null
        log "  Registered kernel-nanoclaw"
    else
        log "  kernel-nanoclaw already registered"
    fi

    # HP Printer
    exists=$(pcc_auth GET "/api/kernels/kernel-hp-printer" | jq -r '.kernel.id // empty')
    if [ -z "$exists" ]; then
        pcc_auth POST "/api/kernels" \
            -d '{"id":"kernel-hp-printer","name":"HP Color LaserJet Pro MFP 3301","physicalAddress":"Frontier Tower"}' > /dev/null
        log "  Registered kernel-hp-printer"
    else
        log "  kernel-hp-printer already registered"
    fi

    # Spark compute (offers the brain/Claude capability)
    exists=$(pcc_auth GET "/api/kernels/kernel-spark" | jq -r '.kernel.id // empty')
    if [ -z "$exists" ]; then
        pcc_auth POST "/api/kernels" \
            -d '{"id":"kernel-spark","name":"DGX Spark — AI Compute Node","physicalAddress":"Frontier Tower"}' > /dev/null
        log "  Registered kernel-spark"
    else
        log "  kernel-spark already registered"
    fi
}

# ── Announce to DHT ─────────────────────────────────────────────────
announce_capabilities() {
    log "Announcing to DHT..."

    # OT-2 liquid handler
    pcc POST "/api/dht/announce" \
        -d '{
            "kernelId": "kernel-nanoclaw",
            "kernelDid": "did:pcc:kernel-nanoclaw",
            "capabilities": [
                {
                    "type": "liquid-handler",
                    "materials": ["aqueous", "biological", "organic", "viscous"],
                    "priceRange": {"min": 10, "max": 50, "currency": "USDC"},
                    "queueDepth": 0
                }
            ],
            "endpoints": [
                {"transport": "http-poll", "url": "'"$PCC_BASE"'/api/relay/kernel-nanoclaw/tool-call", "priority": 1},
                {"transport": "http-poll", "url": "'"$PCC_BASE"'/api/ot2/tool-call", "priority": 2}
            ],
            "ttlSeconds": 600
        }' > /dev/null
    log "  Announced kernel-nanoclaw (liquid-handler)"

    # Spark as AI compute / brain-for-hire
    pcc POST "/api/dht/announce" \
        -d '{
            "kernelId": "kernel-spark",
            "kernelDid": "did:pcc:kernel-spark",
            "capabilities": [
                {
                    "type": "ai-compute",
                    "materials": [],
                    "priceRange": {"min": 0.01, "max": 1.00, "currency": "USDC"},
                    "queueDepth": 0
                },
                {
                    "type": "protocol-design",
                    "materials": [],
                    "priceRange": {"min": 5, "max": 25, "currency": "USDC"},
                    "queueDepth": 0
                }
            ],
            "endpoints": [
                {"transport": "http-poll", "url": "'"$PCC_BASE"'/api/relay/kernel-spark/tool-call", "priority": 1}
            ],
            "ttlSeconds": 600
        }' > /dev/null
    log "  Announced kernel-spark (ai-compute, protocol-design)"

    # HP Printer
    pcc POST "/api/dht/announce" \
        -d '{
            "kernelId": "kernel-hp-printer",
            "kernelDid": "did:pcc:kernel-hp-printer",
            "capabilities": [
                {
                    "type": "document-printing",
                    "materials": ["letter", "legal", "a4", "photo"],
                    "priceRange": {"min": 0.10, "max": 2.00, "currency": "USDC"},
                    "queueDepth": 0
                }
            ],
            "endpoints": [
                {"transport": "http-poll", "url": "'"$PCC_BASE"'/api/relay/kernel-hp-printer/tool-call", "priority": 1}
            ],
            "ttlSeconds": 600
        }' > /dev/null
    log "  Announced kernel-hp-printer (document-printing)"
}

# ── Heartbeat ───────────────────────────────────────────────────────
send_heartbeats() {
    pcc_auth POST "/api/kernels/kernel-nanoclaw/heartbeat" \
        -d '{"status":"online"}' > /dev/null 2>&1
    pcc_auth POST "/api/kernels/kernel-hp-printer/heartbeat" \
        -d '{"status":"online"}' > /dev/null 2>&1
    pcc_auth POST "/api/kernels/kernel-spark/heartbeat" \
        -d '{"status":"online"}' > /dev/null 2>&1
}

# ── Check oracle health ─────────────────────────────────────────────
check_oracle() {
    local health=$(curl -s "$ORACLE_URL/health" 2>/dev/null | jq -r .status 2>/dev/null)
    if [ "$health" = "ok" ]; then
        log "  Oracle: online"
    else
        log "  Oracle: OFFLINE — restarting..."
        cd ~/pcc-oracle && source .env && \
            export ORACLE_PRIVATE_KEY CHAIN_ID PORT PCC_GATEWAY_URL ORACLE_BOOTSTRAP_KEY && \
            nohup node dist/server.js > oracle.log 2>&1 &
        sleep 2
        log "  Oracle: restarted"
    fi
}

# ── Check OT-2 executor ─────────────────────────────────────────────
check_ot2() {
    local call_id=$(pcc_auth POST "/api/ot2/tool-call" \
        -d '{"kernelId":"kernel-nanoclaw","toolName":"ot2_health","args":{}}' \
        | jq -r .id)
    if [ -n "$call_id" ] && [ "$call_id" != "null" ]; then
        sleep 8
        local status=$(pcc_auth GET "/api/ot2/tool-result/$call_id" | jq -r .status)
        if [ "$status" = "completed" ]; then
            log "  OT-2: online (health check completed)"
        else
            log "  OT-2: executor not responding (status=$status)"
        fi
    else
        log "  OT-2: tool call failed"
    fi
}

# ── Main Loop ───────────────────────────────────────────────────────
main() {
    log "=== PCC Spark Agent starting ==="
    log "PCC: $PCC_BASE"
    log "Oracle: $ORACLE_URL"
    log "DHT announce interval: ${DHT_ANNOUNCE_INTERVAL}s"

    ensure_api_key
    register_kernels
    announce_capabilities

    local cycle=0
    while true; do
        cycle=$((cycle + 1))
        log "--- Cycle $cycle ---"

        # Every cycle: heartbeat
        send_heartbeats

        # Every cycle: check oracle
        check_oracle

        # Every 6th cycle (~30 min): check OT-2
        if [ $((cycle % 6)) -eq 0 ]; then
            check_ot2
        fi

        # Re-announce to DHT (TTL is 600s, we announce every 300s)
        announce_capabilities

        log "Sleeping ${DHT_ANNOUNCE_INTERVAL}s..."
        sleep "$DHT_ANNOUNCE_INTERVAL"
    done
}

main "$@"
