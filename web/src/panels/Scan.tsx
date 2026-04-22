import { useState } from "react";
import { Radar, Send, Eye, EyeOff, Loader } from "lucide-react";
import { ethers } from "ethers";
import { wasmApi } from "../wasm";
import { provider, deriveStealthAddress, signerFromPrivKey } from "../chain";
import {
  getApi,
  fetchAnnouncementsSince,
  loadLastNonce,
  saveLastNonce,
  getBalance,
  getAssetBalance,
  deriveSubstrateStealthAddress,
  bytes64ToR,
  spendFromStealth,
  spendAllFromStealth,
  sendAssetFromStealth,
  withdrawFromStealth,
  sponsorGas,
  getSponsorBalance,
  signerAddress,
} from "../substrate";
import type { SubstrateSigner } from "../substrate";
import type { KeyPairs, FoundAddress } from "../types";
import { mergeHistory } from "./History";

interface Props {
  mode: "evm" | "xcm";
  keys: KeyPairs | null;
  sourcePara: number;
  destPara: number;
  subSigner: SubstrateSigner | null;
  connectedAddress: string;
  found: FoundAddress[];
  setFound: React.Dispatch<React.SetStateAction<FoundAddress[]>>;
  toast: (msg: string, type?: "success" | "error") => void;
}

interface SpendModal {
  addr: FoundAddress;
  to: string;
  amount: string;
  loading: boolean;
  txHash: string;
  useWithdraw: boolean;   // true = pallet withdraw extrinsic, false = direct spend
  assetId: string;        // asset ID for pallet-assets withdrawal (empty = native)
}

export default function ScanPanel({ mode, keys, sourcePara, destPara, subSigner, connectedAddress, found, setFound, toast }: Props) {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState("");
  const [modal, setModal] = useState<SpendModal | null>(null);
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});

  const isXcm = mode === "xcm";

  async function scanXcm() {
    if (!keys) return;
    setScanning(true); setFound([]); setProgress("Fetching announcements from Para " + sourcePara + "…");
    try {
      const api = await getApi(sourcePara);
      const addr = subSigner ? signerAddress(subSigner) : "";
      const fromNonce = loadLastNonce(addr);
      const { rows: announcements, nextNonce } = await fetchAnnouncementsSince(api, fromNonce);
      setProgress(`Found ${announcements.length} new announcement(s). Running WASM scan…`);

      const Rs: string[] = [];
      const viewTags: string[] = [];

      for (const ann of announcements) {
        // Convert 64-byte ephemeral pubkey → "X.Y" string for WASM
        Rs.push(bytes64ToR(ann.ephemeralPubkey));
        // First byte of view_tag [u8;2] → hex string
        viewTags.push(ann.viewTag[0].toString(16).padStart(2, "0"));
      }

      if (Rs.length === 0) {
        if (addr) saveLastNonce(addr, nextNonce);
        setFound([]); setProgress("");
        toast("No new announcements since last scan");
        setScanning(false);
        return;
      }

      let result;
      try {
        result = await wasmApi.scan(keys.k, keys.v, Rs, viewTags);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("valid JSON") || msg.includes("already exited")) {
          throw new Error(
            "Storage sadrži matematički nevalidne ephemeral pubkey vrednosti " +
            "(manual test unosi sa nulama). Restartuj zombienet i koristi " +
            "frontend Send panel — on uvek generiše validne kriptografske vrednosti."
          );
        }
        throw e;
      }

      const destApi = await getApi(destPara);
      const matches: FoundAddress[] = [];

      for (let i = 0; i < result.spendingPrivKeys.length; i++) {
        const privKey = result.spendingPrivKeys[i];
        const pubKey = result.spendingPubKeys[i];
        if (!privKey || privKey === "0x" || !pubKey) continue;

        const stealthAddress = deriveSubstrateStealthAddress(pubKey);
        const balPlanck = await getBalance(destApi, stealthAddress);
        const usdcBalance = await getAssetBalance(destApi, stealthAddress, 1);
        if (balPlanck === 0n && usdcBalance === 0n) continue; // već potrošeno, preskoči

        const balFormatted = (Number(balPlanck) / 1e12).toFixed(4);

        matches.push({
          stealthAddress,
          spendingPrivKey: privKey,
          spendingPubKey: pubKey,
          balance: balFormatted,
          balancePlanck: balPlanck,
          usdcBalance,
        });
      }

      if (addr) saveLastNonce(addr, nextNonce);
      setFound(matches);
      if (matches.length > 0 && subSigner) {
        mergeHistory(addr, matches.map(m => ({
          id: m.stealthAddress,
          stealthAddress: m.stealthAddress,
          balancePas: m.balance,
          balanceUsdc: (Number(m.usdcBalance ?? 0n) / 1_000_000).toFixed(2),
          scannedAt: new Date().toISOString(),
          sourcePara,
          spendingPubKey: m.spendingPubKey,
        })));
      }
      setProgress("");
      toast(`Scan complete — found ${matches.length} address(es)`, matches.length > 0 ? "success" : undefined);
    } catch (e: unknown) {
      setProgress("");
      toast(e instanceof Error ? e.message : "Scan failed", "error");
    } finally {
      setScanning(false);
    }
  }

  async function scanEvm() {
    if (!keys) return;
    setScanning(true); setFound([]); setProgress("Fetching announcements from pallet…");
    try {
      // EVM korisnici announce-uju kroz precompile → isti pallet storage kao Substrate
      const api = await getApi(sourcePara);
      const fromNonce = loadLastNonce(connectedAddress);
      const { rows: announcements, nextNonce } = await fetchAnnouncementsSince(api, fromNonce);
      setProgress(`Found ${announcements.length} new announcement(s). Running WASM scan…`);

      const Rs: string[] = [];
      const viewTags: string[] = [];

      for (const ann of announcements) {
        Rs.push(bytes64ToR(ann.ephemeralPubkey));
        viewTags.push(ann.viewTag[0].toString(16).padStart(2, "0"));
      }

      if (Rs.length === 0) {
        if (connectedAddress) saveLastNonce(connectedAddress, nextNonce);
        setFound([]); setProgress("");
        toast("No new announcements since last scan");
        setScanning(false);
        return;
      }

      const result = await wasmApi.scan(keys.k, keys.v, Rs, viewTags);

      // Poseban API za destPara — XCM transferi deponuju pare tamo, ne na sourcePara
      const destApi = sourcePara !== destPara ? await getApi(destPara) : api;

      const matches: FoundAddress[] = [];
      for (let i = 0; i < result.spendingPrivKeys.length; i++) {
        const privKey = result.spendingPrivKeys[i];
        const pubKey = result.spendingPubKeys[i];
        if (!privKey || privKey === "0x" || !pubKey) continue;

        // Provjeri EVM balans (H160 adresa — primljeno EVM sendom na Para 1000)
        const evmAddress = deriveStealthAddress(pubKey);
        const evmRaw = await provider.getBalance(evmAddress);
        if (evmRaw > 0n) {
          matches.push({
            stealthAddress: evmAddress,
            spendingPrivKey: privKey,
            spendingPubKey: pubKey,
            balance: parseFloat(ethers.formatEther(evmRaw)).toFixed(4),
            addressType: "evm",
          });
        }

        // Provjeri Substrate balans na DEST parachanu (XCM send ide sourcePara → destPara)
        const subAddress = deriveSubstrateStealthAddress(pubKey);
        const subBal = await getBalance(destApi, subAddress);
        const subUsdc = await getAssetBalance(destApi, subAddress, 1);
        if (subBal > 0n || subUsdc > 0n) {
          matches.push({
            stealthAddress: subAddress,
            spendingPrivKey: privKey,
            spendingPubKey: pubKey,
            balance: (Number(subBal) / 1e12).toFixed(4),
            balancePlanck: subBal,
            usdcBalance: subUsdc,
            addressType: "substrate",
          });
        }
      }

      if (connectedAddress) saveLastNonce(connectedAddress, nextNonce);
      setFound(matches);
      if (matches.length > 0 && connectedAddress) {
        mergeHistory(connectedAddress, matches.map(m => ({
          id: m.stealthAddress,
          stealthAddress: m.stealthAddress,
          balancePas: m.balance,
          balanceUsdc: (Number(m.usdcBalance ?? 0n) / 1_000_000).toFixed(2),
          scannedAt: new Date().toISOString(),
          sourcePara,
          spendingPubKey: m.spendingPubKey,
        })));
      }
      setProgress("");
      toast(`Scan complete — found ${matches.length} address(es)`, matches.length > 0 ? "success" : undefined);
    } catch (e: unknown) {
      setProgress("");
      toast(e instanceof Error ? e.message : "Scan failed", "error");
    } finally {
      setScanning(false);
    }
  }

  async function spendXcm() {
    if (!modal) return;
    setModal(m => m ? { ...m, loading: true } : m);
    try {
      const api = await getApi(destPara);
      let hash: string;

      if (modal.useWithdraw) {
        if (!subSigner) throw new Error("Connect a dev account in the sidebar to use Withdraw via Pallet");

        // Ensure sponsor has enough in the gas pool (WithdrawalFee = 0.01 DOT, MinDeposit = 1 DOT)
        const WITHDRAWAL_FEE = 10_000_000_000n;
        const MIN_DEPOSIT = 1_000_000_000_000n; // 1 DOT minimum
        const poolBal = await getSponsorBalance(api, signerAddress(subSigner));
        if (poolBal < WITHDRAWAL_FEE) {
          setModal(m => m ? { ...m, loading: true } : m);
          toast("Depositing sponsor gas (1 DOT)…");
          await sponsorGas(api, subSigner, MIN_DEPOSIT);
        }

        // Use the stealthAddresses pallet extrinsic (ECDSA-verified)
        const assetId = modal.assetId.trim() !== "" ? parseInt(modal.assetId, 10) : undefined;
        let withdrawAmount: bigint | undefined;
        if (modal.amount.trim() !== "") {
          if (assetId !== undefined) {
            // USDC: 6 decimals
            withdrawAmount = BigInt(Math.round(parseFloat(modal.amount) * 1_000_000));
            const maxUsdc = modal.addr.usdcBalance ?? 0n;
            if (withdrawAmount > maxUsdc) {
              toast(`Insufficient balance — max ${(Number(maxUsdc) / 1_000_000).toFixed(2)} USDC`, "error");
              setModal(m => m ? { ...m, loading: false } : m);
              return;
            }
          } else {
            // PAS: 12 decimals
            withdrawAmount = BigInt(Math.round(parseFloat(modal.amount) * 1_000_000_000_000));
            const maxPas = modal.addr.balancePlanck ?? 0n;
            if (withdrawAmount > maxPas) {
              toast(`Insufficient balance — max ${(Number(maxPas) / 1e12).toFixed(4)} PAS`, "error");
              setModal(m => m ? { ...m, loading: false } : m);
              return;
            }
          }
        }
        hash = await withdrawFromStealth(
          api,
          modal.addr.stealthAddress,
          modal.addr.spendingPrivKey,
          modal.to,
          subSigner,
          assetId,
          withdrawAmount
        );
      } else {
        // Direct balance transfer (signs tx with stealth keypair)
        const amountPlanck = BigInt(Math.round(parseFloat(modal.amount) * 1_000_000_000_000));
        hash = await spendFromStealth(api, modal.addr.spendingPrivKey, modal.to, amountPlanck);
      }

      setModal(m => m ? { ...m, txHash: hash } : m);
      toast("Withdrawal successful!", "success");
      const newBal = await getBalance(api, modal.addr.stealthAddress);
      setFound(f => f.map(a =>
        a.stealthAddress === modal.addr.stealthAddress
          ? { ...a, balance: (Number(newBal) / 1e12).toFixed(4), balancePlanck: newBal }
          : a
      ));
      setModal(null);
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : "Withdrawal failed", "error");
      setModal(m => m ? { ...m, loading: false } : m);
    }
  }

  async function spendEvm() {
    if (!modal) return;
    setModal(m => m ? { ...m, loading: true } : m);
    try {
      let txHash: string;

      if (modal.addr.addressType === "substrate") {
        const api = await getApi(destPara);
        if (modal.assetId !== "") {
          // USDC na substrate stealth adresi — potpisujemo direktno stealth ključem
          const amountUsdc = BigInt(Math.round(parseFloat(modal.amount) * 1_000_000));
          const maxUsdc = modal.addr.usdcBalance ?? 0n;
          if (amountUsdc > maxUsdc) {
            toast(`Insufficient USDC — max ${(Number(maxUsdc) / 1_000_000).toFixed(2)}`, "error");
            setModal(m => m ? { ...m, loading: false } : m);
            return;
          }
          txHash = await sendAssetFromStealth(api, modal.addr.spendingPrivKey, modal.to, parseInt(modal.assetId), amountUsdc);
          const newUsdc = await getAssetBalance(api, modal.addr.stealthAddress, 1);
          setFound(f => f.map(a =>
            a.stealthAddress === modal!.addr.stealthAddress ? { ...a, usdcBalance: newUsdc } : a
          ));
        } else if (modal.useWithdraw) {
          // Pallet Withdraw — iznos opcionalan (prazno = ceo balans)
          if (subSigner) {
            // Ima Substrate signer → koristi pallet extrinsic (sponsor plaća fee)
            let withdrawAmount: bigint | undefined;
            if (modal.amount.trim() !== "") {
              withdrawAmount = BigInt(Math.round(parseFloat(modal.amount) * 1_000_000_000_000));
            }
            txHash = await withdrawFromStealth(api, modal.addr.stealthAddress, modal.addr.spendingPrivKey, modal.to, subSigner, undefined, withdrawAmount);
          } else {
            // Nema Substrate signer → direktno transferAll (stealth ključ sam plaća fee)
            if (modal.amount.trim() !== "") {
              const amountPlanck = BigInt(Math.round(parseFloat(modal.amount) * 1_000_000_000_000));
              txHash = await spendFromStealth(api, modal.addr.spendingPrivKey, modal.to, amountPlanck);
            } else {
              txHash = await spendAllFromStealth(api, modal.addr.spendingPrivKey, modal.to);
            }
          }
          const newBal = await getBalance(api, modal.addr.stealthAddress);
          setFound(f => f.map(a =>
            a.stealthAddress === modal!.addr.stealthAddress
              ? { ...a, balance: (Number(newBal) / 1e12).toFixed(4), balancePlanck: newBal }
              : a
          ));
        } else {
          // Direktno — iznos obavezan
          const amountPlanck = BigInt(Math.round(parseFloat(modal.amount) * 1_000_000_000_000));
          txHash = await spendFromStealth(api, modal.addr.spendingPrivKey, modal.to, amountPlanck);
          const newBal = await getBalance(api, modal.addr.stealthAddress);
          setFound(f => f.map(a =>
            a.stealthAddress === modal!.addr.stealthAddress
              ? { ...a, balance: (Number(newBal) / 1e12).toFixed(4), balancePlanck: newBal }
              : a
          ));
        }
      } else {
        // Pare su na EVM strani — standardni EVM send
        const spendSigner = signerFromPrivKey(modal.addr.spendingPrivKey);
        const tx = await spendSigner.sendTransaction({ to: modal.to, value: ethers.parseEther(modal.amount) });
        txHash = tx.hash;
        await tx.wait();
        const raw = await provider.getBalance(modal.addr.stealthAddress);
        setFound(f => f.map(a =>
          a.stealthAddress === modal!.addr.stealthAddress ? { ...a, balance: ethers.formatEther(raw) } : a
        ));
      }

      setModal(m => m ? { ...m, txHash } : m);
      toast("Spent successfully!", "success");
      setModal(null);
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : "Spend failed", "error");
      setModal(m => m ? { ...m, loading: false } : m);
    }
  }

  const handleScan = isXcm ? scanXcm : scanEvm;
  const handleSpend = isXcm ? spendXcm : spendEvm;
  const canScan = isXcm ? (!!keys && !!subSigner) : !!keys;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-zinc-100">Scan Inbox</h2>
        <p className="text-zinc-400 mt-1 text-sm">
          {isXcm
            ? `Scan Para ${sourcePara} announcements — balances on Para ${destPara}`
            : "Scan the chain for stealth addresses sent to you"}
        </p>
      </div>

      {!keys && (
        <div className="rounded-lg bg-amber-950/40 border border-amber-700/40 px-4 py-3 text-amber-300 text-sm">
          Generate or import keys first to scan for stealth addresses.
        </div>
      )}

      {isXcm && !subSigner && (
        <div className="rounded-lg bg-amber-950/40 border border-amber-700/40 px-4 py-3 text-amber-300 text-sm">
          Connect a Substrate account in the sidebar.
        </div>
      )}

      <div className="card">
        <div className="flex gap-3 items-end">
          <div className="flex-1 space-y-1">
            {isXcm ? (
              <p className="text-xs text-zinc-400">
                Announcements: <span className="font-mono text-zinc-300">Para {sourcePara}</span>
                {" "}→ Balances: <span className="font-mono text-zinc-300">Para {destPara}</span>
              </p>
            ) : (
              <p className="text-xs text-zinc-400">Scan announcements on Para {sourcePara}</p>
            )}
            {connectedAddress && (() => {
              const n = loadLastNonce(connectedAddress);
              return n > 0 ? (
                <p className="text-xs text-zinc-500">
                  Scanning from announcement #{n} ·{" "}
                  <button
                    className="text-violet-400 hover:text-violet-300 underline"
                    onClick={() => { saveLastNonce(connectedAddress, 0); toast("Reset — next scan will check all announcements"); }}
                  >
                    Rescan from beginning
                  </button>
                </p>
              ) : null;
            })()}
          </div>
          <button
            onClick={handleScan}
            disabled={scanning || !canScan}
            className="btn-primary flex items-center gap-2 h-10"
          >
            {scanning ? <Loader size={14} className="animate-spin" /> : <Radar size={14} />}
            {scanning ? "Scanning…" : "Scan Chain"}
          </button>
        </div>
        {progress && (
          <p className="text-xs text-violet-300 mt-3 flex items-center gap-2">
            <Loader size={12} className="animate-spin" />{progress}
          </p>
        )}
      </div>

      {found.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-zinc-400 uppercase tracking-wider">
            Found {found.length} stealth address(es)
          </h3>
          {found.map(addr => (
            <div key={addr.stealthAddress} className="card border-emerald-700/30">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-2 h-2 rounded-full bg-emerald-400" />
                    <span className="text-xs text-zinc-500">
                      {isXcm
                        ? `Stealth AccountId32 (Para ${destPara})`
                        : addr.addressType === "substrate"
                          ? "Stealth AccountId32 (primljeno via XCM)"
                          : "Stealth EVM adresa"}
                    </span>
                  </div>
                  <p className="font-mono text-sm text-zinc-100 break-all">{addr.stealthAddress}</p>
                  <p className="text-2xl font-bold text-emerald-400 mt-2">
                    {addr.balance}
                    <span className="text-base font-medium text-zinc-400 ml-2">
                      {isXcm ? "PAS" : "PAS"}
                    </span>
                  </p>
                  {addr.usdcBalance !== undefined && addr.usdcBalance > 0n && (
                    <p className="text-lg font-semibold text-blue-400 mt-1">
                      {(Number(addr.usdcBalance) / 1_000_000).toFixed(2)}
                      <span className="text-sm font-medium text-zinc-400 ml-2">USDC</span>
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-3 pt-3 border-t border-zinc-700">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs text-zinc-500">Spending Private Key</span>
                  <button
                    onClick={() => setShowKey(s => ({ ...s, [addr.stealthAddress]: !s[addr.stealthAddress] }))}
                    className="text-zinc-600 hover:text-zinc-400"
                  >
                    {showKey[addr.stealthAddress] ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                </div>
                <p className="font-mono text-xs text-zinc-400 break-all">
                  {showKey[addr.stealthAddress] ? addr.spendingPrivKey : "••••••••••••••••••••••••••••••••••••••••••••••••"}
                </p>
              </div>

              <button
                onClick={() => setModal({ addr, to: "", amount: "", loading: false, txHash: "", useWithdraw: false, assetId: "" })}
                className="btn-primary w-full mt-4 flex items-center justify-center gap-2"
                disabled={addr.balance === "0.0000" && (addr.usdcBalance ?? 0n) === 0n}
              >
                <Send size={14} /> Spend / Withdraw
              </button>
            </div>
          ))}
        </div>
      )}

      {!scanning && found.length === 0 && progress === "" && (
        <div className="text-center py-12 text-zinc-600">
          <Radar size={40} className="mx-auto mb-3 opacity-30" />
          <p>No results yet — run a scan</p>
        </div>
      )}

      {/* Spend Modal */}
      {modal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-6 w-full max-w-md shadow-2xl">
            <h3 className="text-lg font-semibold text-zinc-100 mb-1">
              Spend from Stealth Address
            </h3>
            <p className="text-xs text-zinc-500 font-mono mb-4">{modal.addr.stealthAddress}</p>
            <div className="mb-4 space-y-1">
              <p className="text-sm text-zinc-400">
                Available: <span className="text-emerald-400 font-semibold">{modal.addr.balance} PAS</span>
              </p>
              {modal.addr.usdcBalance !== undefined && modal.addr.usdcBalance > 0n && (
                <p className="text-sm text-zinc-400">
                  USDC: <span className="text-blue-400 font-semibold">{(Number(modal.addr.usdcBalance) / 1_000_000).toFixed(2)} USDC</span>
                </p>
              )}
            </div>

            {modal.txHash ? (
              <div className="text-center py-4">
                <p className="text-zinc-300 text-sm mb-3">Transaction sent!</p>
                <p className="font-mono text-xs text-violet-400 break-all">{modal.txHash}</p>
                <button onClick={() => setModal(null)} className="btn-primary w-full mt-4">Close</button>
              </div>
            ) : (
              <div className="space-y-4">

                {/* Step 1: Token */}
                {(isXcm || modal.addr.addressType === "substrate") && (
                  <div>
                    <label className="label">1. Koji token šalješ?</label>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setModal(m => m ? { ...m, assetId: "", useWithdraw: false } : m)}
                        className={`flex-1 py-2.5 rounded-lg text-sm border transition-colors ${modal.assetId === "" ? "border-violet-500 bg-violet-950/50 text-violet-300" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}
                      >
                        <div className="font-semibold">PAS</div>
                        <div className="text-xs text-zinc-500">{modal.addr.balance}</div>
                      </button>
                      {modal.addr.usdcBalance !== undefined && modal.addr.usdcBalance > 0n && (
                        <button
                          onClick={() => setModal(m => m ? { ...m, assetId: "1", useWithdraw: true } : m)}
                          className={`flex-1 py-2.5 rounded-lg text-sm border transition-colors ${modal.assetId !== "" ? "border-blue-500 bg-blue-950/50 text-blue-300" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}
                        >
                          <div className="font-semibold">USDC</div>
                          <div className="text-xs text-zinc-500">{(Number(modal.addr.usdcBalance) / 1_000_000).toFixed(2)}</div>
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Step 2: Metod — samo za PAS */}
                {(isXcm || modal.addr.addressType === "substrate") && modal.assetId === "" && (
                  <div>
                    <label className="label">2. Kako šalješ?</label>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setModal(m => m ? { ...m, useWithdraw: false } : m)}
                        className={`flex-1 py-2.5 rounded-lg text-sm border transition-colors ${!modal.useWithdraw ? "border-violet-500 bg-violet-950/50 text-violet-300" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}
                      >
                        <div className="font-semibold">Direktno</div>
                        <div className="text-xs text-zinc-500">biraš iznos</div>
                      </button>
                      <button
                        onClick={() => setModal(m => m ? { ...m, useWithdraw: true } : m)}
                        className={`flex-1 py-2.5 rounded-lg text-sm border transition-colors ${modal.useWithdraw ? "border-violet-500 bg-violet-950/50 text-violet-300" : "border-zinc-700 text-zinc-400 hover:text-zinc-200"}`}
                      >
                        <div className="font-semibold">Pallet Withdraw</div>
                        <div className="text-xs text-zinc-500">biraš iznos</div>
                      </button>
                    </div>
                  </div>
                )}

                {/* Step 3: Destination */}
                <div>
                  <label className="label">{(isXcm || modal.addr.addressType === "substrate") && modal.assetId === "" ? "3." : "2."} Destination adresa</label>
                  <input
                    value={modal.to}
                    onChange={e => setModal(m => m ? { ...m, to: e.target.value } : m)}
                    className="input"
                    placeholder={isXcm ? "0x… or 5…" : "0x…"}
                  />
                </div>

                {/* Amount */}
                {modal.assetId !== "" ? (
                  /* USDC — required u EVM modu, optional u XCM modu */
                  <div>
                    <label className="label">3. Iznos (USDC){isXcm && <span className="text-zinc-500 font-normal"> — prazno = ceo balans</span>}</label>
                    <input
                      type="number"
                      value={modal.amount}
                      onChange={e => setModal(m => m ? { ...m, amount: e.target.value } : m)}
                      className="input"
                      placeholder={`max: ${(Number(modal.addr.usdcBalance ?? 0n) / 1_000_000).toFixed(2)}`}
                    />
                  </div>
                ) : (!modal.useWithdraw) ? (
                  /* Direct PAS — required */
                  <div>
                    <label className="label">{isXcm ? "4." : "3."} Iznos (PAS)</label>
                    <input
                      type="number"
                      value={modal.amount}
                      onChange={e => setModal(m => m ? { ...m, amount: e.target.value } : m)}
                      className="input"
                      placeholder="0.0"
                    />
                  </div>
                ) : (
                  /* Pallet Withdraw PAS — optional (empty = ceo balans) */
                  <div>
                    <label className="label">{isXcm ? "4." : "3."} Iznos (PAS) <span className="text-zinc-500 font-normal">— prazno = ceo balans</span></label>
                    <input
                      type="number"
                      value={modal.amount}
                      onChange={e => setModal(m => m ? { ...m, amount: e.target.value } : m)}
                      className="input"
                      placeholder={`max: ${modal.addr.balance}`}
                    />
                  </div>
                )}

                <div className="flex gap-2 mt-2">
                  <button
                    onClick={handleSpend}
                    disabled={modal.loading || !modal.to || ((!modal.useWithdraw && modal.assetId === "") && !modal.amount)}
                    className="btn-primary flex-1 flex items-center justify-center gap-2"
                  >
                    {modal.loading ? <Loader size={14} className="animate-spin" /> : <Send size={14} />}
                    {modal.loading ? "Processing…" : modal.useWithdraw ? `Withdraw ${modal.assetId !== "" ? "USDC" : "PAS"}` : "Send PAS"}
                  </button>
                  <button onClick={() => setModal(null)} className="btn-secondary">Cancel</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}