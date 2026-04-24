/**
 * Test script for StealthPrecompile at address 0x0000000000000000000000000000000010000000
 *
 * Usage:
 *   node test-precompile.mjs
 *
 * Prerequisites:
 *   - Local node running with the new runtime (which includes the precompile)
 *   - EVM RPC available at http://127.0.0.1:8545
 *   - Substrate WS available at ws://127.0.0.1:9944
 */

import { ethers } from "ethers";
import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";

// ── Config ────────────────────────────────────────────────────────────────────

const PRECOMPILE_ADDR = "0x0000000000000000000000000000000010000000";

const EVM_RPC  = "http://127.0.0.1:8545";
const SUB_WS   = "ws://127.0.0.1:9944";

const ALICE_ETH_PRIVKEY =
  "0xe5be9a5092b81bca64be81d212e7f2f9eba183bb7a90954f7b76361f6edb5c0a";

const ABI = [
  "function registerMetaAddress(bytes spendingPubkey, bytes viewingPubkey, uint32 schemeId) external",
  "function announce(bytes ephemeralPubkey, bytes2 viewTag, bytes32 stealthAddress, bytes32 metadata) external",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function hex(bytes) {
  return "0x" + Buffer.from(bytes).toString("hex");
}

function randomBytes(n) {
  const buf = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== StealthPrecompile test ===\n");

  // 1. EVM provider + wallet
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const wallet   = new ethers.Wallet(ALICE_ETH_PRIVKEY, provider);
  console.log("EVM wallet:", wallet.address);

  // 2. Substrate API
  const api = await ApiPromise.create({ provider: new WsProvider(SUB_WS) });
  const keyring   = new Keyring({ type: "sr25519" });
  const alicePair = keyring.addFromUri("//Alice");
  console.log("Substrate Alice:", alicePair.address);
  
  // AccountId32Mapper: H160 → H160 ++ [0xEE; 12]  (pallet-revive fallback mapping)
  const evmAccountId = "0x" + wallet.address.slice(2).toLowerCase() + "ee".repeat(12);

  let balance = await provider.getBalance(wallet.address);
  console.log("EVM balance:", ethers.formatEther(balance), "ETH");

  if (balance === 0n) {
    console.log("Funding EVM address from Substrate Alice...");
    // 10 DOT = 10 * 10^10 planck (decimals=10 na Substrate strani)
    const amount = 10n * 10n ** 10n;
    await new Promise((resolve, reject) => {
      api.tx.balances.transferKeepAlive(evmAccountId, amount)
        .signAndSend(alicePair, ({ status, dispatchError }) => {
          if (dispatchError) reject(new Error(dispatchError.toString()));
          if (status.isInBlock) { console.log("Funding in block:", status.asInBlock.toString()); resolve(); }
        }).catch(reject);
    });
    await new Promise(r => setTimeout(r, 4000));
    balance = await provider.getBalance(wallet.address);
    console.log("EVM balance after funding:", ethers.formatEther(balance), "ETH");
  }

  if (balance === 0n) {
    console.error("❌ Funding failed");
    process.exit(1);
  }

  // ── Test 1: registerMetaAddress ───────────────────────────────────────────

  console.log("\n--- Test 1: registerMetaAddress ---");

  // Dummy 33-byte spending pubkey (0x02 prefix = compressed secp256k1)
  const spendingPubkey = new Uint8Array(33);
  spendingPubkey[0] = 0x02;
  spendingPubkey[1] = 0xAB;

  // Dummy 64-byte viewing pubkey (BN254 G1)
  const viewingPubkey = new Uint8Array(64);
  viewingPubkey[0] = 0x01;

  const precompile = new ethers.Contract(PRECOMPILE_ADDR, ABI, wallet);

  try {
    console.log("Sending registerMetaAddress transaction...");
    const tx = await precompile.registerMetaAddress(
      hex(spendingPubkey),
      hex(viewingPubkey),
      2901,
      { gasLimit: 500_000 }
    );
    console.log("TX hash:", tx.hash);
    const receipt = await tx.wait();
    console.log("Included in block:", receipt.blockNumber);
    console.log("Gas used:", receipt.gasUsed.toString());

    // Check Substrate storage — Alice's EVM address maps to AccountId32
    // AccountId32Mapper: H160 → H160 ++ [0xEE; 12]
    const aliceEvm   = wallet.address.toLowerCase();
    const aliceSubId = "0x" + aliceEvm.slice(2) + "ee".repeat(12);
    console.log("\nChecking Substrate storage...");
    console.log("AccountId32 (EVM mapped):", aliceSubId);

    const stored = await api.query.stealthAddresses.stealthMetaAddressRegistry(aliceSubId);
    if (stored.isSome) {
      const meta = stored.unwrap();
      console.log("✅ StorageMap updated!");
      console.log("  scheme_id:", meta.schemeId.toNumber());
    } else {
      console.log("❌ Storage not updated — precompile may not be registered or origin mapping is incorrect");
    }

  } catch (err) {
    console.error("❌ Error:", err.message ?? err);
  }

  // ── Test 2: announce ──────────────────────────────────────────────────────

  console.log("\n--- Test 2: announce ---");

  const ephemeralPubkey = randomBytes(64);
  const viewTag         = new Uint8Array([0xAB, 0xCD]);
  const stealthAddress  = randomBytes(32);
  const metadata        = new Uint8Array(32);

  try {
    console.log("Sending announce transaction...");
    const tx = await precompile.announce(
      hex(ephemeralPubkey),
      hex(viewTag),
      hex(stealthAddress),
      hex(metadata),
      { gasLimit: 500_000 }
    );
    console.log("TX hash:", tx.hash);
    const receipt = await tx.wait();
    console.log("Included in block:", receipt.blockNumber);

    // Check storage — nonce is 0 for the first announcement
    const ann = await api.query.stealthAddresses.announcements(0);
    if (ann.isSome) {
      console.log("✅ Announcement written at nonce 0!");
    } else {
      console.log("❌ Announcement not found in storage");
    }

  } catch (err) {
    console.error("❌ Error:", err.message ?? err);
  }

  await api.disconnect();
  console.log("\n=== Finished ===");
}

main().catch(console.error);