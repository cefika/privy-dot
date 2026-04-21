/**
 * Privy Dot SDK — TypeScript SDK for the Privy Dot stealth address protocol on Polkadot.
 *
 * Quick start:
 *
 *   import { initWasm, wasmApi, configureEvm, connectMetaMask,
 *            deriveSubstrateStealthAddress, sendAndAnnounceViaPrecompile,
 *            fetchAnnouncements, getApi } from "privy-dot-sdk";
 *
 *   // 1. Initialize crypto (browser — serve privy-core.wasm + wasm_exec.js from public/)
 *   await initWasm("/privy-core.wasm");
 *
 *   // 2. Configure EVM connection
 *   configureEvm("http://localhost:8545");
 *
 *   // 3. Generate keys
 *   const keys = await wasmApi.newMeta();
 *
 *   // 4. Compute stealth send data
 *   const sendResult = await wasmApi.send(recipientK, recipientV);
 *   const stealthAddress = deriveSubstrateStealthAddress(sendResult.spendingPubKey);
 *
 *   // 5. Send + announce via EVM precompile (one MetaMask popup)
 *   const { signer } = await connectMetaMask();
 *   await sendAndAnnounceViaPrecompile(signer, hexToBytes(stealthAddress), "1.0", ...);
 *
 *   // 6. Scan announcements
 *   const api = await getApi("ws://localhost:9944");
 *   const announcements = await fetchAnnouncements(api);
 *   const scanResult = await wasmApi.scan(keys.k, keys.v, Rs, viewTags);
 */

// Types
export type {
  KeyPairs,
  SendResult,
  ScanResult,
  FoundAddress,
  AnnouncementRow,
} from "./types.js";

// WASM crypto module
export { initWasm, resetWasm, wasmApi } from "./wasm.js";

// Substrate / Polkadot module
export type { SubstrateSigner } from "./substrate.js";
export {
  // Wallet / signer
  getExtensionAccounts,
  getDevAccount,
  getAccountFromMnemonic,
  signerFromExtensionAccount,
  getStealthSpendingKeypair,
  signerAddress,
  // Chain connections
  getApi,
  disconnectAll,
  // Crypto helpers
  secp256k1ToCompressed,
  bn254ToBytes64,
  rToBytes64,
  bytes64ToR,
  deriveSubstrateStealthAddress,
  // Chain queries
  fetchAnnouncements,
  getBalance,
  getAssetBalance,
  // Extrinsics
  registerMetaAddress,
  sendStealthXcm,
  sendStealthAssetXcm,
  sendStealthAsset,
  spendFromStealth,
  sendAssetFromStealth,
  sponsorGas,
  getSponsorBalance,
  withdrawFromStealth,
} from "./substrate.js";

// EVM / ethers module
export {
  // Constants
  STEALTH_PRECOMPILE_ADDR,
  STEALTH_PRECOMPILE_ABI,
  // Config
  configureEvm,
  evmProvider,
  signerFromPrivKey,
  // Precompile calls
  registerMetaAddressViaPrecompile,
  announceViaPrecompile,
  sendAndAnnounceViaPrecompile,
  // MetaMask
  connectMetaMask,
  // Address utils
  deriveEvmStealthAddress,
  h160ToAccountId32,
} from "./evm.js";