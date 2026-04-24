# sdk — TypeScript SDK

TypeScript SDK for integrating the Privy Dot stealth address protocol into applications. Wraps the WASM crypto module, EVM contract calls, and Substrate/Polkadot API interactions into a single importable package.

## Install

The package is not yet published to npm. To use it locally:

```bash
cd sdk
npm install
npm run build
```

Then reference from another local package via `file:../sdk` in `package.json`.

## Usage

```ts
import {
  initWasm, wasmApi,
  configureEvm, connectMetaMask,
  deriveSubstrateStealthAddress,
  sendAndAnnounceViaPrecompile,
  fetchAnnouncements,
  getApi,
} from "privy-dot-sdk";

// 1. Load the WASM crypto module (browser — serve privy-core.wasm + wasm-exec.js from public/)
await initWasm("/privy-core.wasm");

// 2. Configure EVM provider
configureEvm("http://localhost:8545");

// 3. Generate keys
const keys = await wasmApi.newMeta();
// keys = { k, v, K, V }

// 4. Compute stealth send data
const result = await wasmApi.send(recipientK, recipientV);
// result = { r, R, viewTag, spendingPubKey }
const stealthAddress = deriveSubstrateStealthAddress(result.spendingPubKey);

// 5. Send + announce (one MetaMask popup)
const { signer } = await connectMetaMask();
await sendAndAnnounceViaPrecompile(signer, hexToBytes(stealthAddress), "1.0", ...);

// 6. Scan for received transfers
const api = await getApi("ws://localhost:9944");
const announcements = await fetchAnnouncements(api);
const scanResult = await wasmApi.scan(keys.k, keys.v, Rs, viewTags);
```

## Module Layout

```
sdk/src/
├── index.ts       ← Re-exports everything
├── types.ts       ← Shared types (KeyPairs, SendResult, ScanResult, etc.)
├── wasm.ts        ← initWasm(), resetWasm(), wasmApi wrapper
├── evm.ts         ← configureEvm(), connectMetaMask(), contract interactions
└── substrate.ts   ← getApi(), fetchAnnouncements(), Substrate signer helpers
```

## Types

```ts
type KeyPairs = { k: string; v: string; K: string; V: string };
type SendResult = { r: string; R: string; viewTag: string; spendingPubKey: string };
type ScanResult = { spendingPubKeys: string[]; spendingPrivKeys: string[] };
type FoundAddress = { address: string; privKey: string };
type AnnouncementRow = { schemeId: bigint; stealthAddress: string; caller: string; R: string; viewTag: string };
```

## Build

```bash
npm run build      # production build → dist/
npm run dev        # watch mode
npm run typecheck  # type check only
```

Output: `dist/index.js` (ESM), `dist/index.cjs` (CommonJS), `dist/index.d.ts` (types).

## Dependencies

- `ethers` ^6 — EVM provider, contract interaction, address derivation
- `@polkadot/api` — Substrate WebSocket connection, event fetching
- `@polkadot/extension-dapp` / `@polkadot/keyring` — Polkadot wallet and key utilities