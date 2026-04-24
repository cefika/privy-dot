# core — Cryptographic WASM Module

Go module that implements the ECPDKSAP cryptographic operations and compiles to WebAssembly for use in the browser.

## What it does

Exposes four functions on `window` after WASM initialization:

| Function | Input | Output | Description |
|---|---|---|---|
| `new_meta()` | — | `{ k, v, K, V }` | Generate fresh SECP256k1 + BN254 key pairs |
| `get_meta(JSON)` | `{ k, v }` | `{ k, v, K, V }` | Derive public keys from existing private keys |
| `send(JSON)` | `{ K, V }` | `{ r, R, viewTag, spendingPubKey }` | Compute stealth send parameters |
| `scan(JSON)` | `{ k, v, Rs[], viewTags[] }` | `{ spendingPubKeys[], spendingPrivKeys[] }` | Detect matching announcements |
| `scan_audit(JSON)` | `{ k, v, Rs[], viewTags[] }` | same as scan | Audit variant (viewing key only) |

Debug helpers (for testing): `dbg_isValidBN254Point`, `dbg_isValidSECP256k1Point`.

## Cryptography

- **SECP256k1** — spending key pair. `K = k × G`. The stealth address is derived as `keccak256(spendingPubKey)[12:]`.
- **BN254 G1** — viewing key pair. `V = v × G1`. Used in the shared secret computation so that scanning only requires the viewing key, not the spending key.
- **Shared secret**: `S = hash(r × V)` where `r` is the sender's ephemeral scalar. The stealth spending key is `k + S mod n`.

Dependencies: [`gnark-crypto`](https://github.com/consensys/gnark-crypto) for BN254, `golang.org/x/crypto` for SECP256k1.

## Directory Layout

```
core/
├── main.go           ← WASM entry point, registers JS functions
├── sender/           ← send() implementation
├── recipient/        ← new_meta(), get_meta(), scan(), scan_audit()
├── utils/            ← Point validation, hex helpers
├── ref-usage/        ← Reference usage examples
└── test/             ← Go unit tests
```

## Build

Requires Go 1.24+.

```bash
cd core
GOOS=js GOARCH=wasm go build -o ../web/public/privy-core.wasm .
```

After building, copy the matching JS bridge:

```bash
cp "$(go env GOROOT)/misc/wasm/wasm-exec.js" ../web/public/wasm-exec.js
```

> **Important**: `wasm-exec.js` must match the Go version used to compile the WASM binary. If Go is updated, copy the new bridge file.

## Tests

```bash
cd core
go test ./...
```

## Gotcha: odd-length viewTag hex

`send()` may return a `viewTag` with an odd number of hex characters. Callers must pad before passing to `ethers.getBytes()`:

```ts
const raw = viewTag.replace(/^0x/, "");
const padded = raw.length % 2 === 0 ? raw : "0" + raw;
ethers.getBytes("0x" + padded);
```