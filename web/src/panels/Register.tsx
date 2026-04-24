import { useState } from "react";
import { Copy, Check, QrCode, Upload, Loader, CheckCircle } from "lucide-react";
import { getApi, registerMetaAddress } from "../substrate";
import type { SubstrateSigner } from "../substrate";
import type { KeyPairs } from "../types";

interface Props {
  mode: "evm" | "xcm";
  keys: KeyPairs | null;
  subSigner: SubstrateSigner | null;
  sourcePara: number;
}

function CopyBtn({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="flex items-center gap-2 btn-secondary text-xs py-1.5 px-3"
    >
      {copied ? <Check size={13} className="text-green-400" /> : <Copy size={13} />}
      {copied ? "Copied!" : label}
    </button>
  );
}

export default function ReceivePanel({ mode, keys, subSigner, sourcePara }: Props) {
  const [registering, setRegistering] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [blockHash, setBlockHash] = useState("");
  const [error, setError] = useState("");

  const isXcm = mode === "xcm";
  const metaAddress = keys ? `${keys.K}:::${keys.V}` : "";

  async function handleRegister() {
    if (!keys || !subSigner) return;
    setRegistering(true); setError("");
    try {
      const api = await getApi(sourcePara);
      const hash = await registerMetaAddress(api, subSigner, keys.K, keys.V);
      setBlockHash(hash);
      setRegistered(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Registration failed");
    } finally {
      setRegistering(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-zinc-100">Receive</h2>
        <p className="text-zinc-400 mt-1 text-sm">
          Share your meta address — senders use it to compute your one-time stealth address
        </p>
      </div>

      {!keys && (
        <div className="rounded-lg bg-amber-950/40 border border-amber-700/40 px-4 py-3 text-amber-300 text-sm">
          Generate or import keys first.
        </div>
      )}

      {keys && (
        <>
          {/* Meta address */}
          <div className="card">
            <div className="flex items-center gap-2 mb-4">
              <QrCode size={18} className="text-violet-400" />
              <h3 className="font-semibold text-zinc-100">Your Meta Address</h3>
            </div>
            <div className="bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 mb-4">
              <p className="font-mono text-xs text-zinc-300 break-all leading-relaxed">{metaAddress}</p>
            </div>
            <div className="flex gap-2 flex-wrap">
              <CopyBtn text={metaAddress} label="Copy meta address" />
              <CopyBtn text={keys.K} label="Copy K (spending pub)" />
              <CopyBtn text={keys.V} label="Copy V (viewing pub)" />
            </div>
          </div>

          {/* On-chain registration (XCM mode only) */}
          {isXcm && (
            <div className="card">
              <h3 className="font-semibold text-zinc-100 mb-1 flex items-center gap-2">
                <Upload size={15} className="text-violet-400" />
                Register on Para {sourcePara}
              </h3>
              <p className="text-xs text-zinc-500 mb-4">
                Publish your meta address on-chain so senders can look it up by your account.
                Required for XCM stealth payments.
              </p>

              {!subSigner && (
                <div className="rounded-lg bg-amber-950/40 border border-amber-700/40 px-3 py-2 text-amber-300 text-xs mb-3">
                  Connect a Substrate account in the sidebar first.
                </div>
              )}

              {registered ? (
                <div className="flex items-center gap-3 text-emerald-400 text-sm">
                  <CheckCircle size={18} />
                  <div>
                    <p className="font-semibold">Registered!</p>
                    <p className="font-mono text-xs text-zinc-500 mt-0.5 break-all">{blockHash}</p>
                  </div>
                </div>
              ) : (
                <>
                  {error && <p className="text-red-400 text-xs mb-3">{error}</p>}
                  <button
                    onClick={handleRegister}
                    disabled={registering || !subSigner}
                    className="btn-primary flex items-center gap-2"
                  >
                    {registering
                      ? <><Loader size={14} className="animate-spin" /> Registering…</>
                      : <><Upload size={14} /> Register Meta Address</>
                    }
                  </button>
                </>
              )}
            </div>
          )}

          {/* Info card */}
          <div className="card bg-zinc-900/50 border-zinc-800">
            <h4 className="text-sm font-medium text-zinc-300 mb-3">How to use this</h4>
            <div className="space-y-2 text-xs text-zinc-500">
              <p>→ Send this meta address to anyone who wants to pay you</p>
              <p>→ They paste K:::V into the Send panel to generate a one-time stealth address</p>
              <p>→ Funds arrive at an address nobody can link back to you</p>
              {isXcm
                ? <p>→ Run Scan on Para {sourcePara} to discover payments (balances on destination para)</p>
                : <p>→ Run Scan to discover and spend received funds</p>
              }
            </div>
          </div>
        </>
      )}
    </div>
  );
}