import type { KeyPairs, SendResult, ScanResult } from "./types";

declare global {
  interface Window { Go: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): void }; }
  function new_meta(): string;
  function get_meta(a: string): string;
  function send(a: string): string;
  function scan(a: string): string;
  function scan_audit(a: string): string;
}

let ready = false;
let promise: Promise<void> | null = null;

export async function initWasm(): Promise<void> {
  if (ready) return;
  if (promise) return promise;
  promise = (async () => {
    const go = new window.Go();
    const res = await fetch("/privy-core.wasm");
    const buf = await res.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(buf, go.importObject);
    go.run(instance);
    ready = true;
  })();
  return promise;
}

// If Go panics it exits and all subsequent calls throw "already exited".
// Reset state so initWasm() can spin up a fresh instance.
async function reinit(): Promise<void> {
  ready = false;
  promise = null;
  await initWasm();
}

// Ensure hex has even length (Go hex.DecodeString requires it).
function padHex(h: string): string {
  const raw = h.startsWith("0x") ? h.slice(2) : h;
  return raw.length % 2 === 0 ? raw : "0" + raw;
}

async function safe<T>(fn: () => T): Promise<T> {
  try {
    return fn();
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("already exited")) {
      await reinit();
      return fn();
    }
    throw e;
  }
}

export const wasmApi = {
  newMeta: (): Promise<KeyPairs> =>
    safe(() => JSON.parse(new_meta())),

  getMeta: (k: string, v: string): Promise<KeyPairs> =>
    safe(() => JSON.parse(get_meta(JSON.stringify({ k: padHex(k), v: padHex(v) })))),

  send: (K: string, V: string): Promise<SendResult> =>
    safe(() => JSON.parse(send(JSON.stringify({ K, V })))),

  scan: (k: string, v: string, Rs: string[], viewTags: string[]): Promise<ScanResult> =>
    safe(() => JSON.parse(scan(JSON.stringify({ k: padHex(k), v: padHex(v), Rs, viewTags })))),

  scanAudit: (K: string, v: string, Rs: string[], viewTags: string[]): Promise<{ spendingPubKeys: string[] }> =>
    safe(() => JSON.parse(scan_audit(JSON.stringify({ K, v: padHex(v), Rs, viewTags })))),
};