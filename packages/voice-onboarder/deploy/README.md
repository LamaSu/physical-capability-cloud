# Deploying pcc-voice-onboarder on Spark

Three things to wire up: the systemd service, the cloudflared tunnel,
and the Twilio webhook.

## 1. Install on Spark

```bash
# Copy the repo to Spark (or clone fresh).
ssh dgx-spark
cd ~/projects/physical-capability-cloud/packages/voice-onboarder
python3.11 -m venv .venv
.venv/bin/pip install -e .
```

## 2. Drop in the env file

```bash
mkdir -p ~/.config/voice-onboarder
cat > ~/.config/voice-onboarder/voice-onboarder.env <<'EOF'
PCC_API_KEY=pcc_live_...
PCC_BASE_URL=https://capability.network
DEEPGRAM_API_KEY=...
ANTHROPIC_API_KEY=...
CARTESIA_API_KEY=...
CARTESIA_VOICE_ID=79a125e8-cd45-4c13-8a67-188112f4dd22
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=+16504480770
WEBHOOK_HOST=https://voice-onboarder.capability.network
SERVER_PORT=8765
LOG_LEVEL=INFO
EOF
chmod 600 ~/.config/voice-onboarder/voice-onboarder.env
```

## 3. Enable the systemd unit

```bash
mkdir -p ~/.config/systemd/user
cp deploy/voice-onboarder.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now voice-onboarder
systemctl --user status voice-onboarder
journalctl --user -u voice-onboarder -f       # live logs
```

## 4. Register the cloudflared tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create pcc-voice-onboarder      # prints <TUNNEL_ID>
cloudflared tunnel route dns pcc-voice-onboarder voice-onboarder.capability.network
cp deploy/cloudflared.yml ~/.cloudflared/config.yml
# Edit ~/.cloudflared/config.yml: replace <TUNNEL_ID> and <SPARK_USER>.
cloudflared --config ~/.cloudflared/config.yml tunnel run pcc-voice-onboarder
```

For permanent operation, install as a service:
```bash
sudo cloudflared --config ~/.cloudflared/config.yml service install
```

## 5. Point Twilio at the tunnel

In the Twilio console, on the inbound phone number's voice webhook:

- URL: `https://voice-onboarder.capability.network/twilio/inbound`
- Method: HTTP POST
- "A call comes in": Webhook (this URL)

Dial the number. The server's TwiML response opens a WebSocket back to
`/ws`, and Pipecat takes over the call from there.

## Smoke check

```bash
curl https://voice-onboarder.capability.network/health
# → {"status":"ok","service":"pcc-voice-onboarder",...}
```
