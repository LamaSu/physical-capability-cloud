#!/usr/bin/env bash
# Generate the PCC Android UPLOAD keystore and print the GitHub secrets to set.
#
# Run this ONCE on a machine that has a JDK (keytool). The resulting .jks is your
# permanent upload identity for network.capability.mobile — safeguard it (a lost
# upload key is recoverable via Play support, but only if you enrolled in Play App
# Signing, and only with hassle). NEVER commit it; it is gitignored.
#
# Usage:  bash generate-upload-keystore.sh
set -euo pipefail

ALIAS="pcc-upload"
OUT="pcc-upload.jks"

if ! command -v keytool >/dev/null 2>&1; then
  echo "ERROR: keytool not found. Install a JDK (e.g. Temurin 17) and retry." >&2
  exit 1
fi

if [ -f "$OUT" ]; then
  echo "ERROR: $OUT already exists here. Refusing to overwrite an existing keystore." >&2
  echo "If this is the real upload key, back it up; do not regenerate it." >&2
  exit 1
fi

echo "Generating $OUT (alias=$ALIAS, RSA 2048, valid 10000 days)."
echo "You'll be prompted for a store password, a key password, and a distinguished name."
keytool -genkeypair -v \
  -keystore "$OUT" \
  -alias "$ALIAS" \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storetype JKS

echo
echo "=================================================================="
echo "DONE. $OUT created in: $(pwd)"
echo
echo "1) MOVE it out of the repo and back it up (password manager + offline copy)."
echo "2) For local release builds, copy keystore.properties.example -> keystore.properties"
echo "   and fill in the absolute path + passwords."
echo "3) For CI (GitHub Actions), set these repo secrets:"
echo "     PCC_ANDROID_KEYSTORE_BASE64   = base64 of $OUT (command below)"
echo "     PCC_ANDROID_KEYSTORE_PASSWORD = your store password"
echo "     PCC_ANDROID_KEY_ALIAS         = $ALIAS"
echo "     PCC_ANDROID_KEY_PASSWORD      = your key password"
echo
echo "   Base64 for the secret (macOS/Linux):"
echo "     base64 -w0 $OUT   # (use 'base64 $OUT' on macOS, no -w0)"
echo "=================================================================="
