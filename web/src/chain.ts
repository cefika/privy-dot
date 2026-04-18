import { ethers } from "ethers";

// ABI for ECPDKSAP — pvm-contract-macros, no registry
export const ABI = [
  "function sendEthViaProxy(address payable stealthAddress, bytes R, bytes viewTag) external payable",
  "function ecpdksapSchemeId() external view returns (uint256)",
  "event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)",
];

// Mutable config — set by App before rendering panels
let _rpcUrl = import.meta.env.VITE_RPC_URL ?? "http://127.0.0.1:8545";
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