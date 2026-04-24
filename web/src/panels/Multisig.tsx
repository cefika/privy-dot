import { useState, useEffect, useCallback } from "react";
import {
  ShieldCheck, Plus, Trash2, Copy, RefreshCw, CheckCircle,
  XCircle, Loader, Clock, Send, ChevronDown, ChevronUp, AlertTriangle,
} from "lucide-react";
import { wasmApi } from "../wasm";
import {
  getApi, signerAddress, computeMultisigAddress, sortSignatories,
  getCallHash, getCallHex, decodeCall, getBalance,
  submitMultisigInitiate, submitMultisigApprove, submitMultisigExecute,
  cancelMultisig, getMultisigOnChainInfo,
  deriveSubstrateStealthAddress, rToBytes64, mkStealthXcmCall, mkStealthAssetXcmCall,
} from "../substrate";
import type { SubstrateSigner, MultisigTimepoint } from "../substrate";

interface Props {
  subSigner: SubstrateSigner | null;
  sourcePara: number;
  destPara: number;
  toast: (msg: string, type?: "success" | "error" | "info") => void;
}

type Tab = "setup" | "newtx" | "pending";
type TokenType = "pas" | "usdc";

// ── LocalStorage persistence ──────────────────────────────────────────────────

const STORE_KEY = "privy-multisig-txs";

export interface StoredMultisigTx {
  callHash: string;
  callHex: string;
  description: string;
  threshold: number;
  signatories: string[];      // sorted
  multisigAddress: string;
  timepoint: MultisigTimepoint | null;
  createdBy: string;
  createdAt: string;
  sourcePara: number;
  destPara: number;
}

function loadPendingTxs(): StoredMultisigTx[] {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]"); }
  catch { return []; }
}

function savePendingTxs(txs: StoredMultisigTx[]) {
  localStorage.setItem(STORE_KEY, JSON.stringify(txs));
}

function upsertPendingTx(tx: StoredMultisigTx) {
  const rest = loadPendingTxs().filter(t => t.callHash !== tx.callHash);
  savePendingTxs([...rest, tx]);
}

function removePendingTx(callHash: string) {
  savePendingTxs(loadPendingTxs().filter(t => t.callHash !== callHash));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseMetaAddress(raw: string): { K: string; V: string } | null {
  const parts = raw.trim().split(":::");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { K: parts[0], V: parts[1] };
}

function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MultisigPanel({ subSigner, sourcePara, destPara, toast }: Props) {
  const [tab, setTab] = useState<Tab>("setup");

  // ── Setup state ──
  const [threshold, setThreshold] = useState(2);
  const [signatories, setSignatories] = useState<string[]>([]);
  const [newAddr, setNewAddr] = useState("");
  const [multisigAddr, setMultisigAddr] = useState("");
  const [multisigBalance, setMultisigBalance] = useState<string | null>(null);

  // ── New TX state ──
  const [metaInput, setMetaInput] = useState("");
  const [amount, setAmount] = useState("");
  const [tokenType, setTokenType] = useState<TokenType>("pas");
  const [stealthAddress, setStealthAddress] = useState("");
  const [ephemeralKey, setEphemeralKey] = useState("");
  const [viewTag, setViewTag] = useState("");
  const [computing, setComputing] = useState(false);
  const [initiating, setInitiating] = useState(false);

  // ── Pending state ──
  const [pendingTxs, setPendingTxs] = useState<StoredMultisigTx[]>([]);
  const [onChainInfo, setOnChainInfo] = useState<Record<string, { approvals: string[]; timepoint: MultisigTimepoint } | null>>({});
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [expandedTx, setExpandedTx] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const myAddress = subSigner ? signerAddress(subSigner) : "";

  // Auto-add own address when signer connects
  useEffect(() => {
    if (!myAddress) return;
    setSignatories(prev => prev.includes(myAddress) ? prev : [myAddress, ...prev]);
  }, [myAddress]);

  // Recompute multisig address
  useEffect(() => {
    if (signatories.length < 2 || threshold < 1 || threshold > signatories.length) {
      setMultisigAddr("");
      return;
    }
    try {
      setMultisigAddr(computeMultisigAddress(signatories, threshold));
    } catch { setMultisigAddr(""); }
  }, [signatories, threshold]);

  // Fetch multisig balance
  useEffect(() => {
    if (!multisigAddr) { setMultisigBalance(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const api = await getApi(sourcePara);
        const bal = await getBalance(api, multisigAddr);
        if (!cancelled) setMultisigBalance((Number(bal) / 1e12).toFixed(4));
      } catch { if (!cancelled) setMultisigBalance("?"); }
    })();
    return () => { cancelled = true; };
  }, [multisigAddr, sourcePara]);

  // Load pending TXs
  useEffect(() => {
    setPendingTxs(loadPendingTxs());
  }, [tab]);

  // Refresh on-chain status for pending TXs
  const refreshOnChain = useCallback(async () => {
    const txs = loadPendingTxs();
    if (txs.length === 0) return;
    setRefreshing(true);
    try {
      const api = await getApi(sourcePara);
      const updates: Record<string, { approvals: string[]; timepoint: MultisigTimepoint } | null> = {};
      for (const tx of txs) {
        try {
          const info = await getMultisigOnChainInfo(api, tx.multisigAddress, tx.callHash);
          if (info) {
            updates[tx.callHash] = { approvals: info.approvals, timepoint: info.when };
            // Sync timepoint into localStorage if missing
            if (!tx.timepoint) {
              upsertPendingTx({ ...tx, timepoint: info.when });
            }
          } else {
            updates[tx.callHash] = null;
          }
        } catch { updates[tx.callHash] = null; }
      }
      setOnChainInfo(updates);
      setPendingTxs(loadPendingTxs());
    } finally { setRefreshing(false); }
  }, [sourcePara]);

  useEffect(() => {
    if (tab === "pending") refreshOnChain();
  }, [tab, refreshOnChain]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  function addSignatory() {
    const addr = newAddr.trim();
    if (!addr) return;
    if (signatories.includes(addr)) { toast("Address already added", "error"); return; }
    setSignatories(prev => [...prev, addr]);
    setNewAddr("");
  }

  function removeSignatory(addr: string) {
    if (addr === myAddress) { toast("Cannot remove your own address", "error"); return; }
    setSignatories(prev => prev.filter(a => a !== addr));
  }

  async function computeStealth() {
    const meta = parseMetaAddress(metaInput);
    if (!meta) { toast("Invalid meta address format (expected K:::V)", "error"); return; }
    setComputing(true);
    setStealthAddress(""); setEphemeralKey(""); setViewTag("");
    try {
      const result = await wasmApi.send(meta.K, meta.V);
      setStealthAddress(deriveSubstrateStealthAddress(result.spendingPubKey));
      setEphemeralKey(result.R);
      setViewTag(result.viewTag);
      toast("Stealth address computed", "success");
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : "Computation failed", "error");
    } finally { setComputing(false); }
  }

  async function initiateMultisigTx() {
    if (!subSigner) { toast("Connect a wallet first", "error"); return; }
    if (!stealthAddress || !ephemeralKey || !viewTag) { toast("Compute stealth address first", "error"); return; }
    if (!amount || isNaN(parseFloat(amount))) { toast("Enter a valid amount", "error"); return; }
    if (signatories.length < 2) { toast("Need at least 2 signatories", "error"); return; }
    if (threshold < 1 || threshold > signatories.length) { toast("Invalid threshold", "error"); return; }

    setInitiating(true);
    try {
      const api = await getApi(sourcePara);
      const ephBytes = rToBytes64(ephemeralKey);
      const vtByte = parseInt(viewTag.replace(/^0x/, ""), 16);
      const vtBytes = new Uint8Array([vtByte, 0x00]);
      const meta = new Uint8Array(32);

      let innerCall;
      let description: string;
      if (tokenType === "usdc") {
        const amountUsdc = BigInt(Math.round(parseFloat(amount) * 1_000_000));
        innerCall = mkStealthAssetXcmCall(api, 1, destPara, stealthAddress, amountUsdc, ephBytes, vtBytes, meta);
        description = `Send ${amount} USDC → ${shortAddr(stealthAddress)} (para ${destPara})`;
      } else {
        const amountBig = BigInt(Math.round(parseFloat(amount) * 1e12));
        innerCall = mkStealthXcmCall(api, destPara, stealthAddress, amountBig, ephBytes, vtBytes, meta);
        description = `Send ${amount} PAS → ${shortAddr(stealthAddress)} (para ${destPara})`;
      }

      const callHash = getCallHash(innerCall);
      const callHex = getCallHex(innerCall);
      const sortedSignatories = sortSignatories(signatories);
      const msigAddr = computeMultisigAddress(signatories, threshold);

      const { txHash, timepoint } = await submitMultisigInitiate(api, subSigner, threshold, signatories, innerCall);

      const stored: StoredMultisigTx = {
        callHash, callHex, description, threshold,
        signatories: sortedSignatories,
        multisigAddress: msigAddr,
        timepoint,
        createdBy: myAddress,
        createdAt: new Date().toISOString(),
        sourcePara, destPara,
      };
      upsertPendingTx(stored);
      setPendingTxs(loadPendingTxs());

      toast(`Multisig TX initiated (${txHash.slice(0, 10)}…). ${threshold - 1} more approval(s) needed.`, "success");
      setTab("pending");
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : "Failed to initiate TX", "error");
    } finally { setInitiating(false); }
  }

  async function approveTx(tx: StoredMultisigTx) {
    if (!subSigner) { toast("Connect wallet first", "error"); return; }
    const timepoint = tx.timepoint ?? onChainInfo[tx.callHash]?.timepoint;
    if (!timepoint) { toast("Timepoint not yet available — refresh on-chain status", "error"); return; }
    setActionLoading(tx.callHash + "_approve");
    try {
      const api = await getApi(sourcePara);
      const txHash = await submitMultisigApprove(api, subSigner, tx.threshold, tx.signatories, timepoint, tx.callHash);
      toast(`Approved (${txHash.slice(0, 10)}…)`, "success");
      await refreshOnChain();
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : "Approval failed", "error");
    } finally { setActionLoading(null); }
  }

  async function executeTx(tx: StoredMultisigTx) {
    if (!subSigner) { toast("Connect wallet first", "error"); return; }
    const timepoint = tx.timepoint ?? onChainInfo[tx.callHash]?.timepoint;
    if (!timepoint) { toast("Timepoint not yet available — refresh on-chain status", "error"); return; }
    setActionLoading(tx.callHash + "_execute");
    try {
      const api = await getApi(sourcePara);
      const call = decodeCall(api, tx.callHex);
      const txHash = await submitMultisigExecute(api, subSigner, tx.threshold, tx.signatories, timepoint, call);
      removePendingTx(tx.callHash);
      setPendingTxs(loadPendingTxs());
      toast(`Executed! TX: ${txHash.slice(0, 10)}…`, "success");
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : "Execution failed", "error");
    } finally { setActionLoading(null); }
  }

  async function cancelTx(tx: StoredMultisigTx) {
    if (!subSigner) { toast("Connect wallet first", "error"); return; }
    const timepoint = tx.timepoint ?? onChainInfo[tx.callHash]?.timepoint;
    if (!timepoint) { toast("Timepoint not yet available", "error"); return; }
    setActionLoading(tx.callHash + "_cancel");
    try {
      const api = await getApi(sourcePara);
      await cancelMultisig(api, subSigner, tx.threshold, tx.signatories, timepoint, tx.callHash);
      removePendingTx(tx.callHash);
      setPendingTxs(loadPendingTxs());
      toast("Multisig TX cancelled", "success");
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : "Cancel failed", "error");
    } finally { setActionLoading(null); }
  }

  function removeLocal(callHash: string) {
    removePendingTx(callHash);
    setPendingTxs(loadPendingTxs());
    toast("Removed from local list", "info");
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const pendingCount = pendingTxs.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-zinc-100 flex items-center gap-2">
          <ShieldCheck size={22} className="text-polka-400" /> Multisig
        </h2>
        <p className="text-zinc-400 mt-1 text-sm">M-of-N approval for stealth transactions — one signature isn't enough</p>
      </div>

      {!subSigner && (
        <div className="card flex items-center gap-3 text-amber-400 text-sm border-amber-500/30">
          <AlertTriangle size={16} className="shrink-0" />
          Connect a Substrate wallet to use multisig
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-zinc-800">
        {([
          { id: "setup", label: "Setup" },
          { id: "newtx", label: "New Transaction" },
          { id: "pending", label: `Pending${pendingCount > 0 ? ` (${pendingCount})` : ""}` },
        ] as { id: Tab; label: string }[]).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t.id
                ? "border-polka-500 text-polka-300"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── SETUP TAB ──────────────────────────────────────────────────────── */}
      {tab === "setup" && (
        <div className="space-y-5">
          {/* Threshold */}
          <div className="card space-y-3">
            <h3 className="text-sm font-semibold text-zinc-200">Threshold</h3>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={1}
                max={signatories.length || 1}
                value={threshold}
                onChange={e => setThreshold(Math.max(1, Math.min(signatories.length, parseInt(e.target.value) || 1)))}
                className="input-field w-20 text-center text-lg font-bold"
              />
              <span className="text-zinc-400 text-sm">of {signatories.length} signatories required</span>
            </div>
            <p className="text-xs text-zinc-500">Any {threshold} of the {signatories.length} signatories below must approve before a transaction executes.</p>
          </div>

          {/* Signatories */}
          <div className="card space-y-3">
            <h3 className="text-sm font-semibold text-zinc-200">Signatories</h3>
            <div className="space-y-2">
              {signatories.map(addr => (
                <div key={addr} className="flex items-center gap-2 bg-zinc-800/50 rounded-lg px-3 py-2">
                  <div className={`w-2 h-2 rounded-full shrink-0 ${addr === myAddress ? "bg-polka-400" : "bg-zinc-500"}`} />
                  <span className="font-mono text-xs text-zinc-300 flex-1 truncate">{addr}</span>
                  {addr === myAddress
                    ? <span className="text-xs text-polka-400 shrink-0">you</span>
                    : <button onClick={() => removeSignatory(addr)} className="text-zinc-600 hover:text-red-400 shrink-0"><Trash2 size={12} /></button>
                  }
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                className="input-field flex-1 text-xs"
                placeholder="Add signatory address (SS58)…"
                value={newAddr}
                onChange={e => setNewAddr(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addSignatory()}
              />
              <button onClick={addSignatory} className="btn-secondary flex items-center gap-1 text-xs px-3">
                <Plus size={12} /> Add
              </button>
            </div>
          </div>

          {/* Derived multisig address */}
          {multisigAddr ? (
            <div className="card space-y-3">
              <h3 className="text-sm font-semibold text-zinc-200">Multisig Address</h3>
              <div className="flex items-center gap-2 bg-zinc-800/60 rounded-lg px-3 py-2.5">
                <span className="font-mono text-xs text-polka-300 flex-1 break-all">{multisigAddr}</span>
                <button
                  onClick={() => { navigator.clipboard.writeText(multisigAddr); toast("Copied!", "success"); }}
                  className="text-zinc-500 hover:text-zinc-300 shrink-0"
                >
                  <Copy size={13} />
                </button>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-zinc-500">Balance</span>
                <span className="font-mono text-zinc-200">
                  {multisigBalance !== null ? `${multisigBalance} PAS` : <Loader size={12} className="animate-spin inline" />}
                </span>
              </div>
              <p className="text-xs text-zinc-500">
                Fund this address with PAS before initiating transactions. Fees are paid by each signer individually.
              </p>
            </div>
          ) : signatories.length >= 2 ? (
            <p className="text-xs text-zinc-600">Enter a valid threshold to derive the multisig address.</p>
          ) : (
            <p className="text-xs text-zinc-600">Add at least 2 signatories to derive the multisig address.</p>
          )}
        </div>
      )}

      {/* ── NEW TX TAB ─────────────────────────────────────────────────────── */}
      {tab === "newtx" && (
        <div className="space-y-4">
          {!multisigAddr && (
            <div className="card flex items-center gap-3 text-amber-400 text-sm border-amber-500/30">
              <AlertTriangle size={15} className="shrink-0" />
              Configure multisig signatories in Setup first
            </div>
          )}

          <div className="card space-y-4">
            <h3 className="text-sm font-semibold text-zinc-200">Recipient</h3>
            <div>
              <label className="text-xs text-zinc-500 mb-1 block">Meta address (K:::V)</label>
              <textarea
                className="input-field w-full text-xs font-mono h-20 resize-none"
                placeholder="K_public_key:::V_public_key"
                value={metaInput}
                onChange={e => { setMetaInput(e.target.value); setStealthAddress(""); }}
              />
            </div>

            <div className="flex gap-3">
              <div className="flex-1">
                <label className="text-xs text-zinc-500 mb-1 block">Amount</label>
                <input
                  className="input-field w-full"
                  placeholder="0.00"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs text-zinc-500 mb-1 block">Token</label>
                <select
                  value={tokenType}
                  onChange={e => setTokenType(e.target.value as TokenType)}
                  className="input-field h-[42px]"
                >
                  <option value="pas">PAS</option>
                  <option value="usdc">USDC</option>
                </select>
              </div>
            </div>

            {stealthAddress && (
              <div className="bg-zinc-800/50 rounded-lg px-3 py-2.5 space-y-1">
                <p className="text-xs text-zinc-500">Stealth address (computed)</p>
                <p className="font-mono text-xs text-emerald-400 break-all">{stealthAddress}</p>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={computeStealth}
                disabled={computing || !metaInput.trim()}
                className="btn-secondary flex items-center gap-2 text-sm disabled:opacity-40"
              >
                {computing ? <Loader size={14} className="animate-spin" /> : <CheckCircle size={14} />}
                {stealthAddress ? "Recompute" : "Compute stealth address"}
              </button>
              <button
                onClick={initiateMultisigTx}
                disabled={initiating || !stealthAddress || !amount || !multisigAddr || !subSigner}
                className="btn-primary flex items-center gap-2 text-sm disabled:opacity-40"
              >
                {initiating ? <Loader size={14} className="animate-spin" /> : <Send size={14} />}
                {initiating ? "Initiating…" : `Initiate (1 of ${threshold} approvals)`}
              </button>
            </div>

            {multisigAddr && (
              <p className="text-xs text-zinc-500">
                Funds will be sent from <span className="font-mono text-zinc-300">{shortAddr(multisigAddr)}</span>.
                You are signing the initiation TX — your wallet pays the fee.
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── PENDING TAB ────────────────────────────────────────────────────── */}
      {tab === "pending" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-zinc-400">{pendingTxs.length === 0 ? "No pending multisig transactions" : `${pendingTxs.length} pending transaction(s)`}</p>
            <button
              onClick={refreshOnChain}
              disabled={refreshing}
              className="btn-secondary flex items-center gap-1.5 text-xs"
            >
              <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>

          {pendingTxs.length === 0 && (
            <div className="card text-center py-10 text-zinc-600">
              <Clock size={32} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">No pending approvals</p>
              <p className="text-xs mt-1">Initiate a multisig transaction from the New Transaction tab</p>
            </div>
          )}

          {pendingTxs.map(tx => {
            const chainInfo = onChainInfo[tx.callHash];
            const approvals = chainInfo?.approvals ?? [];
            const approvalCount = approvals.length;
            const hasApproved = approvals.some(a => a === myAddress || a.toLowerCase() === myAddress.toLowerCase());
            const canExecute = approvalCount >= tx.threshold - 1 && !hasApproved;
            const canApprove = !hasApproved && !canExecute && tx.signatories.includes(myAddress);
            const isInitiator = tx.createdBy === myAddress;
            const isExpanded = expandedTx === tx.callHash;
            const isExecuted = chainInfo === null && tx.timepoint !== null;
            const loadKey_approve = tx.callHash + "_approve";
            const loadKey_execute = tx.callHash + "_execute";
            const loadKey_cancel = tx.callHash + "_cancel";

            return (
              <div key={tx.callHash} className="card space-y-3">
                {/* Header row */}
                <div className="flex items-start gap-3">
                  <div className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${isExecuted ? "bg-zinc-600" : approvalCount >= tx.threshold ? "bg-emerald-400" : "bg-amber-400 animate-pulse"}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-zinc-200 truncate">{tx.description}</p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      {approvalCount}/{tx.threshold} approvals
                      {isExecuted ? " · Executed (or expired)" : ""}
                      {" · "}{new Date(tx.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <button onClick={() => setExpandedTx(isExpanded ? null : tx.callHash)} className="text-zinc-600 hover:text-zinc-400 shrink-0">
                    {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                </div>

                {/* Approval indicators */}
                <div className="flex flex-wrap gap-2">
                  {tx.signatories.map(addr => {
                    const approved = approvals.some(a => a === addr || a.toLowerCase() === addr.toLowerCase());
                    return (
                      <span key={addr} className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${
                        approved ? "border-emerald-700 text-emerald-400 bg-emerald-950/40" : "border-zinc-700 text-zinc-500"
                      }`}>
                        {approved ? <CheckCircle size={10} /> : <Clock size={10} />}
                        {shortAddr(addr)}
                        {addr === myAddress && " (you)"}
                      </span>
                    );
                  })}
                </div>

                {/* Expanded details */}
                {isExpanded && (
                  <div className="border-t border-zinc-800 pt-3 space-y-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="text-zinc-500 w-24">Multisig addr</span>
                      <span className="font-mono text-zinc-300 break-all">{tx.multisigAddress}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-zinc-500 w-24">Call hash</span>
                      <span className="font-mono text-zinc-400">{tx.callHash.slice(0, 20)}…</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-zinc-500 w-24">Timepoint</span>
                      <span className="text-zinc-400">
                        {tx.timepoint ? `block ${tx.timepoint.height}, idx ${tx.timepoint.index}` : "pending…"}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-zinc-500 w-24">Threshold</span>
                      <span className="text-zinc-400">{tx.threshold} of {tx.signatories.length}</span>
                    </div>
                  </div>
                )}

                {/* Action buttons */}
                {!isExecuted && (
                  <div className="flex gap-2 flex-wrap pt-1">
                    {canApprove && (
                      <button
                        onClick={() => approveTx(tx)}
                        disabled={actionLoading === loadKey_approve}
                        className="btn-secondary flex items-center gap-1.5 text-xs disabled:opacity-40"
                      >
                        {actionLoading === loadKey_approve ? <Loader size={11} className="animate-spin" /> : <CheckCircle size={11} />}
                        Approve
                      </button>
                    )}
                    {canExecute && (
                      <button
                        onClick={() => executeTx(tx)}
                        disabled={actionLoading === loadKey_execute}
                        className="btn-primary flex items-center gap-1.5 text-xs disabled:opacity-40"
                      >
                        {actionLoading === loadKey_execute ? <Loader size={11} className="animate-spin" /> : <Send size={11} />}
                        Execute (last approval)
                      </button>
                    )}
                    {hasApproved && !canExecute && (
                      <span className="text-xs text-zinc-500 flex items-center gap-1">
                        <CheckCircle size={11} className="text-emerald-500" /> You approved — waiting for others
                      </span>
                    )}
                    {isInitiator && (
                      <button
                        onClick={() => cancelTx(tx)}
                        disabled={actionLoading === loadKey_cancel}
                        className="text-xs text-zinc-600 hover:text-red-400 flex items-center gap-1 ml-auto transition-colors disabled:opacity-40"
                      >
                        {actionLoading === loadKey_cancel ? <Loader size={11} className="animate-spin" /> : <XCircle size={11} />}
                        Cancel
                      </button>
                    )}
                  </div>
                )}

                {isExecuted && (
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-xs text-zinc-600 italic">No longer active on-chain</span>
                    <button onClick={() => removeLocal(tx.callHash)} className="text-xs text-zinc-600 hover:text-red-400 flex items-center gap-1">
                      <Trash2 size={11} /> Remove
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}