import { useState } from "react";
import { Eye, EyeOff, RefreshCw, Copy, Check, Download, Upload, Link } from "lucide-react";
import type { KeyPairs } from "../types";
import { wasmApi } from "../wasm";

interface Props {
  keys: KeyPairs | null;
  address: string;
  onKeysChange: (k: KeyPairs) => void;
  toast: (msg: string, type?: "success" | "error") => void;
  onRegisterEvm?: () => Promise<void>;
}

function short(s: string) { return s.slice(0, 18) + "…" + s.slice(-6); }

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="p-1 text-zinc-400 hover:text-zinc-100 transition-colors"
    >
      {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
    </button>
  );
}

function MetaCopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all border ${
        copied
          ? "border-green-600 bg-green-950/40 text-green-400"
          : "border-violet-600 bg-violet-950/30 text-violet-300 hover:bg-violet-950/50"
      }`}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? "Copied!" : "Copy meta address"}
    </button>
  );
}

function KeyField({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [show, setShow] = useState(false);
  const display = secret && !show ? "••••••••••••••••••••••••••••••••" : (value.length > 60 ? short(value) : value);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">{label}</span>
        {secret && (
          <button onClick={() => setShow(v => !v)} className="text-zinc-500 hover:text-zinc-300">
            {show ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 bg-zinc-800 rounded-lg px-3 py-2 border border-zinc-700">
        <span className="font-mono text-xs text-zinc-200 flex-1 break-all">{display}</span>
        <CopyBtn text={value} />
      </div>
    </div>
  );
}

export default function KeysPanel({ keys, address, onKeysChange, toast, onRegisterEvm }: Props) {
  const [importMode, setImportMode] = useState(false);
  const [importK, setImportK] = useState("");
  const [importV, setImportV] = useState("");
  const [loading, setLoading] = useState(false);
  const [registering, setRegistering] = useState(false);

  async function handleRegister() {
    if (!onRegisterEvm) return;
    setRegistering(true);
    try { await onRegisterEvm(); } finally { setRegistering(false); }
  }

  async function generate() {
    if (keys && !confirm("Generate new keys? Current keys will be replaced!")) return;
    setLoading(true);
    try {
      const k = await wasmApi.newMeta();
      onKeysChange(k);
      toast("New key pair generated!", "success");
    } catch {
      toast("Failed to generate keys", "error");
    } finally {
      setLoading(false);
    }
  }

  async function importKeys() {
    try {
      const k = await wasmApi.getMeta(importK.trim(), importV.trim());
      onKeysChange(k);
      setImportMode(false);
      toast("Keys imported successfully!", "success");
    } catch {
      toast("Invalid private keys", "error");
    }
  }

  function exportKeys() {
    if (!keys) return;
    const blob = new Blob([JSON.stringify(keys, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "stealth-keys.json"; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-zinc-100">Key Management</h2>
        <p className="text-zinc-400 mt-1 text-sm">Your SECP256k1 spending keys and BN254 viewing keys</p>
      </div>

      {!address ? (
        <div className="rounded-lg bg-amber-950/40 border border-amber-700/40 px-4 py-3 text-amber-300 text-sm">
          Connect a wallet first — stealth keys are stored per wallet address.
        </div>
      ) : !keys ? (
        <div className="border border-dashed border-zinc-700 rounded-xl p-12 text-center">
          <div className="text-zinc-500 mb-4">
            <RefreshCw size={40} className="mx-auto mb-3 opacity-40" />
            <p className="text-lg">No keys for this wallet</p>
            <p className="text-sm font-mono text-zinc-600">{address.slice(0, 10)}…{address.slice(-6)}</p>
            <p className="text-sm mt-2">Generate a key pair to get started</p>
          </div>
          <button onClick={generate} className="btn-primary">
            Generate Key Pair
          </button>
        </div>
      ) : (
        <div className="grid gap-4">
          {/* Meta Address — prominentno na vrhu */}
          <div className="card border-violet-700/40 bg-violet-950/10">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-2 h-2 rounded-full bg-violet-400" />
              <h3 className="font-semibold text-zinc-100">Your Meta Address</h3>
              <span className="text-xs text-zinc-500 ml-auto">Share this to receive payments</span>
            </div>
            <div className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 mb-3">
              <p className="font-mono text-xs text-zinc-300 break-all leading-relaxed">{keys.K}:::{keys.V}</p>
            </div>
            <div className="flex gap-2 flex-wrap">
              <MetaCopyBtn text={`${keys.K}:::${keys.V}`} />
              {onRegisterEvm && (
                <button
                  onClick={handleRegister}
                  disabled={registering}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-emerald-700 bg-emerald-950/30 text-emerald-300 hover:bg-emerald-950/50 transition-all disabled:opacity-50"
                >
                  <Link size={14} />
                  {registering ? "Registering…" : "Register on-chain (EVM)"}
                </button>
              )}
            </div>
            {onRegisterEvm && (
              <p className="text-xs text-zinc-500 mt-2">
                Registracija zahteva mali gas fee u PAS. Nije obavezna — možeš deliti meta address ručno (Copy dugme iznad).
              </p>
            )}
          </div>

          {/* Spending Key Card */}
          <div className="card">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-2 h-2 rounded-full bg-violet-500" />
              <h3 className="font-semibold text-zinc-100">Spending Key (SECP256k1)</h3>
              <span className="text-xs text-zinc-500 ml-auto">Used to receive & spend</span>
            </div>
            <div className="space-y-3">
              <KeyField label="Public Key (K)" value={keys.K} />
              <KeyField label="Private Key (k)" value={keys.k} secret />
            </div>
          </div>

          {/* Viewing Key Card */}
          <div className="card">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-2 h-2 rounded-full bg-emerald-500" />
              <h3 className="font-semibold text-zinc-100">Viewing Key (BN254)</h3>
              <span className="text-xs text-zinc-500 ml-auto">Used to scan announcements</span>
            </div>
            <div className="space-y-3">
              <KeyField label="Public Key (V)" value={keys.V} />
              <KeyField label="Private Key (v)" value={keys.v} secret />
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-3 flex-wrap">
            <button onClick={generate} disabled={loading} className="btn-secondary flex items-center gap-2">
              <RefreshCw size={14} /> Regenerate
            </button>
            <button onClick={exportKeys} className="btn-secondary flex items-center gap-2">
              <Download size={14} /> Export JSON
            </button>
            <button onClick={() => setImportMode(v => !v)} className="btn-secondary flex items-center gap-2">
              <Upload size={14} /> Import
            </button>
          </div>
        </div>
      )}

      {importMode && (
        <div className="card border-violet-700/50">
          <h3 className="font-semibold text-zinc-100 mb-4">Import Existing Keys</h3>
          <div className="space-y-3">
            <div>
              <label className="label">SECP256k1 Private Key (k)</label>
              <input value={importK} onChange={e => setImportK(e.target.value)} className="input" placeholder="hex string..." />
            </div>
            <div>
              <label className="label">BN254 Private Key (v)</label>
              <input value={importV} onChange={e => setImportV(e.target.value)} className="input" placeholder="hex string..." />
            </div>
            <div className="flex gap-2">
              <button onClick={importKeys} className="btn-primary">Import</button>
              <button onClick={() => setImportMode(false)} className="btn-secondary">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {address && !keys && (
        <button onClick={() => setImportMode(v => !v)} className="text-sm text-violet-400 hover:text-violet-300 underline">
          Already have keys? Import them
        </button>
      )}
    </div>
  );
}