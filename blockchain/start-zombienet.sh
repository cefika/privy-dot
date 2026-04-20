#!/usr/bin/env bash
# Pokreće zombienet i automatski injektuje Aura ključeve u oba collatora.
# Korišćenje: ./start-zombienet.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PARA_1000_RPC="http://127.0.0.1:9944"
PARA_2000_RPC="http://127.0.0.1:9935"

# Alice sr25519 public key (za para 1000 — invulnerable u genezi)
ALICE_PUBKEY="0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d"
# Charlie sr25519 public key (za para 2000 — invulnerable u genezi)
CHARLIE_PUBKEY="0x90b5ab205c6974c9ea841be688864633dc9ca8a357843eeacf2314649965fe22"

ETH_RPC_PID=""

cleanup() {
    echo ""
    echo "Gašenje..."
    [ -n "$ETH_RPC_PID" ] && kill "$ETH_RPC_PID" 2>/dev/null || true
    kill "$ZOMBIENET_PID" 2>/dev/null || true
    wait "$ZOMBIENET_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "=== Privy Dot — XCM Test Network ==="
echo ""

# Pokreni zombienet u pozadini
cd "$SCRIPT_DIR"
zombienet spawn zombienet.toml &
ZOMBIENET_PID=$!
echo "Zombienet PID: $ZOMBIENET_PID"
echo ""

# Funkcija: čekaj dok RPC ne odgovori
wait_for_rpc() {
    local url="$1"
    local name="$2"
    echo -n "Čekam $name ($url)..."
    for i in $(seq 1 120); do
        if curl -sf -X POST -H "Content-Type: application/json" \
            -d '{"jsonrpc":"2.0","id":1,"method":"system_health","params":[]}' \
            "$url" >/dev/null 2>&1; then
            echo " spreman!"
            return 0
        fi
        printf "."
        sleep 2
    done
    echo " TIMEOUT!"
    return 1
}

# Funkcija: ubaci Aura ključ
insert_aura_key() {
    local url="$1"
    local seed="$2"
    local pubkey="$3"
    local name="$4"

    echo -n "Injektujem $name Aura ključ..."
    local result
    result=$(curl -sf -X POST -H "Content-Type: application/json" \
        -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"author_insertKey\",\"params\":[\"aura\",\"$seed\",\"$pubkey\"]}" \
        "$url" 2>/dev/null || echo "GREŠKA")

    if echo "$result" | grep -q '"result":null'; then
        echo " OK"
    else
        echo " GREŠKA: $result"
    fi
}

# Čekaj oba parachain RPC-a
wait_for_rpc "$PARA_1000_RPC" "para 1000 collator"
wait_for_rpc "$PARA_2000_RPC" "para 2000 collator"

echo ""

# Injektuj Aura ključeve
insert_aura_key "$PARA_1000_RPC" "//Alice" "$ALICE_PUBKEY" "Alice"
insert_aura_key "$PARA_2000_RPC" "//Charlie" "$CHARLIE_PUBKEY" "Charlie"

# Pokreni eth-rpc proxy za Para 1000
echo ""
echo -n "Pokrećem eth-rpc proxy na http://127.0.0.1:8545..."
eth-rpc \
    --node-rpc-url ws://127.0.0.1:9944 \
    --rpc-port 8545 \
    --chain "$SCRIPT_DIR/chain_spec.json" \
    > /tmp/eth-rpc.log 2>&1 &
ETH_RPC_PID=$!
echo " PID: $ETH_RPC_PID"

echo ""
echo "=== Mreža je sprema ==="
echo "  Relay chain (alice):  ws://127.0.0.1:9950"
echo "  Para 1000  (alice):   ws://127.0.0.1:9944"
echo "  Para 2000  (charlie): ws://127.0.0.1:9935"
echo "  ETH RPC    (proxy):   http://127.0.0.1:8545"
echo ""
echo "Pritisni Ctrl+C za zaustavljanje."

wait "$ZOMBIENET_PID"