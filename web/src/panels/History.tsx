import { useState } from "react";
import { Clock, Download, Trash2, ChevronDown, ChevronUp, Copy, Check } from "lucide-react";
import type { HistoryEntry } from "../types";

interface Props {
  address: string;
}

const HISTORY_LS_KEY = (addr: string) => `privy-history-${addr.toLowerCase()}`;

export function loadHistory(addr: string): HistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_LS_KEY(addr)) ?? "[]");
  } catch { return []; }
}

export function saveHistory(addr: string, entries: HistoryEntry[]) {
  localStorage.setItem(HISTORY_LS_KEY(addr), JSON.stringify(entries));
}

export function mergeHistory(addr: string, newEntries: HistoryEntry[]) {
  const existing = loadHistory(addr);
  const existingIds = new Set(existing.map(e => e.id));
  const merged = [...existing, ...newEntries.filter(e => !existingIds.has(e.id))];
  // Keep latest 200 entries, sorted newest first
  merged.sort((a, b) => new Date(b.scannedAt).getTime() - new Date(a.scannedAt).getTime());
  const trimmed = merged.slice(0, 200);
  saveHistory(addr, trimmed);
  return trimmed;
}

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors"
    >
      {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
    </button>
  );
}

export default function HistoryPanel({ address }: Props) {
  const [entries, setEntries] = useState<HistoryEntry[]>(() => address ? loadHistory(address) : []);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<"all" | "pas" | "usdc">("all");

  function toggleExpand(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function clearHistory() {
    if (!confirm("Clear all transaction history? This cannot be undone.")) return;
    saveHistory(address, []);
    setEntries([]);
  }

  function exportCSV() {
    const lines = ["stealth_address,balance_pas,balance_usdc,scanned_at,para"];
    for (const e of entries) {
      lines.push([e.stealthAddress, e.balancePas, e.balanceUsdc, e.scannedAt, e.sourcePara].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "payment-history.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  const filtered = entries.filter(e => {
    if (filter === "pas") return parseFloat(e.balancePas) > 0;
    if (filter === "usdc") return parseFloat(e.balanceUsdc) > 0;
    return true;
  });

  const totalPas = entries.reduce((s, e) => s + parseFloat(e.balancePas), 0);
  const totalUsdc = entries.reduce((s, e) => s + parseFloat(e.balanceUsdc), 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-zinc-100">Payment History</h2>
        <p className="text-zinc-400 mt-1 text-sm">Stealth addresses discovered during scans — your received payments</p>
      </div>

      {entries.length === 0 ? (
        <div className="border border-dashed border-zinc-700 rounded-xl p-12 text-center">
          <Clock size={36} className="mx-auto mb-3 text-zinc-600" />
          <p className="text-zinc-400">No payment history yet</p>
          <p className="text-sm text-zinc-600 mt-1">Run a scan in the Scan tab to discover incoming payments</p>
        </div>
      ) : (
        <>
          {/* Summary */}
          <div className="grid grid-cols-3 gap-3">
            <div className="card py-3 text-center">
              <p className="text-xl font-bold text-zinc-100">{entries.length}</p>
              <p className="text-xs text-zinc-500 mt-0.5">Total payments</p>
            </div>
            <div className="card py-3 text-center">
              <p className="text-xl font-bold text-polka-300">{totalPas.toFixed(4)}</p>
              <p className="text-xs text-zinc-500 mt-0.5">Total PAS</p>
            </div>
            <div className="card py-3 text-center">
              <p className="text-xl font-bold text-blue-300">{totalUsdc.toFixed(2)}</p>
              <p className="text-xs text-zinc-500 mt-0.5">Total USDC</p>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex rounded-lg border border-zinc-700 overflow-hidden text-xs">
              {(["all", "pas", "usdc"] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1.5 font-medium transition-colors uppercase tracking-wider ${
                    filter === f ? "bg-polka-600 text-white" : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {f === "all" ? "All" : f.toUpperCase()}
                </button>
              ))}
            </div>
            <button onClick={exportCSV} className="btn-secondary flex items-center gap-1.5 text-xs">
              <Download size={12} /> Export CSV
            </button>
            <button onClick={clearHistory} className="text-xs text-zinc-500 hover:text-red-400 flex items-center gap-1 ml-auto transition-colors">
              <Trash2 size={12} /> Clear history
            </button>
          </div>

          {/* Entries */}
          <div className="space-y-2">
            {filtered.map(entry => (
              <div key={entry.id} className="card p-0 overflow-hidden">
                <button
                  onClick={() => toggleExpand(entry.id)}
                  className="w-full flex items-center gap-4 px-4 py-3 hover:bg-zinc-800/30 transition-colors text-left"
                >
                  <div className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-xs text-zinc-300 truncate">
                      {entry.stealthAddress.slice(0, 16)}…{entry.stealthAddress.slice(-8)}
                    </p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      {new Date(entry.scannedAt).toLocaleString()} · Para {entry.sourcePara}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 text-right">
                    {parseFloat(entry.balancePas) > 0 && (
                      <span className="text-sm font-semibold text-polka-300">{entry.balancePas} PAS</span>
                    )}
                    {parseFloat(entry.balanceUsdc) > 0 && (
                      <span className="text-sm font-semibold text-blue-300">{entry.balanceUsdc} USDC</span>
                    )}
                    {expanded.has(entry.id) ? <ChevronUp size={14} className="text-zinc-500" /> : <ChevronDown size={14} className="text-zinc-500" />}
                  </div>
                </button>

                {expanded.has(entry.id) && (
                  <div className="border-t border-zinc-800 px-4 py-3 space-y-2 bg-zinc-900/50">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-500 w-32 shrink-0">Stealth address</span>
                      <span className="font-mono text-xs text-zinc-300 flex-1 break-all">{entry.stealthAddress}</span>
                      <CopyBtn text={entry.stealthAddress} />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-500 w-32 shrink-0">Discovered</span>
                      <span className="text-xs text-zinc-300">{new Date(entry.scannedAt).toLocaleString()}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-zinc-500 w-32 shrink-0">Para</span>
                      <span className="text-xs text-zinc-300">{entry.sourcePara}</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}