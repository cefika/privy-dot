# Blockchain

Polkadot SDK parachain za ECPDKSAP stealth address protokol, kompatibilan sa `polkadot-omni-node`.

## Directory Guide

| Path | What it contains |
| --- | --- |
| [`pallets/stealth-addresses/`](pallets/stealth-addresses/) | ECPDKSAP stealth address FRAME pallet |
| [`runtime/`](runtime/) | Parachain runtime na `polkadot-sdk stable2512-3` |
| [`vendor/`](vendor/) | Lokalno patched Rust crates |
| [`chain_spec.json`](chain_spec.json) | Generisan lokalni chain spec za devnet |
| [`Dockerfile`](Dockerfile) | Docker image koji pakuje chain node |
| [`zombienet.toml`](zombienet.toml) | Zombienet topologija za lokalni relay-backed setup |

## Common Commands

```bash
# Build runtime
cargo build -p privy-runtime --release

# Pallet unit testovi
cargo test -p pallet-stealth-addresses

# Svi testovi u workspaceu
SKIP_PALLET_REVIVE_FIXTURES=1 cargo test --workspace --features runtime-benchmarks
```

## Running Locally

- [`../scripts/start-all.sh`](../scripts/start-all.sh) — Pokreće Docker node + deploy contract + frontend