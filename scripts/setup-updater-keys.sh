#!/usr/bin/env bash
# One-time setup: generate the Tauri updater signing keypair, embed
# the public half in tauri.conf.json, and print the private half so
# you can paste it into the GitHub secret TAURI_SIGNING_PRIVATE_KEY.
#
# Run ONCE before your first signed release. Re-running rotates the
# key (which invalidates auto-update for any already-released
# binaries — they verify against the OLD pubkey baked into them).
#
# Requires: cargo + Tauri CLI. Install with:
#   cargo install tauri-cli --version "^2.0" --locked

set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v tauri >/dev/null 2>&1 && ! cargo tauri --version >/dev/null 2>&1; then
  echo "Tauri CLI not found. Install with:"
  echo "  cargo install tauri-cli --version '^2.0' --locked"
  exit 1
fi

KEY_DIR="$HOME/.tauri"
KEY_FILE="$KEY_DIR/auracle-desktop.key"
mkdir -p "$KEY_DIR"

if [ -f "$KEY_FILE" ]; then
  echo "Existing key found at $KEY_FILE — refusing to overwrite."
  echo "If you want to rotate, mv it aside first."
  exit 1
fi

# Generate. -w writes the private key to the path; the public key is
# printed to stdout AFTER a confirmation prompt for a passphrase.
echo "Generating new keypair. You'll be prompted for a passphrase —"
echo "use a strong one and store it in your password manager. Same"
echo "passphrase goes into the GitHub secret TAURI_SIGNING_PRIVATE_KEY_PASSWORD."
echo
cargo tauri signer generate -w "$KEY_FILE"

PUBKEY_FILE="${KEY_FILE}.pub"
if [ ! -f "$PUBKEY_FILE" ]; then
  echo "Pubkey file not found at $PUBKEY_FILE — Tauri CLI version mismatch?"
  exit 1
fi

PUBKEY=$(cat "$PUBKEY_FILE")

# Patch tauri.conf.json's plugins.updater.pubkey field.
CONF=src-tauri/tauri.conf.json
if grep -q "REPLACE_WITH_TAURI_UPDATER_ED25519_PUBLIC_KEY" "$CONF"; then
  # macOS sed needs an empty -i argument
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|REPLACE_WITH_TAURI_UPDATER_ED25519_PUBLIC_KEY|$PUBKEY|" "$CONF"
  else
    sed -i "s|REPLACE_WITH_TAURI_UPDATER_ED25519_PUBLIC_KEY|$PUBKEY|" "$CONF"
  fi
  echo "✓ Patched $CONF with public key"
else
  echo "Note: $CONF doesn't contain the placeholder — patch manually:"
  echo "  pubkey: $PUBKEY"
fi

cat <<MSG

================================================================
Setup complete.

Next steps (one time):

  1. Commit the patched tauri.conf.json:
       git add $CONF
       git commit -m "chore: embed Tauri updater public key"
       git push

  2. Add these GitHub secrets at:
       https://github.com/SiixQuant/$(basename "$(pwd)")/settings/secrets/actions

       TAURI_SIGNING_PRIVATE_KEY            — contents of $KEY_FILE
       TAURI_SIGNING_PRIVATE_KEY_PASSWORD   — the passphrase you just set

  3. Back up $KEY_FILE somewhere safe (1Password, hardware token, etc.).
     If you lose it, you can never sign updates that existing
     installations will trust. You'd have to ship a manual-update
     build first.

================================================================
MSG
