#!/usr/bin/env node
/**
 * Upgraduje runtime na running zombienet chain.
 * Koristi sudo.sudo(system.setCodeWithoutChecks(wasm)).
 *
 * Korišćenje:
 *   node runtime-upgrade.mjs [--wasm <path>] [--ws <url>]
 *
 * Default WASM: ../../target/release/wbuild/stack-template-runtime/stack_template_runtime.compact.compressed.wasm
 * Default WS:   ws://127.0.0.1:9944
 */

import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));

// Parse args
const args = process.argv.slice(2);
let wasmPath = null;
let wsUrl = "ws://127.0.0.1:9944";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--wasm" && args[i + 1]) { wasmPath = args[++i]; }
  if (args[i] === "--ws"   && args[i + 1]) { wsUrl   = args[++i]; }
}

if (!wasmPath) {
  wasmPath = resolve(
    __dir,
    "../target/release/wbuild/stack-template-runtime/stack_template_runtime.compact.compressed.wasm"
  );
}

console.log("=== Runtime Upgrade ===");
console.log("  WS:   ", wsUrl);
console.log("  WASM: ", wasmPath);

const wasm = readFileSync(wasmPath);
console.log(`  Size:  ${(wasm.length / 1024).toFixed(1)} KB`);

const api = await ApiPromise.create({ provider: new WsProvider(wsUrl) });

const kr = new Keyring({ type: "sr25519" });
const alice = kr.addFromUri("//Alice");

// Provjeri trenutnu spec_version
const ver = api.runtimeVersion;
console.log(`\nTrenutna spec_version: ${ver.specVersion}`);

// Pošalji upgrade
console.log("\nSlanje sudo(system.setCodeWithoutChecks)...");
await new Promise((resolve, reject) => {
  let unsub;
  api.tx.sudo
    .sudo(api.tx.system.setCodeWithoutChecks("0x" + Buffer.from(wasm).toString("hex")))
    .signAndSend(alice, ({ status, events, dispatchError }) => {
      console.log("Status:", status.type);

      if (dispatchError) {
        unsub?.();
        if (dispatchError.isModule) {
          const decoded = api.registry.findMetaError(dispatchError.asModule);
          reject(new Error(`${decoded.section}.${decoded.name}: ${decoded.docs}`));
        } else {
          reject(new Error(dispatchError.toString()));
        }
        return;
      }

      if (status.isInBlock) {
        console.log("✓ U bloku:", status.asInBlock.toHex());
        // Provjeri da li je bilo Sudo event
        events.forEach(({ event }) => {
          console.log(" ", event.section + "." + event.method);
        });
      }

      if (status.isFinalized) {
        console.log("✓ Finalizovano:", status.asFinalized.toHex());
        unsub?.();
        resolve();
      }
    })
    .then(u => { unsub = u; })
    .catch(reject);
});

console.log("\n⏳ Čekam aktivaciju (novi runtime se aktivira u sledećem bloku)...");
await new Promise(r => setTimeout(r, 12_000));

const ver2 = (await api.rpc.state.getRuntimeVersion()).specVersion;
console.log(`Nova spec_version: ${ver2}`);
console.log("\n✓ Runtime upgrade završen!");

await api.disconnect();
process.exit(0);