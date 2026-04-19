# Privy Dot — Technical Notes

Stealth address protocol implementation on Polkadot (pallet-revive / PolkaVM).

---

## Protocol: ECPDKSAP

**Elliptic Curve Pairing Dual Key Stealth Address Protocol**

- **Scheme ID**: 2901
- **Spending key**: SECP256k1 (standard Ethereum key, derives the stealth address)
- **Viewing key**: BN254 (pairing-friendly, used to scan/detect incoming transfers without exposing spending key)
- **Meta address format**: `K:::V` (spending public key ::: viewing public key, delimited by `:::`)
- **Flow**:
  1. Receiver shares `K:::V` meta address publicly
  2. Sender calls `wasmApi.send(K, V)` → gets `{ R, viewTag, spendingPubKey }`
  3. Sender derives `stealthAddress = computeAddress(spendingPubKey)` and calls `sendEthViaProxy(stealthAddress, R, viewTag)`
  4. Contract emits `Announcement(schemeId, stealthAddress, caller, R, viewTag)` and forwards value
  5. Receiver scans: calls `wasmApi.scan(k, v, Rs[], viewTags[])` → gets spending private keys for matched addresses
  6. Receiver can spend from stealth address using the derived private key

---

## Cryptographic WASM Module

- **File**: `web/public/privy-core.wasm`
- **Language**: Go, compiled to WASM via `GOOS=js GOARCH=wasm go build`
- **Runtime**: loaded via `wasm-exec.js` (Go's standard JS bridge, must match Go version)
- **Exposed functions** (on `window`):
  - `new_meta()` → `{ k, v, K, V }` — generate fresh key pairs
  - `get_meta(JSON { k, v })` → `{ k, v, K, V }` — derive public keys from private keys
  - `send(JSON { K, V })` → `{ r, R, viewTag, spendingPubKey }` — compute stealth send params
  - `scan(JSON { k, v, Rs[], viewTags[] })` → `{ spendingPubKeys[], spendingPrivKeys[] }` — detect matching announcements
- **Gotcha**: Go's `hex.DecodeString` requires even-length hex — always pad viewTag before `ethers.getBytes()`

---

## Contract: ECPDKSAP v2

**Location**: `contracts/stealth-v2/`

### Why v2 (pvm-contract-macros)?

v2 uses the `pvm-contract-macros` framework from `github.com/paritytech/cargo-pvm-contract`:
- `#[pvm_contract_macros::contract("ECPDKSAP.sol", allocator = "pico")]` — auto-generates ABI dispatch
- `#[pvm_contract_macros::method]` — auto-decodes ABI params, encodes return values
- `#[pvm_contract_macros::constructor]` — auto-handles deploy
- Uses `pvm_contract_types::Address` and `pvm_contract_types::Bytes` (requires `features = ["alloc"]`)
- Uses `picoalloc = "5"` as heap allocator (fixed 256B heap by default)

### vs v1 (raw pallet-revive-uapi)

| | v1 (raw) | v2 (framework) |
|---|---|---|
| Binary size | 2,543 bytes | 14,754 bytes |
| ABI dispatch | Manual selector matching | Auto-generated |
| Param decoding | Manual `read_u256`/`read_address` | Auto |
| Heap | None needed | picoalloc (~12KB overhead) |

v1 is smaller; v2 is easier to maintain. For production, v1 size matters on Paseo Asset Hub.

### Build

```bash
cd contracts/stealth
cargo build --release
# Note: host (x86_64-mac) compilation will fail with HostFnImpl errors — that's expected.
# The .polkavm artifact is produced by build.rs before the host compile step.
# The file you need: target/ecpdksap_v2.release.polkavm
```

### Deploy

```bash
cd contracts/stealth
npm install
npm run deploy:local      # local node at 127.0.0.1:8545
npm run deploy:testnet    # Paseo Asset Hub (needs PRIVATE_KEY in hardhat vars)
```

Deploy script writes the contract address to:
- `deployments.json` (project root)
- `web/src/config/deployment.ts` (imported by the web app)

### Key contract details

- **Method**: `sendEthViaProxy(address stealthAddress, bytes R, bytes viewTag)` — payable, emits Announcement, forwards value
- **Method**: `ecpdksapSchemeId()` → `uint256` (returns 2901)
- **Event**: `Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)`
- **Note**: `ephemeralPubKey` is the UTF-8 encoded point string `R`; `metadata` first byte is `viewTag`
- Registry (`registerMetaAddress` / `resolve`) is commented out — off-chain meta address sharing for now

---

## Network

- **Local node**: Polkadot SDK dev node (zombienet or `--dev`)
  - EVM RPC: `http://127.0.0.1:8545`
  - Alice private key: `0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133`
- **Testnet**: Paseo Asset Hub
  - EVM RPC: `https://services.polkadothub-rpc.com/testnet`
  - Chain ID: 420420417
  - Explorer: https://assethub-paseo.subscan.io
- **pallet-revive** handles both EVM ABI calls and native PolkaVM contracts — same ABI encoding, different VM

---

## Web App

**Location**: `web/`

Standalone React + Vite app (no Polkadot API dependency, no router — just ethers + WASM).

### Config

- **RPC URL**: `VITE_RPC_URL` env var, defaults to `http://127.0.0.1:8545`
- **Contract address**: `web/src/config/deployment.ts` (auto-updated by deploy script)

### Run locally

```bash
cd web
npm install
npm run dev          # http://localhost:5173
```

### Panels

- **Keys** — Generate/import/export SECP256k1 + BN254 key pairs. Stored in localStorage per wallet address.
- **Send** — Paste recipient's `K:::V` → generate one-time stealth address → send PAS
- **Scan** — Fetch all `Announcement` events, run WASM scan, show matched stealth addresses with balances
- **Receive** — Display own meta address for sharing

---

## Known Issues / Gotchas

1. **viewTag odd hex length**: WASM `send()` sometimes returns viewTag with odd number of hex chars. Must pad before `ethers.getBytes()`:
   ```ts
   const raw = viewTag.replace(/^0x/, "");
   const padded = raw.length % 2 === 0 ? raw : "0" + raw;
   ethers.getBytes("0x" + padded);
   ```

2. **v2 build on Mac**: `cargo build --release` produces host compilation errors for `pallet-revive-uapi` (x86_64 not supported). This is expected — the `.polkavm` artifact is already written by `build.rs` before the host stage fails.

3. **picoalloc heap**: Default 256B heap from `allocator = "pico"`. If registry is re-enabled (longer strings), increase heap size.

4. **wasm-exec.js version**: Must match the Go version used to compile `privy-core.wasm`. If Go is updated, copy the new `wasm-exec.js` from `$(go env GOROOT)/misc/wasm/wasm-exec.js`.

5. **MetaMask on local node**: MetaMask may not support the local chain. Use private key mode (`0x5fb92d6e...` for Alice) as fallback.

---

## Project Structure

```
privy-dot/
  contracts/
    rust-v2/            ← PolkaVM contract (pvm-contract-macros)
      src/ecpdksap_v2.rs
      Cargo.toml
      build.rs
      ECPDKSAP.sol      ← Solidity interface (for ABI codegen only)
      hardhat.config.ts
      package.json
      scripts/deploy.ts
  web/                  ← Standalone React/Vite frontend
    public/
      privy-core.wasm   ← Go WASM crypto module (BN254 + SECP256k1)
      wasm-exec.js      ← Go WASM JS bridge
    src/
      App.tsx           ← Main app (header + sidebar + panels)
      main.tsx
      index.css
      chain.ts          ← ethers provider/contract helpers
      wasm.ts           ← WASM init + wasmApi wrapper
      types.ts
      config/
        deployment.ts   ← Contract address (auto-updated by deploy)
      panels/
        Keys.tsx
        Send.tsx
        Scan.tsx
        Register.tsx
    index.html
    package.json
    vite.config.ts
    tailwind.config.js
  deployments.json      ← Contract address (machine-readable)
  NOTES.md              ← This file
```