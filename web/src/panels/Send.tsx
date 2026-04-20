import { useState, useEffect } from "react";
import { Send as SendIcon, ArrowRight, CheckCircle, Loader, ClipboardPaste } from "lucide-react";
import { ethers } from "ethers";
import { wasmApi } from "../wasm";
import { getContract, deriveStealthAddress } from "../chain";
import {
  getApi,
  sendStealthXcm,
  sendStealthAsset,
  sendStealthAssetXcm,
  deriveSubstrateStealthAddress,
  rToBytes64,
  getBalance,
  getAssetBalance,
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
type TokenType = "pas" | "usdc";

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
  const [tokenType, setTokenType] = useState<TokenType>("pas");
  const [balance, setBalance] = useState<string | null>(null);

  const isXcm = mode === "xcm";

  // Fetch balance kad se promeni signer, token tip ili para
  useEffect(() => {
    setBalance(null);
    if (!subSigner && !signer) return;
    let cancelled = false;

    async function fetchBalance() {
      try {
        if (isXcm && subSigner) {
          const paraId = tokenType === "usdc" && sourcePara !== destPara ? sourcePara : (tokenType === "usdc" ? destPara : sourcePara);
          const api = await getApi(paraId);
          if (tokenType === "usdc") {
            const raw = await getAssetBalance(api, subSigner.address, 1);
            if (!cancelled) setBalance((Number(raw) / 1_000_000).toFixed(2) + " USDC");
          } else {
            const raw = await getBalance(api, subSigner.address);
            if (!cancelled) setBalance((Number(raw) / 1e12).toFixed(4) + " PAS");
          }
        } else if (!isXcm && signer) {
          const addr = await signer.getAddress();
          const provider = (signer as any).provider;
          if (provider) {
            const raw = await provider.getBalance(addr);
            if (!cancelled) setBalance((Number(raw) / 1e18).toFixed(4) + " PAS");
          }
        }
      } catch { /* ignore */ }
    }

    fetchBalance();
    return () => { cancelled = true; };
  }, [subSigner, signer, tokenType, sourcePara, destPara, isXcm]);

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

        // Encode ephemeral pubkey R → 64 bytes
        const ephemeralPubkey = rToBytes64(resolved.ephemeralKey);

        // Encode viewTag: WASM returns 1-byte hex (e.g. "ab"), pallet expects [u8;2]
        const rawVt = resolved.viewTag.replace(/^0x/, "");
        const vtByte = parseInt(rawVt.slice(0, 2), 16);
        const viewTag = new Uint8Array([vtByte, 0x00]);

        // Metadata: 32 zero bytes
        const metadata = new Uint8Array(32);

        let hash: string;

        if (tokenType === "usdc") {
          const amountUsdc = BigInt(Math.round(parseFloat(amount) * 1_000_000)); // 6 decimals
          if (sourcePara !== destPara) {
            // Cross-chain USDC via XCM Transact (burn on source, mint on dest)
            const api = await getApi(sourcePara);
            hash = await sendStealthAssetXcm(
              api,
              subSigner,
              1, // asset ID 1 = USDC
              destPara,
              resolved.stealthAddress,
              amountUsdc,
              ephemeralPubkey,
              viewTag,
              metadata
            );
            toast(`Sent ${amount} USDC via XCM to stealth address!`, "success");
          } else {
            // Same-chain USDC: assets.transfer + announce (batchAll)
            const api = await getApi(destPara);
            hash = await sendStealthAsset(
              api,
              subSigner,
              1,
              resolved.stealthAddress,
              amountUsdc,
              ephemeralPubkey,
              viewTag,
              metadata
            );
            toast(`Sent ${amount} USDC to stealth address!`, "success");
          }
        } else {
          // XCM PAS: cross-chain teleport
          const api = await getApi(sourcePara);
          const amountPlanck = BigInt(Math.round(parseFloat(amount) * 1_000_000_000_000));
          hash = await sendStealthXcm(
            api,
            subSigner,
            destPara,
            resolved.stealthAddress,
            amountPlanck,
            ephemeralPubkey,
            viewTag,
            metadata
          );
          toast(`Sent ${amount} PAS via XCM!`, "success");
        }

        setTxHash(hash);
        setStep("done");

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

  function reset() { setStep("idle"); setResolved(null); setTxHash(""); setMetaInput(""); setError(""); setAmount("1"); }

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
            <span className="font-semibold text-zinc-200">{amount} {!isXcm ? "PAS" : tokenType === "usdc" ? "USDC" : "PAS"}</span> sent to{" "}
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
      {canSend && balance !== null && (
        <div className="rounded-lg bg-zinc-800/60 border border-zinc-700/40 px-4 py-2.5 flex items-center justify-between">
          <span className="text-xs text-zinc-500">Your balance</span>
          <span className="text-sm font-semibold text-zinc-200">{balance}</span>
        </div>
      )}

      {/* Token selector — only in XCM mode */}
      {isXcm && (
        <div className="card">
          <label className="label mb-2 block">Token</label>
          <div className="flex gap-2">
            <button
              onClick={() => { setTokenType("pas"); setStep("idle"); setResolved(null); setAmount("1"); }}
              className={`flex-1 py-2.5 rounded-lg text-sm border transition-colors ${tokenType === "pas" ? "border-violet-500 bg-violet-950/50 text-violet-300" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}
            >
              <div className="font-semibold">PAS</div>
              <div className="text-xs text-zinc-500">XCM cross-chain</div>
            </button>
            <button
              onClick={() => { setTokenType("usdc"); setStep("idle"); setResolved(null); setAmount("1"); }}
              className={`flex-1 py-2.5 rounded-lg text-sm border transition-colors ${tokenType === "usdc" ? "border-blue-500 bg-blue-950/50 text-blue-300" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}
            >
              <div className="font-semibold">USDC</div>
              <div className="text-xs text-zinc-500">{sourcePara !== destPara ? "XCM cross-chain" : `Same-chain (Para ${destPara})`}</div>
            </button>
          </div>
          {tokenType === "usdc" && sourcePara !== destPara && (
            <p className="text-xs text-zinc-500 mt-2">
              Spaljuje USDC na Para {sourcePara}, mintuje na stealth adresu na Para {destPara} via XCM — announcement na Para {destPara}.
            </p>
          )}
          {tokenType === "usdc" && sourcePara === destPara && (
            <p className="text-xs text-zinc-500 mt-2">
              Šalje USDC (asset ID 1) na stealth adresu na Para {destPara} i kreira announcement — primalac može da skenira.
            </p>
          )}
          {tokenType === "pas" && (
            <p className="text-xs text-zinc-500 mt-2">
              Teleportuje PAS sa Para {sourcePara} na stealth adresu na Para {destPara} via XCM.
            </p>
          )}
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
            <span className="text-zinc-400 font-medium">
              {!isXcm ? "PAS" : tokenType === "usdc" ? "USDC" : "PAS"}
            </span>
          </div>
          {isXcm && tokenType === "pas" && (
            <p className="text-xs text-zinc-500 mt-2">
              1 PAS = 10¹² planck. Min preporučeno: 2 (da pokrije XCM fees).
            </p>
          )}
          {isXcm && tokenType === "usdc" && (
            <p className="text-xs text-zinc-500 mt-2">
              USDC ima 6 decimala. Npr. 5 = 5.000000 USDC.
            </p>
          )}
          <button
            onClick={sendFunds}
            disabled={!canSend || step === "sending" || !amount}
            className="btn-primary w-full mt-4 flex items-center justify-center gap-2"
          >
            {step === "sending" ? (
              <><Loader size={14} className="animate-spin" /> {isXcm && tokenType === "pas" ? "Sending XCM…" : "Sending…"}</>
            ) : (
              <><SendIcon size={14} /> Send {amount} {!isXcm ? "PAS" : tokenType === "usdc" ? "USDC" : "PAS"} <ArrowRight size={12} /> {resolved.stealthAddress.slice(0, 8)}…</>
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
          {isXcm && tokenType === "pas" && (
            <>
              <p>→ PAS sent via XCM from Para {sourcePara} to stealth address on Para {destPara}</p>
              <p>→ Announcement stored on Para {sourcePara} — scan Para {sourcePara}→{destPara} to find it</p>
            </>
          )}
          {isXcm && tokenType === "usdc" && sourcePara !== destPara && (
            <>
              <p>→ USDC burned on Para {sourcePara}, minted on stealth address on Para {destPara} via XCM</p>
              <p>→ Announcement stored on Para {destPara} — scan Para {destPara}→{destPara} to find it</p>
            </>
          )}
          {isXcm && tokenType === "usdc" && sourcePara === destPara && (
            <>
              <p>→ USDC transferred to stealth address on Para {destPara} (same-chain)</p>
              <p>→ Announcement stored on Para {destPara} — scan Para {destPara}→{destPara} to find it</p>
            </>
          )}
          {!isXcm && <p>→ Funds arrive at an address nobody can link to the recipient</p>}
          <p>→ Only the recipient can discover and spend (using Scan)</p>
        </div>
      </div>
    </div>
  );
}
