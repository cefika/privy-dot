/**
 * Go WASM wrapper for Privy Dot cryptographic operations.
 *
 * Browser setup (in your HTML before any SDK calls):
 *   <script src="/wasm_exec.js"></script>   <!-- Go runtime shim -->
 *
 * Then call initWasm("/privy-core.wasm") once during app startup.
 * Copy privy-core.wasm into your public directory.
 */
import type { KeyPairs, SendResult, ScanResult } from "./types.js";

declare global {
  interface Window {
    Go: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): void };
  }
  function new_meta(): string;
  function get_meta(a: string): string;
  function send(a: string): string;
  function scan(a: string): string;
}

let _wasmUrl: string | null = null;
let ready = false;
let initPromise: Promise<void> | null = null;

/**
 * Load and start the Go WASM module.
 * Must be called once before any wasmApi calls.
 *
 * @param wasmUrl URL of privy-core.wasm (e.g. "/privy-core.wasm")
 */
export async function initWasm(wasmUrl: string): Promise<void> {
  _wasmUrl = wasmUrl;
  if (ready) return;
  if (initPromise) return initPromise;
  initPromise = _boot(wasmUrl);
  return initPromise;
}

async function _boot(wasmUrl: string): Promise<void> {
  const go = new window.Go();
  const res = await fetch(wasmUrl);
  if (!res.ok) throw new Error(`Failed to fetch WASM: ${res.status} ${res.statusText}`);
  const buf = await res.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(buf, go.importObject);
  go.run(instance);
  ready = true;
}

/** Reinitialize WASM after a Go panic ("already exited" error) */
export async function resetWasm(): Promise<void> {
  if (!_wasmUrl) throw new Error("initWasm() must be called before resetWasm()");
  ready = false;
  initPromise = null;
  await initWasm(_wasmUrl);
}

// Ensure hex has even length (Go hex.DecodeString requires it)
function padHex(h: string): string {
  const raw = h.startsWith("0x") ? h.slice(2) : h;
  return raw.length % 2 === 0 ? raw : "0" + raw;
}

async function safe<T>(fn: () => T): Promise<T> {
  try {
    return fn();
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("already exited")) {
      await resetWasm();
      return fn();
    }
    throw e;
  }
}

export const wasmApi = {
  /**
   * Generate a new random stealth meta-address key pair.
   * Returns spending (k/K) and viewing (v/V) key pairs.
   */
  newMeta: (): Promise<KeyPairs> =>
    safe(() => JSON.parse(new_meta())),

  /**
   * Restore KeyPairs from existing private keys.
   * @param k Spending private key (hex)
   * @param v Viewing private key (hex)
   */
  getMeta: (k: string, v: string): Promise<KeyPairs> =>
    safe(() => JSON.parse(get_meta(JSON.stringify({ k: padHex(k), v: padHex(v) })))),

  /**
   * Compute send result (ephemeral key, view tag, stealth spending pubkey).
   * @param K Recipient spending public key "X.Y"
   * @param V Recipient viewing public key "X.Y"
   */
  send: (K: string, V: string): Promise<SendResult> =>
    safe(() => JSON.parse(send(JSON.stringify({ K, V })))),

  /**
   * Scan announcements and return matching stealth spending keys.
   * @param k Viewing private key (hex)
   * @param v Viewing private key (hex, same key — kept for API symmetry)
   * @param Rs Array of ephemeral pubkeys "X.Y" from announcements
   * @param viewTags Array of view tags (hex) from announcements
   */
  scan: (k: string, v: string, Rs: string[], viewTags: string[]): Promise<ScanResult> =>
    safe(() => JSON.parse(scan(JSON.stringify({ k: padHex(k), v: padHex(v), Rs, viewTags })))),
};