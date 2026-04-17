# Parachain Runtime

A Cumulus-based parachain runtime built on `polkadot-sdk stable2512-3`. Compatible with `polkadot-omni-node` for local development.

## What's Included

- **Core pallets**: System, Balances, Aura, Session, Sudo, XCM
- **TemplatePallet** (index 50): Proof of Existence — see [`../pallets/template/`](../pallets/template/)
- **pallet-revive** (index 90): EVM and PVM smart contract execution with Ethereum RPC compatibility
- **pallet-statement** + `sp-statement-store` runtime API for Statement Store support

## Source Layout

| File | Purpose |
|---|---|
| `src/lib.rs` | Runtime definition, opaque types, version, runtime APIs |
| `src/configs/mod.rs` | All pallet configuration (System, Balances, Revive, etc.) |
| `src/configs/xcm_config.rs` | XCM cross-chain messaging configuration |
| `src/genesis_config_presets.rs` | Genesis presets for dev and testnet |
| `src/tests.rs` | Runtime integration tests |
| `src/weights/` | Auto-generated weight files per pallet |

## Commands

```bash
# Build the runtime (WASM + native)
cargo build -p stack-template-runtime --release

# Run tests
cargo test -p stack-template-runtime

# Run all workspace tests including benchmarks
SKIP_PALLET_REVIVE_FIXTURES=1 cargo test --workspace --features runtime-benchmarks
```

The compiled WASM blob is output to:
```
target/release/wbuild/stack-template-runtime/stack_template_runtime.compact.compressed.wasm
```

See [`../README.md`](../README.md) for full blockchain build and run instructions.
