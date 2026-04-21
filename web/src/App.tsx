import { useState, useEffect, useCallback, useRef } from "react";
import { ethers } from "ethers";
import { Key, Send, Radar, Wallet, WifiOff, X, CheckCircle, AlertCircle, Info, Loader } from "lucide-react";
import { initWasm, wasmApi } from "./wasm";
import { connectMetaMask, signerFromPrivKey, provider, registerMetaAddressViaPrecompile } from "./chain";
import { getDevAccount, getExtensionAccounts, signerFromExtensionAccount, signerAddress, PARACHAINS, disconnectAll, getBalance, getAssetBalance, getApi, fetchAnnouncements, deriveSubstrateStealthAddress, bytes64ToR, registerMetaAddress, secp256k1ToCompressed, bn254ToBytes64 } from "./substrate";

import type { SubstrateSigner, InjectedAccountWithMeta } from "./substrate";
import type { KeyPairs, Toast, FoundAddress } from "./types";
import KeysPanel from "./panels/Keys";
import SendPanel from "./panels/Send";
import ScanPanel from "./panels/Scan";

type Tab = "keys" | "send" | "scan";
type Mode = "evm" | "xcm";
type DevAccount = "alice" | "bob" | "charlie";

const NAV: { id: Tab; label: string; Icon: React.FC<{ size?: number | string; className?: string }> }[] = [
  { id: "keys", label: "My Keys", Icon: Key  },
  { id: "send", label: "Send",    Icon: Send },
  { id: "scan", label: "Scan",    Icon: Radar },
];

function keysLSKey(addr: string) { return `privy-keys-${addr.toLowerCase()}`; }
function loadKeys(addr: string): KeyPairs | null {
  try { return JSON.parse(localStorage.getItem(keysLSKey(addr)) ?? "null"); } catch { return null; }
}
function saveKeys(addr: string, k: KeyPairs) { localStorage.setItem(keysLSKey(addr), JSON.stringify(k)); }

let toastId = 0;

export default function App() {
  const [tab, setTab] = useState<Tab>("keys");
  const [mode, setMode] = useState<Mode>("xcm");
  const [wasmReady, setWasmReady] = useState(false);
  const [keys, setKeys] = useState<KeyPairs | null>(null);

  // EVM state
  const [signer, setSigner] = useState<ethers.Signer | null>(null);
  const [address, setAddress] = useState("");
  const [balance, setBalance] = useState("");
  const [blockNumber, setBlockNumber] = useState<number | null>(null);

  // XCM / Substrate state
  const [subSigner, setSubSigner] = useState<SubstrateSigner | null>(null);
  const [subAddress, setSubAddress] = useState("");
  const [devAccount, setDevAccount] = useState<DevAccount>("alice");
  const [extensionAccounts, setExtensionAccounts] = useState<InjectedAccountWithMeta[]>([]);
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [extensionLoading, setExtensionLoading] = useState(false);
  const [showDevInModal, setShowDevInModal] = useState(false);
  const [showPrivInModal, setShowPrivInModal] = useState(false);
  const [privKeyModal, setPrivKeyModal] = useState("");
  const [sourcePara, setSourcePara] = useState<number>(5186);
  const [destPara, setDestPara] = useState<number>(5186);
  const [subPas, setSubPas] = useState<string | null>(null);
  const [subUsdc, setSubUsdc] = useState<string | null>(null);
  const [autoScanning, setAutoScanning] = useState(false);

  const [foundAddresses, setFoundAddresses] = useState<FoundAddress[]>([]);

  const [toasts, setToasts] = useState<Toast[]>([]);

  // Track which EVM address has already been registered to avoid duplicate MetaMask popups
  const registeredEvmAddress = useRef<string>("");

  useEffect(() => { initWasm().then(() => setWasmReady(true)).catch(console.error); }, []);

  // EVM block ticker
  useEffect(() => {
    if (mode !== "evm") return;
    const tick = async () => { try { setBlockNumber(await provider.getBlockNumber()); } catch {} };
    tick();
    const id = setInterval(tick, 12_000);
    return () => clearInterval(id);
  }, [mode]);

  const refreshBalance = useCallback(async (addr: string) => {
    try {
      // Koristi MetaMask-ov provajder ako postoji — da bude konzistentno sa Send panelom
      const p = (signer as any)?.provider ?? provider;
      const b = await p.getBalance(addr);
      setBalance(parseFloat(ethers.formatEther(b)).toFixed(4));
    } catch { setBalance("—"); }
  }, [signer]);

  useEffect(() => {
    if (!address) return;
    refreshBalance(address);
    const id = setInterval(() => refreshBalance(address), 15_000);
    return () => clearInterval(id);
  }, [address, refreshBalance]);

  // Auto-scan u pozadini kad se konektuje acc sa keys
  useEffect(() => {
    if (!subSigner || !keys || !wasmReady) return;
    let cancelled = false;
    setAutoScanning(true);
    (async () => {
      try {
        const srcApi = await getApi(sourcePara);
        const announcements = await fetchAnnouncements(srcApi);
        if (announcements.length === 0 || cancelled) return;
        const Rs = announcements.map(a => bytes64ToR(a.ephemeralPubkey));
        const viewTags = announcements.map(a => a.viewTag[0].toString(16).padStart(2, "0"));
        const result = await wasmApi.scan(keys.k, keys.v, Rs, viewTags);
        if (cancelled) return;
        const destApi = await getApi(destPara);
        const matches: FoundAddress[] = [];
        for (let i = 0; i < result.spendingPrivKeys.length; i++) {
          const privKey = result.spendingPrivKeys[i];
          const pubKey = result.spendingPubKeys[i];
          if (!privKey || privKey === "0x" || !pubKey) continue;
          const stealthAddress = deriveSubstrateStealthAddress(pubKey);
          const balPlanck = await getBalance(destApi, stealthAddress);
          const usdcBalance = await getAssetBalance(destApi, stealthAddress, 1);
          if (balPlanck === 0n && usdcBalance === 0n) continue;
          matches.push({
            stealthAddress,
            spendingPrivKey: privKey,
            spendingPubKey: pubKey,
            balance: (Number(balPlanck) / 1e12).toFixed(4),
            balancePlanck: balPlanck,
            usdcBalance,
          });
        }
        if (!cancelled) setFoundAddresses(matches);
      } catch {}
      finally { setAutoScanning(false); }
    })();
    return () => { cancelled = true; };
  }, [subSigner, keys, sourcePara, destPara, wasmReady]);

  // Auto-register meta address kad su keys + subSigner dostupni (Substrate)
  useEffect(() => {
    if (!subSigner || !keys || !wasmReady) return;
    let cancelled = false;
    (async () => {
      try {
        const api = await getApi(sourcePara);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existing = await (api.query.stealthAddresses as any).stealthMetaAddressRegistry(signerAddress(subSigner));
        if (cancelled) return;
        if (existing.isNone || !existing.isSome) {
          await registerMetaAddress(api, subSigner, keys.K, keys.V);
          if (!cancelled) addToast("Meta address registered on-chain", "success");
        }
      } catch (e: unknown) {
        if (!cancelled) addToast(e instanceof Error ? e.message : "Registration failed", "error");
      }
    })();
    return () => { cancelled = true; };
  }, [subSigner, keys, sourcePara, wasmReady]);

  // Eksplicitna registracija na zahtev korisnika (dugme u Keys panelu)
  async function handleRegisterViaPrecompile() {
    if (!signer || !keys) return;
    try {
      const addr = await signer.getAddress();
      if (registeredEvmAddress.current === addr.toLowerCase()) {
        addToast("Already registered in this session", "info");
        return;
      }
      const spBytes = secp256k1ToCompressed(keys.K);
      const vpBytes = bn254ToBytes64(keys.V);
      const hash = await registerMetaAddressViaPrecompile(signer, spBytes, vpBytes);
      registeredEvmAddress.current = addr.toLowerCase();
      addToast(`Registered on-chain (${hash.slice(0, 10)}…)`, "success");
    } catch (e: unknown) {
      addToast(e instanceof Error ? e.message : "Registration failed", "error");
    }
  }

  useEffect(() => {
    setSubPas(null); setSubUsdc(null);
    if (!subSigner) return;
    let cancelled = false;
    (async () => {
      try {
        const api = await getApi(sourcePara);
        const pas = await getBalance(api, signerAddress(subSigner));
        const usdc = await getAssetBalance(api, signerAddress(subSigner), 1);
        if (!cancelled) {
          setSubPas((Number(pas) / 1e12).toFixed(4));
          setSubUsdc((Number(usdc) / 1_000_000).toFixed(2));
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [subSigner, sourcePara]);

  function onKeysChange(k: KeyPairs) {
    setKeys(k);
    const addr = mode === "evm" ? address : subAddress;
    if (addr) saveKeys(addr, k);
  }

  function addToast(message: string, type: Toast["type"] = "info") {
    const id = ++toastId;
    setToasts(t => [...t, { id, type, message }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4000);
  }

  // ── Wallet connect (unified) ──────────────────────────────────────────────

  async function openWalletModal() {
    setShowWalletModal(true);
    setExtensionLoading(true);
    try {
      const accounts = await getExtensionAccounts();
      setExtensionAccounts(accounts);
    } catch {
      setExtensionAccounts([]);
    } finally {
      setExtensionLoading(false);
    }
  }

  async function handleMetaMaskFromModal() {
    try {
      const { signer: s, address: a } = await connectMetaMask();
      setSigner(s); setAddress(a);
      setKeys(loadKeys(a));
      setMode("evm");
      setShowWalletModal(false);
      addToast("MetaMask connected!", "success");
    } catch (e: unknown) {
      addToast(e instanceof Error ? e.message : "MetaMask not found", "error");
    }
  }

  function handlePrivKeyFromModal() {
    try {
      const w = signerFromPrivKey(privKeyModal.trim());
      setSigner(w); setAddress(w.address);
      setKeys(loadKeys(w.address));
      setMode("evm");
      setShowWalletModal(false);
      setPrivKeyModal("");
      addToast("Connected via private key", "success");
    } catch { addToast("Invalid private key", "error"); }
  }

  function connectExtensionAccount(account: InjectedAccountWithMeta) {
    const s = signerFromExtensionAccount(account);
    const addr = signerAddress(s);
    setSubSigner(s); setSubAddress(addr);
    setMode("xcm");
    setShowWalletModal(false);
    setKeys(loadKeys(addr));
    addToast(`Connected: ${account.meta.name ?? addr.slice(0, 8)}`, "success");
  }

  function connectDevAccount(name: DevAccount) {
    const s = getDevAccount(name);
    const addr = signerAddress(s);
    setSubSigner(s); setSubAddress(addr);
    setDevAccount(name);
    setMode("xcm");
    setShowWalletModal(false);
    setKeys(loadKeys(addr));
    addToast(`Connected as ${name.charAt(0).toUpperCase() + name.slice(1)}`, "success");
  }

  function handleDisconnect() {
    setSigner(null); setAddress(""); setBalance("");
    setSubSigner(null); setSubAddress("");
    setKeys(null); setFoundAddresses([]); setSubPas(null); setSubUsdc(null);
    setExtensionAccounts([]); setShowWalletModal(false);
    disconnectAll();
  }

  if (!wasmReady) {
    return (
      <div className="min-h-screen bg-pattern flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-2 border-polka-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-text-secondary">Loading cryptographic module…</p>
        </div>
      </div>
    );
  }

  const isXcm = mode === "xcm";
  const connectedAddress = isXcm ? subAddress : address;

  return (
    <div className="min-h-screen bg-pattern relative flex flex-col">
      <div className="gradient-orb" style={{ background: "#e6007a", top: "-200px", right: "-100px" }} />
      <div className="gradient-orb" style={{ background: "#4cc2ff", bottom: "-200px", left: "-100px" }} />

      {/* Header */}
      <header className="relative z-10 border-b border-white/[0.06] backdrop-blur-xl bg-surface-950/80 px-6 py-3 flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-polka-500 to-polka-700 flex items-center justify-center shadow-glow">
            <svg viewBox="0 0 16 16" className="w-4 h-4" fill="white">
              <circle cx="8" cy="3" r="2" /><circle cx="3" cy="8" r="2" />
              <circle cx="13" cy="8" r="2" /><circle cx="8" cy="13" r="2" />
              <circle cx="8" cy="8" r="1.5" opacity="0.6" />
            </svg>
          </div>
          <span className="text-base font-semibold text-text-primary font-display tracking-tight">Privy Dot</span>
          <span className="text-xs text-text-muted ml-1">/ Stealth Addresses on Polkadot</span>
        </div>

        {/* XCM parachain selectors */}
        {isXcm && (
          <div className="flex items-center gap-3 text-xs text-text-secondary">
            <span className="text-text-muted">From:</span>
            <select
              value={sourcePara}
              onChange={e => setSourcePara(Number(e.target.value))}
              className="bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1 text-text-primary"
            >
              {Object.entries(PARACHAINS).map(([id, { label }]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
            <span className="text-text-muted">→ To:</span>
            <select
              value={destPara}
              onChange={e => setDestPara(Number(e.target.value))}
              className="bg-white/[0.04] border border-white/[0.08] rounded px-2 py-1 text-text-primary"
            >
              {Object.entries(PARACHAINS).map(([id, { label }]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
          </div>
        )}

        {/* Block / info */}
        <div className="ml-auto flex items-center gap-4 text-xs text-text-tertiary">
          {!isXcm && blockNumber && (
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse" />
              Block {blockNumber.toLocaleString()}
            </span>
          )}
        </div>
      </header>

      <div className="relative z-10 flex flex-1">
        {/* Sidebar */}
        <nav className="w-52 border-r border-white/[0.06] px-3 py-4 space-y-1 shrink-0">
          {NAV.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                tab === id
                  ? "bg-accent-purple/10 text-accent-purple border border-accent-purple/20"
                  : "text-text-secondary hover:text-text-primary hover:bg-white/[0.04]"
              }`}
            >
              <Icon size={15} />
              {label}
              {id === "scan" && keys && <span className="ml-auto w-2 h-2 rounded-full bg-accent-green/60" />}
            </button>
          ))}

          <div className="pt-4 mt-4 border-t border-white/[0.06] space-y-2">
            {connectedAddress ? (
              <div className="space-y-2 px-1">
                <div className="flex items-center gap-2 text-xs">
                  <span className="w-2 h-2 rounded-full bg-accent-green shrink-0" />
                  <span className="font-mono text-text-secondary truncate">
                    {connectedAddress.slice(0, 6)}…{connectedAddress.slice(-4)}
                  </span>
                </div>
                <p className="text-xs text-text-muted pl-4 truncate">
                  {!isXcm ? "MetaMask / EVM"
                    : subSigner?.type === "injected" ? (subSigner.name ?? "Extension account")
                    : <span className="capitalize">{devAccount}</span>}
                </p>
                <div className="pl-4 space-y-0.5">
                  {!isXcm && balance && <p className="text-xs text-zinc-300">{balance} PAS</p>}
                  {isXcm && subPas !== null && <p className="text-xs text-zinc-300">{subPas} PAS</p>}
                  {isXcm && subUsdc !== null && Number(subUsdc) > 0 && <p className="text-xs text-blue-400">{subUsdc} USDC</p>}
                  {autoScanning && (
                    <p className="text-xs text-zinc-500 flex items-center gap-1">
                      <Loader size={10} className="animate-spin" /> scanning…
                    </p>
                  )}
                </div>
                {foundAddresses.length > 0 && (() => {
                  const totalPas = foundAddresses.reduce((s, a) => s + (a.balancePlanck ?? 0n), 0n);
                  const totalUsdc = foundAddresses.reduce((s, a) => s + (a.usdcBalance ?? 0n), 0n);
                  return (
                    <div className="pl-4 space-y-0.5">
                      <p className="text-xs text-text-muted">Stealth balances:</p>
                      {totalPas > 0n && <p className="text-xs text-emerald-400 font-semibold">{(Number(totalPas) / 1e12).toFixed(4)} PAS</p>}
                      {totalUsdc > 0n && <p className="text-xs text-blue-400 font-semibold">{(Number(totalUsdc) / 1_000_000).toFixed(2)} USDC</p>}
                    </div>
                  );
                })()}
                <button onClick={handleDisconnect} className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary px-1">
                  <WifiOff size={11} /> Disconnect
                </button>
              </div>
            ) : (
              <div className="px-1">
                <button
                  onClick={openWalletModal}
                  className="w-full flex items-center justify-center gap-1.5 text-xs btn-primary py-2"
                >
                  <Wallet size={12} /> Connect Wallet
                </button>
              </div>
            )}
          </div>
        </nav>

        {/* Main content */}
        <main className="flex-1 px-6 py-4 overflow-y-auto max-w-2xl">
          {tab === "keys" && <KeysPanel keys={keys} address={connectedAddress} onKeysChange={onKeysChange} toast={addToast} onRegisterEvm={signer ? handleRegisterViaPrecompile : undefined} />}
          {tab === "send" && <SendPanel mode={mode} signer={signer} subSigner={subSigner} sourcePara={sourcePara} destPara={destPara} toast={addToast} />}
          {tab === "scan" && <ScanPanel mode={mode} keys={keys} sourcePara={sourcePara} destPara={destPara} subSigner={subSigner} found={foundAddresses} setFound={setFoundAddresses} toast={addToast} />}
        </main>
      </div>

      {/* Unified wallet picker modal */}
      {showWalletModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowWalletModal(false)} />
          <div className="relative bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-sm shadow-2xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
              <h2 className="text-sm font-semibold text-zinc-100">Connect Wallet</h2>
              <button onClick={() => setShowWalletModal(false)} className="text-zinc-500 hover:text-zinc-300">
                <X size={16} />
              </button>
            </div>

            <div className="p-3 space-y-3 max-h-[70vh] overflow-y-auto">
              {/* MetaMask */}
              <div>
                <p className="text-xs text-zinc-500 uppercase tracking-wider px-1 mb-1.5">EVM</p>
                <button
                  onClick={handleMetaMaskFromModal}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-zinc-800 border border-zinc-700 transition-colors text-left"
                >
                  <div className="w-7 h-7 rounded-full bg-orange-900/40 border border-orange-700/40 flex items-center justify-center shrink-0 text-base">
                    🦊
                  </div>
                  <div>
                    <p className="text-xs font-medium text-zinc-200">MetaMask</p>
                    <p className="text-xs text-zinc-500">Connect via browser extension</p>
                  </div>
                </button>
              </div>

              {/* Extension accounts (Talisman, Polkadot.js) */}
              <div>
                <p className="text-xs text-zinc-500 uppercase tracking-wider px-1 mb-1.5">Substrate</p>
                {extensionLoading ? (
                  <div className="flex items-center gap-2 px-3 py-4 text-xs text-zinc-500">
                    <Loader size={12} className="animate-spin" /> Loading accounts…
                  </div>
                ) : extensionAccounts.length === 0 ? (
                  <p className="text-xs text-zinc-600 px-3 py-3">No extension accounts found.</p>
                ) : (
                  <div className="space-y-1">
                    {extensionAccounts.map(account => (
                      <button
                        key={account.address}
                        onClick={() => connectExtensionAccount(account)}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-zinc-800 transition-colors text-left"
                      >
                        <div className="w-7 h-7 rounded-full bg-violet-900/60 border border-violet-700/40 flex items-center justify-center shrink-0">
                          <span className="text-xs text-violet-300 font-semibold">
                            {(account.meta.name ?? "?")[0].toUpperCase()}
                          </span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-zinc-200 truncate">{account.meta.name ?? "Account"}</p>
                          <p className="text-xs font-mono text-zinc-500 truncate">{account.address.slice(0, 12)}…{account.address.slice(-6)}</p>
                        </div>
                        {account.meta.source && (
                          <span className="text-xs text-zinc-600 shrink-0">{account.meta.source}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Dev accounts */}
              <div className="border-t border-zinc-800 pt-2">
                <button
                  onClick={() => setShowDevInModal(v => !v)}
                  className="w-full text-xs text-zinc-500 hover:text-zinc-400 text-left px-1 py-1 flex items-center gap-1"
                >
                  <span className={`transition-transform ${showDevInModal ? "rotate-90" : ""}`}>▶</span>
                  Dev accounts (local testing)
                </button>
                {showDevInModal && (
                  <div className="flex flex-col gap-1 mt-1.5">
                    {(["alice", "bob", "charlie"] as DevAccount[]).map(name => (
                      <button
                        key={name}
                        onClick={() => connectDevAccount(name)}
                        className="w-full text-left text-xs btn-secondary py-1.5 px-3 capitalize"
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Private key (EVM) */}
              <div className="border-t border-zinc-800 pt-2">
                <button
                  onClick={() => setShowPrivInModal(v => !v)}
                  className="w-full text-xs text-zinc-500 hover:text-zinc-400 text-left px-1 py-1 flex items-center gap-1"
                >
                  <span className={`transition-transform ${showPrivInModal ? "rotate-90" : ""}`}>▶</span>
                  Private key (EVM)
                </button>
                {showPrivInModal && (
                  <div className="space-y-1.5 mt-1.5">
                    <input
                      type="password"
                      value={privKeyModal}
                      onChange={e => setPrivKeyModal(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && handlePrivKeyFromModal()}
                      className="input-field w-full text-xs py-1.5"
                      placeholder="0x private key…"
                    />
                    <button onClick={handlePrivKeyFromModal} className="btn-primary text-xs py-1.5 w-full">
                      Connect
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toasts */}
      <div className="fixed bottom-6 right-6 space-y-2 z-50">
        {toasts.map(t => (
          <div key={t.id} className={`flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl border text-sm max-w-sm ${
            t.type === "success" ? "bg-emerald-950 border-emerald-700 text-emerald-200" :
            t.type === "error"   ? "bg-red-950 border-red-700 text-red-200" :
                                   "bg-zinc-800 border-zinc-600 text-zinc-200"
          }`}>
            {t.type === "success" ? <CheckCircle size={15} className="text-emerald-400 shrink-0" /> :
             t.type === "error"   ? <AlertCircle size={15} className="text-red-400 shrink-0" /> :
                                    <Info size={15} className="text-zinc-400 shrink-0" />}
            <span className="flex-1">{t.message}</span>
            <button onClick={() => setToasts(ts => ts.filter(x => x.id !== t.id))} className="opacity-50 hover:opacity-100 shrink-0">
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}