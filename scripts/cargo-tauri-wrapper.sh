#!/bin/bash
# Wrapper around cargo that codesigns the aivm binary after building.
# Used by `cargo tauri dev` to ensure the virtualization entitlement is applied.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BINARY="$REPO_ROOT/target/debug/aivm"
ENTITLEMENTS="$REPO_ROOT/entitlements.plist"

# Run the real cargo with all original arguments
cargo "$@"

# After a successful build, codesign the binary if it exists
if [ -f "$BINARY" ]; then
    codesign --sign - --entitlements "$ENTITLEMENTS" --force "$BINARY" 2>/dev/null || true
fi
