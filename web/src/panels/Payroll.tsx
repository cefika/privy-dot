import { useState, useRef } from "react";
import {
  Upload, Play, CheckCircle, XCircle, Loader, FileText,
  Download, ChevronDown, ChevronUp, Trash2, Layers
} from "lucide-react";
import { wasmApi } from "../wasm";
import { ethers } from "ethers";
import { sendAndAnnounceViaPrecompile } from "../chain";
import {
  getApi, sendStealthAsset,
  deriveSubstrateStealthAddress, rToBytes64,
  mkStealthXcmCall, mkStealthAssetXcmCall, mkStealthAssetCalls, submitBatchAll,
} from "../substrate";
import type { SubstrateSigner } from "../substrate";

interface Props {
  mode: "evm" | "xcm";
  signer: ethers.Signer | null;
  subSigner: SubstrateSigner | null;
  sourcePara: number;
  destPara: number;
  toast: (msg: string, type?: "success" | "error" | "info") => void;
}

type RowStatus = "pending" | "computing" | "sending" | "done" | "error";
type TokenType = "pas" | "usdc";

interface PayrollRow {
  id: number;
  name: string;
  metaAddress: string;
  amount: string;
  tokenType: TokenType;
  // Computed
  K?: string;
  V?: string;
  stealthAddress?: string;
  ephemeralKey?: string;
  viewTag?: string;
  status: RowStatus;
  error?: string;
  txHash?: string;
}

function parseMetaAddress(raw: string): { K: string; V: string } | null {
  const parts = raw.trim().split(":::");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { K: parts[0], V: parts[1] };
}

function parseCSV(text: string): PayrollRow[] {
  const lines = text.trim().split("\n").filter(l => l.trim());
  const rows: PayrollRow[] = [];
  let id = 0;
  for (const line of lines) {
    // Skip header line
    if (line.toLowerCase().includes("name") && line.toLowerCase().includes("meta")) continue;
    const cols = line.split(",").map(c => c.trim().replace(/^"|"$/g, ""));
    if (cols.length < 3) continue;
    const [name, metaAddress, amountRaw] = cols;
    if (!name || !metaAddress || !amountRaw) continue;
    // Parse "100 PAS", "100 USDC", or plain "100" (defaults to PAS)
    const match = amountRaw.trim().match(/^([\d.]+)\s*(pas|usdc)?$/i);
    if (!match) continue;
    const amount = match[1];
    const tokenType: TokenType = match[2]?.toLowerCase() === "usdc" ? "usdc" : "pas";
    rows.push({ id: id++, name, metaAddress, amount, tokenType, status: "pending" });
  }
  return rows;
}

const EXAMPLE_CSV = `name,meta_address,amount
Alice Smith,K_PUBLIC_KEY:::V_PUBLIC_KEY,100 PAS
Bob Jones,K_PUBLIC_KEY:::V_PUBLIC_KEY,150 USDC`;

export default function PayrollPanel({ mode, signer, subSigner, sourcePara, destPara, toast }: Props) {
  const [rows, setRows] = useState<PayrollRow[]>([]);
  const [running, setRunning] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const isXcm = mode === "xcm";

  function updateRow(id: number, patch: Partial<PayrollRow>) {
    setRows(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
  }

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target?.result as string;
      const parsed = parseCSV(text);
      if (parsed.length === 0) {
        toast("No valid rows found in CSV. Check format: name, meta_address, amount (e.g. 100 PAS)", "error");
        return;
      }
      setRows(parsed);
      toast(`Loaded ${parsed.length} employee${parsed.length > 1 ? "s" : ""}`, "success");
    };
    reader.readAsText(file);
  }

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
    e.target.value = "";
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f && f.name.endsWith(".csv")) handleFile(f);
  }

  function downloadExample() {
    const blob = new Blob([EXAMPLE_CSV], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "payroll-template.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  function exportResults() {
    const lines = ["name,meta_address,amount,token,stealth_address,tx_hash,status"];
    for (const r of rows) {
      lines.push([r.name, r.metaAddress, r.amount, r.tokenType.toUpperCase(), r.stealthAddress ?? "", r.txHash ?? "", r.status].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "payroll-results.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  async function computeAll(): Promise<PayrollRow[]> {
    const pending = rows.filter(r => r.status === "pending" && !r.stealthAddress);
    // Build a local snapshot so sendAll can use fresh data without stale closure
    let snapshot = rows.map(r => ({ ...r }));
    for (const row of pending) {
      const meta = parseMetaAddress(row.metaAddress);
      if (!meta) {
        const patch = { status: "error" as const, error: "Invalid meta address format (expected K:::V)" };
        updateRow(row.id, patch);
        snapshot = snapshot.map(r => r.id === row.id ? { ...r, ...patch } : r);
        continue;
      }
      updateRow(row.id, { status: "computing" });
      try {
        const result = await wasmApi.send(meta.K, meta.V);
        const stealthAddress = isXcm
          ? deriveSubstrateStealthAddress(result.spendingPubKey)
          : result.spendingPubKey;
        const patch = {
          K: meta.K, V: meta.V,
          stealthAddress,
          ephemeralKey: result.R,
          viewTag: result.viewTag,
          status: "pending" as const,
        };
        updateRow(row.id, patch);
        snapshot = snapshot.map(r => r.id === row.id ? { ...r, ...patch } : r);
      } catch (e: unknown) {
        const patch = { status: "error" as const, error: e instanceof Error ? e.message : "Computation failed" };
        updateRow(row.id, patch);
        snapshot = snapshot.map(r => r.id === row.id ? { ...r, ...patch } : r);
      }
    }
    return snapshot;
  }

  async function sendAll() {
    if (!signer && !subSigner) {
      toast("Connect a wallet first", "error");
      return;
    }
    setRunning(true);
    const currentRows = await computeAll();

    const toSend = currentRows.filter(r => r.status === "pending" && r.stealthAddress);
    if (toSend.length === 0) {
      setRunning(false);
      toast("Nothing to send", "info");
      return;
    }

    try {
      if (isXcm && subSigner) {
        // ── Batch mode: build all calls, submit in one tx ────────────────────
        const api = await getApi(sourcePara);
        const calls: ReturnType<typeof mkStealthXcmCall>[] = [];
        const validRows: typeof toSend = [];

        for (const row of toSend) {
          if (!row.stealthAddress || !row.ephemeralKey || !row.viewTag) continue;
          updateRow(row.id, { status: "sending" });
          const ephBytes = rToBytes64(row.ephemeralKey);
          const vtByte = parseInt(row.viewTag.replace(/^0x/, ""), 16);
          const vtBytes = new Uint8Array([vtByte, 0x00]);
          const meta = new Uint8Array(32);

          if (row.tokenType === "usdc") {
            const amountUsdc = BigInt(Math.round(parseFloat(row.amount) * 1_000_000));
            if (sourcePara !== destPara) {
              calls.push(mkStealthAssetXcmCall(api, 1, destPara, row.stealthAddress, amountUsdc, ephBytes, vtBytes, meta));
            } else {
              // same-chain: assets.transfer + announce (2 calls per row)
              calls.push(...mkStealthAssetCalls(api, 1, row.stealthAddress, amountUsdc, ephBytes, vtBytes, meta));
            }
          } else {
            const amountBig = BigInt(Math.round(parseFloat(row.amount) * 1e12));
            calls.push(mkStealthXcmCall(api, destPara, row.stealthAddress, amountBig, ephBytes, vtBytes, meta));
          }
          validRows.push(row);
        }

        const txHash = await submitBatchAll(api, subSigner, calls);
        for (const row of validRows) {
          updateRow(row.id, { status: "done", txHash });
        }
        toast(`Payroll sent: ${validRows.length} employees in 1 batch tx`, "success");

      } else if (!isXcm && signer) {
        // ── EVM mode: sequential (no batchAll on EVM side) ───────────────────
        let sent = 0;
        for (const row of toSend) {
          if (!row.stealthAddress || !row.ephemeralKey || !row.viewTag) continue;
          updateRow(row.id, { status: "sending" });
          try {
            const ephBytes = rToBytes64(row.ephemeralKey);
            const vtByte = parseInt(row.viewTag.replace(/^0x/, ""), 16);
            const vtBytes = new Uint8Array([vtByte, 0x00]);
            const stealthHex = row.stealthAddress.startsWith("0x") ? row.stealthAddress.slice(2) : row.stealthAddress;
            const stealthBytes = new Uint8Array(32);
            for (let i = 0; i < 32; i++) stealthBytes[i] = parseInt(stealthHex.slice(i * 2, i * 2 + 2), 16);
            const txHash = await sendAndAnnounceViaPrecompile(signer, stealthBytes, row.amount, ephBytes, vtBytes);
            updateRow(row.id, { status: "done", txHash });
            sent++;
          } catch (e: unknown) {
            updateRow(row.id, { status: "error", error: e instanceof Error ? e.message : "Send failed" });
          }
        }
        toast(`Payroll sent: ${sent} transactions`, "success");
      } else if (isXcm && !subSigner && subSigner === null) {
        // same-chain USDC fallback (no XCM)
        const api = await getApi(sourcePara);
        let sent = 0;
        for (const row of toSend) {
          if (!row.stealthAddress || !row.ephemeralKey || !row.viewTag) continue;
          updateRow(row.id, { status: "sending" });
          try {
            const ephBytes = rToBytes64(row.ephemeralKey);
            const vtByte = parseInt(row.viewTag.replace(/^0x/, ""), 16);
            const vtBytes = new Uint8Array([vtByte, 0x00]);
            const meta = new Uint8Array(32);
            const amountUsdc = BigInt(Math.round(parseFloat(row.amount) * 1_000_000));
            const txHash = await sendStealthAsset(api, subSigner!, 1, row.stealthAddress, amountUsdc, ephBytes, vtBytes, meta);
            updateRow(row.id, { status: "done", txHash });
            sent++;
          } catch (e: unknown) {
            updateRow(row.id, { status: "error", error: e instanceof Error ? e.message : "Send failed" });
          }
        }
        toast(`Payroll sent: ${sent} transactions`, "success");
      }
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : "Batch send failed", "error");
      for (const row of toSend) {
        updateRow(row.id, { status: "error", error: e instanceof Error ? e.message : "Batch failed" });
      }
    }

    setRunning(false);
  }

  const totalPas = rows.filter(r => r.tokenType === "pas").reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
  const totalUsdc = rows.filter(r => r.tokenType === "usdc").reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);

  const doneCount = rows.filter(r => r.status === "done").length;
  const errorCount = rows.filter(r => r.status === "error").length;
  const computedCount = rows.filter(r => r.stealthAddress).length;

  const totalDisplay = [
    totalPas > 0 ? `${totalPas.toFixed(2)} PAS` : null,
    totalUsdc > 0 ? `${totalUsdc.toFixed(2)} USDC` : null,
  ].filter(Boolean).join(" + ") || "0";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-zinc-100">Payroll Dashboard</h2>
        <p className="text-zinc-400 mt-1 text-sm">Upload a CSV, preview stealth addresses, and send salary in batch</p>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={downloadExample} className="btn-secondary flex items-center gap-1.5 text-xs">
          <FileText size={12} /> Download CSV template
        </button>
        {rows.length > 0 && doneCount > 0 && (
          <button onClick={exportResults} className="btn-secondary flex items-center gap-1.5 text-xs">
            <Download size={12} /> Export results
          </button>
        )}
        {rows.length > 0 && (
          <button onClick={() => setRows([])} className="text-xs text-zinc-500 hover:text-red-400 flex items-center gap-1 transition-colors ml-auto">
            <Trash2 size={12} /> Clear
          </button>
        )}
      </div>

      {/* Upload zone */}
      {rows.length === 0 && (
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => fileRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-all ${
            dragOver
              ? "border-polka-500 bg-polka-500/10"
              : "border-zinc-700 hover:border-zinc-500 hover:bg-zinc-800/30"
          }`}
        >
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={onFileInput} />
          <Upload size={36} className="mx-auto mb-3 text-zinc-500" />
          <p className="text-zinc-300 font-medium">Drop CSV file here or click to browse</p>
          <p className="text-xs text-zinc-500 mt-2">Format: <span className="font-mono">name, meta_address, amount</span> — e.g. <span className="font-mono">100 PAS</span> or <span className="font-mono">150 USDC</span></p>
        </div>
      )}

      {/* Stats bar */}
      {rows.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Employees", value: rows.length, color: "text-zinc-200" },
            { label: "Total", value: totalDisplay, color: "text-polka-300" },
            { label: "Sent", value: doneCount, color: "text-emerald-400" },
            { label: "Errors", value: errorCount, color: errorCount > 0 ? "text-red-400" : "text-zinc-500" },
          ].map(s => (
            <div key={s.label} className="card py-3 text-center">
              <p className={`text-xl font-bold font-display ${s.color}`}>{s.value}</p>
              <p className="text-xs text-zinc-500 mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Action buttons */}
      {rows.length > 0 && (
        <div className="flex gap-3 flex-wrap">
          <button
            onClick={computeAll}
            disabled={running || computedCount === rows.length}
            className="btn-secondary flex items-center gap-2 text-sm disabled:opacity-40"
          >
            <CheckCircle size={14} />
            {computedCount === rows.length ? "All addresses computed" : `Compute stealth addresses (${rows.length - computedCount} remaining)`}
          </button>
          <button
            onClick={sendAll}
            disabled={running || rows.every(r => r.status === "done")}
            className="btn-primary flex items-center gap-2 text-sm disabled:opacity-40"
          >
            {running
              ? <Loader size={14} className="animate-spin" />
              : isXcm ? <Layers size={14} /> : <Play size={14} />}
            {running ? "Sending…" : isXcm ? "Send Payroll (batch)" : "Send Payroll"}
          </button>
        </div>
      )}

      {/* Payroll table */}
      {rows.length > 0 && (
        <div className="card p-0 overflow-hidden">
          <button
            onClick={() => setShowPreview(v => !v)}
            className="w-full flex items-center justify-between px-4 py-3 border-b border-zinc-800 text-sm font-medium text-zinc-300 hover:bg-zinc-800/30 transition-colors"
          >
            <span>Payroll Preview — {rows.length} employees</span>
            {showPreview ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>

          {showPreview && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-500 text-left">
                    <th className="px-4 py-2 font-medium">Name</th>
                    <th className="px-4 py-2 font-medium">Amount</th>
                    <th className="px-4 py-2 font-medium">Stealth Address</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={row.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/20 transition-colors">
                      <td className="px-4 py-2.5 text-zinc-200 font-medium">{row.name}</td>
                      <td className="px-4 py-2.5 font-mono">
                        <span className="text-polka-300">{row.amount}</span>
                        <span className={`ml-1 text-xs font-semibold ${row.tokenType === "usdc" ? "text-blue-400" : "text-polka-400"}`}>
                          {row.tokenType.toUpperCase()}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-zinc-400">
                        {row.stealthAddress
                          ? `${row.stealthAddress.slice(0, 10)}…${row.stealthAddress.slice(-6)}`
                          : <span className="text-zinc-600 italic">not computed</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge row={row} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ row }: { row: PayrollRow }) {
  switch (row.status) {
    case "pending":
      return <span className="text-zinc-500">Pending</span>;
    case "computing":
      return <span className="flex items-center gap-1 text-yellow-400"><Loader size={10} className="animate-spin" /> Computing…</span>;
    case "sending":
      return <span className="flex items-center gap-1 text-blue-400"><Loader size={10} className="animate-spin" /> Sending…</span>;
    case "done":
      return (
        <span className="flex items-center gap-1 text-emerald-400">
          <CheckCircle size={11} />
          {row.txHash ? (
            <span className="font-mono">{row.txHash.slice(0, 8)}…</span>
          ) : "Done"}
        </span>
      );
    case "error":
      return (
        <span className="flex items-center gap-1 text-red-400" title={row.error}>
          <XCircle size={11} /> Error
        </span>
      );
  }
}