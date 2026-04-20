/**
 * EVM / ethers.js interactions for the Privy Dot stealth protocol.
 * Covers: precompile calls (register, announce, sendAndAnnounce),
 * MetaMask connection with automatic chain switching, and utility helpers.
 */
import { ethers } from "ethers";

// ── Stealth precompile ────────────────────────────────────────────────────────

/**
 * Stealth precompile address (fixed at H160 0x...10000000 on the Privy Dot chain).
 * Registered via AddressMatcher::Fixed in the runtime.
 */
export const STEALTH_PRECOMPILE_ADDR = "0x0000000000000000000000000000000010000000";

export const STEALTH_PRECOMPILE_ABI = [
  "function registerMetaAddress(bytes spendingPubkey, bytes viewingPubkey, uint32 schemeId) external",
  "function announce(bytes ephemeralPubkey, bytes2 viewTag, bytes32 stealthAddress, bytes32 metadata) external",
  "function sendAndAnnounce(bytes32 stealthAddress, bytes ephemeralPubkey, bytes2 viewTag, bytes32 metadata) external payable",
];

// ── Runtime config ────────────────────────────────────────────────────────────

let _rpcUrl = "";
let _chainId = 420420421; // Privy Dot localnet default
let _providerInstance: ethers.JsonRpcProvider | null = null;

/**
 * Configure the EVM module with chain connection details.
 * Must be called before using any EVM functions.
 *
 * @param rpcUrl HTTP/HTTPS or WebSocket URL for the EVM RPC endpoint
 * @param chainId EVM chain ID (default: 420420421 for Privy Dot localnet)
 */
export function configureEvm(rpcUrl: string, chainId = 420420421): void {
  _rpcUrl = rpcUrl;
  _chainId = chainId;
  _providerInstance = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
}

function getProvider(): ethers.JsonRpcProvider {
  if (!_providerInstance) {
    throw new Error("EVM not configured. Call configureEvm(rpcUrl) first.");
  }
  return _providerInstance;
}

// ── Provider helpers ──────────────────────────────────────────────────────────

/** Get the EVM provider instance (configured via configureEvm) */
export const evmProvider = {
  getBalance: (addr: string) => getProvider().getBalance(addr),
  getBlockNumber: () => getProvider().getBlockNumber(),
};

/** Create an ethers Wallet from a raw private key using the configured provider */
export function signerFromPrivKey(privKey: string): ethers.Wallet {
  return new ethers.Wallet(privKey, getProvider());
}

// ── Precompile calls ──────────────────────────────────────────────────────────

function getPrecompile(signer: ethers.Signer): ethers.Contract {
  return new ethers.Contract(STEALTH_PRECOMPILE_ADDR, STEALTH_PRECOMPILE_ABI, signer);
}

/**
 * Register a stealth meta-address via the EVM precompile (MetaMask / EVM wallet).
 *
 * @param signer EVM signer (e.g. from connectMetaMask or signerFromPrivKey)
 * @param spendingBytes 33-byte compressed secp256k1 spending public key
 * @param viewingBytes 64-byte BN254 G1 viewing public key (x_32 ++ y_32)
 * @param schemeId Protocol scheme ID (default: 2901 for ECPDKSAP-BN254)
 * @returns Transaction hash
 */
export async function registerMetaAddressViaPrecompile(
  signer: ethers.Signer,
  spendingBytes: Uint8Array,
  viewingBytes: Uint8Array,
  schemeId = 2901
): Promise<string> {
  const precompile = getPrecompile(signer);
  const tx = await precompile.registerMetaAddress(
    ethers.hexlify(spendingBytes),
    ethers.hexlify(viewingBytes),
    schemeId,
    { gasLimit: 500_000 }
  );
  const receipt = await tx.wait();
  return receipt.hash;
}

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
export async function announceViaPrecompile(
  signer: ethers.Signer,
  ephemeralPubkey64: Uint8Array,
  viewTag2: Uint8Array,
  stealthAccountId32: Uint8Array,
  metadata: Uint8Array = new Uint8Array(32)
): Promise<string> {
  const precompile = getPrecompile(signer);
  const tx = await precompile.announce(
    ethers.hexlify(ephemeralPubkey64),
    ethers.hexlify(viewTag2),
    ethers.hexlify(stealthAccountId32),
    ethers.hexlify(metadata),
    { gasLimit: 500_000 }
  );
  const receipt = await tx.wait();
  return receipt.hash;
}

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
export async function sendAndAnnounceViaPrecompile(
  signer: ethers.Signer,
  stealthAccountId32: Uint8Array,
  amountEther: string,
  ephemeralPubkey64: Uint8Array,
  viewTag2: Uint8Array,
  metadata: Uint8Array = new Uint8Array(32)
): Promise<string> {
  const precompile = getPrecompile(signer);
  const tx = await precompile.sendAndAnnounce(
    ethers.hexlify(stealthAccountId32),
    ethers.hexlify(ephemeralPubkey64),
    ethers.hexlify(viewTag2),
    ethers.hexlify(metadata),
    {
      gasLimit: 800_000,
      value: ethers.parseEther(amountEther),
    }
  );
  const receipt = await tx.wait();
  return receipt.hash;
}

// ── MetaMask connection ───────────────────────────────────────────────────────

/**
 * Connect MetaMask and switch to the configured chain.
 * Automatically adds the chain if it's not in MetaMask yet.
 *
 * @param chainName Display name for the chain (shown in wallet_addEthereumChain)
 * @param nativeCurrency Currency info for wallet_addEthereumChain
 * @returns Connected signer and the user's address
 */
export async function connectMetaMask(
  chainName = "Privy Localnet",
  nativeCurrency = { name: "PAS", symbol: "PAS", decimals: 18 }
): Promise<{ signer: ethers.Signer; address: string }> {
  if (!window.ethereum) {
    throw new Error("MetaMask not found. Use private key mode instead.");
  }

  const eth = window.ethereum as {
    request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
  };

  await eth.request({ method: "eth_requestAccounts" });

  const chainHex = (await eth.request({ method: "eth_chainId", params: [] })) as string;
  const currentChain = parseInt(chainHex, 16);

  if (currentChain !== _chainId) {
    try {
      await eth.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + _chainId.toString(16) }],
      });
    } catch (switchErr: unknown) {
      const code = (switchErr as { code?: number })?.code;
      if (code === 4902) {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: "0x" + _chainId.toString(16),
              chainName,
              nativeCurrency,
              rpcUrls: [_rpcUrl],
            },
          ],
        });
      } else {
        throw new Error(
          `Wrong network. Please switch MetaMask to chain ID ${_chainId} (${chainName}).`
        );
      }
    }
  }

  const bp = new ethers.BrowserProvider(window.ethereum as ethers.Eip1193Provider);
  const signer = await bp.getSigner();
  return { signer, address: await signer.getAddress() };
}

// ── Address utilities ─────────────────────────────────────────────────────────

/**
 * Derive the EVM H160 address from a secp256k1 spending public key "X.Y".
 * Note: for the unified Substrate path, use deriveSubstrateStealthAddress from substrate.ts.
 */
export function deriveEvmStealthAddress(spendingPubKey: string): string {
  const [X, Y] = spendingPubKey.split(".");
  const pub =
    "0x" +
    BigInt(X).toString(16).padStart(64, "0") +
    BigInt(Y).toString(16).padStart(64, "0");
  return ethers.computeAddress(pub);
}

/**
 * Convert an H160 EVM address to its AccountId32 equivalent.
 * Uses the pallet-revive AccountId32Mapper fallback: H160 ++ 0xEE*12.
 */
export function h160ToAccountId32(address: string): Uint8Array {
  const bytes = new Uint8Array(32);
  const h160 = ethers.getBytes(address);
  bytes.set(h160, 0);
  bytes.fill(0xee, 20);
  return bytes;
}

// ── Window type augmentation ──────────────────────────────────────────────────

declare global {
  interface Window {
    ethereum?: Record<string, unknown> & {
      request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}