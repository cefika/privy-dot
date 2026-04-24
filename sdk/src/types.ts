/** Spending and viewing key pairs returned by WASM */
export interface KeyPairs {
  /** Private spending key (hex, secp256k1) */
  k: string;
  /** Private viewing key (hex, BN254) */
  v: string;
  /** Public spending key "X.Y" (secp256k1) */
  K: string;
  /** Public viewing key "X.Y" (BN254 G1) */
  V: string;
}

/** WASM send() output — ephemeral key material for a stealth transfer */
export interface SendResult {
  /** Private ephemeral key (hex) */
  r: string;
  /** Public ephemeral key "X.Y" (secp256k1) */
  R: string;
  /** View tag (2-byte hex prefix for fast scanning) */
  viewTag: string;
  /** Derived public spending key "X.Y" for the stealth address */
  spendingPubKey: string;
}

/** WASM scan() output — keys for each matching announcement */
export interface ScanResult {
  spendingPubKeys: string[];
  spendingPrivKeys: string[];
}

/** A discovered stealth address with its balance information */
export interface FoundAddress {
  /** Hex AccountId32 of the stealth address */
  stealthAddress: string;
  /** ECDSA private key to spend from this stealth address */
  spendingPrivKey: string;
  /** Secp256k1 public spending key "X.Y" */
  spendingPubKey: string;
  /** Human-readable native balance (e.g. "1.500 PAS") */
  balance: string;
  /** Native balance in planck (smallest unit) */
  balancePlanck?: bigint;
  /** USDC balance in smallest unit */
  usdcBalance?: bigint;
  /** Whether the address was found via EVM (H160) or Substrate (AccountId32) path */
  addressType?: "evm" | "substrate";
}

/** A single announcement row read from chain storage */
export interface AnnouncementRow {
  nonce: number;
  /** 64-byte uncompressed secp256k1 ephemeral public key */
  ephemeralPubkey: Uint8Array;
  /** 2-byte view tag */
  viewTag: Uint8Array;
  /** Hex AccountId32 of the stealth address */
  stealthAddress: string;
  /** 32-byte metadata */
  metadata: Uint8Array;
}