import { ethers } from "ethers";

// ── Stealth Precompile ────────────────────────────────────────────────────────
// Registrovan na adresi AddressMatcher::Fixed(0x1000) → H160 bytes[16..20] = 0x10000000
export const PRECOMPILE_ADDR = "0x0000000000000000000000000000000010000000";

export const PRECOMPILE_ABI = [
  "function registerMetaAddress(bytes spendingPubkey, bytes viewingPubkey, uint32 schemeId) external",
  "function announce(bytes ephemeralPubkey, bytes2 viewTag, bytes32 stealthAddress, bytes32 metadata) external",
];

export function getPrecompile(signer: ethers.Signer) {
  return new ethers.Contract(PRECOMPILE_ADDR, PRECOMPILE_ABI, signer);
}

// H160 → AccountId32 (pallet-revive AccountId32Mapper fallback: H160 ++ 0xEE*12)
export function h160ToAccountId32(address: string): Uint8Array {
  const bytes = new Uint8Array(32);
  const h160 = ethers.getBytes(address); // 20 bytes
  bytes.set(h160, 0);
  bytes.fill(0xEE, 20);
  return bytes;
}

export async function announceViaPrecompile(
  signer: ethers.Signer,
  ephemeralPubkey64: Uint8Array, // 64 bytes
  viewTag2: Uint8Array,           // 2 bytes
  stealthAccountId32: Uint8Array, // 32 bytes
  metadata: Uint8Array = new Uint8Array(32),
): Promise<string> {
  const precompile = getPrecompile(signer);
  const tx = await precompile.announce(
    ethers.hexlify(ephemeralPubkey64),
    ethers.hexlify(viewTag2),
    ethers.hexlify(stealthAccountId32),
    ethers.hexlify(metadata),
    { gasLimit: 500_000 },
  );
  const receipt = await tx.wait();
  return receipt.hash;
}

export async function registerMetaAddressViaPrecompile(
  signer: ethers.Signer,
  spendingBytes: Uint8Array,  // 33 bytes compressed secp256k1
  viewingBytes: Uint8Array,   // 64 bytes BN254 G1
  schemeId = 2901,
): Promise<string> {
  const precompile = getPrecompile(signer);
  const tx = await precompile.registerMetaAddress(
    ethers.hexlify(spendingBytes),
    ethers.hexlify(viewingBytes),
    schemeId,
    { gasLimit: 500_000 },
  );
  const receipt = await tx.wait();
  return receipt.hash;
}

// ── ABI for ECPDKSAP — pvm-contract-macros, no registry ──────────────────────
export const ABI = [
  "function sendEthViaProxy(address payable stealthAddress, bytes R, bytes viewTag) external payable",
  "function ecpdksapSchemeId() external view returns (uint256)",
  "event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)",
];

// Mutable config — set by App before rendering panels
let _rpcUrl: string = import.meta.env.VITE_RPC_URL ?? (typeof window !== "undefined" ? `${window.location.origin}/eth-rpc` : "http://127.0.0.1:8545");
let _contractAddress = "";
let _providerInstance = new ethers.JsonRpcProvider(_rpcUrl, undefined, { staticNetwork: true });

export function configure(rpcUrl: string, contractAddress: string) {
  if (rpcUrl !== _rpcUrl) {
    _rpcUrl = rpcUrl;
    _providerInstance = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  }
  _contractAddress = contractAddress;
}

// Explicit wrappers — avoids ethers v6 ENS resolution on unknown networks
export const provider = {
  getBalance: (addr: string) => _providerInstance.getBalance(addr),
  getBlockNumber: () => _providerInstance.getBlockNumber(),
};

export function getContract(signerOrProvider?: ethers.Signer | ethers.Provider) {
  if (!_contractAddress.startsWith("0x")) {
    throw new Error("Contract address not set");
  }
  return new ethers.Contract(_contractAddress, ABI, signerOrProvider ?? _providerInstance);
}

export function signerFromPrivKey(privKey: string): ethers.Wallet {
  return new ethers.Wallet(privKey, _providerInstance);
}

export function deriveStealthAddress(spendingPubKey: string): string {
  const [X, Y] = spendingPubKey.split(".");
  const pub =
    "0x" +
    BigInt(X).toString(16).padStart(64, "0") +
    BigInt(Y).toString(16).padStart(64, "0");
  return ethers.computeAddress(pub);
}

export async function connectMetaMask(): Promise<{ signer: ethers.Signer; address: string }> {
  if (!window.ethereum) throw new Error("MetaMask not found. Use private key mode.");
  await (window.ethereum as { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }).request({ method: "eth_requestAccounts" });
  const bp = new ethers.BrowserProvider(window.ethereum as ethers.Eip1193Provider);
  const signer = await bp.getSigner();
  return { signer, address: await signer.getAddress() };
}

declare global {
  interface Window {
    ethereum?: Record<string, unknown> & {
      request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}