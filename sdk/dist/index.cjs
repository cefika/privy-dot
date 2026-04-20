'use strict';

var api = require('@polkadot/api');
var keyring = require('@polkadot/keyring');
var utilCrypto = require('@polkadot/util-crypto');
var util = require('@polkadot/util');
var extensionDapp = require('@polkadot/extension-dapp');
var ethers = require('ethers');

// src/wasm.ts
var _wasmUrl = null;
var ready = false;
var initPromise = null;
async function initWasm(wasmUrl) {
  _wasmUrl = wasmUrl;
  if (ready) return;
  if (initPromise) return initPromise;
  initPromise = _boot(wasmUrl);
  return initPromise;
}
async function _boot(wasmUrl) {
  const go = new window.Go();
  const res = await fetch(wasmUrl);
  if (!res.ok) throw new Error(`Failed to fetch WASM: ${res.status} ${res.statusText}`);
  const buf = await res.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(buf, go.importObject);
  go.run(instance);
  ready = true;
}
async function resetWasm() {
  if (!_wasmUrl) throw new Error("initWasm() must be called before resetWasm()");
  ready = false;
  initPromise = null;
  await initWasm(_wasmUrl);
}
function padHex(h) {
  const raw = h.startsWith("0x") ? h.slice(2) : h;
  return raw.length % 2 === 0 ? raw : "0" + raw;
}
async function safe(fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Error && e.message.includes("already exited")) {
      await resetWasm();
      return fn();
    }
    throw e;
  }
}
var wasmApi = {
  /**
   * Generate a new random stealth meta-address key pair.
   * Returns spending (k/K) and viewing (v/V) key pairs.
   */
  newMeta: () => safe(() => JSON.parse(new_meta())),
  /**
   * Restore KeyPairs from existing private keys.
   * @param k Spending private key (hex)
   * @param v Viewing private key (hex)
   */
  getMeta: (k, v) => safe(() => JSON.parse(get_meta(JSON.stringify({ k: padHex(k), v: padHex(v) })))),
  /**
   * Compute send result (ephemeral key, view tag, stealth spending pubkey).
   * @param K Recipient spending public key "X.Y"
   * @param V Recipient viewing public key "X.Y"
   */
  send: (K, V) => safe(() => JSON.parse(send(JSON.stringify({ K, V })))),
  /**
   * Scan announcements and return matching stealth spending keys.
   * @param k Viewing private key (hex)
   * @param v Viewing private key (hex, same key — kept for API symmetry)
   * @param Rs Array of ephemeral pubkeys "X.Y" from announcements
   * @param viewTags Array of view tags (hex) from announcements
   */
  scan: (k, v, Rs, viewTags) => safe(() => JSON.parse(scan(JSON.stringify({ k: padHex(k), v: padHex(v), Rs, viewTags }))))
};
function signerAddress(s) {
  return s.type === "keypair" ? s.pair.address : s.address;
}
async function getExtensionAccounts(appName = "Privy Dot") {
  const extensions = await extensionDapp.web3Enable(appName);
  if (extensions.length === 0) {
    throw new Error("No Polkadot wallet extension found. Install Talisman or SubWallet.");
  }
  return extensionDapp.web3Accounts();
}
var apiCache = /* @__PURE__ */ new Map();
async function getApi(wsUrl) {
  const cached = apiCache.get(wsUrl);
  if (cached?.isConnected) return cached;
  const api$1 = await api.ApiPromise.create({ provider: new api.WsProvider(wsUrl) });
  apiCache.set(wsUrl, api$1);
  return api$1;
}
function disconnectAll() {
  for (const api of apiCache.values()) api.disconnect();
  apiCache.clear();
}
function getDevAccount(name) {
  const keyring$1 = new keyring.Keyring({ type: "sr25519" });
  const pair = keyring$1.addFromUri(`//${name.charAt(0).toUpperCase() + name.slice(1)}`);
  return { type: "keypair", pair };
}
function getAccountFromMnemonic(mnemonic) {
  const keyring$1 = new keyring.Keyring({ type: "sr25519" });
  const pair = keyring$1.addFromMnemonic(mnemonic);
  return { type: "keypair", pair };
}
function signerFromExtensionAccount(account) {
  return { type: "injected", address: account.address, name: account.meta.name };
}
function getStealthSpendingKeypair(spendingPrivKey) {
  const keyring$1 = new keyring.Keyring({ type: "ecdsa" });
  const raw = spendingPrivKey.startsWith("0x") ? spendingPrivKey.slice(2) : spendingPrivKey;
  const padded = raw.padStart(64, "0").slice(0, 64);
  return keyring$1.addFromSeed(util.hexToU8a("0x" + padded));
}
function secp256k1ToCompressed(pubKey) {
  const [X, Y] = pubKey.split(".");
  const x = BigInt(X);
  const y = BigInt(Y);
  const prefix = y % 2n === 0n ? 2 : 3;
  const xBytes = new Uint8Array(32);
  let xVal = x;
  for (let i = 31; i >= 0; i--) {
    xBytes[i] = Number(xVal & 0xffn);
    xVal >>= 8n;
  }
  return new Uint8Array([prefix, ...xBytes]);
}
function pointToBytes64(pubKey) {
  const [X, Y] = pubKey.split(".");
  const result = new Uint8Array(64);
  let xVal = BigInt(X);
  let yVal = BigInt(Y);
  for (let i = 31; i >= 0; i--) {
    result[i] = Number(xVal & 0xffn);
    xVal >>= 8n;
    result[i + 32] = Number(yVal & 0xffn);
    yVal >>= 8n;
  }
  return result;
}
function bn254ToBytes64(pubKey) {
  return pointToBytes64(pubKey);
}
function rToBytes64(R) {
  return pointToBytes64(R);
}
function bytes64ToR(bytes) {
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const xBig = BigInt("0x" + hex.slice(0, 64));
  const yBig = BigInt("0x" + hex.slice(64));
  return `${xBig}.${yBig}`;
}
function deriveSubstrateStealthAddress(spendingPubKey) {
  const compressed = secp256k1ToCompressed(spendingPubKey);
  return util.u8aToHex(utilCrypto.blake2AsU8a(compressed, 256));
}
function decodeBytes(val) {
  if (typeof val === "string") return util.hexToU8a(val);
  if (Array.isArray(val)) return new Uint8Array(val);
  return new Uint8Array();
}
async function fetchAnnouncements(api) {
  const entries = await api.query.stealthAddresses.announcements.entries();
  const rows = [];
  for (const [key, rawVal] of entries) {
    const codec = rawVal;
    if (codec.isNone) continue;
    const ann = codec.isSome ? codec.unwrap() : codec;
    const json = ann.toJSON?.() ?? ann;
    rows.push({
      nonce: key.args[0].toNumber(),
      ephemeralPubkey: decodeBytes(json.ephemeralPubkey ?? json.ephemeral_pubkey),
      viewTag: decodeBytes(json.viewTag ?? json.view_tag),
      stealthAddress: util.u8aToHex(decodeBytes(json.stealthAddress ?? json.stealth_address)),
      metadata: decodeBytes(json.metadata)
    });
  }
  return rows;
}
async function getBalance(api, accountId) {
  const acc = await api.query.system.account(accountId);
  return acc.data.free.toBigInt();
}
async function getAssetBalance(api, accountId, assetId) {
  const acc = await api.query.assets.account(assetId, accountId);
  if (!acc || acc.isNone) return 0n;
  const inner = acc.isSome ? acc.unwrap() : acc;
  return inner.balance?.toBigInt?.() ?? 0n;
}
async function submitTx(tx, signer, onInBlock) {
  let injectorSigner;
  if (signer.type === "injected") {
    const injector = await extensionDapp.web3FromAddress(signer.address);
    injectorSigner = injector.signer;
  }
  return new Promise((resolve, reject) => {
    let unsub;
    const callback = (result) => {
      if (result.status.isInBlock) {
        const hash = result.status.asInBlock.toHex();
        if (result.dispatchError) {
          unsub?.();
          reject(new Error(result.dispatchError.toString()));
        } else {
          unsub?.();
          resolve(hash);
        }
      } else if (result.status.isDropped || result.status.isInvalid) {
        unsub?.();
        reject(new Error("Transaction dropped or invalid"));
      }
    };
    const sendPromise = signer.type === "keypair" ? tx.signAndSend(signer.pair, callback) : tx.signAndSend(signer.address, { signer: injectorSigner }, callback);
    sendPromise.then((u) => {
      unsub = u;
    }).catch(reject);
  });
}
async function registerMetaAddress(api, signer, spendingPubKey, viewingPubKey, schemeId = 2901) {
  const spBytes = Array.from(secp256k1ToCompressed(spendingPubKey));
  const vpBytes = Array.from(bn254ToBytes64(viewingPubKey));
  return submitTx(
    api.tx.stealthAddresses.registerStealthMetaAddress(spBytes, vpBytes, schemeId),
    signer
  );
}
async function sendStealthXcm(api, signer, destParaId, stealthAddress, amount, ephemeralPubkey, viewTag, metadata) {
  return submitTx(
    api.tx.stealthAddresses.sendStealthXcm(
      destParaId,
      stealthAddress,
      amount.toString(),
      Array.from(ephemeralPubkey),
      Array.from(viewTag),
      Array.from(metadata)
    ),
    signer
  );
}
async function sendStealthAssetXcm(api, signer, assetId, destParaId, stealthAddress, amount, ephemeralPubkey, viewTag, metadata) {
  return submitTx(
    api.tx.stealthAddresses.sendStealthAssetXcm(
      assetId,
      destParaId,
      stealthAddress,
      amount.toString(),
      Array.from(ephemeralPubkey),
      Array.from(viewTag),
      Array.from(metadata)
    ),
    signer
  );
}
async function sendStealthAsset(api, signer, assetId, stealthAddress, amount, ephemeralPubkey, viewTag, metadata) {
  const transferCall = api.tx.assets.transfer(assetId, stealthAddress, amount.toString());
  const announceCall = api.tx.stealthAddresses.announce(
    Array.from(ephemeralPubkey),
    Array.from(viewTag),
    stealthAddress,
    Array.from(metadata)
  );
  return submitTx(api.tx.utility.batchAll([transferCall, announceCall]), signer);
}
async function spendFromStealth(api, spendingPrivKey, to, amount) {
  const pair = getStealthSpendingKeypair(spendingPrivKey);
  let dest = to;
  if (/^0x[0-9a-fA-F]{40}$/.test(to)) {
    dest = to.toLowerCase() + "ee".repeat(12);
  }
  return submitTx(api.tx.balances.transferAllowDeath(dest, amount.toString()), {
    type: "keypair",
    pair
  });
}
async function sendAssetFromStealth(api, spendingPrivKey, to, assetId, amount) {
  const pair = getStealthSpendingKeypair(spendingPrivKey);
  return submitTx(api.tx.assets.transfer(assetId, to, amount.toString()), {
    type: "keypair",
    pair
  });
}
async function sponsorGas(api, signer, amount) {
  return submitTx(api.tx.stealthAddresses.sponsorGas(amount.toString()), signer);
}
async function getSponsorBalance(api, accountId) {
  const val = await api.query.stealthAddresses.gasSponsorPool(accountId);
  return val?.toBigInt?.() ?? 0n;
}
function buildWithdrawalMessage(stealthHex, destBytes, assetId, amount) {
  const prefix = new TextEncoder().encode("PrivyDot::withdraw:v2");
  const stealth = util.hexToU8a(stealthHex);
  let assetBytes;
  if (assetId === void 0 || assetId === null) {
    assetBytes = new Uint8Array([0]);
  } else {
    assetBytes = new Uint8Array(5);
    assetBytes[0] = 1;
    new DataView(assetBytes.buffer).setUint32(1, assetId, true);
  }
  let amountBytes;
  if (amount === void 0 || amount === null) {
    amountBytes = new Uint8Array([0]);
  } else {
    amountBytes = new Uint8Array(17);
    amountBytes[0] = 1;
    let v = amount;
    for (let i = 0; i < 16; i++) {
      amountBytes[1 + i] = Number(v & 0xffn);
      v >>= 8n;
    }
  }
  const msg = new Uint8Array(
    prefix.length + 32 + 32 + assetBytes.length + amountBytes.length
  );
  let offset = 0;
  msg.set(prefix, offset);
  offset += prefix.length;
  msg.set(stealth, offset);
  offset += 32;
  msg.set(destBytes, offset);
  offset += 32;
  msg.set(assetBytes, offset);
  offset += assetBytes.length;
  msg.set(amountBytes, offset);
  return msg;
}
async function withdrawFromStealth(api, stealthAddress, spendingPrivKey, destination, sponsor, assetId, amount) {
  const stealthPair = getStealthSpendingKeypair(spendingPrivKey);
  const destBytes = utilCrypto.decodeAddress(destination);
  const msg = buildWithdrawalMessage(stealthAddress, destBytes, assetId, amount);
  const sig = stealthPair.sign(msg);
  const assetArg = assetId !== void 0 && assetId !== null ? assetId : null;
  const amountArg = amount !== void 0 && amount !== null ? amount.toString() : null;
  return submitTx(
    api.tx.stealthAddresses.withdrawFromStealth(
      Array.from(util.hexToU8a(stealthAddress)),
      destination,
      Array.from(sig),
      signerAddress(sponsor),
      assetArg,
      amountArg
    ),
    sponsor
  );
}
var STEALTH_PRECOMPILE_ADDR = "0x0000000000000000000000000000000010000000";
var STEALTH_PRECOMPILE_ABI = [
  "function registerMetaAddress(bytes spendingPubkey, bytes viewingPubkey, uint32 schemeId) external",
  "function announce(bytes ephemeralPubkey, bytes2 viewTag, bytes32 stealthAddress, bytes32 metadata) external",
  "function sendAndAnnounce(bytes32 stealthAddress, bytes ephemeralPubkey, bytes2 viewTag, bytes32 metadata) external payable"
];
var _rpcUrl = "";
var _chainId = 420420421;
var _providerInstance = null;
function configureEvm(rpcUrl, chainId = 420420421) {
  _rpcUrl = rpcUrl;
  _chainId = chainId;
  _providerInstance = new ethers.ethers.JsonRpcProvider(rpcUrl, void 0, { staticNetwork: true });
}
function getProvider() {
  if (!_providerInstance) {
    throw new Error("EVM not configured. Call configureEvm(rpcUrl) first.");
  }
  return _providerInstance;
}
var evmProvider = {
  getBalance: (addr) => getProvider().getBalance(addr),
  getBlockNumber: () => getProvider().getBlockNumber()
};
function signerFromPrivKey(privKey) {
  return new ethers.ethers.Wallet(privKey, getProvider());
}
function getPrecompile(signer) {
  return new ethers.ethers.Contract(STEALTH_PRECOMPILE_ADDR, STEALTH_PRECOMPILE_ABI, signer);
}
async function registerMetaAddressViaPrecompile(signer, spendingBytes, viewingBytes, schemeId = 2901) {
  const precompile = getPrecompile(signer);
  const tx = await precompile.registerMetaAddress(
    ethers.ethers.hexlify(spendingBytes),
    ethers.ethers.hexlify(viewingBytes),
    schemeId,
    { gasLimit: 5e5 }
  );
  const receipt = await tx.wait();
  return receipt.hash;
}
async function announceViaPrecompile(signer, ephemeralPubkey64, viewTag2, stealthAccountId32, metadata = new Uint8Array(32)) {
  const precompile = getPrecompile(signer);
  const tx = await precompile.announce(
    ethers.ethers.hexlify(ephemeralPubkey64),
    ethers.ethers.hexlify(viewTag2),
    ethers.ethers.hexlify(stealthAccountId32),
    ethers.ethers.hexlify(metadata),
    { gasLimit: 5e5 }
  );
  const receipt = await tx.wait();
  return receipt.hash;
}
async function sendAndAnnounceViaPrecompile(signer, stealthAccountId32, amountEther, ephemeralPubkey64, viewTag2, metadata = new Uint8Array(32)) {
  const precompile = getPrecompile(signer);
  const tx = await precompile.sendAndAnnounce(
    ethers.ethers.hexlify(stealthAccountId32),
    ethers.ethers.hexlify(ephemeralPubkey64),
    ethers.ethers.hexlify(viewTag2),
    ethers.ethers.hexlify(metadata),
    {
      gasLimit: 8e5,
      value: ethers.ethers.parseEther(amountEther)
    }
  );
  const receipt = await tx.wait();
  return receipt.hash;
}
async function connectMetaMask(chainName = "Privy Localnet", nativeCurrency = { name: "PAS", symbol: "PAS", decimals: 18 }) {
  if (!window.ethereum) {
    throw new Error("MetaMask not found. Use private key mode instead.");
  }
  const eth = window.ethereum;
  await eth.request({ method: "eth_requestAccounts" });
  const chainHex = await eth.request({ method: "eth_chainId", params: [] });
  const currentChain = parseInt(chainHex, 16);
  if (currentChain !== _chainId) {
    try {
      await eth.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + _chainId.toString(16) }]
      });
    } catch (switchErr) {
      const code = switchErr?.code;
      if (code === 4902) {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: "0x" + _chainId.toString(16),
              chainName,
              nativeCurrency,
              rpcUrls: [_rpcUrl]
            }
          ]
        });
      } else {
        throw new Error(
          `Wrong network. Please switch MetaMask to chain ID ${_chainId} (${chainName}).`
        );
      }
    }
  }
  const bp = new ethers.ethers.BrowserProvider(window.ethereum);
  const signer = await bp.getSigner();
  return { signer, address: await signer.getAddress() };
}
function deriveEvmStealthAddress(spendingPubKey) {
  const [X, Y] = spendingPubKey.split(".");
  const pub = "0x" + BigInt(X).toString(16).padStart(64, "0") + BigInt(Y).toString(16).padStart(64, "0");
  return ethers.ethers.computeAddress(pub);
}
function h160ToAccountId32(address) {
  const bytes = new Uint8Array(32);
  const h160 = ethers.ethers.getBytes(address);
  bytes.set(h160, 0);
  bytes.fill(238, 20);
  return bytes;
}

exports.STEALTH_PRECOMPILE_ABI = STEALTH_PRECOMPILE_ABI;
exports.STEALTH_PRECOMPILE_ADDR = STEALTH_PRECOMPILE_ADDR;
exports.announceViaPrecompile = announceViaPrecompile;
exports.bn254ToBytes64 = bn254ToBytes64;
exports.bytes64ToR = bytes64ToR;
exports.configureEvm = configureEvm;
exports.connectMetaMask = connectMetaMask;
exports.deriveEvmStealthAddress = deriveEvmStealthAddress;
exports.deriveSubstrateStealthAddress = deriveSubstrateStealthAddress;
exports.disconnectAll = disconnectAll;
exports.evmProvider = evmProvider;
exports.fetchAnnouncements = fetchAnnouncements;
exports.getAccountFromMnemonic = getAccountFromMnemonic;
exports.getApi = getApi;
exports.getAssetBalance = getAssetBalance;
exports.getBalance = getBalance;
exports.getDevAccount = getDevAccount;
exports.getExtensionAccounts = getExtensionAccounts;
exports.getSponsorBalance = getSponsorBalance;
exports.getStealthSpendingKeypair = getStealthSpendingKeypair;
exports.h160ToAccountId32 = h160ToAccountId32;
exports.initWasm = initWasm;
exports.rToBytes64 = rToBytes64;
exports.registerMetaAddress = registerMetaAddress;
exports.registerMetaAddressViaPrecompile = registerMetaAddressViaPrecompile;
exports.resetWasm = resetWasm;
exports.secp256k1ToCompressed = secp256k1ToCompressed;
exports.sendAndAnnounceViaPrecompile = sendAndAnnounceViaPrecompile;
exports.sendAssetFromStealth = sendAssetFromStealth;
exports.sendStealthAsset = sendStealthAsset;
exports.sendStealthAssetXcm = sendStealthAssetXcm;
exports.sendStealthXcm = sendStealthXcm;
exports.signerAddress = signerAddress;
exports.signerFromExtensionAccount = signerFromExtensionAccount;
exports.signerFromPrivKey = signerFromPrivKey;
exports.spendFromStealth = spendFromStealth;
exports.sponsorGas = sponsorGas;
exports.wasmApi = wasmApi;
exports.withdrawFromStealth = withdrawFromStealth;
//# sourceMappingURL=index.cjs.map
//# sourceMappingURL=index.cjs.map