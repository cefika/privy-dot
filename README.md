# Privy Dot

Privacy layer for Polkadot — a full-stack implementation of the **ECPDKSAP stealth address protocol** on a Substrate parachain with PolkaVM smart contracts.

---

## Table of Contents

- [What problem does this solve?](#what-problem-does-this-solve)
- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Repository Layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Quick Start (Local Dev)](#quick-start-local-dev)
- [Manual Setup](#manual-setup)
- [Networks](#networks)
- [Protocol Deep Dive](#protocol-deep-dive)
- [Pallet Extrinsics](#pallet-extrinsics)
- [EVM Precompile](#evm-precompile)
- [Key Addresses](#key-addresses)
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
│  │  UI panels:          │    │  Can be imported by any app  │   │
│  │  Keys, Send, Scan,   │    │                              │   │
│  │  Receive, Payroll,   │    └──────────────────────────────┘   │
│  │  Multisig, Business  │                                        │
│  └──────────┬───────────┘                                        │
│             │ ethers.js                                           │
│  ┌──────────▼──────────────────────────┐                         │
│  │  core/  privy-core.wasm             │                         │
│  │  Go → WASM                          │                         │
│  │  new_meta / send / scan             │                         │
│  │  BN254 (gnark) + SECP256k1          │                         │
│  └─────────────────────────────────────┘                         │
└────────────────────────┬─────────────────────────────────────────┘
                         │ JSON-RPC (eth_*)
          ┌──────────────▼──────────────────────┐
          │  Docker: eth-rpc  (pallet-revive)    │
          │  http://127.0.0.1:8545              │
          └──────────────┬──────────────────────┘
                         │ WebSocket
          ┌──────────────▼──────────────────────┐
          │  Docker: node (Substrate parachain)  │
          │  ws://127.0.0.1:9944                │
          │                                      │
          │  ┌──────────────────────────────┐   │
          │  │  pallet-stealth-addresses    │   │
          │  │  - meta address registry     │   │
          │  │  - announcement index        │   │
          │  │  - gas sponsorship           │   │
          │  │  - XCM cross-chain sends     │   │
          │  └──────────────────────────────┘   │
          │                                      │
          │  ┌──────────────────────────────┐   │
          │  │  pallet-revive (PolkaVM)     │   │
          │  │  contracts/stealth → ECPDKSAP│   │
          │  │  contracts/usdc   → mock ERC-20 │ │
          │  └──────────────────────────────┘   │
          └──────────────────────────────────────┘
```

There are **two parallel paths** for sending/announcing:

1. **EVM contract path** (`contracts/stealth`) — call `sendEthViaProxy()` via MetaMask or ethers.js. Contract forwards value and emits `Announcement` event. Easiest to integrate from any EVM tooling.

2. **Native pallet path** (`pallet-stealth-addresses`) — call `announce` and `send_stealth_xcm` extrinsics directly via Substrate. Required for XCM cross-chain stealth sends and gas-sponsored withdrawals.

Both paths produce scannable on-chain announcements. The frontend uses the EVM contract path today; the pallet path is active and tested via the precompile at `0x0000000000000000000000000000000010000000`.

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
│   ├── chain_spec.json          ← Dev chain spec
│   ├── Dockerfile               ← Node Docker image
│   └── zombienet.toml           ← Local relay-backed test network topology
├── contracts/
│   ├── stealth/                 ← ECPDKSAP PolkaVM contract (Rust, pvm-contract-macros)
│   └── usdc/                    ← Mock USDC PolkaVM contract (Rust, raw pallet-revive-uapi)
├── core/                        ← Go WASM crypto module (BN254 + SECP256k1)
├── sdk/                         ← TypeScript SDK (ethers + Polkadot API)
├── web/                         ← React/Vite frontend
├── scripts/
│   └── start-all.sh             ← One-command local stack bootstrap
├── docker-compose.yml           ← Node + eth-rpc services
├── deployments.json             ← Deployed contract addresses (auto-updated)
├── rust-toolchain.toml          ← Pinned Rust toolchain
└── Cargo.toml                   ← Rust workspace root
```

---

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Docker | any recent | Used to run the parachain node |
| Node.js | 22.x | Required by web app and deploy scripts |
| npm | 10+ | |
| Go | 1.24+ | Only needed to rebuild `privy-core.wasm` |
| Rust + cargo | see `rust-toolchain.toml` | Only needed to rebuild contracts or blockchain |

---

## Quick Start (Local Dev)

```bash
# Clone and enter
git clone <repo-url>
cd privy-dot

# Start the full local stack
./scripts/start-all.sh
```

The script does the following steps automatically:

1. **Starts the Docker node** — the first run compiles the parachain runtime inside Docker (~10–20 min). Subsequent starts use the cached image and take a few seconds.
2. **Waits for eth-rpc** — polls `eth_chainId` until the Ethereum JSON-RPC adapter is up.
3. **Builds contracts** (first time only) — runs `cargo build --release` in `contracts/stealth/` and `contracts/usdc/`. Note: host compilation step is expected to fail on Mac — the `.polkavm` artifact is already written by `build.rs` before that stage.
4. **Deploys contracts** — runs `npm run deploy:local` which writes the address to `deployments.json` and `web/src/config/deployment.ts`.
5. **Starts the frontend** at `http://localhost:5173`.

Press `Ctrl+C` to shut everything down.

---

## Manual Setup

If you want to run components individually:

```bash
# 1. Node only
docker compose up -d

# 2. Deploy contracts
cd contracts/stealth && npm install && npm run deploy:local

# 3. Frontend
cd web && npm install && npm run dev

# 4. (Optional) Mint USDC on the local node
cd blockchain && node setup-usdc.mjs --mint <address> 1000
```

---

## Networks

| Network | Substrate WS | EVM RPC | Chain ID | Explorer |
| --- | --- | --- | --- | --- |
| Local (Docker) | `ws://127.0.0.1:9944` | `http://127.0.0.1:8545` | — | — |
| Paseo Asset Hub | — | `https://services.polkadothub-rpc.com/testnet` | 420420417 | [subscan](https://assethub-paseo.subscan.io) |

To deploy to Paseo Asset Hub:
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

The meta address `K:::V` is shared publicly (e.g. on-chain in the pallet registry, or off-chain).

### Send

```
1. Sender calls wasmApi.send(K, V)
   ├── Generates ephemeral scalar r
   ├── R = r × G1  (ephemeral public key, BN254)
   ├── shared_secret = hash(r × V)
   ├── stealth_spending_key = k + shared_secret  (mod n, SECP256k1)
   ├── spendingPubKey = stealth_spending_key × G
   ├── stealthAddress = keccak256(spendingPubKey)[12:]  (Ethereum-style)
   └── viewTag = first byte of shared_secret  (used to skip 255/256 scan checks)

2. Sender calls contract.sendEthViaProxy(stealthAddress, R, viewTag)
   - Forwards value to stealthAddress
   - Contract emits Announcement(schemeId=2901, stealthAddress, caller, R, viewTag)
```

### Scan

```
1. Recipient fetches all Announcement events (R, viewTag pairs)
2. Calls wasmApi.scan(k, v, Rs[], viewTags[])
   For each announcement:
   ├── Compute shared_secret = hash(v × R)  (only viewing key needed)
   ├── Check viewTag matches first byte of shared_secret  (fast reject — skips ~255/256)
   ├── If match: derive stealth_spending_key = k + shared_secret
   └── Verify stealthAddress matches → return spending private key

3. Recipient signs withdrawals using the derived private key
```

The view tag reduces scanning cost by ~256x — the recipient only does the full BN254 pairing computation for ~1/256 of all announcements.

### Privacy guarantees

- The sender does not know the recipient's spending key.
- An observer cannot link `stealthAddress` to `K:::V` without knowing `v`.
- The viewing key `v` can be delegated to an auditor (pallet `delegate_viewing_key`) for compliance purposes without giving spending access.

---

## Pallet Extrinsics

`pallet-stealth-addresses` exposes these callable extrinsics:

| Extrinsic | Description |
| --- | --- |
| `register_stealth_meta_address(spending_pubkey, viewing_pubkey, scheme_id)` | Registers your `K:::V` on-chain. All parachains can resolve it via XCM. |
| `announce(ephemeral_pubkey, view_tag, stealth_address, metadata)` | Called by the sender after a transfer. Indexes announcement by view tag for efficient recipient scanning. |
| `sponsor_gas(amount)` | Deposits native tokens into the gas sponsorship pool. Stealth addresses have no balance to pay fees — sponsors cover the cost and take a commission. |
| `withdraw_from_stealth(stealth_address, destination, sig, sponsor)` | Recipient withdraws from a stealth address. Signature proves ownership of the derived private key. Fee is paid by the sponsor from the pool. |
| `delegate_viewing_key(delegate, valid_from, valid_until, encrypted_viewing_key)` | Grants a time-limited viewing delegation to an auditor. |
| `send_stealth_xcm(dest_para_id, stealth_address, amount, ephemeral_pubkey, ...)` | Cross-chain stealth send via XCM. Transfers tokens to a stealth address on another parachain. |
| `send_stealth_asset_xcm(...)` | Same as above but for pallet-assets tokens (e.g. USDC). |

---

## EVM Precompile

A precompile is available at `0x0000000000000000000000000000000010000000`. It bridges EVM calls to the native pallet extrinsics, so MetaMask or any EVM wallet can interact with the pallet without needing a Substrate signer.

```ts
const PRECOMPILE_ABI = [
  "function registerMetaAddress(bytes spendingPubkey, bytes viewingPubkey, uint32 schemeId) external",
  "function announce(bytes ephemeralPubkey, bytes2 viewTag, bytes32 stealthAddress, bytes32 metadata) external",
  "function sendAndAnnounce(bytes32 stealthAddress, bytes ephemeralPubkey, bytes2 viewTag, bytes32 metadata) external payable",
];
```

`sendAndAnnounce` is the primary method used by the web app — it sends PAS to the stealth address and writes the announcement in a single transaction.

---

## Key Addresses

| Name | Value | Notes |
| --- | --- | --- |
| Alice private key | `0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133` | Pre-funded on local dev node |
| Stealth precompile | `0x0000000000000000000000000000000010000000` | Bridges EVM → pallet |
| Deployed contract | see `deployments.json` | Updated by deploy script |

---

## Components

| Directory | Language | Description |
| --- | --- | --- |
| [`blockchain/`](blockchain/README.md) | Rust | Substrate parachain runtime, pallet-stealth-addresses, Docker node |
| [`contracts/stealth/`](contracts/stealth/README.md) | Rust | ECPDKSAP PolkaVM contract — `sendEthViaProxy`, `Announcement` event |
| [`contracts/usdc/`](contracts/usdc/README.md) | Rust | Mock ERC-20 USDC PolkaVM contract for multi-token testing |
| [`core/`](core/README.md) | Go | Cryptographic WASM module — key generation, send, scan |
| [`sdk/`](sdk/README.md) | TypeScript | Reusable SDK wrapping WASM, EVM, and Substrate interactions |
| [`web/`](web/README.md) | TypeScript/React | Frontend with Keys, Send, Scan, Receive, Payroll, Multisig panels |