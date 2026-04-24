import { ApiPromise } from '@polkadot/api';
import { KeyringPair } from '@polkadot/keyring/types';
import { InjectedAccountWithMeta } from '@polkadot/extension-inject/types';
import { ethers } from 'ethers';

/** Spending and viewing key pairs returned by WASM */
interface KeyPairs {
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
interface SendResult {
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
interface ScanResult {
    spendingPubKeys: string[];
    spendingPrivKeys: string[];
}
/** A discovered stealth address with its balance information */
interface FoundAddress {
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
interface AnnouncementRow {
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

/**
 * Go WASM wrapper for Privy Dot cryptographic operations.
 *
 * Browser setup (in your HTML before any SDK calls):
 *   <script src="/wasm_exec.js"></script>   <!-- Go runtime shim -->
 *
 * Then call initWasm("/privy-core.wasm") once during app startup.
 * Copy privy-core.wasm into your public directory.
 */

declare global {
    interface Window {
        Go: new () => {
            importObject: WebAssembly.Imports;
            run(i: WebAssembly.Instance): void;
        };
    }
    function new_meta(): string;
    function get_meta(a: string): string;
    function send(a: string): string;
    function scan(a: string): string;
}
/**
 * Load and start the Go WASM module.
 * Must be called once before any wasmApi calls.
 *
 * @param wasmUrl URL of privy-core.wasm (e.g. "/privy-core.wasm")
 */
declare function initWasm(wasmUrl: string): Promise<void>;
/** Reinitialize WASM after a Go panic ("already exited" error) */
declare function resetWasm(): Promise<void>;
declare const wasmApi: {
    /**
     * Generate a new random stealth meta-address key pair.
     * Returns spending (k/K) and viewing (v/V) key pairs.
     */
    newMeta: () => Promise<KeyPairs>;
    /**
     * Restore KeyPairs from existing private keys.
     * @param k Spending private key (hex)
     * @param v Viewing private key (hex)
     */
    getMeta: (k: string, v: string) => Promise<KeyPairs>;
    /**
     * Compute send result (ephemeral key, view tag, stealth spending pubkey).
     * @param K Recipient spending public key "X.Y"
     * @param V Recipient viewing public key "X.Y"
     */
    send: (K: string, V: string) => Promise<SendResult>;
    /**
     * Scan announcements and return matching stealth spending keys.
     * @param k Viewing private key (hex)
     * @param v Viewing private key (hex, same key — kept for API symmetry)
     * @param Rs Array of ephemeral pubkeys "X.Y" from announcements
     * @param viewTags Array of view tags (hex) from announcements
     */
    scan: (k: string, v: string, Rs: string[], viewTags: string[]) => Promise<ScanResult>;
};

/**
 * Substrate / Polkadot-API interactions for the Privy Dot stealth protocol.
 * Covers: key derivation, parachain connections, announcements, registration,
 * stealth sends (native + assets + XCM), spending, and withdrawal.
 */

/** Unified signer: dev keypair or browser extension (Talisman, SubWallet, Polkadot.js) */
type SubstrateSigner = {
    type: "keypair";
    pair: KeyringPair;
} | {
    type: "injected";
    address: string;
    name?: string;
};
/** Extract address regardless of signer type */
declare function signerAddress(s: SubstrateSigner): string;
/**
 * Request permission from browser wallet extensions (Talisman, SubWallet, Polkadot.js).
 * Returns the list of accounts available in installed extensions.
 * @param appName Name shown in the wallet permission dialog
 */
declare function getExtensionAccounts(appName?: string): Promise<InjectedAccountWithMeta[]>;
/**
 * Get (or create and cache) a Polkadot API connection.
 * @param wsUrl WebSocket URL of the parachain RPC node
 */
declare function getApi(wsUrl: string): Promise<ApiPromise>;
/** Disconnect all cached API connections */
declare function disconnectAll(): void;
/** Get a dev account (Alice, Bob, Charlie) as a SubstrateSigner */
declare function getDevAccount(name: "alice" | "bob" | "charlie"): SubstrateSigner;
/** Create a SubstrateSigner from a mnemonic phrase */
declare function getAccountFromMnemonic(mnemonic: string): SubstrateSigner;
/** Wrap an extension account as a SubstrateSigner */
declare function signerFromExtensionAccount(account: InjectedAccountWithMeta): SubstrateSigner;
/**
 * Get the ECDSA keypair for spending FROM a stealth address.
 * @param spendingPrivKey Hex spending private key (from scan results)
 */
declare function getStealthSpendingKeypair(spendingPrivKey: string): KeyringPair;
/**
 * Convert a secp256k1 public key in "X.Y" decimal format to 33-byte compressed form.
 */
declare function secp256k1ToCompressed(pubKey: string): Uint8Array;
/**
 * Convert a BN254 G1 point in "X.Y" decimal format to 64-byte form.
 * Used for the viewing public key in meta-address registration.
 */
declare function bn254ToBytes64(pubKey: string): Uint8Array;
/**
 * Convert a secp256k1 ephemeral public key in "X.Y" format to 64-byte form.
 * Used when converting scan results to announcement inputs.
 */
declare function rToBytes64(R: string): Uint8Array;
/**
 * Convert raw 64-byte ephemeral pubkey to "X.Y" decimal format for WASM scan input.
 */
declare function bytes64ToR(bytes: Uint8Array): string;
/**
 * Derive the Substrate AccountId32 for a stealth address from its spending public key.
 * AccountId32 = blake2b_256(compressed_secp256k1_pubkey)
 * This is consistent with Keyring({ type: 'ecdsa' }).addFromSeed(privKey).address
 *
 * @param spendingPubKey Secp256k1 spending public key in "X.Y" decimal format
 * @returns Hex AccountId32 (0x-prefixed, 32 bytes)
 */
declare function deriveSubstrateStealthAddress(spendingPubKey: string): string;
/**
 * Fetch all stealth announcements from on-chain storage.
 * @param api Connected ApiPromise instance
 */
declare function fetchAnnouncements(api: ApiPromise): Promise<AnnouncementRow[]>;
/**
 * Get the free native balance of an account.
 * @param api Connected ApiPromise instance
 * @param accountId Hex AccountId32 or SS58 address
 * @returns Balance in planck (native token smallest unit)
 */
declare function getBalance(api: ApiPromise, accountId: string): Promise<bigint>;
/**
 * Get the balance of a pallet-assets token for an account.
 * @param api Connected ApiPromise instance
 * @param accountId Hex AccountId32 or SS58 address
 * @param assetId Asset ID (e.g. 1 for USDC)
 * @returns Asset balance in smallest unit
 */
declare function getAssetBalance(api: ApiPromise, accountId: string, assetId: number): Promise<bigint>;
/**
 * Register a stealth meta-address on-chain via the Substrate pallet.
 * @param api Connected ApiPromise instance
 * @param signer Account that pays the transaction fee
 * @param spendingPubKey Secp256k1 public spending key "X.Y"
 * @param viewingPubKey BN254 G1 public viewing key "X.Y"
 * @param schemeId Protocol scheme ID (default: 2901 for ECPDKSAP-BN254)
 */
declare function registerMetaAddress(api: ApiPromise, signer: SubstrateSigner, spendingPubKey: string, viewingPubKey: string, schemeId?: number): Promise<string>;
/**
 * Send native PAS to a stealth address on another parachain via XCM, with announcement.
 */
declare function sendStealthXcm(api: ApiPromise, signer: SubstrateSigner, destParaId: number, stealthAddress: string, amount: bigint, ephemeralPubkey: Uint8Array, viewTag: Uint8Array, metadata: Uint8Array): Promise<string>;
/**
 * Send a pallet-assets token to a stealth address on another parachain via XCM, with announcement.
 */
declare function sendStealthAssetXcm(api: ApiPromise, signer: SubstrateSigner, assetId: number, destParaId: number, stealthAddress: string, amount: bigint, ephemeralPubkey: Uint8Array, viewTag: Uint8Array, metadata: Uint8Array): Promise<string>;
/**
 * Send a pallet-assets token directly to a stealth address on the same chain, with announcement.
 * Uses utility.batchAll so both transfer and announcement succeed or both fail.
 */
declare function sendStealthAsset(api: ApiPromise, signer: SubstrateSigner, assetId: number, stealthAddress: string, amount: bigint, ephemeralPubkey: Uint8Array, viewTag: Uint8Array, metadata: Uint8Array): Promise<string>;
/**
 * Spend from a stealth address — direct balance transfer.
 * The stealth ECDSA keypair signs the transaction.
 *
 * @param api Connected ApiPromise on the chain where the stealth address holds funds
 * @param spendingPrivKey ECDSA private key from scan results
 * @param to Destination address (AccountId32 hex, SS58, or H160 EVM address)
 * @param amount Amount in planck
 */
declare function spendFromStealth(api: ApiPromise, spendingPrivKey: string, to: string, amount: bigint): Promise<string>;
/**
 * Send a specific pallet-assets token from a stealth address to any recipient.
 */
declare function sendAssetFromStealth(api: ApiPromise, spendingPrivKey: string, to: string, assetId: number, amount: bigint): Promise<string>;
/**
 * Deposit into the gas sponsor pool so withdrawFromStealth can be covered.
 * @param api Connected ApiPromise instance
 * @param signer Sponsor account
 * @param amount Amount in planck to deposit
 */
declare function sponsorGas(api: ApiPromise, signer: SubstrateSigner, amount: bigint): Promise<string>;
/**
 * Query how much an account has in the gas sponsor pool.
 */
declare function getSponsorBalance(api: ApiPromise, accountId: string): Promise<bigint>;
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
declare function withdrawFromStealth(api: ApiPromise, stealthAddress: string, spendingPrivKey: string, destination: string, sponsor: SubstrateSigner, assetId?: number, amount?: bigint): Promise<string>;

/**
 * EVM / ethers.js interactions for the Privy Dot stealth protocol.
 * Covers: precompile calls (register, announce, sendAndAnnounce),
 * MetaMask connection with automatic chain switching, and utility helpers.
 */

/**
 * Stealth precompile address (fixed at H160 0x...10000000 on the Privy Dot chain).
 * Registered via AddressMatcher::Fixed in the runtime.
 */
declare const STEALTH_PRECOMPILE_ADDR = "0x0000000000000000000000000000000010000000";
declare const STEALTH_PRECOMPILE_ABI: string[];
/**
 * Configure the EVM module with chain connection details.
 * Must be called before using any EVM functions.
 *
 * @param rpcUrl HTTP/HTTPS or WebSocket URL for the EVM RPC endpoint
 * @param chainId EVM chain ID (default: 420420421 for Privy Dot localnet)
 */
declare function configureEvm(rpcUrl: string, chainId?: number): void;
/** Get the EVM provider instance (configured via configureEvm) */
declare const evmProvider: {
    getBalance: (addr: string) => Promise<bigint>;
    getBlockNumber: () => Promise<number>;
};
/** Create an ethers Wallet from a raw private key using the configured provider */
declare function signerFromPrivKey(privKey: string): ethers.Wallet;
/**
 * Register a stealth meta-address via the EVM precompile (MetaMask / EVM wallet).
 *
 * @param signer EVM signer (e.g. from connectMetaMask or signerFromPrivKey)
 * @param spendingBytes 33-byte compressed secp256k1 spending public key
 * @param viewingBytes 64-byte BN254 G1 viewing public key (x_32 ++ y_32)
 * @param schemeId Protocol scheme ID (default: 2901 for ECPDKSAP-BN254)
 * @returns Transaction hash
 */
declare function registerMetaAddressViaPrecompile(signer: ethers.Signer, spendingBytes: Uint8Array, viewingBytes: Uint8Array, schemeId?: number): Promise<string>;
/**
 * Announce a stealth transfer via the EVM precompile.
 * Use this when funds were already sent via another mechanism and you only need the announcement.
 *
 * @param signer EVM signer
 * @param ephemeralPubkey64 64-byte uncompressed ephemeral public key
 * @param viewTag2 2-byte view tag
 * @param stealthAccountId32 32-byte AccountId32 of the stealth address
 * @param metadata 32-byte metadata (default: zeroed)
 * @returns Transaction hash
 */
declare function announceViaPrecompile(signer: ethers.Signer, ephemeralPubkey64: Uint8Array, viewTag2: Uint8Array, stealthAccountId32: Uint8Array, metadata?: Uint8Array): Promise<string>;
/**
 * Send native PAS to a stealth address AND announce — all in a single transaction.
 * This is the recommended EVM send path: one MetaMask popup, funds land on the
 * Substrate AccountId32 stealth address (compatible with Talisman/XCM senders).
 *
 * @param signer EVM signer
 * @param stealthAccountId32 32-byte AccountId32 of the stealth address
 * @param amountEther Amount to send in ether units (e.g. "1.5")
 * @param ephemeralPubkey64 64-byte ephemeral public key
 * @param viewTag2 2-byte view tag
 * @param metadata 32-byte metadata (default: zeroed)
 * @returns Transaction hash
 */
declare function sendAndAnnounceViaPrecompile(signer: ethers.Signer, stealthAccountId32: Uint8Array, amountEther: string, ephemeralPubkey64: Uint8Array, viewTag2: Uint8Array, metadata?: Uint8Array): Promise<string>;
/**
 * Connect MetaMask and switch to the configured chain.
 * Automatically adds the chain if it's not in MetaMask yet.
 *
 * @param chainName Display name for the chain (shown in wallet_addEthereumChain)
 * @param nativeCurrency Currency info for wallet_addEthereumChain
 * @returns Connected signer and the user's address
 */
declare function connectMetaMask(chainName?: string, nativeCurrency?: {
    name: string;
    symbol: string;
    decimals: number;
}): Promise<{
    signer: ethers.Signer;
    address: string;
}>;
/**
 * Derive the EVM H160 address from a secp256k1 spending public key "X.Y".
 * Note: for the unified Substrate path, use deriveSubstrateStealthAddress from substrate.ts.
 */
declare function deriveEvmStealthAddress(spendingPubKey: string): string;
/**
 * Convert an H160 EVM address to its AccountId32 equivalent.
 * Uses the pallet-revive AccountId32Mapper fallback: H160 ++ 0xEE*12.
 */
declare function h160ToAccountId32(address: string): Uint8Array;
declare global {
    interface Window {
        ethereum?: Record<string, unknown> & {
            request: (a: {
                method: string;
                params?: unknown[];
            }) => Promise<unknown>;
        };
    }
}

export { type AnnouncementRow, type FoundAddress, type KeyPairs, STEALTH_PRECOMPILE_ABI, STEALTH_PRECOMPILE_ADDR, type ScanResult, type SendResult, type SubstrateSigner, announceViaPrecompile, bn254ToBytes64, bytes64ToR, configureEvm, connectMetaMask, deriveEvmStealthAddress, deriveSubstrateStealthAddress, disconnectAll, evmProvider, fetchAnnouncements, getAccountFromMnemonic, getApi, getAssetBalance, getBalance, getDevAccount, getExtensionAccounts, getSponsorBalance, getStealthSpendingKeypair, h160ToAccountId32, initWasm, rToBytes64, registerMetaAddress, registerMetaAddressViaPrecompile, resetWasm, secp256k1ToCompressed, sendAndAnnounceViaPrecompile, sendAssetFromStealth, sendStealthAsset, sendStealthAssetXcm, sendStealthXcm, signerAddress, signerFromExtensionAccount, signerFromPrivKey, spendFromStealth, sponsorGas, wasmApi, withdrawFromStealth };
