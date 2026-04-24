import { useState } from "react";
import { Search, Loader, CheckCircle, Download, Eye, EyeOff, AlertCircle, X } from "lucide-react";
import { wasmApi } from "../wasm";
import { getApi, fetchAnnouncements, getBalance, getAssetBalance, deriveSubstrateStealthAddress, bytes64ToR } from "../substrate";

interface Props {
  sourcePara: number;
  destPara: number;
  toast: (msg: string, type?: "success" | "error" | "info") => void;
}

interface AuditRow {
  index: number;
  stealthAddress: string;
  spendingPubKey: string;
  balancePas: bigint;
  balanceUsdc: bigint;
  ephemeralKey: string;
  viewTag: string;
}

export default function AuditPanel({ sourcePara, destPara, toast }: Props) {
  const [spendingPubKey, setSpendingPubKey] = useState("");
  const [viewingKey, setViewingKey] = useState("");
  const [viewingPubKey, setViewingPubKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState<AuditRow[] | null>(null);
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [addressFilter, setAddressFilter] = useState("");

  async function runAudit() {
    if (!spendingPubKey.trim() || !viewingKey.trim() || !viewingPubKey.trim()) {
      toast("Enter all three fields: spending public key, viewing public key, and viewing private key", "error");
      return;
    }
    setScanning(true);
    setResults(null);
    try {
      const api = await getApi(sourcePara);
      const announcements = await fetchAnnouncements(api);
      if (announcements.length === 0) {
        setResults([]);
        setScannedAt(new Date().toLocaleString());
        toast("No announcements found on chain", "info");
        setScanning(false);
        return;
      }
      const Rs = announcements.map(a => bytes64ToR(a.ephemeralPubkey));
      const viewTags = announcements.map(a => a.viewTag[0].toString(16).padStart(2, "0"));
      const scanResult = await wasmApi.scanAudit(
        spendingPubKey.trim(),
        viewingKey.trim(),
        Rs,
        viewTags
      );
      const destApi = await getApi(destPara);
      const rows: AuditRow[] = [];
      for (let i = 0; i < (scanResult as { spendingPubKeys: string[] }).spendingPubKeys.length; i++) {
        const pubKey = (scanResult as { spendingPubKeys: string[] }).spendingPubKeys[i];
        if (!pubKey) continue;
        const stealthAddress = deriveSubstrateStealthAddress(pubKey);
        const balPas = await getBalance(destApi, stealthAddress);
        const balUsdc = await getAssetBalance(destApi, stealthAddress, 1);
        rows.push({
          index: i,
          stealthAddress,
          spendingPubKey: pubKey,
          balancePas: balPas,
          balanceUsdc: balUsdc,
          ephemeralKey: Rs[i],
          viewTag: viewTags[i],
        });
      }
      setResults(rows);
      setScannedAt(new Date().toLocaleString());
      toast(`Found ${rows.length} payment${rows.length !== 1 ? "s" : ""}`, rows.length > 0 ? "success" : "info");
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : "Audit failed", "error");
    } finally {
      setScanning(false);
    }
  }

  function exportCSV() {
    if (!results) return;
    const lines = ["stealth_address,balance_pas,balance_usdc,ephemeral_key,view_tag"];
    for (const r of results) {
      lines.push([
        r.stealthAddress,
        (Number(r.balancePas) / 1e12).toFixed(4),
        (Number(r.balanceUsdc) / 1_000_000).toFixed(2),
        r.ephemeralKey,
        r.viewTag,
      ].join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "audit-report.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  const filtered = results?.filter(r =>
    addressFilter.trim() === "" || r.stealthAddress.toLowerCase().includes(addressFilter.trim().toLowerCase())
  ) ?? [];
  const totalPas = results?.reduce((s, r) => s + r.balancePas, 0n) ?? 0n;
  const totalUsdc = results?.reduce((s, r) => s + r.balanceUsdc, 0n) ?? 0n;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-zinc-100">Government Audit</h2>
        <p className="text-zinc-400 mt-1 text-sm">
          View all payments received by an employee using their viewing key — read-only, no access to funds
        </p>
      </div>

      {/* Warning */}
      <div className="flex gap-3 p-3 rounded-lg bg-amber-950/30 border border-amber-700/30">
        <AlertCircle size={15} className="text-amber-400 shrink-0 mt-0.5" />
        <p className="text-xs text-amber-300 leading-relaxed">
          The viewing key (v) + spending public key (K) reveal all incoming payments to this employee
          but cannot be used to move funds. Handle with care — store securely and limit access.
        </p>
      </div>

      {/* Key input */}
      <div className="card space-y-4">
        <h3 className="font-semibold text-zinc-100 text-sm">Enter Viewing Key Package</h3>

        <div className="space-y-1">
          <label className="text-xs text-zinc-400 font-medium uppercase tracking-wider">Spending Public Key (K)</label>
          <input
            value={spendingPubKey}
            onChange={e => setSpendingPubKey(e.target.value)}
            className="input-field w-full font-mono text-xs"
            placeholder="decimal X.Y format…"
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs text-zinc-400 font-medium uppercase tracking-wider">Viewing Public Key (V)</label>
          <input
            value={viewingPubKey}
            onChange={e => setViewingPubKey(e.target.value)}
            className="input-field w-full font-mono text-xs"
            placeholder="decimal X.Y format…"
          />
        </div>

        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <label className="text-xs text-zinc-400 font-medium uppercase tracking-wider">Viewing Private Key (v)</label>
            <button onClick={() => setShowKey(v => !v)} className="text-zinc-500 hover:text-zinc-300">
              {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
          </div>
          <input
            type={showKey ? "text" : "password"}
            value={viewingKey}
            onChange={e => setViewingKey(e.target.value)}
            className="input-field w-full font-mono text-xs"
            placeholder="hex string…"
          />
        </div>

        <button
          onClick={runAudit}
          disabled={scanning}
          className="btn-primary flex items-center gap-2 w-full justify-center"
        >
          {scanning ? <Loader size={14} className="animate-spin" /> : <Search size={14} />}
          {scanning ? "Scanning blockchain…" : "Run Audit"}
        </button>
      </div>

      {/* Results */}
      {results !== null && (
        <div className="space-y-4">
          {/* Summary */}
          <div className="grid grid-cols-3 gap-3">
            <div className="card py-3 text-center">
              <p className="text-xl font-bold text-zinc-100">{results.length}</p>
              <p className="text-xs text-zinc-500 mt-0.5">Payments found</p>
            </div>
            <div className="card py-3 text-center">
              <p className="text-xl font-bold text-polka-300">{(Number(totalPas) / 1e12).toFixed(4)}</p>
              <p className="text-xs text-zinc-500 mt-0.5">Total PAS</p>
            </div>
            <div className="card py-3 text-center">
              <p className="text-xl font-bold text-blue-300">{(Number(totalUsdc) / 1_000_000).toFixed(2)}</p>
              <p className="text-xs text-zinc-500 mt-0.5">Total USDC</p>
            </div>
          </div>

          {scannedAt && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-zinc-500">Scanned at {scannedAt} · Para {sourcePara}</p>
              {results.length > 0 && (
                <button onClick={exportCSV} className="btn-secondary flex items-center gap-1.5 text-xs">
                  <Download size={12} /> Export CSV
                </button>
              )}
            </div>
          )}

          {results.length === 0 ? (
            <div className="card text-center py-8 text-zinc-500">
              <CheckCircle size={32} className="mx-auto mb-2 opacity-30" />
              <p>No payments found for this viewing key</p>
            </div>
          ) : (
            <div className="space-y-2">
              {/* Filter */}
              <div className="relative">
                <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  value={addressFilter}
                  onChange={e => setAddressFilter(e.target.value)}
                  className="input-field w-full pl-8 pr-8 text-xs py-2"
                  placeholder="Filter by stealth address…"
                />
                {addressFilter && (
                  <button onClick={() => setAddressFilter("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300">
                    <X size={12} />
                  </button>
                )}
              </div>

              <div className="card p-0 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-zinc-800 text-zinc-500 text-left">
                        <th className="px-4 py-2 font-medium">#</th>
                        <th className="px-4 py-2 font-medium">Stealth Address</th>
                        <th className="px-4 py-2 font-medium">Balance PAS</th>
                        <th className="px-4 py-2 font-medium">Balance USDC</th>
                        <th className="px-4 py-2 font-medium">View Tag</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-4 py-6 text-center text-zinc-600">No results match the filter</td>
                        </tr>
                      ) : filtered.map((r, i) => (
                        <tr key={r.index} className="border-b border-zinc-800/50 hover:bg-zinc-800/20 transition-colors">
                          <td className="px-4 py-2.5 text-zinc-500">{i + 1}</td>
                          <td className="px-4 py-2.5 font-mono text-zinc-300">
                            {r.stealthAddress.slice(0, 10)}…{r.stealthAddress.slice(-6)}
                          </td>
                          <td className="px-4 py-2.5 text-polka-300 font-mono">
                            {r.balancePas > 0n ? (Number(r.balancePas) / 1e12).toFixed(4) : "—"}
                          </td>
                          <td className="px-4 py-2.5 text-blue-300 font-mono">
                            {r.balanceUsdc > 0n ? (Number(r.balanceUsdc) / 1_000_000).toFixed(2) : "—"}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-zinc-500">{r.viewTag}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}