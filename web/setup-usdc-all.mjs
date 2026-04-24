#!/usr/bin/env node
/**
 * Creates USDC asset (id=1) on Para 1000 and Para 2000 and mints 1000 USDC
 * to all dev accounts (Alice, Bob, Charlie).
 *
 * Usage:
 *   node setup-usdc-all.mjs
 */

import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";

const ASSET_ID = 1;
const PARA_1000_WS = "ws://127.0.0.1:9944";
const PARA_2000_WS = "ws://127.0.0.1:9935";
const MINT_AMOUNT = 1000n * 1_000_000n; // 1000 USDC (6 decimals)

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function send(tx, signer) {
  return new Promise((resolve, reject) => {
    let unsub;
    tx.signAndSend(signer, result => {
      if (result.status.isInBlock) {
        if (result.dispatchError) {
          unsub?.();
          reject(new Error(result.dispatchError.toString()));
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

async function setupPara(ws, label) {
  console.log(`\n========== ${label} (${ws}) ==========`);
  const api = await ApiPromise.create({ provider: new WsProvider(ws) });

  const keyring = new Keyring({ type: "sr25519" });
  const alice   = keyring.addFromUri("//Alice");
  const bob     = keyring.addFromUri("//Bob");
  const charlie = keyring.addFromUri("//Charlie");

  console.log(`Alice:   ${alice.address}`);
  console.log(`Bob:     ${bob.address}`);
  console.log(`Charlie: ${charlie.address}`);

  // Check/delete existing asset
  const assetInfo = await api.query.assets.asset(ASSET_ID);
  const exists = assetInfo.isSome;
  console.log(`\nAsset ${ASSET_ID} exists: ${exists}`);

  if (exists) {
    const status = assetInfo.unwrap().status.toString();
    console.log(`  status: ${status}`);

    if (status !== "Destroying") {
      console.log("→ startDestroy...");
      await send(api.tx.assets.startDestroy(ASSET_ID), alice);
      await sleep(3000);
    }

    for (let i = 0; i < 10; i++) {
      try {
        await send(api.tx.assets.destroyAccounts(ASSET_ID), alice);
        console.log(`  destroyAccounts OK (${i + 1})`);
      } catch { break; }
      await sleep(2000);
    }

    for (let i = 0; i < 10; i++) {
      try {
        await send(api.tx.assets.destroyApprovals(ASSET_ID), alice);
      } catch { break; }
      await sleep(2000);
    }

    console.log("→ finishDestroy...");
    await send(api.tx.assets.finishDestroy(ASSET_ID), alice);
    await sleep(3000);
  }

  // forceCreate via sudo (is_sufficient=true — stealth addresses can receive without PAS)
  console.log("→ sudo(assets.forceCreate) is_sufficient=true...");
  await send(api.tx.sudo.sudo(
    api.tx.assets.forceCreate(ASSET_ID, alice.address, true, 1)
  ), alice);
  await sleep(2000);

  // setMetadata
  console.log("→ assets.setMetadata...");
  await send(api.tx.assets.setMetadata(ASSET_ID, "USDC", "USDC", 6), alice);
  await sleep(2000);

  // Mint svima po 1000 USDC
  for (const [name, acc] of [["Alice", alice], ["Bob", bob], ["Charlie", charlie]]) {
    console.log(`→ mint 1000 USDC → ${name} (${acc.address})...`);
    await send(api.tx.assets.mint(ASSET_ID, acc.address, MINT_AMOUNT.toString()), alice);
    console.log(`  OK`);
    await sleep(1000);
  }

  const meta = await api.query.assets.metadata(ASSET_ID);
  console.log(`\n✓ ${label} ready: ${meta.symbol.toUtf8()}, decimals=${meta.decimals}`);

  await api.disconnect();
}

async function main() {
  await setupPara(PARA_1000_WS, "Para 1000");
  await setupPara(PARA_2000_WS, "Para 2000");
  console.log("\nGotovo! Alice, Bob i Charlie imaju po 1000 USDC na oba parachain-a.");
}

main().catch(e => {
  console.error("ERROR:", e.message);
  process.exit(1);
});