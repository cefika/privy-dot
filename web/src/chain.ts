import { ethers } from "ethers";

// ── Stealth Precompile ────────────────────────────────────────────────────────
// Registrovan na adresi AddressMatcher::Fixed(0x1000) → H160 bytes[16..20] = 0x10000000
export const PRECOMPILE_ADDR = "0x0000000000000000000000000000000010000000";

export const PRECOMPILE_ABI = [
  "function registerMetaAddress(bytes spendingPubkey, bytes viewingPubkey, uint32 schemeId) external",
  "function announce(bytes ephemeralPubkey, bytes2 viewTag, bytes32 stealthAddress, bytes32 metadata) external",
  "function sendAndAnnounce(bytes32 stealthAddress, bytes ephemeralPubkey, bytes2 viewTag, bytes32 metadata) external payable",
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

// Pošalji PAS na AccountId32 stealth adresu + announce u jednoj transakciji
export async function sendAndAnnounceViaPrecompile(
  signer: ethers.Signer,
  stealthAccountId32: Uint8Array, // 32 bytes AccountId32
  amountEther: string,             // npr. "1.5"
  ephemeralPubkey64: Uint8Array,  // 64 bytes
  viewTag2: Uint8Array,            // 2 bytes
  metadata: Uint8Array = new Uint8Array(32),
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
    },
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

const _rpcUrl: string = import.meta.env.VITE_RPC_URL ?? (typeof window !== "undefined" ? `${window.location.origin}/eth-rpc` : "http://127.0.0.1:8545");
const _providerInstance = new ethers.JsonRpcProvider(_rpcUrl, undefined, { staticNetwork: true });

// Explicit wrappers — avoids ethers v6 ENS resolution on unknown networks
export const provider = {
  getBalance: (addr: string) => _providerInstance.getBalance(addr),
  getBlockNumber: () => _providerInstance.getBlockNumber(),
};

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

// Chain ID lokalnog zombieneta (eth_chainId vratio 0x190f1b45 = 420420421)
// Za produkciju (Paseo testnet) override-uj VITE_CHAIN_ID u .env
const EXPECTED_CHAIN_ID: number = parseInt(import.meta.env.VITE_CHAIN_ID ?? "420420421", 10);

export async function connectMetaMask(): Promise<{ signer: ethers.Signer; address: string }> {
  if (!window.ethereum) throw new Error("MetaMask not found. Use private key mode.");
  const eth = window.ethereum as { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };

  await eth.request({ method: "eth_requestAccounts" });

  // Provjeri da li je MetaMask na pravoj mreži
  const chainHex = await eth.request({ method: "eth_chainId", params: [] }) as string;
  const currentChain = parseInt(chainHex, 16);

  if (currentChain !== EXPECTED_CHAIN_ID) {
    try {
      // Pokušaj switch na lokalnu mrežu
      await eth.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + EXPECTED_CHAIN_ID.toString(16) }],
      });
    } catch (switchErr: unknown) {
      // Chain nije dodat u MetaMask — dodaj ga automatski
      const code = (switchErr as { code?: number })?.code;
      if (code === 4902) {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: "0x" + EXPECTED_CHAIN_ID.toString(16),
            chainName: "Privy Localnet",
            nativeCurrency: { name: "PAS", symbol: "PAS", decimals: 18 },
            rpcUrls: [_rpcUrl.startsWith("/") ? window.location.origin + _rpcUrl : _rpcUrl],
          }],
        });
      } else {
        throw new Error(
          `Wrong network. Please switch MetaMask to chain ID ${EXPECTED_CHAIN_ID} (Privy Localnet).`
        );
      }
    }
  }

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