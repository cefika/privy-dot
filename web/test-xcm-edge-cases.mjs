#!/usr/bin/env node
/**
 * Edge case testovi za stealth pallet (Para 2000)
 *
 * 1. Pogrešan potpis → InvalidProof
 * 2. Sponsor bez para u pool-u → InsufficientSponsorFunds
 * 3. Prazan stealth balans → ZeroAmount
 * 4. Pogrešna destination u poruci → InvalidProof
 * 5. Delimičan iznos (partial withdraw) → tačan iznos prebačen
 * 6. Replay isti potpis → ZeroAmount (stealth je prazan)
 *
 * Pokretanje:
 *   node test-xcm-edge-cases.mjs
 */

import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";
import { blake2AsU8a, decodeAddress } from "@polkadot/util-crypto";
import { u8aToHex, hexToU8a } from "@polkadot/util";

const PARA_2000_WS   = "ws://127.0.0.1:9935";
const PARA_1000_WS   = "ws://127.0.0.1:9944";
const WITHDRAWAL_FEE = 10_000_000_000n;
const FUND_AMOUNT    = 20_000_000_000_000n; // 20 PAS
const SPONSOR_DEPO   = 5_000_000_000_000n;  // 5 PAS

const SEEDS = {
  main:    "0x" + "aa".repeat(32),
  wrong:   "0x" + "bb".repeat(32),
  partial: "0x" + "cc".repeat(32),
  replay:  "0x" + "dd".repeat(32),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function log(test, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${test.padEnd(10)}] ${msg}`);
}
function pas(planck) { return (Number(planck) / 1e12).toFixed(4) + " PAS"; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function submitTx(tx, signer, api) {
  return new Promise((resolve, reject) => {
    let unsub;
    tx.signAndSend(signer, result => {
      if (result.status.isInBlock) {
        if (result.dispatchError) {
          unsub?.();
          let errMsg;
          if (result.dispatchError.isModule && api) {
            try {
              const decoded = api.registry.findMetaError(result.dispatchError.asModule);
              errMsg = decoded.name;
            } catch {
              errMsg = result.dispatchError.toString();
            }
          } else {
            errMsg = result.dispatchError.toString();
          }
          reject(new Error(errMsg));
        } else {
          unsub?.();
          resolve(result.status.asInBlock.toHex());
        }
      } else if (result.status.isDropped || result.status.isInvalid) {
        unsub?.(); reject(new Error("Dropped/Invalid"));
      }
    }).then(u => { unsub = u; }).catch(reject);
  });
}

async function getBalance(api, address) {
  const acc = await api.query.system.account(address);
  return acc.data.free.toBigInt();
}

async function fund(api, signer, address, amount) {
  await submitTx(api.tx.balances.transferAllowDeath(address, amount.toString()), signer, api);
}

function encodeOptionU128(val) {
  if (val === null || val === undefined) return new Uint8Array([0x00]);
  const b = new Uint8Array(17); b[0] = 0x01;
  let v = BigInt(val);
  for (let i = 0; i < 16; i++) { b[1 + i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}

function encodeOptionU32(val) {
  if (val === null || val === undefined) return new Uint8Array([0x00]);
  const b = new Uint8Array(5); b[0] = 0x01;
  new DataView(b.buffer).setUint32(1, val, true);
  return b;
}

function buildMsg(stealthHex, destBytes, assetId, amount) {
  const prefix  = new TextEncoder().encode("PrivyDot::withdraw:v2");
  const stealth = hexToU8a(stealthHex);
  const asset   = encodeOptionU32(assetId);
  const amountB = encodeOptionU128(amount);
  const msg = new Uint8Array(prefix.length + 32 + 32 + asset.length + amountB.length);
  let off = 0;
  msg.set(prefix, off); off += prefix.length;
  msg.set(stealth, off); off += 32;
  msg.set(destBytes, off); off += 32;
  msg.set(asset, off); off += asset.length;
  msg.set(amountB, off);
  return msg;
}

function makeStealth(ecKr, seed) {
  const pair = ecKr.addFromSeed(hexToU8a(seed));
  const address = u8aToHex(blake2AsU8a(pair.publicKey, 256));
  return { pair, address, bytes: Array.from(hexToU8a(address)) };
}

async function assertFails(label, fn, expectedError, api) {
  try {
    await fn(api);
    log(label, `✗ FAIL — trebalo je da baci "${expectedError}" ali je prošlo`);
    failed++;
  } catch (e) {
    if (e.message.includes(expectedError)) {
      log(label, `✓ PASS — ${expectedError} ✓`);
      passed++;
    } else {
      log(label, `✗ FAIL — očekivano "${expectedError}", dobijeno: ${e.message}`);
      failed++;
    }
  }
}

async function assertOk(label, fn, api) {
  try {
    const hash = await fn(api);
    log(label, `✓ PASS — block: ${hash.slice(0, 16)}...`);
    passed++;
    return hash;
  } catch (e) {
    log(label, `✗ FAIL — ${e.message}`);
    failed++;
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   Stealth Edge Case Tests                    ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  const api2 = await ApiPromise.create({ provider: new WsProvider(PARA_2000_WS) });
  const api1 = await ApiPromise.create({ provider: new WsProvider(PARA_1000_WS) });

  const srKr = new Keyring({ type: "sr25519" });
  const ecKr = new Keyring({ type: "ecdsa" });

  const alice = srKr.addFromUri("//Alice");
  const bob   = srKr.addFromUri("//Bob");

  const main    = makeStealth(ecKr, SEEDS.main);
  const wrong   = makeStealth(ecKr, SEEDS.wrong);
  const partial = makeStealth(ecKr, SEEDS.partial);
  const replay  = makeStealth(ecKr, SEEDS.replay);

  const aliceDest = decodeAddress(alice.address);
  const bobDest   = decodeAddress(bob.address);

  log("SETUP", `Alice:   ${alice.address}`);
  log("SETUP", `Bob:     ${bob.address}`);
  log("SETUP", `main    stealth: ${main.address}`);
  log("SETUP", `partial stealth: ${partial.address}`);
  log("SETUP", `replay  stealth: ${replay.address}`);

  // Osiguraj gas pool za Alice
  const poolBal = (await api2.query.stealthAddresses.gasSponsorPool(alice.address)).toBigInt();
  if (poolBal < WITHDRAWAL_FEE * 10n) {
    log("SETUP", `Deponujem ${pas(SPONSOR_DEPO)} u gas pool...`);
    await submitTx(api2.tx.stealthAddresses.sponsorGas(SPONSOR_DEPO.toString()), alice, api2);
  }
  log("SETUP", `Gas pool: ${pas((await api2.query.stealthAddresses.gasSponsorPool(alice.address)).toBigInt())}\n`);

  // ── Test 1: Pogrešan potpis → InvalidProof ─────────────────────────────────
  console.log("── Test 1: Pogrešan potpis ──────────────────────────────────");
  await fund(api2, alice, main.address, FUND_AMOUNT);
  await assertFails("1-BadSig", async (api) => {
    const msg    = buildMsg(main.address, aliceDest, null, null);
    const badSig = wrong.pair.sign(msg); // pogrešan keypair potpisuje
    return submitTx(
      api.tx.stealthAddresses.withdrawFromStealth(main.bytes, alice.address, Array.from(badSig), alice.address, null, null),
      alice, api
    );
  }, "InvalidProof", api2);

  // ── Test 2: Sponsor bez sredstava → InsufficientSponsorFunds ──────────────
  console.log("\n── Test 2: Sponsor bez sredstava ────────────────────────────");
  await assertFails("2-NoSponsor", async (api) => {
    const msg = buildMsg(main.address, aliceDest, null, null);
    const sig = main.pair.sign(msg);
    return submitTx(
      api.tx.stealthAddresses.withdrawFromStealth(main.bytes, alice.address, Array.from(sig), bob.address, null, null), // bob nema pool
      alice, api
    );
  }, "InsufficientSponsorFunds", api2);

  // ── Test 3: Prazna stealth adresa → ZeroAmount ────────────────────────────
  console.log("\n── Test 3: Prazna stealth adresa ────────────────────────────");
  await assertFails("3-ZeroBal", async (api) => {
    const msg = buildMsg(wrong.address, aliceDest, null, null);
    const sig = wrong.pair.sign(msg);
    return submitTx(
      api.tx.stealthAddresses.withdrawFromStealth(wrong.bytes, alice.address, Array.from(sig), alice.address, null, null),
      alice, api
    );
  }, "ZeroAmount", api2);

  // ── Test 4: Pogrešna destination u poruci → InvalidProof ──────────────────
  console.log("\n── Test 4: Pogrešna destination u poruci ────────────────────");
  await fund(api2, alice, partial.address, FUND_AMOUNT);
  await assertFails("4-WrongDest", async (api) => {
    const msg = buildMsg(partial.address, bobDest, null, null); // potpisan za Bob-a
    const sig = partial.pair.sign(msg);
    return submitTx(
      api.tx.stealthAddresses.withdrawFromStealth(partial.bytes, alice.address, Array.from(sig), alice.address, null, null), // šalje Alice-i
      alice, api
    );
  }, "InvalidProof", api2);

  // ── Test 5: Delimičan iznos (partial withdraw) ────────────────────────────
  console.log("\n── Test 5: Delimičan iznos ──────────────────────────────────");
  const PARTIAL = 5_000_000_000_000n; // 5 PAS od 20 PAS
  const partialBefore = await getBalance(api2, partial.address);
  log("5-Partial", `Stealth balans pre: ${pas(partialBefore)}`);
  log("5-Partial", `Šaljem delimičan iznos: ${pas(PARTIAL)}`);

  await assertOk("5-Partial", async (api) => {
    const msg = buildMsg(partial.address, aliceDest, null, PARTIAL);
    const sig = partial.pair.sign(msg);
    return submitTx(
      api.tx.stealthAddresses.withdrawFromStealth(partial.bytes, alice.address, Array.from(sig), alice.address, null, PARTIAL.toString()),
      alice, api
    );
  }, api2);

  const partialAfter = await getBalance(api2, partial.address);
  log("5-Partial", `Stealth balans posle: ${pas(partialAfter)} (očekivano ~${pas(partialBefore - PARTIAL)})`);
  if (partialAfter > 0n && partialAfter < partialBefore) {
    log("5-Partial", `✓ Parcijalan withdrawal ispravan`); passed++;
  } else {
    log("5-Partial", `✗ Neočekivan balans`); failed++;
  }

  // ── Test 6: Replay attack → ZeroAmount ────────────────────────────────────
  console.log("\n── Test 6: Replay attack ────────────────────────────────────");
  await fund(api2, alice, replay.address, FUND_AMOUNT);

  const replayMsg = buildMsg(replay.address, aliceDest, null, null);
  const replaySig = replay.pair.sign(replayMsg);

  log("6-Replay", "Prvi withdrawal (treba da prođe)...");
  await assertOk("6-Replay-1", async (api) => submitTx(
    api.tx.stealthAddresses.withdrawFromStealth(replay.bytes, alice.address, Array.from(replaySig), alice.address, null, null),
    alice, api
  ), api2);

  log("6-Replay", "Drugi isti withdrawal (treba da pada sa ZeroAmount)...");
  await assertFails("6-Replay-2", async (api) => submitTx(
    api.tx.stealthAddresses.withdrawFromStealth(replay.bytes, alice.address, Array.from(replaySig), alice.address, null, null),
    alice, api
  ), "ZeroAmount", api2);

  // ── Rezultati ─────────────────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log(`║   Rezultati: ${String(passed).padEnd(2)} prošlo, ${String(failed).padEnd(2)} palo          ║`);
  console.log(failed === 0
    ? "║   Svi testovi PROŠLI ✓                       ║"
    : "║   Neki testovi PALI ✗                        ║");
  console.log("╚══════════════════════════════════════════════╝");

  await api1.disconnect();
  await api2.disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error("\n✗ Neočekivana greška:", e.message);
  process.exit(1);
});