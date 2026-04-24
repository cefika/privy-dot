# web — React Frontend

Standalone React + Vite application for interacting with the Privy Dot stealth address protocol. No Polkadot API dependency at runtime — uses only `ethers` for EVM calls and the WASM crypto module.

## Run

```bash
cd web
npm install
npm run dev        # http://localhost:5173
npm run build      # production build → dist/
npm run preview    # serve production build locally
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `VITE_RPC_URL` | `http://127.0.0.1:8545` | EVM RPC endpoint |

Contract address is read from `src/config/deployment.ts`, which is auto-updated by the deploy script in `contracts/stealth/`.

## Panels

### Keys
Generate or import SECP256k1 + BN254 key pairs. Keys are stored in `localStorage` keyed by wallet address. Displays the shareable `K:::V` meta address.

### Send
1. Paste recipient's `K:::V` meta address
2. Enter amount
3. Click Send — calls `wasmApi.send(K, V)`, derives stealth address, calls `contract.sendEthViaProxy()` via MetaMask or private key mode

### Scan
Fetches all `Announcement` events from the contract, runs `wasmApi.scan()` against your viewing key, and lists matched stealth addresses with their balances. Matched addresses can be swept.

### Receive
Displays your own meta address (`K:::V`) as text and QR code for sharing with senders.

## Source Layout

```
web/src/
├── App.tsx           ← Root layout: header, sidebar, panel switcher
├── main.tsx
├── index.css         ← Tailwind base
├── chain.ts          ← ethers provider, contract instance, helpers
├── wasm.ts           ← WASM init and wasmApi wrapper
├── crypto.ts         ← Address derivation utilities
├── substrate.ts      ← Substrate-specific helpers
├── types.ts          ← Shared types
├── config/
│   └── deployment.ts ← Contract address (auto-updated by deploy script)
└── panels/
    ├── Keys.tsx
    ├── Send.tsx
    ├── Scan.tsx
    └── Register.tsx

web/public/
├── privy-core.wasm   ← Go WASM crypto module (built from core/)
└── wasm-exec.js      ← Go WASM JS bridge (must match Go version)
```

## Notes

- **MetaMask on local node**: MetaMask may reject the local chain. Use private key mode (Alice: `0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133`) as fallback.
- **WASM loading**: `privy-core.wasm` and `wasm-exec.js` in `public/` must stay in sync with the Go version in `core/`. After rebuilding the WASM, copy the matching `wasm-exec.js` from `$(go env GOROOT)/misc/wasm/`.
- Node.js 22.x required (`engines` field in `package.json`).