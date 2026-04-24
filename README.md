# Privy Dot

Privacy layer for Polkadot — a full-stack implementation of the **ECPDKSAP stealth address protocol** on a Substrate parachain with PolkaVM smart contracts.

---

## Table of Contents

- [What problem does this solve?](#what-problem-does-this-solve)
- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Repository Layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Setup Mode 1 — Docker (simple local dev)](#setup-mode-1--docker-simple-local-dev)
- [Setup Mode 2 — Zombienet (XCM testing)](#setup-mode-2--zombienet-xcm-testing)
- [Hosted Frontend (GitHub Pages + Cloudflare Tunnel)](#hosted-frontend-github-pages--cloudflare-tunnel)
- [Updating the WASM on GitHub Pages](#updating-the-wasm-on-github-pages)
- [Runtime Upgrade](#runtime-upgrade)
- [Networks](#networks)
- [Protocol Deep Dive](#protocol-deep-dive)
- [Pallet Extrinsics](#pallet-extrinsics)
- [EVM Precompile](#evm-precompile)
- [Key Addresses](#key-addresses)
- [Utility Scripts](#utility-scripts)
- [Components](#components)

---

## What problem does this solve?

On public blockchains every transaction is visible. If you publish your wallet address (e.g. to receive a payment), anyone can see every transfer you receive, your total balance, and who sent funds to you.

Stealth addresses break this linkability. The recipient never reveals their actual wallet. Instead they publish a **meta address** — two public keys that senders use to derive a fresh, one-time address for each payment. Only the recipient can detect which on-chain addresses belong to them (using their private viewing key), and only the recipient can spend from those addresses (using their private spending key).

---

## How it works

The scheme is **ECPDKSAP** (Elliptic Curve Pairing Dual Key Stealth Address Protocol, scheme ID `2901`).

Two separate key types are used intentionally:

| Key | Curve | Role |
| --- | --- | --- |
| Spending key `k` / `K` | SECP256k1 | Controls funds. Never exposed during scanning. |
| Viewing key `v` / `V` | BN254 G1 | Used to detect incoming transfers. Can be delegated to an auditor without giving spending access. |

The meta address format is `K:::V` — both public keys concatenated with `:::` as separator.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Browser                                                         │
│                                                                  │
│  ┌──────────────────────┐    ┌──────────────────────────────┐   │
│  │  web/  (React/Vite)  │    │  sdk/  (TypeScript SDK)      │   │
│  │  Keys, Send, Scan,   │    │  importable by any app       │   │
│  │  Receive, Payroll,   │    └──────────────────────────────┘   │
│  │  Multisig, Business  │                                        │
│  └──────────┬───────────┘                                        │
│             │ ethers.js (EVM JSON-RPC)                           │
│  ┌──────────▼──────────────────────────┐                         │
│  │  core/  privy-core.wasm             │                         │
│  │  Go → WASM (fetched from GH Pages)  │                         │
│  │  new_meta / send / scan             │                         │
│  │  BN254 (gnark) + SECP256k1          │                         │
│  └─────────────────────────────────────┘                         │
└────────────────────────┬─────────────────────────────────────────┘
                         │ JSON-RPC (eth_*)
                         │ ← direct on localhost
                         │ ← via Cloudflare Tunnel on GitHub Pages
          ┌──────────────▼──────────────────────┐
          │  eth-rpc  (pallet-revive adapter)    │
          │  http://127.0.0.1:8545              │
          └──────────────┬──────────────────────┘
                         │ WebSocket
          ┌──────────────▼──────────────────────┐
          │  Substrate parachain node            │
          │  ws://127.0.0.1:9944                │
          │                                      │
          │  pallet-stealth-addresses            │
          │  - meta address registry             │
          │  - announcement index (view tags)    │
          │  - gas sponsorship pool              │
          │  - XCM cross-chain sends             │
          │                                      │
          │  pallet-revive (PolkaVM)             │
          │  - contracts/stealth → ECPDKSAP      │
          │  - contracts/usdc   → mock ERC-20    │
          └──────────────────────────────────────┘

  Docker mode: single node container (simple, no relay chain)
  Zombienet mode: relay chain (rococo-local) + para 1000 + para 2000
                  (required for XCM cross-chain testing)
```

There are **two parallel paths** for sending and announcing stealth transfers:

1. **EVM contract path** (`contracts/stealth`) — call `sendEthViaProxy()` via MetaMask or ethers.js. Contract forwards value and emits `Announcement` event. Easiest to integrate from any EVM tooling.

2. **Native pallet path** (`pallet-stealth-addresses`) — call extrinsics directly via Substrate. Required for XCM cross-chain stealth sends, gas-sponsored withdrawals, and on-chain meta address registration.

Both produce scannable on-chain announcements. The frontend uses the EVM contract path today; the pallet path is active and accessible via the precompile at `0x0000000000000000000000000000000010000000`.

---

## Repository Layout

```
privy-dot/
├── blockchain/
│   ├── pallets/
│   │   ├── stealth-addresses/   ← ECPDKSAP FRAME pallet
│   │   └── template/            ← PoE template pallet
│   ├── runtime/                 ← Cumulus parachain runtime (polkadot-sdk stable2512-3)
│   ├── vendor/                  ← Locally patched Rust crates
│   ├── chain_spec.json          ← Dev chain spec (para 1000)
│   ├── chain_spec_2000.json     ← Dev chain spec (para 2000, for XCM)
│   ├── Dockerfile               ← Node Docker image
│   ├── zombienet.toml           ← Zombienet topology (relay + 2 paras + HRMP channels)
│   ├── start-zombienet.sh       ← Start zombienet + inject Aura keys + eth-rpc
│   ├── setup-usdc.mjs           ← Create USDC asset on para 2000 and optionally mint
│   └── setup-usdc-all.mjs       ← Create + mint USDC on both para 1000 and para 2000
├── contracts/
│   ├── stealth/                 ← ECPDKSAP PolkaVM contract (Rust, pvm-contract-macros)
│   └── usdc/                    ← Mock USDC PolkaVM contract (Rust, raw pallet-revive-uapi)
├── core/                        ← Go WASM crypto module (BN254 + SECP256k1)
├── sdk/                         ← TypeScript SDK (ethers + Polkadot API)
├── web/                         ← React/Vite frontend
│   ├── public/
│   │   ├── privy-core.wasm      ← Go WASM binary (also hosted on GitHub Pages)
│   │   └── wasm-exec.js         ← Go WASM JS bridge
│   └── runtime-upgrade.mjs      ← Script to push a runtime upgrade via sudo
├── scripts/
│   └── start-all.sh             ← One-command Docker stack bootstrap
├── docker/
│   ├── Dockerfile.node          ← Builds the parachain node image
│   └── Dockerfile.eth-rpc       ← Builds the Ethereum RPC adapter image
├── docker-compose.yml           ← Node + eth-rpc services
├── deployments.json             ← Deployed contract addresses (auto-updated by deploy script)
├── rust-toolchain.toml          ← Pinned Rust toolchain
└── Cargo.toml                   ← Rust workspace root
```

---

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Docker | any recent | Runs the parachain node in Docker mode |
| Node.js | 22.x | Required by web app and all `.mjs` scripts |
| npm | 10+ | |
| Go | 1.24+ | Only needed to rebuild `privy-core.wasm` |
| Rust + cargo | see `rust-toolchain.toml` | Only needed to rebuild contracts or blockchain |
| `zombienet` | latest | Only needed for XCM testing (mode 2) |
| `polkadot` binary | stable2512-3 | Only needed for XCM testing (relay chain) |
| `polkadot-omni-node` | stable2512-3 | Only needed for XCM testing (parachain collator) |
| `eth-rpc` | from polkadot-sdk | Only needed for XCM testing (Ethereum adapter) |
| `cloudflared` | latest | Only needed when exposing local node to GitHub Pages frontend |

---

## Setup Mode 1 — Docker (simple local dev)

The easiest way to get running. Everything except the frontend runs in Docker containers.

```bash
./scripts/start-all.sh
```

This does the following automatically:
1. **Starts Docker containers** — the first run compiles the parachain runtime inside Docker (~10–20 min, cached after that).
2. **Waits for `eth-rpc`** — polls `eth_chainId` until the Ethereum JSON-RPC adapter is ready at `http://127.0.0.1:8545`.
3. **Builds contracts** (first time only) — `cargo build --release` in `contracts/stealth/` and `contracts/usdc/`. The host compilation step is expected to fail on Mac — the `.polkavm` artifact is already written by `build.rs` before that stage.
4. **Deploys contracts** — runs `npm run deploy:local`, writes address to `deployments.json` and `web/src/config/deployment.ts`.
5. **Starts frontend** at `http://localhost:5173`.

Press `Ctrl+C` to stop. Docker containers keep running until `docker compose down`.

### Manual Docker commands

```bash
# Start node only
docker compose up -d

# Stop and clean up chain state
docker compose down -v

# Check logs
docker compose logs -f node
docker compose logs -f eth-rpc

# Deploy contracts separately
cd contracts/stealth && npm install && npm run deploy:local

# Start frontend separately
cd web && npm install && npm run dev
```

---

## Setup Mode 2 — Zombienet (XCM testing)

Used when testing **cross-chain stealth transfers** (XCM). Spawns a full local relay chain (rococo-local) plus two parachains connected by HRMP channels.

### What runs

| Service | Port | Notes |
| --- | --- | --- |
| Relay chain — alice | ws://127.0.0.1:9950 | rococo-local validator |
| Relay chain — bob | ws://127.0.0.1:9951 | rococo-local validator |
| Para 1000 — collator alice | ws://127.0.0.1:9944 | main stealth chain |
| Para 2000 — collator charlie | ws://127.0.0.1:9935 | second chain for XCM |
| eth-rpc proxy | http://127.0.0.1:8545 | Ethereum adapter on para 1000 |

### Start

```bash
cd blockchain
./start-zombienet.sh
```

The script:
1. Runs `zombienet spawn zombienet.toml` in the background.
2. Waits for both parachain RPCs to be ready.
3. Injects Aura keys into both collators via `author_insertKey` (required so blocks are produced).
4. Starts the `eth-rpc` adapter on port 8545.

### Set up USDC on both chains

```bash
cd blockchain
node setup-usdc-all.mjs
```

This creates asset ID `1` (USDC, 6 decimals, `is_sufficient=true`) on both para 1000 and para 2000, and mints 1000 USDC to Alice, Bob, and Charlie.

Or to set up only para 2000 and optionally mint to a specific address:

```bash
node setup-usdc.mjs --mint 5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY 5
```

> **Why `is_sufficient=true`?** Stealth addresses are always fresh accounts with no native token balance. Without `is_sufficient=true`, an account cannot receive an asset unless it already has a native token balance. Setting it to `true` removes this requirement.

### Redeploy contracts against zombienet

```bash
cd contracts/stealth && npm run deploy:local
```

The contracts deploy to the EVM RPC at `http://127.0.0.1:8545`, which is the same address in both Docker and Zombienet mode.

---

## Hosted Frontend (GitHub Pages + Cloudflare Tunnel)

The frontend is deployed to GitHub Pages at `https://cefika.github.io/privy-dot/`. Because GitHub Pages is served over HTTPS, it cannot call a plain `http://localhost:8545` RPC directly (browsers block mixed content). **Cloudflare Tunnel** solves this by creating a public HTTPS URL that forwards to the local node.

### Setup

1. Install `cloudflared`:
   ```bash
   brew install cloudflared
   ```

2. Start a tunnel pointing at the local eth-rpc:
   ```bash
   cloudflared tunnel --url http://127.0.0.1:8545
   ```
   Cloudflare prints a public URL like `https://random-name.trycloudflare.com`.

3. Open the hosted frontend, open the settings panel, and paste that URL as the RPC endpoint. The frontend stores it in `localStorage` and uses it for all subsequent calls.

> The tunnel URL changes every time `cloudflared` is restarted. Update the frontend's RPC setting whenever you start a new tunnel.

### RPC URL resolution in the frontend

The frontend resolves the EVM RPC URL in this order:
1. `VITE_RPC_URL` env var (set at build time)
2. `localStorage` RPC override (set at runtime via settings panel)
3. `window.location.origin + /eth-rpc` — works in local dev because Vite proxies `/eth-rpc` → `http://127.0.0.1:8545`

---

## Updating the WASM on GitHub Pages

The cryptographic WASM binary (`privy-core.wasm`) is hosted on GitHub Pages and fetched by the frontend at runtime from:
```
https://cefika.github.io/privy-dot/privy-core.wasm
```

After rebuilding the WASM in `core/`, it needs to be pushed to the `gh-pages` branch (or the GitHub Pages source directory) so the hosted frontend picks up the new version.

```bash
# Rebuild WASM
cd core
GOOS=js GOARCH=wasm go build -o ../web/public/privy-core.wasm .

# Copy matching JS bridge (must match Go version)
cp "$(go env GOROOT)/misc/wasm/wasm-exec.js" ../web/public/wasm-exec.js

# Deploy to GitHub Pages (adjust to your Pages setup)
# If using the gh-pages branch, copy the files there and push.
```

> `wasm-exec.js` must always match the Go version used to compile the WASM. If Go is updated, the bridge file must be updated too.

---

## Runtime Upgrade

To upgrade the running chain's runtime without restarting the node (e.g. after changing the pallet):

```bash
# Build the new runtime WASM
cargo build -p stack-template-runtime --release

# Push the upgrade via sudo
node web/runtime-upgrade.mjs

# Or specify a custom WASM path or WS URL
node web/runtime-upgrade.mjs \
  --wasm target/release/wbuild/stack-template-runtime/stack_template_runtime.compact.compressed.wasm \
  --ws ws://127.0.0.1:9944
```

The script uses `sudo.sudo(system.setCodeWithoutChecks(wasm))` signed by Alice.

---

## Networks

| Network | Substrate WS | EVM RPC | Chain ID |
| --- | --- | --- | --- |
| Local — Docker | `ws://127.0.0.1:9944` | `http://127.0.0.1:8545` | 420420421 |
| Local — Zombienet para 1000 | `ws://127.0.0.1:9944` | `http://127.0.0.1:8545` | 420420421 |
| Local — Zombienet para 2000 | `ws://127.0.0.1:9935` | — | — |
| Paseo Asset Hub (testnet) | — | `https://services.polkadothub-rpc.com/testnet` | 420420417 |

Explorer for testnet: [assethub-paseo.subscan.io](https://assethub-paseo.subscan.io)

### Deploy to Paseo Asset Hub

```bash
cd contracts/stealth
npx hardhat vars set PRIVATE_KEY <your-key>
npm run deploy:testnet
```

---

## Protocol Deep Dive

### Key generation

The recipient generates two key pairs:
- `(k, K)` — SECP256k1 spending pair. `K = k × G`.
- `(v, V)` — BN254 G1 viewing pair. `V = v × G1`.

The meta address `K:::V` is shared publicly (e.g. on-chain via the pallet registry, or off-chain).

### Send flow

```
1. Sender calls wasmApi.send(K, V)
   ├── Generates ephemeral scalar r
   ├── R = r × G1  (BN254 ephemeral public key)
   ├── shared_secret = hash(r × V)
   ├── stealth_spending_key = k + shared_secret  (mod n, SECP256k1 field)
   ├── spendingPubKey = stealth_spending_key × G
   ├── stealthAddress = keccak256(spendingPubKey)[12:]  (Ethereum-style H160)
   └── viewTag = first byte of shared_secret  (used to skip 255/256 scan checks)

2. Sender calls contract.sendEthViaProxy(stealthAddress, R, viewTag)
   ├── Forwards value to stealthAddress
   └── Emits Announcement(schemeId=2901, stealthAddress, caller, R, viewTag)
```

### Scan flow

```
1. Recipient fetches all Announcement events (R, viewTag pairs)
2. Calls wasmApi.scan(k, v, Rs[], viewTags[])
   For each announcement:
   ├── Compute shared_secret = hash(v × R)  (viewing key only — spending key not needed)
   ├── Check: first byte of shared_secret == viewTag?
   │         No  → skip  (fast reject, eliminates ~255/256 of all events)
   │         Yes → full check
   ├── Derive stealth_spending_key = k + shared_secret
   ├── Verify derived stealthAddress matches the announced one
   └── If match → return spending private key
3. Recipient uses the derived private key to sign withdrawals
```

The view tag reduces scanning cost by ~256× — the recipient only performs the full BN254 point multiplication for roughly 1 in 256 announcements.

### Privacy guarantees

- The sender does not learn the recipient's spending key `k`.
- An observer cannot link a `stealthAddress` back to `K:::V` without knowing the viewing key `v`.
- The viewing key `v` can be delegated to an auditor (via `delegate_viewing_key` pallet extrinsic) for compliance purposes, without granting spending access.
- Stealth addresses are standard Ethereum-style H160 addresses — they are indistinguishable from regular accounts on-chain.

---

## Pallet Extrinsics

`pallet-stealth-addresses` (index in runtime: configured in `runtime/src/configs/mod.rs`):

| Extrinsic | Description |
| --- | --- |
| `register_stealth_meta_address(spending_pubkey [u8;33], viewing_pubkey [u8;64], scheme_id u32)` | Registers your `K:::V` on-chain. All parachains can resolve it via XCM. |
| `announce(ephemeral_pubkey [u8;64], view_tag [u8;2], stealth_address AccountId, metadata [u8;32])` | Called by the sender after a transfer. Indexed by view tag for efficient recipient scanning. |
| `sponsor_gas(amount u128)` | Deposits native tokens into the gas sponsorship pool. Stealth addresses have no balance to pay fees — sponsors cover the cost and take a commission on withdrawal. |
| `withdraw_from_stealth(stealth_address [u8;32], destination AccountId, sig [u8;65], sponsor AccountId)` | Recipient withdraws from a stealth address. `sig` proves ownership of the derived spending key. Fee paid from the sponsor's pool. |
| `delegate_viewing_key(delegate AccountId, valid_from BlockNumber, valid_until Option<BlockNumber>, encrypted_viewing_key [u8;64])` | Grants a time-limited viewing delegation to an auditor without exposing the spending key. |
| `send_stealth_xcm(dest_para_id u32, stealth_address [u8;32], amount u128, ephemeral_pubkey [u8;64], ...)` | Cross-chain stealth transfer of native token via XCM. |
| `send_stealth_asset_xcm(asset_id, dest_para_id u32, stealth_address [u8;32], amount u128, ...)` | Cross-chain stealth transfer of a pallet-assets token (e.g. USDC) via XCM. |

---

## EVM Precompile

A precompile bridges EVM callers (MetaMask, ethers.js) to the native pallet extrinsics, registered at a fixed address:

```
0x0000000000000000000000000000000010000000
```

ABI:

```ts
[
  "function registerMetaAddress(bytes spendingPubkey, bytes viewingPubkey, uint32 schemeId) external",
  "function announce(bytes ephemeralPubkey, bytes2 viewTag, bytes32 stealthAddress, bytes32 metadata) external",
  "function sendAndAnnounce(bytes32 stealthAddress, bytes ephemeralPubkey, bytes2 viewTag, bytes32 metadata) external payable",
]
```

`sendAndAnnounce` is the primary method used by the frontend — it sends PAS to the stealth address and writes the on-chain announcement in a single MetaMask transaction.

---

## Key Addresses

| Name | Value | Notes |
| --- | --- | --- |
| Alice private key | `0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133` | Pre-funded on every local dev node |
| Stealth precompile | `0x0000000000000000000000000000000010000000` | Bridges EVM → pallet |
| Deployed contract | see [`deployments.json`](deployments.json) | Updated automatically by deploy script |

---

## Utility Scripts

| Script | Location | Description |
| --- | --- | --- |
| `start-all.sh` | `scripts/` | Docker mode: start node, deploy contracts, start frontend |
| `start-zombienet.sh` | `blockchain/` | Zombienet mode: relay + 2 paras + eth-rpc |
| `setup-usdc.mjs` | `blockchain/` | Create + mint USDC asset on para 2000 |
| `setup-usdc-all.mjs` | `blockchain/` | Create + mint USDC on both para 1000 and para 2000 |
| `runtime-upgrade.mjs` | `web/` | Push a runtime upgrade to a running chain via sudo |

---

## Components

| Directory | Language | Description |
| --- | --- | --- |
| [`blockchain/`](blockchain/README.md) | Rust | Substrate parachain runtime, FRAME pallet, Docker node, Zombienet config |
| [`contracts/stealth/`](contracts/stealth/README.md) | Rust | ECPDKSAP PolkaVM contract — `sendEthViaProxy`, `Announcement` event |
| [`contracts/usdc/`](contracts/usdc/README.md) | Rust | Mock ERC-20 USDC PolkaVM contract for multi-token testing |
| [`core/`](core/README.md) | Go | Cryptographic WASM module — key generation, send, scan (BN254 + SECP256k1) |
| [`sdk/`](sdk/README.md) | TypeScript | Reusable SDK wrapping WASM, EVM, and Substrate interactions |
| [`web/`](web/README.md) | TypeScript/React | Frontend with Keys, Send, Scan, Receive, Payroll, Multisig panels |