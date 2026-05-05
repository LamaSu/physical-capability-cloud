# Deploying connectors-runtime on Spark

The connectors-runtime is a Python sidecar that runs on Spark via
`systemd --user`. It is **NOT** baked into the gateway Docker image —
the gateway will eventually proxy public traffic to it under
`/api/connectors/*`, but the runtime itself stays on Spark.

## One-time setup

```bash
ssh dgx-spark
cd ~/projects/physical-capability-cloud/packages/connectors-runtime

# Create the venv (Python 3.11+).
python3.11 -m venv .venv
.venv/bin/pip install -e .

# Storage directory (matches default STORAGE_PATH).
sudo mkdir -p /var/lib/pcc/connectors
sudo chown $USER:$USER /var/lib/pcc/connectors

# Env file (mode 600 — most fields are optional).
mkdir -p ~/.config/connectors-runtime
cat > ~/.config/connectors-runtime/connectors-runtime.env <<'EOF'
LISTEN_HOST=127.0.0.1
LISTEN_PORT=8766
STORAGE_PATH=/var/lib/pcc/connectors
LOG_LEVEL=INFO
MAX_PIPELINE_SECONDS=600
ENABLE_DESTROY_ENDPOINT=false

# Optional InsForge defaults — per-pipeline overrides take precedence.
# INSFORGE_BASE_URL=https://insforge.example.com
# INSFORGE_API_KEY=...
EOF
chmod 600 ~/.config/connectors-runtime/connectors-runtime.env

# Install + start the unit.
mkdir -p ~/.config/systemd/user
cp deploy/connectors-runtime.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now connectors-runtime
systemctl --user status connectors-runtime
```

Verify it's running:

```bash
curl -sS http://127.0.0.1:8766/health
```

Expected:

```json
{"status":"ok","service":"pcc-connectors-runtime","dlt_version":"...","n_pipelines":0,"n_running":0}
```

## Updating after a code change

```bash
cd ~/projects/physical-capability-cloud
git pull
cd packages/connectors-runtime
.venv/bin/pip install -e .
systemctl --user restart connectors-runtime
journalctl --user -u connectors-runtime -n 20
```

## Destination credentials

The runtime resolves destinations at pipeline-create time, NOT startup.
That means the `POST /destinations` body carries the credentials for
that specific destination — there is no global "Postgres password" env
var. The TS shells pass per-call config through; per-tenant secrets
should live in the gateway's secrets store and be forwarded only when a
pipeline is being created.

The two optional `INSFORGE_*` env vars exist purely as defaults for
single-tenant deployments where every InsForge destination talks to the
same instance.

## Wave 4 (not yet)

- Pipeline state persistence (Postgres) — currently in-memory dict
- Gateway proxy at `/api/connectors/*` — currently TS shells call us
  directly via `CONNECTORS_RUNTIME_URL`
- InsForge custom destination wiring (vendor SDK pin)
- Salesforce / SharePoint / SAP source SDKs (currently 501 from the
  bridge with `vendor_sdk_not_wired`)
