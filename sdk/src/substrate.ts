/**
 * Substrate / Polkadot-API interactions for the Privy Dot stealth protocol.
 * Covers: key derivation, parachain connections, announcements, registration,
 * stealth sends (native + assets + XCM), spending, and withdrawal.
 */
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { blake2AsU8a, decodeAddress } from "@polkadot/util-crypto";
import { u8aToHex, hexToU8a } from "@polkadot/util";
import { web3Enable, web3Accounts, web3FromAddress } from "@polkadot/extension-dapp";
import type { KeyringPair } from "@polkadot/keyring/types";
import type { InjectedAccountWithMeta } from "@polkadot/extension-inject/types";
import type { AnnouncementRow } from "./types.js";

export type { KeyringPair, InjectedAccountWithMeta };

// ── Signer union type ─────────────────────────────────────────────────────────

/** Unified signer: dev keypair or browser extension (Talisman, SubWallet, Polkadot.js) */
export type SubstrateSigner =
  | { type: "keypair"; pair: KeyringPair }
  | { type: "injected"; address: string; name?: string };

/** Extract address regardless of signer type */
export function signerAddress(s: SubstrateSigner): string {
  return s.type === "keypair" ? s.pair.address : s.address;
}

// ── Extension wallet ──────────────────────────────────────────────────────────

/**
 * Request permission from browser wallet extensions (Talisman, SubWallet, Polkadot.js).
 * Returns the list of accounts available in installed extensions.
 * @param appName Name shown in the wallet permission dialog
 */
export async function getExtensionAccounts(
  appName = "Privy Dot"
): Promise<InjectedAccountWithMeta[]> {
  const extensions = await web3Enable(appName);
  if (extensions.length === 0) {
    throw new Error("No Polkadot wallet extension found. Install Talisman or SubWallet.");
  }
  return web3Accounts();
}

// ── Parachain connections ─────────────────────────────────────────────────────

export interface ParachainConfig {
  ws: string;
  label?: string;
}

const apiCache = new Map<string, ApiPromise>();

/**
 * Get (or create and cache) a Polkadot API connection.
 * @param wsUrl WebSocket URL of the parachain RPC node
 */
export async function getApi(wsUrl: string): Promise<ApiPromise> {
  const cached = apiCache.get(wsUrl);
  if (cached?.isConnected) return cached;
  const api = await ApiPromise.create({ provider: new WsProvider(wsUrl) });
  apiCache.set(wsUrl, api);
  return api;
}

/** Disconnect all cached API connections */
export function disconnectAll(): void {
  for (const api of apiCache.values()) api.disconnect();
  apiCache.clear();
}

// ── Signer helpers ────────────────────────────────────────────────────────────

/** Get a dev account (Alice, Bob, Charlie) as a SubstrateSigner */
export function getDevAccount(name: "alice" | "bob" | "charlie"): SubstrateSigner {
  const keyring = new Keyring({ type: "sr25519" });
  const pair = keyring.addFromUri(`//${name.charAt(0).toUpperCase() + name.slice(1)}`);
  return { type: "keypair", pair };
}

/** Create a SubstrateSigner from a mnemonic phrase */
export function getAccountFromMnemonic(mnemonic: string): SubstrateSigner {
  const keyring = new Keyring({ type: "sr25519" });
  const pair = keyring.addFromMnemonic(mnemonic);
  return { type: "keypair", pair };
}

/** Wrap an extension account as a SubstrateSigner */
export function signerFromExtensionAccount(account: InjectedAccountWithMeta): SubstrateSigner {
  return { type: "injected", address: account.address, name: account.meta.name };
}

/**
 * Get the ECDSA keypair for spending FROM a stealth address.
 * @param spendingPrivKey Hex spending private key (from scan results)
 */
export function getStealthSpendingKeypair(spendingPrivKey: string): KeyringPair {
  const keyring = new Keyring({ type: "ecdsa" });
  const raw = spendingPrivKey.startsWith("0x") ? spendingPrivKey.slice(2) : spendingPrivKey;
  const padded = raw.padStart(64, "0").slice(0, 64);
  return keyring.addFromSeed(hexToU8a("0x" + padded));
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

/**
 * Convert a secp256k1 public key in "X.Y" decimal format to 33-byte compressed form.
 */
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

/**
 * Convert a BN254 G1 point in "X.Y" decimal format to 64-byte form.
 * Used for the viewing public key in meta-address registration.
 */
export function bn254ToBytes64(pubKey: string): Uint8Array {
  return pointToBytes64(pubKey);
}

/**
 * Convert a secp256k1 ephemeral public key in "X.Y" format to 64-byte form.
 * Used when converting scan results to announcement inputs.
 */
export function rToBytes64(R: string): Uint8Array {
  return pointToBytes64(R);
}

/**
 * Convert raw 64-byte ephemeral pubkey to "X.Y" decimal format for WASM scan input.
 */
export function bytes64ToR(bytes: Uint8Array): string {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const xBig = BigInt("0x" + hex.slice(0, 64));
  const yBig = BigInt("0x" + hex.slice(64));
  return `${xBig}.${yBig}`;
}

/**
 * Derive the Substrate AccountId32 for a stealth address from its spending public key.
 * AccountId32 = blake2b_256(compressed_secp256k1_pubkey)
 * This is consistent with Keyring({ type: 'ecdsa' }).addFromSeed(privKey).address
 *
 * @param spendingPubKey Secp256k1 spending public key in "X.Y" decimal format
 * @returns Hex AccountId32 (0x-prefixed, 32 bytes)
 */
export function deriveSubstrateStealthAddress(spendingPubKey: string): string {
  const compressed = secp256k1ToCompressed(spendingPubKey);
  return u8aToHex(blake2AsU8a(compressed, 256));
}

// ── Chain queries ─────────────────────────────────────────────────────────────

function decodeBytes(val: unknown): Uint8Array {
  if (typeof val === "string") return hexToU8a(val);
  if (Array.isArray(val)) return new Uint8Array(val as number[]);
  return new Uint8Array();
}

/**
 * Fetch all stealth announcements from on-chain storage.
 * @param api Connected ApiPromise instance
 */
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

/**
 * Get the free native balance of an account.
 * @param api Connected ApiPromise instance
 * @param accountId Hex AccountId32 or SS58 address
 * @returns Balance in planck (native token smallest unit)
 */
export async function getBalance(api: ApiPromise, accountId: string): Promise<bigint> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acc = await api.query.system.account(accountId) as any;
  return acc.data.free.toBigInt();
}

/**
 * Get the balance of a pallet-assets token for an account.
 * @param api Connected ApiPromise instance
 * @param accountId Hex AccountId32 or SS58 address
 * @param assetId Asset ID (e.g. 1 for USDC)
 * @returns Asset balance in smallest unit
 */
export async function getAssetBalance(
  api: ApiPromise,
  accountId: string,
  assetId: number
): Promise<bigint> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acc = await api.query.assets.account(assetId, accountId) as any;
  if (!acc || acc.isNone) return 0n;
  const inner = acc.isSome ? acc.unwrap() : acc;
  return inner.balance?.toBigInt?.() ?? 0n;
}

// ── Internal tx submission ────────────────────────────────────────────────────

async function submitTx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  signer: SubstrateSigner,
  onInBlock?: (hash: string) => void
): Promise<string> {
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

    const sendPromise =
      signer.type === "keypair"
        ? tx.signAndSend(signer.pair, callback)
        : tx.signAndSend(signer.address, { signer: injectorSigner }, callback);

    sendPromise.then((u: unknown) => { unsub = u; }).catch(reject);
  });
}

// ── Extrinsics ────────────────────────────────────────────────────────────────

/**
 * Register a stealth meta-address on-chain via the Substrate pallet.
 * @param api Connected ApiPromise instance
 * @param signer Account that pays the transaction fee
 * @param spendingPubKey Secp256k1 public spending key "X.Y"
 * @param viewingPubKey BN254 G1 public viewing key "X.Y"
 * @param schemeId Protocol scheme ID (default: 2901 for ECPDKSAP-BN254)
 */
export async function registerMetaAddress(
  api: ApiPromise,
  signer: SubstrateSigner,
  spendingPubKey: string,
  viewingPubKey: string,
  schemeId = 2901
): Promise<string> {
  const spBytes = Array.from(secp256k1ToCompressed(spendingPubKey));
  const vpBytes = Array.from(bn254ToBytes64(viewingPubKey));
  return submitTx(
    api.tx.stealthAddresses.registerStealthMetaAddress(spBytes, vpBytes, schemeId),
    signer
  );
}

/**
 * Send native PAS to a stealth address on another parachain via XCM, with announcement.
 */
export async function sendStealthXcm(
  api: ApiPromise,
  signer: SubstrateSigner,
  destParaId: number,
  stealthAddress: string,
  amount: bigint,
  ephemeralPubkey: Uint8Array,
  viewTag: Uint8Array,
  metadata: Uint8Array
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

/**
 * Send a pallet-assets token to a stealth address on another parachain via XCM, with announcement.
 */
export async function sendStealthAssetXcm(
  api: ApiPromise,
  signer: SubstrateSigner,
  assetId: number,
  destParaId: number,
  stealthAddress: string,
  amount: bigint,
  ephemeralPubkey: Uint8Array,
  viewTag: Uint8Array,
  metadata: Uint8Array
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

/**
 * Send a pallet-assets token directly to a stealth address on the same chain, with announcement.
 * Uses utility.batchAll so both transfer and announcement succeed or both fail.
 */
export async function sendStealthAsset(
  api: ApiPromise,
  signer: SubstrateSigner,
  assetId: number,
  stealthAddress: string,
  amount: bigint,
  ephemeralPubkey: Uint8Array,
  viewTag: Uint8Array,
  metadata: Uint8Array
): Promise<string> {
  const transferCall = api.tx.assets.transfer(assetId, stealthAddress, amount.toString());
  const announceCall = api.tx.stealthAddresses.announce(
    Array.from(ephemeralPubkey),
    Array.from(viewTag),
    stealthAddress,
    Array.from(metadata)
  );
  return submitTx(api.tx.utility.batchAll([transferCall, announceCall]), signer);
}

/**
 * Spend from a stealth address — direct balance transfer.
 * The stealth ECDSA keypair signs the transaction.
 *
 * @param api Connected ApiPromise on the chain where the stealth address holds funds
 * @param spendingPrivKey ECDSA private key from scan results
 * @param to Destination address (AccountId32 hex, SS58, or H160 EVM address)
 * @param amount Amount in planck
 */
export async function spendFromStealth(
  api: ApiPromise,
  spendingPrivKey: string,
  to: string,
  amount: bigint
): Promise<string> {
  const pair = getStealthSpendingKeypair(spendingPrivKey);
  // Convert H160 EVM address → AccountId32 (pallet-revive AccountId32Mapper: H160 ++ 0xEE*12)
  let dest = to;
  if (/^0x[0-9a-fA-F]{40}$/.test(to)) {
    dest = to.toLowerCase() + "ee".repeat(12);
  }
  return submitTx(api.tx.balances.transferAllowDeath(dest, amount.toString()), {
    type: "keypair",
    pair,
  });
}

/**
 * Send a specific pallet-assets token from a stealth address to any recipient.
 */
export async function sendAssetFromStealth(
  api: ApiPromise,
  spendingPrivKey: string,
  to: string,
  assetId: number,
  amount: bigint
): Promise<string> {
  const pair = getStealthSpendingKeypair(spendingPrivKey);
  return submitTx(api.tx.assets.transfer(assetId, to, amount.toString()), {
    type: "keypair",
    pair,
  });
}

// ── Gas-sponsored withdrawal ──────────────────────────────────────────────────

/**
 * Deposit into the gas sponsor pool so withdrawFromStealth can be covered.
 * @param api Connected ApiPromise instance
 * @param signer Sponsor account
 * @param amount Amount in planck to deposit
 */
export async function sponsorGas(
  api: ApiPromise,
  signer: SubstrateSigner,
  amount: bigint
): Promise<string> {
  return submitTx(api.tx.stealthAddresses.sponsorGas(amount.toString()), signer);
}

/**
 * Query how much an account has in the gas sponsor pool.
 */
export async function getSponsorBalance(api: ApiPromise, accountId: string): Promise<bigint> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const val = await api.query.stealthAddresses.gasSponsorPool(accountId) as any;
  return val?.toBigInt?.() ?? 0n;
}

function buildWithdrawalMessage(
  stealthHex: string,
  destBytes: Uint8Array,
  assetId?: number,
  amount?: bigint
): Uint8Array {
  const prefix = new TextEncoder().encode("PrivyDot::withdraw:v2");
  const stealth = hexToU8a(stealthHex);

  let assetBytes: Uint8Array;
  if (assetId === undefined || assetId === null) {
    assetBytes = new Uint8Array([0x00]);
  } else {
    assetBytes = new Uint8Array(5);
    assetBytes[0] = 0x01;
    new DataView(assetBytes.buffer).setUint32(1, assetId, true);
  }

  let amountBytes: Uint8Array;
  if (amount === undefined || amount === null) {
    amountBytes = new Uint8Array([0x00]);
  } else {
    amountBytes = new Uint8Array(17);
    amountBytes[0] = 0x01;
    let v = amount;
    for (let i = 0; i < 16; i++) {
      amountBytes[1 + i] = Number(v & 0xffn);
      v >>= 8n;
    }
  }

  const msg = new Uint8Array(
    prefix.length + 32 + 32 + assetBytes.length + amountBytes.length
  );
  let offset = 0;
  msg.set(prefix, offset); offset += prefix.length;
  msg.set(stealth, offset); offset += 32;
  msg.set(destBytes, offset); offset += 32;
  msg.set(assetBytes, offset); offset += assetBytes.length;
  msg.set(amountBytes, offset);
  return msg;
}

/**
 * Withdraw from a stealth address using the pallet's gas-sponsored withdrawal.
 * The stealth ECDSA key signs the withdrawal message; a sponsor pays the fee.
 *
 * @param api Connected ApiPromise instance
 * @param stealthAddress Hex AccountId32 of the stealth address (from scan)
 * @param spendingPrivKey ECDSA private key (from scan results) — used only for signing
 * @param destination AccountId32 hex or SS58 of recipient
 * @param sponsor Account with PAS in the gas sponsor pool (pays inclusion fee)
 * @param assetId undefined = native PAS; number = pallet-assets asset ID
 * @param amount undefined = entire balance; bigint = specific amount in planck
 */
export async function withdrawFromStealth(
  api: ApiPromise,
  stealthAddress: string,
  spendingPrivKey: string,
  destination: string,
  sponsor: SubstrateSigner,
  assetId?: number,
  amount?: bigint
): Promise<string> {
  const stealthPair = getStealthSpendingKeypair(spendingPrivKey);
  const destBytes = decodeAddress(destination);

  const msg = buildWithdrawalMessage(stealthAddress, destBytes, assetId, amount);
  const sig = stealthPair.sign(msg);

  const assetArg = assetId !== undefined && assetId !== null ? assetId : null;
  const amountArg = amount !== undefined && amount !== null ? amount.toString() : null;

  return submitTx(
    api.tx.stealthAddresses.withdrawFromStealth(
      Array.from(hexToU8a(stealthAddress)),
      destination,
      Array.from(sig),
      signerAddress(sponsor),
      assetArg,
      amountArg
    ),
    sponsor
  );
}