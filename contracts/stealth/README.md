# contracts/stealth — ECPDKSAP PolkaVM Contract

PolkaVM smart contract that receives tokens and emits `Announcement` events for the ECPDKSAP stealth address protocol. Written in Rust using [`pvm-contract-macros`](https://github.com/paritytech/cargo-pvm-contract).

## Interface

### Methods

| Method | Payable | Description |
|---|---|---|
| `sendEthViaProxy(address stealthAddress, bytes R, bytes viewTag)` | yes | Forwards sent value to `stealthAddress`, emits `Announcement` |
| `ecpdksapSchemeId()` | no | Returns `2901` |

### Event

```solidity
event Announcement(
    uint256 indexed schemeId,       // always 2901
    address indexed stealthAddress,
    address indexed caller,
    bytes ephemeralPubKey,          // R — the sender's ephemeral point (UTF-8 encoded)
    bytes metadata                  // first byte is viewTag
)
```

## Build

The build process is two-stage. `build.rs` produces the `.polkavm` artifact first, then Cargo compiles a host (x86_64) binary for ABI generation. **The host compilation step is expected to fail on Mac** — that is normal. The artifact you need is already written before that stage.

```bash
cd contracts/stealth
cargo build --release
```

Output artifact: `target/ecpdksap.release.polkavm`

## Deploy

Requires Node.js and the hardhat config in this directory.

```bash
cd contracts/stealth
npm install

# Local node (http://127.0.0.1:8545)
npm run deploy:local

# Paseo Asset Hub testnet (requires PRIVATE_KEY set via hardhat vars)
npm run deploy:testnet
```

The deploy script writes the contract address to:
- `../../deployments.json` — machine-readable, used by scripts
- `../../web/src/config/deployment.ts` — imported by the web app at build time

## Contract vs pallet-revive

The contract runs on `pallet-revive` (PolkaVM), not the EVM. It uses EVM ABI encoding for its interface (so ethers.js can call it), but executes in the PolkaVM runtime. The Solidity file (`ECPDKSAP.sol`) is the ABI interface only — it is not compiled.

## Why `pvm-contract-macros`?

The macro framework auto-generates ABI dispatch, parameter decoding, and return encoding from the Solidity interface file. The alternative (v1, raw `pallet-revive-uapi`) produces a smaller binary (~2.5KB vs ~14KB) but requires manual selector matching and parameter parsing. v2 is used here for maintainability.

## Notes

- Registry methods (`registerMetaAddress`, `updateMetaAddress`, `resolve`) are commented out — meta addresses are shared off-chain for now.
- Heap allocator is `picoalloc` with default 256B heap. Re-enabling the registry (which uses `String`/`Vec`) requires increasing the heap size.