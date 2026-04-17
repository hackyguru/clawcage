#!/bin/bash
# Hetzner spike runner for Clawcage remote-mode validation.
#
# Provisions a CAX11 (arm64 Debian 12), cross-compiles guest agents, scp's
# them + hetzner_bare_init.sh to the box, runs the bare-host init, collects
# logs, and offers cleanup.
#
# Goal: prove that the Clawcage air-gapped network setup + guest agents
# work on bare Debian arm64, without nested virtualization. Any failure
# surfaced here is the real work list for remote mode.
#
# Requirements:
#   - hcloud CLI + HCLOUD_TOKEN env var (or `hcloud context`)
#   - SSH key uploaded to Hetzner (default name: laptop)
#   - Matching private key accessible via ssh agent or explicit path
#
# Usage:
#   scripts/hetzner_spike.sh                       # full run, prompts to destroy
#   scripts/hetzner_spike.sh --keep                # don't destroy at end
#   scripts/hetzner_spike.sh --reuse spike         # reuse existing server
#   SSH_KEY_FILE=~/.ssh/clawcage_hetzner scripts/hetzner_spike.sh

set -euo pipefail

# ---- Config --------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_NAME="${SERVER_NAME:-clawcage-spike}"
SERVER_TYPE="${SERVER_TYPE:-cax11}"
IMAGE="${IMAGE:-debian-12}"
LOCATION="${LOCATION:-nbg1}"
SSH_KEY_NAME="${SSH_KEY_NAME:-laptop}"
SSH_KEY_FILE="${SSH_KEY_FILE:-$HOME/.ssh/clawcage_hetzner}"
TARGET="aarch64-unknown-linux-musl"
BIN_DIR_REMOTE="/opt/clawcage"

KEEP=0
REUSE=""
for arg in "$@"; do
    case "$arg" in
        --keep)      KEEP=1 ;;
        --reuse=*)   REUSE="${arg#--reuse=}"; SERVER_NAME="$REUSE" ;;
        --reuse)     shift; REUSE="$1"; SERVER_NAME="$REUSE" ;;
        -h|--help)
            sed -n '2,25p' "$0"; exit 0 ;;
    esac
done

log() { printf '\033[1;36m[spike]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[spike]\033[0m %s\n' "$*" >&2; }

# ---- Preflight -----------------------------------------------------------
command -v hcloud >/dev/null 2>&1 || { err "hcloud CLI not found (brew install hcloud)"; exit 1; }
command -v cargo  >/dev/null 2>&1 || { err "cargo not found"; exit 1; }
if ! hcloud context active >/dev/null 2>&1; then
    err "hcloud has no active context. Run: hcloud context create clawcage"
    exit 1
fi
if [ ! -f "$SSH_KEY_FILE" ]; then
    err "SSH key not found at $SSH_KEY_FILE (set SSH_KEY_FILE=path)"
    exit 1
fi

SSH_OPTS=(
    -i "$SSH_KEY_FILE"
    -o StrictHostKeyChecking=no
    -o UserKnownHostsFile=/dev/null
    -o LogLevel=ERROR
)

# ---- Build agents --------------------------------------------------------
log "cross-compiling guest agents for $TARGET..."
cd "$REPO_ROOT"
rustup target add "$TARGET" >/dev/null 2>&1 || true
cargo build --release --target "$TARGET" -p clawcage-agent 2>&1 | tail -3

BIN_SRC_DIR="$REPO_ROOT/target/$TARGET/release"
BINS=(clawcage-pty-agent clawcage-net-proxy clawcage-mcp-server clawcage-fs-watch clawcage-port-watch clawcage-sys-watch)
for b in "${BINS[@]}"; do
    if [ ! -x "$BIN_SRC_DIR/$b" ]; then
        err "missing binary: $BIN_SRC_DIR/$b"
        exit 1
    fi
done
log "built $(echo "${BINS[@]}" | wc -w | tr -d ' ') binaries"

# ---- Provision or reuse server ------------------------------------------
IP=""
if [ -n "$REUSE" ]; then
    log "reusing server: $SERVER_NAME"
    IP="$(hcloud server ip "$SERVER_NAME" 2>/dev/null || true)"
    if [ -z "$IP" ]; then
        err "server $SERVER_NAME not found"
        exit 1
    fi
else
    if hcloud server describe "$SERVER_NAME" >/dev/null 2>&1; then
        log "server $SERVER_NAME already exists, deleting..."
        hcloud server delete "$SERVER_NAME" >/dev/null
    fi
    log "provisioning $SERVER_TYPE in $LOCATION (image=$IMAGE)..."
    hcloud server create \
        --name "$SERVER_NAME" \
        --type "$SERVER_TYPE" \
        --image "$IMAGE" \
        --location "$LOCATION" \
        --ssh-key "$SSH_KEY_NAME" \
        --start-after-create=true >/dev/null
    IP="$(hcloud server ip "$SERVER_NAME")"
    log "server ready: $IP"
fi

# Wait for SSH.
log "waiting for SSH..."
for _ in $(seq 1 30); do
    if ssh "${SSH_OPTS[@]}" -o ConnectTimeout=3 "root@$IP" 'echo ready' >/dev/null 2>&1; then
        break
    fi
    sleep 2
done
if ! ssh "${SSH_OPTS[@]}" -o ConnectTimeout=3 "root@$IP" 'echo ready' >/dev/null 2>&1; then
    err "SSH never came up"
    exit 1
fi
log "SSH ready"

# ---- Deploy binaries + init script --------------------------------------
log "creating $BIN_DIR_REMOTE on remote..."
ssh "${SSH_OPTS[@]}" "root@$IP" "mkdir -p $BIN_DIR_REMOTE"

log "scp binaries + init script..."
scp "${SSH_OPTS[@]}" \
    "$BIN_SRC_DIR/clawcage-pty-agent" \
    "$BIN_SRC_DIR/clawcage-net-proxy" \
    "$BIN_SRC_DIR/clawcage-mcp-server" \
    "$BIN_SRC_DIR/clawcage-fs-watch" \
    "$BIN_SRC_DIR/clawcage-port-watch" \
    "$BIN_SRC_DIR/clawcage-sys-watch" \
    "$REPO_ROOT/scripts/hetzner_bare_init.sh" \
    "root@$IP:$BIN_DIR_REMOTE/" >/dev/null
ssh "${SSH_OPTS[@]}" "root@$IP" "chmod 755 $BIN_DIR_REMOTE/*"

# ---- Run bare init ------------------------------------------------------
log ""
log "=== running hetzner_bare_init.sh on remote ==="
ssh "${SSH_OPTS[@]}" "root@$IP" "BIN_DIR=$BIN_DIR_REMOTE bash $BIN_DIR_REMOTE/hetzner_bare_init.sh" || {
    err "bare init returned non-zero"
}

# ---- Collect agent logs -------------------------------------------------
log ""
log "=== agent logs (first 30 lines each) ==="
for b in clawcage-net-proxy clawcage-fs-watch clawcage-port-watch clawcage-sys-watch; do
    log "--- $b ---"
    ssh "${SSH_OPTS[@]}" "root@$IP" "head -30 /var/log/$b.log 2>&1 || echo '(no log)'" | sed 's/^/  /'
done

# ---- PTY agent smoke test -----------------------------------------------
log ""
log "=== clawcage-pty-agent smoke test (vsock mode, expected to retry) ==="
ssh "${SSH_OPTS[@]}" "root@$IP" \
    "timeout 3 $BIN_DIR_REMOTE/clawcage-pty-agent 2>&1 | head -10" | sed 's/^/  /' || true

# ---- TCP transport end-to-end test --------------------------------------
# Kill the vsock-mode agents, start a mock TCP listener on :5008, then run
# sys-watch in TCP mode. If the new transport works, the listener receives
# framed SystemMetrics bytes. This is the go/no-go for CLAWCAGE_TRANSPORT=tcp.
log ""
log "=== TCP transport end-to-end test ==="
ssh "${SSH_OPTS[@]}" "root@$IP" bash <<'REMOTE_EOF' 2>&1 | sed 's/^/  /'
set -u
pkill -x clawcage-sys-watch clawcage-fs-watch clawcage-port-watch clawcage-net-proxy 2>/dev/null || true
sleep 0.3

apt-get install -y -qq ncat >/dev/null 2>&1 || apt-get install -y -qq netcat-openbsd >/dev/null 2>&1

MOCK_LOG=/tmp/clawcage-tcp-mock.log
: > "$MOCK_LOG"

# ncat dumps bytes to log; -k keeps listening after disconnect.
# Use -o to log received bytes as hex (ncat-only feature) if available; fall
# back to plain capture.
if ncat --version 2>/dev/null | grep -q Ncat; then
    ncat -k -l 127.0.0.1 5008 > "$MOCK_LOG" 2>&1 &
else
    nc -k -l -p 5008 > "$MOCK_LOG" 2>&1 &
fi
MOCK_PID=$!
sleep 0.3

if ! kill -0 "$MOCK_PID" 2>/dev/null; then
    echo "FATAL: mock listener failed to start"
    exit 1
fi
echo "mock listener on 127.0.0.1:5008 (pid $MOCK_PID)"

# Run sys-watch in TCP mode for 3 seconds. It should emit 1-2 metric frames.
CLAWCAGE_TRANSPORT=tcp CLAWCAGE_HOST=127.0.0.1 \
    timeout 3 /opt/clawcage/clawcage-sys-watch 2>&1 | head -10

sleep 0.3
kill "$MOCK_PID" 2>/dev/null || true

RECEIVED_BYTES=$(wc -c < "$MOCK_LOG")
echo ""
echo "mock listener received: $RECEIVED_BYTES bytes"
if [ "$RECEIVED_BYTES" -gt 0 ]; then
    echo "first 64 bytes (hex):"
    head -c 64 "$MOCK_LOG" | od -An -tx1 | head -4
    echo "PASS: TCP transport delivered bytes"
else
    echo "FAIL: no bytes received"
fi
REMOTE_EOF

# ---- Cleanup ------------------------------------------------------------
log ""
if [ "$KEEP" = "1" ]; then
    log "--keep passed; server left running at $IP"
    log "destroy manually: hcloud server delete $SERVER_NAME"
else
    read -r -p "[spike] destroy server $SERVER_NAME? [Y/n] " ans
    if [ "${ans:-Y}" = "Y" ] || [ "${ans:-y}" = "y" ]; then
        hcloud server delete "$SERVER_NAME" >/dev/null
        log "server destroyed"
    else
        log "server kept at $IP"
    fi
fi
