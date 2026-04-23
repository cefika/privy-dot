#!/usr/bin/env node
/**
 * Integration test: Stealth XCM PAS transfer
 * Para 1000 → Para 2000
 *
 * Flow:
 *  1. Alice sends PAS via sendStealthXcm (Para 1000 → Para 2000)
 *  2. Check announcement on Para 1000
 *  3. Wait for funds to arrive at the stealth address (Para 2000)
 *  4. Alice deposits gas into sponsor pool (Para 2000)
 *  5. Stealth keypair signs withdrawal message
 *  6. withdrawFromStealth transfers funds to Alice (Para 2000)
 *  7. Print all balances before/after
 *
 * Usage:
 *   node test-xcm-flow.mjs
 */

import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";
import { blake2AsU8a, decodeAddress } from "@polkadot/util-crypto";
import { u8aToHex, hexToU8a } from "@polkadot/util";

// ── Config ────────────────────────────────────────────────────────────────────

const PARA_1000_WS  = "ws://127.0.0.1:9944";
const PARA_2000_WS  = "ws://127.0.0.1:9935";
const SEND_AMOUNT   = 5_000_000_000_000n;  
const SPONSOR_DEPO  = 1_000_000_000_000n;  
const WITHDRAWAL_FEE = 10_000_000_000n;    
const XCM_TIMEOUT_MS = 90_000;             

const STEALTH_SEED = "0x" + "cd".repeat(32);

// ── Helpers ───────────────────────────────────────────────────────────────────

const PAD = 8;
function log(step, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${step.padEnd(PAD)}] ${msg}`);
}
function pas(planck) {
  return (Number(planck) / 1e12).toFixed(4) + " PAS";
}
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function submitTx(tx, signer) {
  return new Promise((resolve, reject) => {
    let unsub;
    tx.signAndSend(signer, result => {
      if (result.status.isInBlock) {
        if (result.dispatchError) {
          unsub?.();
          reject(new Error(`DispatchError: ${result.dispatchError.toString()}`));
        } else {
          unsub?.();
          resolve(result.status.asInBlock.toHex());
        }
      } else if (result.status.isDropped || result.status.isInvalid) {
        unsub?.();
        reject(new Error("Transaction dropped or invalid"));
      }
    }).then(u => { unsub = u; }).catch(reject);
  });
}

async function getBalance(api, address) {
  const acc = await api.query.system.account(address);
  return acc.data.free.toBigInt();
}

async function pollBalance(api, address, minBalance, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bal = await getBalance(api, address);
    if (bal >= minBalance) return bal;
    await sleep(3000);
  }
  throw new Error(`Timeout: balance on ${address} never reached ${pas(minBalance)}`);
}

function encodeOptionU128(val) {
  if (val === null || val === undefined) return new Uint8Array([0x00]);
  const bytes = new Uint8Array(17);
  bytes[0] = 0x01;
  let v = val;
  for (let i = 0; i < 16; i++) { bytes[1 + i] = Number(v & 0xffn); v >>= 8n; }
  return bytes;
}

function encodeOptionU32(val) {
  if (val === null || val === undefined) return new Uint8Array([0x00]);
  const bytes = new Uint8Array(5);
  bytes[0] = 0x01;
  new DataView(bytes.buffer).setUint32(1, val, true);
  return bytes;
}

function buildWithdrawalMessage(stealthHex, destBytes, assetId, amount) {
  const prefix   = new TextEncoder().encode("PrivyDot::withdraw:v2");
  const stealth  = hexToU8a(stealthHex);
  const asset    = encodeOptionU32(assetId);
  const amountB  = encodeOptionU128(amount);

  const msg = new Uint8Array(prefix.length + 32 + 32 + asset.length + amountB.length);
  let off = 0;
  msg.set(prefix,  off); off += prefix.length;
  msg.set(stealth, off); off += 32;
  msg.set(destBytes, off); off += 32;
  msg.set(asset,   off); off += asset.length;
  msg.set(amountB, off);
  return msg;
}


async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   Stealth XCM Integration Test (PAS)         ║");
  console.log("║   Para 1000 → Para 2000                      ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  log("CONNECT", `Para 1000: ${PARA_1000_WS}`);
  const api1 = await ApiPromise.create({ provider: new WsProvider(PARA_1000_WS) });
  log("CONNECT", `Para 2000: ${PARA_2000_WS}`);
  const api2 = await ApiPromise.create({ provider: new WsProvider(PARA_2000_WS) });
  log("CONNECT", "Both parachains available ✓");

  const srKr = new Keyring({ type: "sr25519" });
  const ecKr = new Keyring({ type: "ecdsa" });

  const alice = srKr.addFromUri("//Alice");
  log("SETUP", `Alice (sr25519): ${alice.address}`);

  const stealthPair    = ecKr.addFromSeed(hexToU8a(STEALTH_SEED));
  const stealthAddress = u8aToHex(blake2AsU8a(stealthPair.publicKey, 256)); // 33-byte compressed → blake2b
  log("SETUP", `Stealth seed: ${STEALTH_SEED.slice(0, 10)}...`);
  log("SETUP", `Stealth address (Para 2000): ${stealthAddress}`);

  console.log("");
  log("BEFORE", "Balances before test:");
  const aliceBal1  = await getBalance(api1, alice.address);
  const aliceBal2  = await getBalance(api2, alice.address);
  const stealthBal = await getBalance(api2, stealthAddress);
  const sponsorBal = (await api2.query.stealthAddresses.gasSponsorPool(alice.address)).toBigInt();
  log("BEFORE", `  Alice    Para 1000: ${pas(aliceBal1)}`);
  log("BEFORE", `  Alice    Para 2000: ${pas(aliceBal2)}`);
  log("BEFORE", `  Stealth  Para 2000: ${pas(stealthBal)}`);
  log("BEFORE", `  Sponsor  Para 2000: ${pas(sponsorBal)}`);
  
  console.log("");
  log("STEP 1", `Sending ${pas(SEND_AMOUNT)} via XCM (Para 1000 → Para 2000)...`);
  log("STEP 1", `Destination stealth: ${stealthAddress}`);

  const ephemeralPubkey = new Uint8Array(64).fill(0x02); // dummy (in production: generated by WASM)
  const viewTag         = new Uint8Array([0xcd, 0x00]);
  const metadata        = new Uint8Array(32);
  const stealthBytes    = Array.from(hexToU8a(stealthAddress));

  const xcmBlock = await submitTx(
    api1.tx.stealthAddresses.sendStealthXcm(
      2000,
      stealthBytes,
      SEND_AMOUNT.toString(),
      Array.from(ephemeralPubkey),
      Array.from(viewTag),
      Array.from(metadata)
    ),
    alice
  );
  log("STEP 1", `✓ XCM extrinsic in block: ${xcmBlock}`);

  await sleep(2000);
  log("STEP 2", "Checking announcement on Para 1000...");
  const entries = await api1.query.stealthAddresses.announcements.entries();
  log("STEP 2", `✓ Found ${entries.length} announcement(s):`);
  for (const [key, rawVal] of entries) {
    const nonce = key.args[0].toNumber();
    const ann   = rawVal.isSome ? rawVal.unwrap() : rawVal;
    const json  = ann.toJSON?.() ?? ann;
    log("STEP 2", `  nonce=${nonce}  stealth=${JSON.stringify(json.stealthAddress ?? json.stealth_address ?? "?").slice(0, 20)}...`);
  }

  console.log("");
  log("STEP 3", `Waiting for XCM delivery on Para 2000 (max ${XCM_TIMEOUT_MS / 1000}s)...`);
  const stealthAfterXcm = await pollBalance(api2, stealthAddress, 1n, XCM_TIMEOUT_MS);
  log("STEP 3", `✓ Stealth balance on Para 2000: ${pas(stealthAfterXcm)}`);
  const xcmFee = SEND_AMOUNT - stealthAfterXcm;
  log("STEP 3", `  XCM fee deducted: ${pas(xcmFee)}`);
  
  console.log("");
  log("STEP 4", "Checking Alice's gas sponsor pool on Para 2000...");
  const poolBal = (await api2.query.stealthAddresses.gasSponsorPool(alice.address)).toBigInt();
  if (poolBal < WITHDRAWAL_FEE) {
    log("STEP 4", `Pool empty (${pas(poolBal)}), depositing ${pas(SPONSOR_DEPO)}...`);
    const sponsorBlock = await submitTx(
      api2.tx.stealthAddresses.sponsorGas(SPONSOR_DEPO.toString()),
      alice
    );
    log("STEP 4", `✓ Sponsor gas deposited in block: ${sponsorBlock}`);
  } else {
    log("STEP 4", `✓ Pool already has ${pas(poolBal)}, skipping deposit`);
  }

  console.log("");
  log("STEP 5", "Building withdrawal message v2 and signing with stealth ECDSA key...");

  const destBytes = decodeAddress(alice.address); // 32-byte AccountId32
  const msg       = buildWithdrawalMessage(stealthAddress, destBytes, null, null);
  const sig       = stealthPair.sign(msg); // blake2_256 internally, 65 bytes

  log("STEP 5", `  Stealth:     ${stealthAddress}`);
  log("STEP 5", `  Destination: ${alice.address} (Alice)`);
  log("STEP 5", `  Sponsor:     ${alice.address} (Alice)`);
  log("STEP 5", `  Asset:       None (native PAS)`);
  log("STEP 5", `  Amount:      None (full balance)`);
  log("STEP 5", `  Sig:         ${u8aToHex(sig).slice(0, 20)}...`);

  const aliceBal2Before = await getBalance(api2, alice.address);

  log("STEP 5", "Sending withdrawFromStealth extrinsic (relayer = Alice)...");
  const withdrawBlock = await submitTx(
    api2.tx.stealthAddresses.withdrawFromStealth(
      stealthBytes,           // stealth: [u8; 32]
      alice.address,          // destination
      Array.from(sig),        // signature: [u8; 65]
      alice.address,          // sponsor
      null,                   // asset_id: Option<u32> = None
      null                    // amount: Option<u128> = None
    ),
    alice
  );
  log("STEP 5", `✓ Withdrawal in block: ${withdrawBlock}`);

  console.log("");
  log("AFTER", "Balances after test:");
  const stealthFinal  = await getBalance(api2, stealthAddress);
  const aliceBal2End  = await getBalance(api2, alice.address);
  const sponsorFinal  = (await api2.query.stealthAddresses.gasSponsorPool(alice.address)).toBigInt();

  log("AFTER", `  Stealth  Para 2000:  ${pas(stealthFinal)}  (expected: 0)`);
  log("AFTER", `  Alice    Para 2000:  ${pas(aliceBal2End)}`);
  log("AFTER", `  Sponsor  Para 2000:  ${pas(sponsorFinal)}  (reduced by ${pas(WITHDRAWAL_FEE)})`);

  const aliceGained = aliceBal2End - aliceBal2Before;
  log("AFTER", `  Alice received: ${pas(aliceGained)} (stealth balance - withdrawal fee)`);
  
  console.log("");
  const errors = [];
  if (stealthFinal !== 0n) errors.push(`Stealth not empty: ${pas(stealthFinal)}`);
  if (aliceGained <= 0n)   errors.push(`Alice did not receive funds`);

  if (errors.length === 0) {
    console.log("╔══════════════════════════════════╗");
    console.log("║   Test PASSED ✓                  ║");
    console.log("╚══════════════════════════════════╝");
  } else {
    console.log("╔══════════════════════════════════╗");
    console.log("║   Test PAO ✗                     ║");
    console.log("╚══════════════════════════════════╝");
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exitCode = 1;
  }

  await api1.disconnect();
  await api2.disconnect();
}

main().catch(e => {
  console.error("\n╔══════════════════════════════════╗");
  console.error("║   Test PAO ✗ (exception)         ║");
  console.error("╚══════════════════════════════════╝");
  console.error(e.message);
  process.exit(1);
});