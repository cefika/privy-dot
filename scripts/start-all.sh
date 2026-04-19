#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ETH_RPC="http://127.0.0.1:8545"
FRONTEND_PID=""

cleanup() {
    echo ""
    echo "Shutting down..."
    [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "=== Privy Dot — Local Stack ==="
echo ""

# [1] Start Docker if not already running
echo "[1/4] Starting Docker node + eth-rpc..."
cd "$ROOT_DIR"
docker compose up -d

# [2] Wait for eth-rpc to be ready
echo "[2/4] Waiting for Ethereum RPC at $ETH_RPC..."
for i in $(seq 1 60); do
    if curl -sf -X POST -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
        "$ETH_RPC" | grep -q result 2>/dev/null; then
        echo "      eth-rpc ready!"
        break
    fi
    if [ "$i" -eq 60 ]; then
        echo "ERROR: eth-rpc did not start in time. Check: docker compose logs"
        exit 1
    fi
    printf "      waiting... (%ds)\r" "$i"
    sleep 1
done

# [3] Build + Deploy contracts
STEALTH_ARTIFACT="$ROOT_DIR/contracts/stealth/target/ecpdksap.release.polkavm"
USDC_ARTIFACT="$ROOT_DIR/contracts/usdc/target/usdc.release.polkavm"

if [ ! -f "$STEALTH_ARTIFACT" ]; then
    echo "[3a/4] Building stealth contract (first time, may take a few minutes)..."
    cd "$ROOT_DIR/contracts/stealth"
    cargo build --release 2>&1 || true  # host compilation fails on Mac — that's expected
    cd "$ROOT_DIR"
fi

if [ ! -f "$USDC_ARTIFACT" ]; then
    echo "[3b/4] Building USDC contract (first time, may take a few minutes)..."
    cd "$ROOT_DIR/contracts/usdc"
    cargo build --release 2>&1 || true
    cd "$ROOT_DIR"
fi

echo "[3/4] Deploying contracts..."
cd "$ROOT_DIR/contracts/stealth"
npm install --silent
npm run deploy:local
cd "$ROOT_DIR"

# [4] Start frontend
echo "[4/4] Starting frontend..."
cd "$ROOT_DIR/web"
npm install --silent
npm run dev -- --host 127.0.0.1 --port 5173 &
FRONTEND_PID=$!

echo ""
echo "=== Stack running ==="
echo "  Ethereum RPC:  $ETH_RPC"
echo "  Frontend:      http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop."
wait "$FRONTEND_PID"