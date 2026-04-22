#!/usr/bin/env node
/**
 * Kreira USDC asset (id=1) na Para 2000 sa is_sufficient=true.
 *
 * is_sufficient=true znaci da account moze da primi USDC cak i ako nema
 * ni jedan PAS — sto je kljucno za stealth adrese koje su uvek nove/prazne.
 *
 * Ako asset vec postoji, skripta ga najpre destroy-uje pa recreate-uje.
 *
 * Koriscenje:
 *   node setup-usdc.mjs [--para2000 ws://127.0.0.1:9935] [--mint <adresa> <iznos_usdc>]
 *
 * Primeri:
 *   node setup-usdc.mjs
 *   node setup-usdc.mjs --mint 5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY 5
 */

import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";

const ASSET_ID = 1;
const PARA_2000_WS = process.env.PARA2000_WS ?? "ws://127.0.0.1:9935";

// Parse --mint <adresa> <iznos>
let mintTo = null;
let mintAmount = 0n;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--mint" && args[i + 1] && args[i + 2]) {
    mintTo = args[i + 1];
    mintAmount = BigInt(Math.round(parseFloat(args[i + 2]) * 1_000_000)); // 6 decimala
    i += 2;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Potpisuje i šalje tx, čeka InBlock
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

async function main() {
  console.log(`Connecting to Para 2000: ${PARA_2000_WS}`);
  const api = await ApiPromise.create({ provider: new WsProvider(PARA_2000_WS) });

  const keyring = new Keyring({ type: "sr25519" });
  const alice = keyring.addFromUri("//Alice");

  console.log(`Alice address: ${alice.address}`);

  // Proveri da li asset vec postoji
  const assetInfo = await api.query.assets.asset(ASSET_ID);
  const exists = assetInfo.isSome;
  console.log(`Asset ${ASSET_ID} postoji: ${exists}`);

  if (exists) {
    const status = assetInfo.unwrap().status.toString();
    console.log(`Asset status: ${status}`);

    if (status !== "Destroying") {
      console.log("→ startDestroy...");
      await send(api.tx.assets.startDestroy(ASSET_ID), alice);
      console.log("  OK");
      await sleep(3000);
    }

    console.log("→ destroyAccounts...");
    // Pozivamo dok ne izbrisemo sve accounte (max 10 pokusaja)
    for (let i = 0; i < 10; i++) {
      try {
        await send(api.tx.assets.destroyAccounts(ASSET_ID), alice);
        console.log(`  destroyAccounts OK (pokusaj ${i + 1})`);
      } catch (e) {
        // Ako nema vise accounta, pall ce baciti gresku — nastavljamo
        console.log(`  destroyAccounts: ${e.message}`);
        break;
      }
      await sleep(2000);
    }

    console.log("→ destroyApprovals...");
    for (let i = 0; i < 10; i++) {
      try {
        await send(api.tx.assets.destroyApprovals(ASSET_ID), alice);
        console.log(`  destroyApprovals OK (pokusaj ${i + 1})`);
      } catch (e) {
        console.log(`  destroyApprovals: ${e.message}`);
        break;
      }
      await sleep(2000);
    }

    console.log("→ finishDestroy...");
    await send(api.tx.assets.finishDestroy(ASSET_ID), alice);
    console.log("  OK");
    await sleep(3000);
  }

  // forceCreate zahteva Root origin → koristimo sudo
  console.log("→ sudo(assets.forceCreate) sa is_sufficient=true...");
  const forceCreateCall = api.tx.assets.forceCreate(
    ASSET_ID,
    alice.address,  // owner
    true,           // is_sufficient — kljucno! svaka adresa moze primiti USDC bez PAS-a
    1               // min_balance
  );
  await send(api.tx.sudo.sudo(forceCreateCall), alice);
  console.log("  OK");
  await sleep(2000);

  // setMetadata
  console.log("→ assets.setMetadata...");
  await send(api.tx.assets.setMetadata(ASSET_ID, "USDC", "USDC", 6), alice);
  console.log("  OK");
  await sleep(2000);

  // Opciono: mint
  if (mintTo) {
    console.log(`→ assets.mint → ${mintTo} (${mintAmount} planck = ${Number(mintAmount) / 1_000_000} USDC)...`);
    await send(api.tx.assets.mint(ASSET_ID, mintTo, mintAmount.toString()), alice);
    console.log("  OK");
  }

  const meta = await api.query.assets.metadata(ASSET_ID);
  const info2 = await api.query.assets.asset(ASSET_ID);
  console.log(`\nAsset ${ASSET_ID} spreman:`);
  console.log(`  name:         ${meta.name.toUtf8()}`);
  console.log(`  symbol:       ${meta.symbol.toUtf8()}`);
  console.log(`  decimals:     ${meta.decimals}`);
  console.log(`  is_sufficient: ${info2.unwrap().isSufficient}`);

  await api.disconnect();
  console.log("\nGotovo!");
}

main().catch(e => {
  console.error("GREŠKA:", e.message);
  process.exit(1);
});