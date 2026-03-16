# Aivm Justfile
#
# Dependency chains:
#
#   doctor          read-only check of all required tools (user-facing)
#   _install-tools  auto-installs rust targets, components, cargo tools (internal)
#   _check-assets   verifies VM assets exist, tells you to run build-assets if not
#
#   run          -> _check-assets -> _pack-initrd -> _sign -> _compile -> _frontend
#   test         -> _install-tools
#   build-assets -> doctor + _install-tools
#   full-test    -> test + _check-assets + _pack-initrd + _sign
#   install      -> doctor + full-test + _frontend
#
# First-time setup:
#   just setup        (installs all deps + builds assets -- full onboarding)
#   just doctor       (shows what's missing)
#   just build-assets (builds kernel, initrd, rootfs -- needs docker/podman)
#
# Daily dev:          just run     (fast ~10s, auto-repacks initrd)
# Before install:     just install (doctor + full-test + /Applications)
# Releases:           CI only -- push a vX.Y.Z tag to trigger .github/workflows/release.yaml

binary := "target/debug/aivm"
release_app := "target/release/bundle/macos/Aivm.app"
assets_dir := "assets"
entitlements := "entitlements.plist"

# One-command first-time setup: installs all deps, configures toolchain, builds assets
setup:
    #!/bin/bash
    set -euo pipefail
    echo "=== Aivm First-Time Setup ==="
    echo ""

    # 1. Brew dependencies
    echo "== Installing Homebrew dependencies =="
    for pkg in just podman b3sum; do
        if command -v "$pkg" &>/dev/null; then
            echo "  [OK] $pkg already installed"
        else
            echo "  Installing $pkg..."
            brew install "$pkg"
        fi
    done

    # 2. Musl cross-compiler
    if command -v aarch64-unknown-linux-musl-gcc &>/dev/null; then
        echo "  [OK] aarch64-unknown-linux-musl-gcc already installed"
    else
        echo "  Installing musl cross-compiler (this may take a few minutes)..."
        brew install messense/macos-cross-toolchains/aarch64-unknown-linux-musl
    fi

    # 3. .cargo/config.toml
    if [ -f ".cargo/config.toml" ] && grep -q 'aarch64-unknown-linux-musl' .cargo/config.toml 2>/dev/null; then
        echo "  [OK] .cargo/config.toml already configured"
    else
        echo "  Creating .cargo/config.toml with musl linker..."
        mkdir -p .cargo
        cat > .cargo/config.toml << 'EOF'
    [target.aarch64-unknown-linux-musl]
    linker = "aarch64-unknown-linux-musl-gcc"
    EOF
    fi

    # 4. Rust targets and tools
    echo ""
    echo "== Installing Rust targets and tools =="
    just _install-tools

    # 5. Node.js / pnpm
    echo ""
    echo "== Installing frontend dependencies =="
    if ! command -v pnpm &>/dev/null; then
        echo "  Installing pnpm..."
        npm install -g pnpm
    fi
    cd frontend && pnpm install && cd ..

    # 6. Podman machine
    echo ""
    echo "== Checking container runtime =="
    if command -v podman &>/dev/null; then
        if podman machine inspect &>/dev/null 2>&1; then
            echo "  [OK] Podman machine exists"
        else
            echo "  Initializing Podman machine..."
            podman machine init
        fi
        if podman machine inspect --format '{{{{.State}}}}' 2>/dev/null | grep -qi running; then
            echo "  [OK] Podman machine running"
        else
            echo "  Starting Podman machine..."
            podman machine start || echo "  (Podman machine may already be running)"
        fi
    fi

    # 7. Build VM assets
    echo ""
    echo "== Building VM assets (this takes ~10 minutes the first time) =="
    just build-assets

    echo ""
    echo "=== Setup complete! ==="
    echo ""
    echo "Quick start:"
    echo "  just dev    # hot-reload app (frontend + Rust)"
    echo "  just ui     # frontend-only dev (mock mode, no VM)"
    echo "  just run    # build + sign + boot VM (~10s)"

# Run the app in development mode with hot-reloading
dev: _check-assets _pack-initrd
    #!/bin/bash
    set -euo pipefail
    echo "Stopping running instances..."
    pkill -x aivm 2>/dev/null || true
    pkill -x Aivm 2>/dev/null || true
    # Free port 5173 so Vite can bind to it (Tauri devUrl expects it)
    lsof -ti:5173 | xargs kill -9 2>/dev/null || true
    sleep 0.5
    # Start frontend dev server in background
    (cd frontend && pnpm dev) &
    FRONTEND_PID=$!
    trap "kill $FRONTEND_PID 2>/dev/null" EXIT
    # Wait for frontend to be ready
    echo "Waiting for frontend dev server..."
    until curl -s http://localhost:5173 >/dev/null 2>&1; do sleep 0.3; done
    # Build, sign, and run
    cargo build -p aivm
    codesign --sign - --entitlements {{entitlements}} --force {{binary}}
    AIVM_ASSETS_DIR={{assets_dir}} {{binary}}
    

# Frontend-only dev server with mock data (no Tauri/VM needed)
ui:
    cd frontend && pnpm run dev

# Pack + boot VM (interactive or with command, ~10s)
run *CMD: _check-assets _pack-initrd _sign
    #!/bin/bash
    set -euo pipefail
    pkill -x aivm 2>/dev/null || true
    AIVM_ASSETS_DIR={{assets_dir}} {{binary}} {{CMD}}

# Full VM asset rebuild (kernel, initrd, rootfs) via Docker/Podman
build-assets: doctor _install-tools
    cd images && python3 build.py

# Unit tests + cross-compile check + frontend type-check (no VM)
test: _install-tools
    cargo llvm-cov --workspace --no-cfg-coverage
    cargo build --release --target aarch64-unknown-linux-musl -p aivm-agent 2>&1 | tail -3
    cd frontend && pnpm run check && pnpm run build

# Full validation: test + aivm-doctor + integration test + bench (boots VM)
full-test: test _check-assets _pack-initrd _sign
    @echo ""
    @echo "=== aivm-doctor ==="
    AIVM_ASSETS_DIR={{assets_dir}} {{binary}} "aivm-doctor"
    @echo ""
    @echo "=== Integration test ==="
    python3 scripts/integration_test.py --binary {{binary}} --assets {{assets_dir}}
    @echo ""
    @echo "=== Benchmarks ==="
    AIVM_ASSETS_DIR={{assets_dir}} {{binary}} "aivm-bench"

# Run in-VM benchmarks (disk I/O, rootfs read, CLI startup, HTTP latency)
bench: _check-assets _sign
    AIVM_ASSETS_DIR={{assets_dir}} {{binary}} "aivm-bench"

# Build release .app + install to /Applications + launch
install: doctor full-test _frontend
    cd crates/aivm-app && cargo tauri build
    codesign --sign - --entitlements {{entitlements}} --force --deep "{{release_app}}"
    @echo "Stopping running Aivm..."
    -@pkill -x Aivm 2>/dev/null || true
    -@pkill -x aivm 2>/dev/null || true
    @echo "Installing to /Applications..."
    rm -rf "/Applications/Aivm.app"
    cp -R "{{release_app}}" "/Applications/"
    @echo "Launching Aivm..."
    open "/Applications/Aivm.app"

# Check that all required dev tools and dependencies are installed
doctor:
    #!/bin/bash
    set -euo pipefail
    PASS=0; FAIL=0
    pass() { echo "  [PASS] $1"; PASS=$((PASS + 1)); }
    fail() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }

    echo "Aivm Doctor"
    echo "============="

    echo ""
    echo "== System Tools =="
    for tool in cargo rustup codesign pnpm node python3 sqlite3 git; do
        if command -v "$tool" &>/dev/null; then
            pass "$tool"
        else
            fail "$tool not found"
        fi
    done

    echo ""
    echo "== Container Runtime =="
    if command -v docker &>/dev/null; then
        pass "docker"
    elif command -v podman &>/dev/null; then
        pass "podman"
    else
        fail "docker or podman -- brew install podman && podman machine init && podman machine start"
    fi

    echo ""
    echo "== Rust Toolchain =="
    if rustup target list --installed 2>/dev/null | grep -q aarch64-unknown-linux-musl; then
        pass "target: aarch64-unknown-linux-musl"
    else
        fail "target: aarch64-unknown-linux-musl -- run: rustup target add aarch64-unknown-linux-musl"
    fi
    if rustup component list --installed 2>/dev/null | grep -q llvm-tools; then
        pass "component: llvm-tools (provides rust-lld)"
    else
        fail "component: llvm-tools -- run: rustup component add llvm-tools"
    fi

    echo ""
    echo "== Cross-Compiler =="
    if command -v aarch64-unknown-linux-musl-gcc &>/dev/null; then
        pass "aarch64-unknown-linux-musl-gcc"
    else
        fail "aarch64-unknown-linux-musl-gcc -- run: brew install messense/macos-cross-toolchains/aarch64-unknown-linux-musl"
    fi
    if [ -f ".cargo/config.toml" ] && grep -q 'aarch64-unknown-linux-musl' .cargo/config.toml 2>/dev/null; then
        pass ".cargo/config.toml (linker configured)"
    else
        fail ".cargo/config.toml missing musl linker config -- run: just setup"
    fi

    echo ""
    echo "== Cargo Tools =="
    for tool in cargo-llvm-cov b3sum cargo-tauri; do
        if command -v "$tool" &>/dev/null; then
            pass "$tool"
        else
            fail "$tool -- run: cargo install ${tool/cargo-/}"
        fi
    done

    echo ""
    echo "== Optional (CI/Release) =="
    for tool in gh openssl; do
        if command -v "$tool" &>/dev/null; then
            pass "$tool"
        else
            echo "  [SKIP] $tool -- brew install $tool (only needed for releases)"
        fi
    done

    echo ""
    echo "============="
    echo "Results: $PASS passed, $FAIL failed"
    if [ "$FAIL" -gt 0 ]; then
        echo ""
        echo "Install missing tools, or run: just _install-tools (auto-installs Rust components + cargo tools)"
        exit 1
    fi
    echo "All good!"

# Clean build artifacts
clean:
    cargo clean
    cd frontend && rm -rf dist node_modules
    rm -rf target/release/bundle/macos/Aivm.app target/release/Aivm.dmg

# Inspect session DB integrity and event summary (latest by default)
inspect-session *args='':
    python3 scripts/check_session.py {{args}}

# Update test fixture DB from a real session (scrubs API keys)
update-fixture src:
    #!/usr/bin/env bash
    set -euo pipefail
    src="{{src}}"
    dst="data/fixtures/test.db"
    pub="frontend/public/fixtures/test.db"
    # Checkpoint WAL so we get a single clean file
    sqlite3 "$src" "PRAGMA wal_checkpoint(TRUNCATE);"
    cp "$src" "$dst"
    # Scrub any leaked API keys (belt-and-suspenders)
    sqlite3 "$dst" "
        UPDATE net_events SET request_headers  = REPLACE(request_headers,  'x-api-key', 'x-api-key-REDACTED') WHERE request_headers  LIKE '%sk-%';
        UPDATE net_events SET request_headers  = REPLACE(request_headers,  'authorization', 'authorization-REDACTED') WHERE request_headers  LIKE '%Bearer%';
        UPDATE net_events SET request_body_preview  = '' WHERE request_body_preview  LIKE '%sk-%' OR request_body_preview  LIKE '%AIza%';
        UPDATE net_events SET response_body_preview = '' WHERE response_body_preview LIKE '%sk-%' OR response_body_preview LIKE '%AIza%';
    "
    # Verify no keys leaked
    count=$(sqlite3 "$dst" "SELECT COUNT(*) FROM (
        SELECT 1 FROM net_events WHERE request_headers  LIKE '%sk-ant-%' OR request_headers  LIKE '%AIza%'
        UNION ALL
        SELECT 1 FROM net_events WHERE request_body_preview LIKE '%sk-ant-%' OR request_body_preview LIKE '%AIza%'
        UNION ALL
        SELECT 1 FROM net_events WHERE response_body_preview LIKE '%sk-ant-%' OR response_body_preview LIKE '%AIza%'
    );")
    if [ "$count" -ne 0 ]; then
        echo "ERROR: Found $count rows with potential API keys -- aborting"
        exit 1
    fi
    # Remove WAL/SHM leftovers
    rm -f "$dst-wal" "$dst-shm"
    # Copy to frontend public
    cp "$dst" "$pub"
    echo "Updated fixture: $(sqlite3 "$dst" 'SELECT COUNT(*) FROM net_events') net_events, $(sqlite3 "$dst" 'SELECT COUNT(*) FROM model_calls') model_calls"

# Update model pricing data from pydantic/genai-prices
update-prices:
    curl -sL https://raw.githubusercontent.com/pydantic/genai-prices/main/prices/data_slim.json \
        -o config/genai-prices.json
    @echo "Updated config/genai-prices.json"

# --- Internal helpers (hidden from `just --list`) ---

# Auto-install Rust targets, components, and cargo tools
_install-tools:
    #!/bin/bash
    set -euo pipefail
    # Musl target for cross-compiling guest binaries
    if ! rustup target list --installed | grep -q aarch64-unknown-linux-musl; then
        echo "Installing aarch64-unknown-linux-musl target..."
        rustup target add aarch64-unknown-linux-musl
    fi
    # rust-lld linker (from llvm-tools component)
    if ! rustup component list --installed | grep -q llvm-tools; then
        echo "Installing llvm-tools (provides rust-lld)..."
        rustup component add llvm-tools
    fi
    # cargo-llvm-cov for coverage
    if ! command -v cargo-llvm-cov &>/dev/null; then
        echo "Installing cargo-llvm-cov..."
        cargo install cargo-llvm-cov
    fi
    # b3sum for BLAKE3 checksums
    if ! command -v b3sum &>/dev/null; then
        echo "Installing b3sum..."
        cargo install b3sum --locked
    fi
    # Tauri CLI
    if ! cargo tauri --version &>/dev/null; then
        echo "Installing Tauri CLI..."
        cargo install tauri-cli
    fi

# Verify VM assets exist (vmlinuz, initrd.img, rootfs)
_check-assets:
    #!/bin/bash
    set -euo pipefail
    dir="{{assets_dir}}"
    missing=()
    for f in vmlinuz initrd.img; do
        [ -f "$dir/$f" ] || missing+=("$f")
    done
    # Accept either rootfs format
    if [ ! -f "$dir/rootfs.squashfs" ] && [ ! -f "$dir/rootfs.img" ]; then
        missing+=("rootfs.squashfs")
    fi
    if [ ${#missing[@]} -gt 0 ]; then
        echo "ERROR: Missing VM assets in $dir/: ${missing[*]}"
        echo ""
        echo "Run 'just build-assets' to build them (requires docker or podman)."
        exit 1
    fi

_frontend:
    cd frontend && pnpm build

_compile: _frontend
    cargo build -p aivm

_sign: _compile
    codesign --sign - --entitlements {{entitlements}} --force {{binary}}

_pack-initrd:
    #!/bin/bash
    set -euo pipefail
    ROOT="{{justfile_directory()}}"
    INITRD="$ROOT/{{assets_dir}}/initrd.img"
    if [ ! -f "$INITRD" ]; then
        echo "ERROR: $INITRD not found. Run 'just build-assets' first."
        exit 1
    fi
    echo "=== Cross-compile agent ==="
    cargo build --release --target aarch64-unknown-linux-musl -p aivm-agent 2>&1 | tail -3
    echo ""
    echo "=== Repack initrd ==="
    WORKDIR=$(mktemp -d)
    cd "$WORKDIR"
    gzip -dc "$INITRD" | cpio -id 2>/dev/null
    cp "$ROOT/images/aivm-init" init
    chmod 755 init
    rm -f aivm-pty-agent aivm-net-proxy aivm-mcp-server aivm-fs-watch aivm-port-watch
    cp "$ROOT/target/aarch64-unknown-linux-musl/release/aivm-pty-agent" aivm-pty-agent
    chmod 555 aivm-pty-agent
    cp "$ROOT/target/aarch64-unknown-linux-musl/release/aivm-net-proxy" aivm-net-proxy
    chmod 555 aivm-net-proxy
    cp "$ROOT/target/aarch64-unknown-linux-musl/release/aivm-mcp-server" aivm-mcp-server
    chmod 555 aivm-mcp-server
    cp "$ROOT/target/aarch64-unknown-linux-musl/release/aivm-fs-watch" aivm-fs-watch
    chmod 555 aivm-fs-watch
    cp "$ROOT/target/aarch64-unknown-linux-musl/release/aivm-port-watch" aivm-port-watch
    chmod 555 aivm-port-watch
    cp "$ROOT/images/aivm-doctor" aivm-doctor
    chmod 755 aivm-doctor
    cp "$ROOT/images/aivm-bench" aivm-bench
    chmod 755 aivm-bench
    cp "$ROOT/images/aivm-bashrc" aivm-bashrc
    cp "$ROOT/images/banner.txt" aivm-banner.txt
    cp "$ROOT/images/tips.txt" aivm-tips.txt
    rm -rf diagnostics
    cp -r "$ROOT/images/diagnostics" diagnostics
    find . | cpio -o -H newc 2>/dev/null | gzip > "$INITRD"
    rm -rf "$WORKDIR"
    cd "$ROOT"
    (cd "{{assets_dir}}" && b3sum vmlinuz initrd.img rootfs.squashfs > B3SUMS)
    echo "initrd repacked (with agent + net-proxy + mcp-server + fs-watch + port-watch + doctor)"
