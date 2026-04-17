#!/bin/bash
# Bare-host init for Clawcage remote mode.
#
# Runs directly on a Hetzner Cloud CAX11 (Debian 12 aarch64) as a replacement
# for the VZ-guest clawcage-init. The Hetzner VPS is itself ephemeral, so no
# overlayfs/squashfs/chroot is needed — this script sets up only what the
# agents require: network layout and daemon launch.
#
# Usage:
#   hetzner_bare_init.sh                    # full MITM mode (local-parity, for spikes)
#   hetzner_bare_init.sh --no-mitm          # remote mode: skip air-gap, agents hit real internet
#   hetzner_bare_init.sh --tmux-session=NAME  # wrap pty-agent in tmux for resilient reattach
#
# Env:
#   BIN_DIR=/opt/clawcage         # where guest binaries live (default)
#   CLAWCAGE_TRANSPORT=vsock|tcp  # passed to agents
#   CLAWCAGE_HOST=...             # passed to agents in tcp mode

set -u

BIN_DIR="${BIN_DIR:-/opt/clawcage}"
LOG_PREFIX="[clawcage-bare]"
NO_MITM=0
TMUX_SESSION=""

for arg in "$@"; do
    case "$arg" in
        --no-mitm)            NO_MITM=1 ;;
        --tmux-session=*)     TMUX_SESSION="${arg#*=}" ;;
        -h|--help)
            sed -n '2,16p' "$0"; exit 0 ;;
        *)
            echo "$LOG_PREFIX unknown arg: $arg"; exit 1 ;;
    esac
done

echo "$LOG_PREFIX starting on $(uname -a)"
if [ "$NO_MITM" = "1" ]; then
    echo "$LOG_PREFIX mode: --no-mitm (remote mode, agents hit real internet)"
else
    echo "$LOG_PREFIX mode: full air-gap (local-parity)"
fi
if [ -n "$TMUX_SESSION" ]; then
    echo "$LOG_PREFIX tmux session: $TMUX_SESSION (pty-agent will run inside)"
fi

# ---- Dependencies check --------------------------------------------------
# In --no-mitm mode we only need iproute2 (for agent diagnostics, optional).
# In full mode we also need dnsmasq + iptables.
need_pkg=""
if [ "$NO_MITM" = "0" ]; then
    for cmd in iptables dnsmasq ip; do
        command -v "$cmd" >/dev/null 2>&1 || need_pkg="$need_pkg $cmd"
    done
fi
if [ -n "$TMUX_SESSION" ]; then
    command -v tmux >/dev/null 2>&1 || need_pkg="$need_pkg tmux"
fi
if [ -n "$need_pkg" ]; then
    echo "$LOG_PREFIX installing missing tools:$need_pkg"
    apt-get update -qq
    if [ "$NO_MITM" = "0" ]; then
        apt-get install -y -qq iptables dnsmasq iproute2
    fi
    if [ -n "$TMUX_SESSION" ]; then
        apt-get install -y -qq tmux
    fi
fi

# ---- MITM setup (skipped with --no-mitm) --------------------------------
if [ "$NO_MITM" = "0" ]; then
    echo "$LOG_PREFIX setting up dummy0..."
    ip link show dummy0 >/dev/null 2>&1 && ip link del dummy0
    modprobe dummy 2>/dev/null || true
    if ! ip link add dummy0 type dummy 2>&1; then
        echo "$LOG_PREFIX FATAL: cannot create dummy0 interface"
        exit 1
    fi
    ip addr add 10.0.0.1/24 dev dummy0
    ip link set dummy0 up
    echo "$LOG_PREFIX dummy0 up"

    echo "$LOG_PREFIX starting dnsmasq..."
    pkill -x dnsmasq 2>/dev/null || true
    sleep 0.2
    setsid nohup dnsmasq \
        --no-daemon --no-resolv --no-hosts \
        --address=/#/10.0.0.1 \
        --listen-address=127.0.0.1 \
        --bind-interfaces \
        --port=53 \
        --log-facility=/var/log/clawcage-dnsmasq.log \
        < /dev/null > /var/log/clawcage-dnsmasq-stderr.log 2>&1 &
    DNSMASQ_PID=$!
    disown 2>/dev/null || true
    sleep 0.3
    if ! kill -0 "$DNSMASQ_PID" 2>/dev/null; then
        echo "$LOG_PREFIX FATAL: dnsmasq failed to start"
        cat /var/log/clawcage-dnsmasq.log 2>/dev/null | head -20
        exit 1
    fi
    rm -f /etc/resolv.conf
    echo "nameserver 127.0.0.1" > /etc/resolv.conf
    echo "$LOG_PREFIX dnsmasq started (pid $DNSMASQ_PID)"

    echo "$LOG_PREFIX setting up iptables..."
    IPTABLES=iptables
    if command -v iptables-legacy >/dev/null 2>&1; then
        IPTABLES=iptables-legacy
    fi
    $IPTABLES -t nat -D OUTPUT -p tcp --dport 443 -j REDIRECT --to-port 10443 2>/dev/null || true
    $IPTABLES -t nat -A OUTPUT -p tcp --dport 443 -j REDIRECT --to-port 10443
    echo "$LOG_PREFIX iptables rule added"
else
    echo "$LOG_PREFIX skipping dummy0 / dnsmasq / iptables (--no-mitm)"
fi

# ---- Launch guest agents -------------------------------------------------
# setsid + nohup + </dev/null ensures full detachment from the SSH session,
# so the ssh command that invoked this script can exit cleanly.
start_agent() {
    local name="$1"
    local path="$BIN_DIR/$name"
    if [ ! -x "$path" ]; then
        echo "$LOG_PREFIX WARN: $name not found at $path"
        return
    fi
    setsid nohup "$path" < /dev/null > "/var/log/$name.log" 2>&1 &
    local pid=$!
    disown 2>/dev/null || true
    sleep 0.3
    if kill -0 "$pid" 2>/dev/null; then
        echo "$LOG_PREFIX $name started (pid $pid)"
    else
        echo "$LOG_PREFIX WARN: $name exited immediately"
        tail -20 "/var/log/$name.log" 2>/dev/null | sed "s/^/$LOG_PREFIX  /"
    fi
}

# clawcage-net-proxy is only useful with MITM (it bridges port 10443 to the
# MITM proxy). In --no-mitm mode, agents contact the real internet directly.
if [ "$NO_MITM" = "0" ]; then
    start_agent clawcage-net-proxy
fi
start_agent clawcage-fs-watch
start_agent clawcage-port-watch
start_agent clawcage-sys-watch

# ---- pty-agent (optionally wrapped in tmux) -----------------------------
# In remote mode, pty-agent runs inside a tmux session so the user's shell
# survives SSH disconnects when they close their laptop. When they reopen,
# Tauri re-SSHes and `tmux attach -t <session>` reattaches to the same shell.
PTY_AGENT_PATH="$BIN_DIR/clawcage-pty-agent"
if [ -x "$PTY_AGENT_PATH" ] && [ -n "$TMUX_SESSION" ]; then
    # Kill any previous tmux session by the same name (idempotent).
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
    # New detached tmux session. The agent's env inherits CLAWCAGE_TRANSPORT etc.
    tmux new-session -d -s "$TMUX_SESSION" -x 200 -y 50 \
        "$PTY_AGENT_PATH; exec bash"
    sleep 0.2
    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        echo "$LOG_PREFIX pty-agent running in tmux session '$TMUX_SESSION'"
        echo "$LOG_PREFIX   attach with: tmux attach -t $TMUX_SESSION"
    else
        echo "$LOG_PREFIX WARN: tmux session did not come up"
    fi
elif [ -x "$PTY_AGENT_PATH" ]; then
    echo "$LOG_PREFIX pty-agent not auto-launched (no --tmux-session)"
else
    echo "$LOG_PREFIX WARN: $PTY_AGENT_PATH not found"
fi

echo "$LOG_PREFIX setup complete"

# ---- Smoke tests --------------------------------------------------------
echo ""
echo "$LOG_PREFIX === smoke tests ==="

if [ "$NO_MITM" = "0" ]; then
    echo "$LOG_PREFIX DNS lookup via 127.0.0.1:"
    getent hosts example.com 2>&1 | sed "s/^/$LOG_PREFIX   /" || echo "$LOG_PREFIX   (getent failed)"
    echo "$LOG_PREFIX iptables nat OUTPUT chain:"
    $IPTABLES -t nat -L OUTPUT -n --line-numbers 2>&1 | sed "s/^/$LOG_PREFIX   /"
    echo "$LOG_PREFIX dummy0 addr:"
    ip -4 addr show dev dummy0 2>&1 | sed "s/^/$LOG_PREFIX   /"
else
    echo "$LOG_PREFIX real-internet reachability (https://example.com):"
    curl -s -o /dev/null -w "  HTTP %{http_code} in %{time_total}s\n" \
        --max-time 5 https://example.com 2>&1 | sed "s/^/$LOG_PREFIX /" || \
        echo "$LOG_PREFIX   (curl failed)"
fi

echo "$LOG_PREFIX listening sockets:"
ss -tlnp 2>&1 | head -20 | sed "s/^/$LOG_PREFIX   /"

if [ -n "$TMUX_SESSION" ]; then
    echo "$LOG_PREFIX tmux sessions:"
    tmux list-sessions 2>&1 | sed "s/^/$LOG_PREFIX   /"
fi

echo "$LOG_PREFIX === done ==="
