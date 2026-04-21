import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { blake2AsU8a, decodeAddress } from "@polkadot/util-crypto";
import { u8aToHex, hexToU8a } from "@polkadot/util";
import { web3Enable, web3Accounts, web3FromAddress } from "@polkadot/extension-dapp";
import type { KeyringPair } from "@polkadot/keyring/types";
import type { InjectedAccountWithMeta } from "@polkadot/extension-inject/types";

export type { KeyringPair, InjectedAccountWithMeta };

// ── Signer union type ─────────────────────────────────────────────────────────

/** Jednobrazni signer koji može biti dev keypair ili extenzija (Talisman, SubWallet…) */
export type SubstrateSigner =
  | { type: "keypair"; pair: KeyringPair }
  | { type: "injected"; address: string; name?: string };

/** Izvlači adresu bez obzira na tip signera */
export function signerAddress(s: SubstrateSigner): string {
  return s.type === "keypair" ? s.pair.address : s.address;
}

// ── Extension wallet API ──────────────────────────────────────────────────────

/**
 * Traži dozvolu od browser extenzija (Talisman, SubWallet, Polkadot.js).
 * Vraća listu account-a dostupnih u extenzijama.
 */
export async function getExtensionAccounts(): Promise<InjectedAccountWithMeta[]> {
  const extensions = await web3Enable("Privy Dot");
  if (extensions.length === 0) throw new Error("No Polkadot wallet extension found. Install Talisman or SubWallet.");
  return web3Accounts();
}

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

export function getDevAccount(name: "alice" | "bob" | "charlie"): SubstrateSigner {
  const keyring = new Keyring({ type: "sr25519" });
  const pair = keyring.addFromUri(`//${name.charAt(0).toUpperCase() + name.slice(1)}`);
  return { type: "keypair", pair };
}

export function getAccountFromMnemonic(mnemonic: string): SubstrateSigner {
  const keyring = new Keyring({ type: "sr25519" });
  const pair = keyring.addFromMnemonic(mnemonic);
  return { type: "keypair", pair };
}

export function signerFromExtensionAccount(account: InjectedAccountWithMeta): SubstrateSigner {
  return { type: "injected", address: account.address, name: account.meta.name };
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

// ── Nonce persistence ─────────────────────────────────────────────────────────

const LAST_NONCE_KEY = (addr: string) => `privy-last-nonce-${addr.toLowerCase()}`;

export function loadLastNonce(addr: string): number {
  return parseInt(localStorage.getItem(LAST_NONCE_KEY(addr)) ?? "0", 10);
}

export function saveLastNonce(addr: string, nonce: number) {
  localStorage.setItem(LAST_NONCE_KEY(addr), String(nonce));
}

// ── Announcement fetching ─────────────────────────────────────────────────────

function parseAnnouncement(nonce: number, rawVal: unknown): AnnouncementRow | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const codec = rawVal as any;
  if (!codec || codec.isNone) return null;
  const ann = codec.isSome ? codec.unwrap() : codec;
  const json = ann.toJSON?.() ?? ann;
  return {
    nonce,
    ephemeralPubkey: decodeBytes(json.ephemeralPubkey ?? json.ephemeral_pubkey),
    viewTag: decodeBytes(json.viewTag ?? json.view_tag),
    stealthAddress: u8aToHex(decodeBytes(json.stealthAddress ?? json.stealth_address)),
    metadata: decodeBytes(json.metadata),
  };
}

/** Vraća trenutni nonce sa lanca (= ukupan broj announcement-a dosad). */
export async function fetchAnnouncementNonce(api: ApiPromise): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const val = await (api.query.stealthAddresses as any).announcementNonce();
  return val.toNumber();
}

/**
 * Fetchuje samo announcement-e sa nonce >= fromNonce.
 * Koristi multi() umesto entries() — ne skida celu storage mapu.
 * Vraća i nextNonce kako bi caller mogao da ga sačuva.
 */
export async function fetchAnnouncementsSince(
  api: ApiPromise,
  fromNonce: number,
): Promise<{ rows: AnnouncementRow[]; nextNonce: number }> {
  const nextNonce = await fetchAnnouncementNonce(api);
  if (fromNonce >= nextNonce) return { rows: [], nextNonce };

  const nonces = Array.from({ length: nextNonce - fromNonce }, (_, i) => fromNonce + i);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawVals = await (api.query.stealthAddresses as any).announcements.multi(nonces);

  const rows: AnnouncementRow[] = [];
  for (let i = 0; i < nonces.length; i++) {
    const row = parseAnnouncement(nonces[i], rawVals[i]);
    if (row) rows.push(row);
  }
  return { rows, nextNonce };
}

/** Compat: fetchuje SVE announcement-e (koristi se samo ako nema sačuvanog nonce-a). */
export async function fetchAnnouncements(api: ApiPromise): Promise<AnnouncementRow[]> {
  const { rows } = await fetchAnnouncementsSince(api, 0);
  return rows;
}

export async function getBalance(api: ApiPromise, accountId: string): Promise<bigint> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acc = await api.query.system.account(accountId) as any;
  return acc.data.free.toBigInt();
}

// ── Extrinsics ────────────────────────────────────────────────────────────────

async function submitTx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  signer: SubstrateSigner,
  onInBlock?: (hash: string) => void
): Promise<string> {
  // Za injected signere, dohvati injector iz extenzije neposredno pre slanja
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let injectorSigner: any | undefined;
  if (signer.type === "injected") {
    const injector = await web3FromAddress(signer.address);
    injectorSigner = injector.signer;
  }

  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let unsub: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callback = (result: any) => {
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
    };

    const sendPromise = signer.type === "keypair"
      ? tx.signAndSend(signer.pair, callback)
      : tx.signAndSend(signer.address, { signer: injectorSigner }, callback);

    sendPromise.then((u: unknown) => { unsub = u; }).catch(reject);
  });
}

export async function registerMetaAddress(
  api: ApiPromise,
  signer: SubstrateSigner,
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
  signer: SubstrateSigner,
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

export async function sendStealthAssetXcm(
  api: ApiPromise,
  signer: SubstrateSigner,
  assetId: number,
  destParaId: number,
  stealthAddress: string,      // hex AccountId32
  amount: bigint,
  ephemeralPubkey: Uint8Array, // 64 bytes
  viewTag: Uint8Array,         // 2 bytes
  metadata: Uint8Array         // 32 bytes
): Promise<string> {
  return submitTx(
    api.tx.stealthAddresses.sendStealthAssetXcm(
      assetId,
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
  // Ako je destinacija H160 (20-byte EVM adresa), konvertuj u AccountId32 (H160 ++ 0xEE*12)
  let dest = to;
  if (/^0x[0-9a-fA-F]{40}$/.test(to)) {
    dest = to.toLowerCase().replace("0x", "0x") + "ee".repeat(12);
  }
  return submitTx(
    api.tx.balances.transferAllowDeath(dest, amount.toString()),
    { type: "keypair", pair }
  );
}

// ── Stealth pallet withdrawal ─────────────────────────────────────────────────

// Build the message that the stealth pallet verifies (v2):
// PREFIX ++ stealth[32] ++ dest[32] ++ SCALE(Option<u32>) ++ SCALE(Option<u128>)
function buildWithdrawalMessage(stealthHex: string, destBytes: Uint8Array, assetId?: number, amount?: bigint): Uint8Array {
  const prefix = new TextEncoder().encode("PrivyDot::withdraw:v2");
  const stealth = hexToU8a(stealthHex); // 32 bytes

  // SCALE-encode Option<u32>: 0x00 = None, 0x01 ++ u32_LE = Some
  let assetBytes: Uint8Array;
  if (assetId === undefined || assetId === null) {
    assetBytes = new Uint8Array([0x00]);
  } else {
    assetBytes = new Uint8Array(5);
    assetBytes[0] = 0x01;
    new DataView(assetBytes.buffer).setUint32(1, assetId, true);
  }

  // SCALE-encode Option<u128>: 0x00 = None, 0x01 ++ u128_LE (16 bytes) = Some
  let amountBytes: Uint8Array;
  if (amount === undefined || amount === null) {
    amountBytes = new Uint8Array([0x00]);
  } else {
    amountBytes = new Uint8Array(17);
    amountBytes[0] = 0x01;
    // Write u128 as 16 bytes little-endian
    let v = amount;
    for (let i = 0; i < 16; i++) {
      amountBytes[1 + i] = Number(v & 0xffn);
      v >>= 8n;
    }
  }

  const msg = new Uint8Array(prefix.length + 32 + 32 + assetBytes.length + amountBytes.length);
  let offset = 0;
  msg.set(prefix, offset); offset += prefix.length;
  msg.set(stealth, offset); offset += 32;
  msg.set(destBytes, offset); offset += 32;
  msg.set(assetBytes, offset); offset += assetBytes.length;
  msg.set(amountBytes, offset);
  return msg;
}

// Send a pallet-assets token to a stealth address (same-chain) + announce
// Uses utility.batchAll so both transfer and announcement succeed or both fail
export async function sendStealthAsset(
  api: ApiPromise,
  signer: SubstrateSigner,
  assetId: number,
  stealthAddress: string,      // hex AccountId32
  amount: bigint,
  ephemeralPubkey: Uint8Array, // 64 bytes
  viewTag: Uint8Array,         // 2 bytes
  metadata: Uint8Array         // 32 bytes
): Promise<string> {
  const transferCall = api.tx.assets.transfer(
    assetId,
    stealthAddress,
    amount.toString()
  );
  const announceCall = api.tx.stealthAddresses.announce(
    Array.from(ephemeralPubkey),
    Array.from(viewTag),
    stealthAddress,
    Array.from(metadata)
  );
  return submitTx(api.tx.utility.batchAll([transferCall, announceCall]), signer);
}

// Send a specific amount of a pallet-assets token directly from a stealth address
export async function sendAssetFromStealth(
  api: ApiPromise,
  spendingPrivKey: string,
  to: string,
  assetId: number,
  amount: bigint
): Promise<string> {
  const pair = getStealthSpendingKeypair(spendingPrivKey);
  return submitTx(api.tx.assets.transfer(assetId, to, amount.toString()), { type: "keypair", pair });
}

// Fetch pallet-assets balance for a given asset ID
export async function getAssetBalance(api: ApiPromise, accountId: string, assetId: number): Promise<bigint> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acc = await api.query.assets.account(assetId, accountId) as any;
  if (!acc || acc.isNone) return 0n;
  const inner = acc.isSome ? acc.unwrap() : acc;
  return inner.balance?.toBigInt?.() ?? 0n;
}

// Deposit into gas sponsor pool (sponsor must call this before withdrawFromStealth can use them)
export async function sponsorGas(
  api: ApiPromise,
  signer: SubstrateSigner,
  amount: bigint
): Promise<string> {
  return submitTx(api.tx.stealthAddresses.sponsorGas(amount.toString()), signer);
}

// Query how much an account has in the gas sponsor pool
export async function getSponsorBalance(api: ApiPromise, accountId: string): Promise<bigint> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const val = await api.query.stealthAddresses.gasSponsorPool(accountId) as any;
  return val?.toBigInt?.() ?? 0n;
}

// Withdraw from a stealth address via the pallet (ECDSA-signed).
// amount: undefined/null = entire balance; bigint = specific amount
export async function withdrawFromStealth(
  api: ApiPromise,
  stealthAddress: string,   // AccountId32 hex (from scan results)
  spendingPrivKey: string,  // ECDSA spending private key (used to SIGN only)
  destination: string,      // AccountId32 hex or SS58 of recipient
  sponsor: SubstrateSigner, // Signer sa PAS + sredstvima u GasSponsorPool-u (podnosi i plaća fee)
  assetId?: number,         // undefined = native PAS, number = pallet-assets asset
  amount?: bigint           // undefined = entire balance, bigint = specific amount
): Promise<string> {
  const stealthPair = getStealthSpendingKeypair(spendingPrivKey);

  // Decode destination to raw 32 bytes for the message (SCALE encoding of AccountId32 = raw bytes)
  const destBytes = decodeAddress(destination);

  // Build and sign the v2 withdrawal message (includes asset_id + amount)
  const msg = buildWithdrawalMessage(stealthAddress, destBytes, assetId, amount);
  const sig = stealthPair.sign(msg); // 65 bytes: r[32] + s[32] + v[1]

  // Option<u32> for polkadot.js: null = None, number = Some(n)
  const assetArg = assetId !== undefined && assetId !== null ? assetId : null;
  // Option<u128> for polkadot.js: null = None, string = Some(n)
  const amountArg = amount !== undefined && amount !== null ? amount.toString() : null;

  // Sponsor submits and pays the inclusion fee — stealth address needs no PAS
  return submitTx(
    api.tx.stealthAddresses.withdrawFromStealth(
      Array.from(hexToU8a(stealthAddress)), // stealth: [u8; 32]
      destination,                            // destination: AccountId
      Array.from(sig),                        // signature: [u8; 65]
      signerAddress(sponsor),                 // sponsor: AccountId (must have pool funds)
      assetArg,                               // asset_id: Option<u32>
      amountArg                               // amount: Option<u128>
    ),
    sponsor  // ← sponsor podnosi i plaća fee, ne stealth adresa
  );
}