import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { blake2AsU8a } from "@polkadot/util-crypto";
import { u8aToHex, hexToU8a } from "@polkadot/util";
import type { KeyringPair } from "@polkadot/keyring/types";

export type { KeyringPair };

// ── Parachain config ──────────────────────────────────────────────────────────

export const PARACHAINS: Record<number, { ws: string; label: string }> = {
  1000: { ws: "ws://127.0.0.1:9944", label: "Para 1000" },
  2000: { ws: "ws://127.0.0.1:9935", label: "Para 2000" },
};

const apiCache = new Map<number, ApiPromise>();

export async function getApi(paraId: number): Promise<ApiPromise> {
  const cached = apiCache.get(paraId);
  if (cached?.isConnected) return cached;
  const api = await ApiPromise.create({
    provider: new WsProvider(PARACHAINS[paraId].ws),
  });
  apiCache.set(paraId, api);
  return api;
}

export function disconnectAll() {
  for (const api of apiCache.values()) api.disconnect();
  apiCache.clear();
}

// ── Signers ───────────────────────────────────────────────────────────────────

export function getDevAccount(name: "alice" | "bob" | "charlie"): KeyringPair {
  const keyring = new Keyring({ type: "sr25519" });
  return keyring.addFromUri(`//${name.charAt(0).toUpperCase() + name.slice(1)}`);
}

export function getAccountFromMnemonic(mnemonic: string): KeyringPair {
  const keyring = new Keyring({ type: "sr25519" });
  return keyring.addFromMnemonic(mnemonic);
}

// ECDSA keypair from stealth spending private key (for spending FROM stealth address)
export function getStealthSpendingKeypair(spendingPrivKey: string): KeyringPair {
  const keyring = new Keyring({ type: "ecdsa" });
  const raw = spendingPrivKey.startsWith("0x") ? spendingPrivKey.slice(2) : spendingPrivKey;
  const padded = raw.padStart(64, "0").slice(0, 64);
  return keyring.addFromSeed(hexToU8a("0x" + padded));
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

// "X.Y" decimal → 33-byte compressed SECP256k1
export function secp256k1ToCompressed(pubKey: string): Uint8Array {
  const [X, Y] = pubKey.split(".");
  const x = BigInt(X);
  const y = BigInt(Y);
  const prefix = y % 2n === 0n ? 0x02 : 0x03;
  const xBytes = new Uint8Array(32);
  let xVal = x;
  for (let i = 31; i >= 0; i--) {
    xBytes[i] = Number(xVal & 0xffn);
    xVal >>= 8n;
  }
  return new Uint8Array([prefix, ...xBytes]);
}

// "X.Y" decimal → 64-byte uncompressed (x_32 ++ y_32), works for BN254 G1 and SECP256k1
function pointToBytes64(pubKey: string): Uint8Array {
  const [X, Y] = pubKey.split(".");
  const result = new Uint8Array(64);
  let xVal = BigInt(X);
  let yVal = BigInt(Y);
  for (let i = 31; i >= 0; i--) {
    result[i] = Number(xVal & 0xffn);
    xVal >>= 8n;
    result[i + 32] = Number(yVal & 0xffn);
    yVal >>= 8n;
  }
  return result;
}

export function bn254ToBytes64(pubKey: string): Uint8Array {
  return pointToBytes64(pubKey);
}

export function rToBytes64(R: string): Uint8Array {
  return pointToBytes64(R);
}

// 64-byte ephemeral pubkey → "X.Y" for WASM scan input
export function bytes64ToR(bytes: Uint8Array): string {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const xBig = BigInt("0x" + hex.slice(0, 64));
  const yBig = BigInt("0x" + hex.slice(64));
  return `${xBig}.${yBig}`;
}

// SECP256k1 spending pubkey "X.Y" → Substrate AccountId32 hex
// AccountId32 = blake2b_256(compressed_secp256k1_pubkey)
// Consistent with Keyring({ type: 'ecdsa' }).addFromSeed(privKey).address
export function deriveSubstrateStealthAddress(spendingPubKey: string): string {
  const compressed = secp256k1ToCompressed(spendingPubKey);
  return u8aToHex(blake2AsU8a(compressed, 256));
}

// ── Chain queries ─────────────────────────────────────────────────────────────

export interface AnnouncementRow {
  nonce: number;
  ephemeralPubkey: Uint8Array; // 64 bytes
  viewTag: Uint8Array;         // 2 bytes
  stealthAddress: string;      // hex AccountId32
  metadata: Uint8Array;        // 32 bytes
}

function decodeBytes(val: unknown): Uint8Array {
  if (typeof val === "string") return hexToU8a(val);
  if (Array.isArray(val)) return new Uint8Array(val as number[]);
  return new Uint8Array();
}

export async function fetchAnnouncements(api: ApiPromise): Promise<AnnouncementRow[]> {
  const entries = await api.query.stealthAddresses.announcements.entries();
  const rows: AnnouncementRow[] = [];
  for (const [key, rawVal] of entries) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const codec = rawVal as any;
    if (codec.isNone) continue;
    const ann = codec.isSome ? codec.unwrap() : codec;
    const json = ann.toJSON?.() ?? ann;
    rows.push({
      nonce: (key.args[0] as unknown as { toNumber(): number }).toNumber(),
      ephemeralPubkey: decodeBytes(json.ephemeralPubkey ?? json.ephemeral_pubkey),
      viewTag: decodeBytes(json.viewTag ?? json.view_tag),
      stealthAddress: u8aToHex(decodeBytes(json.stealthAddress ?? json.stealth_address)),
      metadata: decodeBytes(json.metadata),
    });
  }
  return rows;
}

export async function getBalance(api: ApiPromise, accountId: string): Promise<bigint> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acc = await api.query.system.account(accountId) as any;
  return acc.data.free.toBigInt();
}

// ── Extrinsics ────────────────────────────────────────────────────────────────

function submitTx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  signer: KeyringPair,
  onInBlock?: (hash: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let unsub: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx.signAndSend(signer, (result: any) => {
      if (result.status.isInBlock) {
        const hash = result.status.asInBlock.toHex();
        onInBlock?.(hash);
        if (result.dispatchError) {
          unsub?.();
          reject(new Error(result.dispatchError.toString()));
        } else {
          unsub?.();
          resolve(hash);
        }
      } else if (result.status.isDropped || result.status.isInvalid) {
        unsub?.();
        reject(new Error("Transaction dropped or invalid"));
      }
    })
      .then((u: unknown) => { unsub = u; })
      .catch(reject);
  });
}

export async function registerMetaAddress(
  api: ApiPromise,
  signer: KeyringPair,
  spendingPubKey: string, // K from keys, "X.Y" format
  viewingPubKey: string,  // V from keys, "X.Y" format
  schemeId = 2901
): Promise<string> {
  const spBytes = Array.from(secp256k1ToCompressed(spendingPubKey));
  const vpBytes = Array.from(bn254ToBytes64(viewingPubKey));
  return submitTx(
    api.tx.stealthAddresses.registerStealthMetaAddress(spBytes, vpBytes, schemeId),
    signer
  );
}

export async function sendStealthXcm(
  api: ApiPromise,
  signer: KeyringPair,
  destParaId: number,
  stealthAddress: string,      // hex AccountId32
  amount: bigint,
  ephemeralPubkey: Uint8Array, // 64 bytes
  viewTag: Uint8Array,         // 2 bytes
  metadata: Uint8Array         // 32 bytes
): Promise<string> {
  return submitTx(
    api.tx.stealthAddresses.sendStealthXcm(
      destParaId,
      stealthAddress,
      amount.toString(),
      Array.from(ephemeralPubkey),
      Array.from(viewTag),
      Array.from(metadata)
    ),
    signer
  );
}

export async function spendFromStealth(
  api: ApiPromise,
  spendingPrivKey: string,
  to: string,
  amount: bigint
): Promise<string> {
  const pair = getStealthSpendingKeypair(spendingPrivKey);
  return submitTx(
    api.tx.balances.transferAllowDeath(to, amount.toString()),
    pair
  );
}