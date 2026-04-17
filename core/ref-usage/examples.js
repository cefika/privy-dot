import fs from "fs";
import "./wasm_exec.js";

const go = new globalThis.Go();
const wasmBuffer = fs.readFileSync("./curvy-core.wasm");

const wasmModule = await WebAssembly.instantiate(wasmBuffer, go.importObject);
go.run(wasmModule.instance);

// Generates new Meta Address information (with private keys)
// Input:
//  None
let recipientInfo = await globalThis.new_meta();
console.log(recipientInfo);
// Output (json string):
// {
//   "k": "...", // Private spending key
//   "v": "...", // Private viewing key
//   "K": "X.Y", // Public spending key encoded as: "X.Y" where X and Y are affine coordinates
//   "V": "X.Y"  // Public viewing key encoded as: "X.Y" where X and Y are affine coordinates
// }

// Reconstruct public keys based on private keys
// Input (json string):
// {
//   "k": "...", // Private spending key
//   "v": "...", // Private viewing key
// }
const { k, v } = JSON.parse(recipientInfo);
let reconstructedRecipientInfo = await globalThis.get_meta(
    JSON.stringify({ k, v })
);
console.log({ reconstructedRecipientInfo });
// Output (json string):
// {
//   "k": "...", // Private spending key
//   "v": "...", // Private viewing key
//   "K": "X.Y", // Public spending key encoded as: "X.Y" where X and Y are affine coordinates
//   "V": "X.Y"  // Public viewing key encoded as: "X.Y" where X and Y are affine coordinates
// }

// Send to recipient
// Input (json string):
// {
//   "K": "X.Y", // Public spending key encoded as: "X.Y" where X and Y are affine coordinates
//   "V": "X.Y"  // Public viewing key encoded as: "X.Y" where X and Y are affine coordinates
// }
const { K, V } = JSON.parse(reconstructedRecipientInfo);
const senderInfo = JSON.parse(await globalThis.send(JSON.stringify({ K, V })));
console.log(senderInfo);
// Output (json string):
// {
//   "r": "...", // Private ephemeral key
//   "R": "X.Y", // Public ephemeral key encoded as: "X.Y" where X and Y are affine coordinates
//   "viewTag": "..", // Viewing tag
//   "spendingPubKey": "X.Y" // Public spending key for the new stealth account, encoded as: "X.Y" where X and Y are affine coordinates
// }

// Perform a scan of all ephemeral keys and view tags
// Input (json string):
// {
//   "k": "...", // Private spending key
//   "v": "...", // Private viewing key
//   "Rs": ["X.Y"] // List of ephemeral keys encoded as: "X.Y" where X and Y are affine coordinates
//   "viewTags": [""], // List of view tags
// }
const Rs = [senderInfo.R];
const viewTags = [senderInfo.viewTag];
const scanResponseRaw = await globalThis.scan(
    JSON.stringify({ k, v, Rs, viewTags })
);
const scanResponse = JSON.parse(scanResponseRaw);
console.log(scanResponse);
// Output (json string):
// {
//   "spendingPubKeys": ["X.Y"] // List of spending public keys (for detected stealth accounts)
//                      encoded as: "X.Y" where X and Y are affine coordinates
//   "spendingPrivKeys": ["..."] // List of corresponding private keys for the detected stealth accounts
// }

// Checks whether a BN254 Point is valid
// Input:
//  point: "X.Y" where X and Y are affine coordinates
const validBN254Point = senderInfo.R;
const validPointRes = await globalThis.dbg_isValidBN254Point(validBN254Point);
console.log({ validPointRes });
// Output:
//  res: bool (is valid or not)

// Checks whether a SECP256k1 Point is valid
// Input:
//  point: "X.Y" where X and Y are affine coordinates
const validSECP256k1 = K;
const secp2561ValidPointRes = await globalThis.dbg_isValidSECP256k1Point(
    validSECP256k1
);
console.log({ secp2561ValidPointRes });
// Output:
//  res: bool (is valid or not)
