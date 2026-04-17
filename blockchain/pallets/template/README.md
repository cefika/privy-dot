# Proof of Existence Pallet

A FRAME pallet that lets users create and revoke ownership claims over 32-byte blake2-256 hashes (e.g. file hashes).

## Dispatchables

- `create_claim(hash)` — Record who submitted the hash and when. Fails if the hash is already claimed.
- `revoke_claim(hash)` — Remove a claim. Only the original owner can revoke.

## Source Layout

| File | Purpose |
|---|---|
| `src/lib.rs` | Pallet storage, config, calls, events, and errors |
| `src/weights.rs` | Auto-generated weight functions from benchmarks |
| `src/benchmarking.rs` | Benchmark definitions for `create_claim` and `revoke_claim` |
| `src/mock.rs` | Mock runtime used by unit tests |
| `src/tests.rs` | Unit tests |

## Commands

```bash
# Check compilation
cargo check -p pallet-template

# Run unit tests
cargo test -p pallet-template

# Run benchmarks
cargo test -p pallet-template --features runtime-benchmarks
```

See [`../../README.md`](../../README.md) for full blockchain build and run instructions.
