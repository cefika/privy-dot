import { useState } from "react";
import { Send as SendIcon, ArrowRight, CheckCircle, Loader, ClipboardPaste } from "lucide-react";
import { ethers } from "ethers";
import { wasmApi } from "../wasm";
import { getContract, deriveStealthAddress } from "../chain";
import {
  getApi,
  sendStealthXcm,
  deriveSubstrateStealthAddress,
  rToBytes64,
} from "../substrate";
import type { KeyringPair } from "../substrate";

interface Props {
  mode: "evm" | "xcm";
  signer: ethers.Signer | null;
  subSigner: KeyringPair | null;
  sourcePara: number;
  destPara: number;
  toast: (msg: string, type?: "success" | "error") => void;
}

type Step = "idle" | "resolved" | "sending" | "done";

interface Resolved {
  K: string; V: string;
  stealthAddress: string;   // EVM: 0x20-byte; XCM: 0x32-byte AccountId32
  ephemeralKey: string;     // R in "X.Y" format
  viewTag: string;          // hex, 1 byte
}

export default function SendPanel({ mode, signer, subSigner, sourcePara, destPara, toast }: Props) {
  const [metaInput, setMetaInput] = useState("");
  const [amount, setAmount] = useState("1");
  const [step, setStep] = useState<Step>("idle");
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [txHash, setTxHash] = useState("");
  const [error, setError] = useState("");

  const isXcm = mode === "xcm";

  async function generate() {
    setError("");
    const parts = metaInput.trim().split(":::");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      setError("Paste a valid meta address: K:::V");
      return;
    }
    const [K, V] = parts;
    try {
      const sendResult = await wasmApi.send(K, V);
      const stealthAddress = isXcm
        ? deriveSubstrateStealthAddress(sendResult.spendingPubKey)
        : deriveStealthAddress(sendResult.spendingPubKey);
      setResolved({ K, V, stealthAddress, ephemeralKey: sendResult.R, viewTag: sendResult.viewTag });
      setStep("resolved");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to generate stealth address");
    }
  }

  async function sendFunds() {
    if (!resolved) return;
    setStep("sending"); setError("");

    try {
      if (isXcm) {
        if (!subSigner) throw new Error("Connect a Substrate account first");

        const api = await getApi(sourcePara);

        // Encode ephemeral pubkey R → 64 bytes
        const ephemeralPubkey = rToBytes64(resolved.ephemeralKey);

        // Encode viewTag: WASM returns 1-byte hex (e.g. "ab"), pallet expects [u8;2]
        const rawVt = resolved.viewTag.replace(/^0x/, "");
        const vtByte = parseInt(rawVt.slice(0, 2), 16);
        const viewTag = new Uint8Array([vtByte, 0x00]);

        // Metadata: 32 zero bytes
        const metadata = new Uint8Array(32);

        // Amount in planck (12 decimals)
        const amountPlanck = BigInt(Math.round(parseFloat(amount) * 1_000_000_000_000));

        const hash = await sendStealthXcm(
          api,
          subSigner,
          destPara,
          resolved.stealthAddress,
          amountPlanck,
          ephemeralPubkey,
          viewTag,
          metadata
        );
        setTxHash(hash);
        setStep("done");
        toast(`Sent ${amount} tokens via XCM!`, "success");

      } else {
        if (!signer) throw new Error("Connect a wallet first");
        const contract = getContract(signer);
        const rawVt = resolved.viewTag.replace(/^0x/, "");
        const paddedVt = rawVt.length % 2 === 0 ? rawVt : "0" + rawVt;
        const tx = await contract.sendEthViaProxy(
          resolved.stealthAddress,
          ethers.toUtf8Bytes(resolved.ephemeralKey),
          ethers.getBytes("0x" + paddedVt),
          { value: ethers.parseEther(amount) }
        );
        setTxHash(tx.hash);
        await tx.wait();
        setStep("done");
        toast(`Sent ${amount} PAS to stealth address!`, "success");
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Transaction failed");
      setStep("resolved");
    }
  }

  function reset() { setStep("idle"); setResolved(null); setTxHash(""); setMetaInput(""); setError(""); }

  if (step === "done") {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold text-zinc-100">Send</h2>
          <p className="text-zinc-400 mt-1 text-sm">Send funds privately to a stealth address</p>
        </div>
        <div className="card text-center py-10">
          <CheckCircle size={48} className="text-green-400 mx-auto mb-4" />
          <h3 className="text-xl font-semibold text-zinc-100 mb-2">Transfer Complete</h3>
          <p className="text-zinc-400 mb-4">
            <span className="font-semibold text-zinc-200">{amount} {isXcm ? "tokens" : "PAS"}</span> sent to{" "}
            <span className="font-mono text-violet-400">{resolved!.stealthAddress.slice(0, 10)}…</span>
          </p>
          <div className="bg-zinc-800 rounded-lg p-3 mb-4">
            <p className="text-xs text-zinc-500 mb-1">Stealth address (recipient)</p>
            <p className="font-mono text-xs text-violet-300 break-all">{resolved!.stealthAddress}</p>
          </div>
          <div className="bg-zinc-800 rounded-lg p-3 mb-6">
            <p className="text-xs text-zinc-500 mb-1">{isXcm ? "Block hash" : "Transaction"}</p>
            <p className="font-mono text-xs text-violet-400 break-all">{txHash}</p>
          </div>
          <button onClick={reset} className="btn-primary">Send Another</button>
        </div>
      </div>
    );
  }

  const canSend = isXcm ? !!subSigner : !!signer;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-zinc-100">Send</h2>
        <p className="text-zinc-400 mt-1 text-sm">
          {isXcm
            ? `XCM stealth send from Para ${sourcePara} → Para ${destPara}`
            : "Paste a recipient's meta address to generate a one-time stealth address"}
        </p>
      </div>

      {!canSend && (
        <div className="rounded-lg bg-amber-950/40 border border-amber-700/40 px-4 py-3 text-amber-300 text-sm">
          {isXcm ? "Connect a dev account (Alice/Bob/Charlie) in the sidebar." : "Connect a wallet in the sidebar to send transactions."}
        </div>
      )}

      {/* Step 1: Meta address input */}
      <div className="card">
        <h3 className="font-semibold text-zinc-100 mb-1 flex items-center gap-2">
          <span className="step-badge">1</span> Recipient's Meta Address
        </h3>
        <p className="text-xs text-zinc-500 mb-3">The K:::V key pair shared by the recipient (from their Receive panel)</p>
        <textarea
          value={metaInput}
          onChange={e => { setMetaInput(e.target.value); setStep("idle"); setResolved(null); }}
          className="input w-full font-mono text-xs resize-none h-20"
          placeholder={"0x04abc...:::1234.5678"}
          disabled={step === "sending"}
        />
        {error && <p className="text-red-400 text-xs mt-2">{error}</p>}
        <button
          onClick={generate}
          disabled={!metaInput.trim() || step === "sending"}
          className="btn-primary mt-3 flex items-center gap-2"
        >
          <ClipboardPaste size={14} /> Generate Stealth Address
        </button>
      </div>

      {/* Step 2: Stealth address preview */}
      {resolved && (
        <div className="card border-violet-700/30">
          <h3 className="font-semibold text-zinc-100 mb-4 flex items-center gap-2">
            <span className="step-badge">2</span> One-Time Stealth Address
          </h3>
          <div className="space-y-3">
            <div className="bg-zinc-800 rounded-lg p-3">
              <p className="text-xs text-zinc-500 mb-1">
                {isXcm ? "Substrate AccountId32 (stealth address on Para " + destPara + ")" : "Stealth Address (EVM)"}
              </p>
              <p className="font-mono text-sm text-violet-300 break-all">{resolved.stealthAddress}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-zinc-800 rounded-lg p-3">
                <p className="text-xs text-zinc-500 mb-1">Ephemeral Key R</p>
                <p className="font-mono text-xs text-zinc-300 break-all">{resolved.ephemeralKey.slice(0, 30)}…</p>
              </div>
              <div className="bg-zinc-800 rounded-lg p-3">
                <p className="text-xs text-zinc-500 mb-1">View Tag</p>
                <p className="font-mono text-sm text-zinc-300">0x{resolved.viewTag}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Step 3: Amount + Send */}
      {resolved && (
        <div className="card">
          <h3 className="font-semibold text-zinc-100 mb-4 flex items-center gap-2">
            <span className="step-badge">3</span> Amount
          </h3>
          <div className="flex gap-2 items-center">
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              className="input flex-1"
              placeholder="0.0"
              min="0" step="0.1"
            />
            <span className="text-zinc-400 font-medium">{isXcm ? "tokens" : "PAS"}</span>
          </div>
          {isXcm && (
            <p className="text-xs text-zinc-500 mt-2">
              1 token = 10¹² planck. Min recommended: 2 (to cover XCM fees).
            </p>
          )}
          <button
            onClick={sendFunds}
            disabled={!canSend || step === "sending" || !amount}
            className="btn-primary w-full mt-4 flex items-center justify-center gap-2"
          >
            {step === "sending" ? (
              <><Loader size={14} className="animate-spin" /> {isXcm ? "Sending XCM…" : "Sending…"}</>
            ) : (
              <><SendIcon size={14} /> Send {amount} <ArrowRight size={12} /> {resolved.stealthAddress.slice(0, 8)}…</>
            )}
          </button>
          {step !== "sending" && (
            <button onClick={reset} className="text-xs text-zinc-500 hover:text-zinc-400 mt-3 w-full">Cancel</button>
          )}
        </div>
      )}

      {/* How it works */}
      <div className="card bg-zinc-900/50 border-zinc-800">
        <h4 className="text-sm font-medium text-zinc-300 mb-3">
          {isXcm ? "How XCM stealth sending works" : "How stealth sending works"}
        </h4>
        <div className="space-y-2 text-xs text-zinc-500">
          <p>→ Recipient shares their meta address (K:::V public keys)</p>
          <p>→ You generate a fresh one-time stealth address using their keys</p>
          {isXcm
            ? <>
                <p>→ Funds are sent via XCM from Para {sourcePara} to the stealth address on Para {destPara}</p>
                <p>→ Announcement is stored on Para {sourcePara} (scan there to discover payments)</p>
              </>
            : <p>→ Funds arrive at an address nobody can link to the recipient</p>
          }
          <p>→ Only the recipient can discover and spend (using Scan)</p>
        </div>
      </div>
    </div>
  );
}
