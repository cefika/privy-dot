import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import { Key, Send, Radar, Wallet, WifiOff, X, CheckCircle, AlertCircle, Info, Loader } from "lucide-react";
import { initWasm, wasmApi } from "./wasm";
import { configure, connectMetaMask, signerFromPrivKey, provider } from "./chain";
import { contractAddress } from "./config/deployment";
import { getDevAccount, getAccountFromMnemonic, PARACHAINS, disconnectAll, getBalance, getAssetBalance, getApi, fetchAnnouncements, deriveSubstrateStealthAddress, bytes64ToR, registerMetaAddress } from "./substrate";
import type { KeyringPair } from "./substrate";
import type { KeyPairs, Toast, FoundAddress } from "./types";
import KeysPanel from "./panels/Keys";
import SendPanel from "./panels/Send";
import ScanPanel from "./panels/Scan";

const RPC_URL = (import.meta.env.VITE_RPC_URL as string | undefined) ?? "http://127.0.0.1:8545";

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
  const [privKeyInput, setPrivKeyInput] = useState("");
  const [showPrivInput, setShowPrivInput] = useState(false);
  const [blockNumber, setBlockNumber] = useState<number | null>(null);

  // XCM / Substrate state
  const [subSigner, setSubSigner] = useState<KeyringPair | null>(null);
  const [subAddress, setSubAddress] = useState("");
  const [devAccount, setDevAccount] = useState<DevAccount>("alice");
  const [mnemonicInput, setMnemonicInput] = useState("");
  const [showMnemonicInput, setShowMnemonicInput] = useState(false);
  const [sourcePara, setSourcePara] = useState<number>(1000);
  const [destPara, setDestPara] = useState<number>(2000);
  const [subPas, setSubPas] = useState<string | null>(null);
  const [subUsdc, setSubUsdc] = useState<string | null>(null);
  const [autoScanning, setAutoScanning] = useState(false);

  const [foundAddresses, setFoundAddresses] = useState<FoundAddress[]>([]);

  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    configure(RPC_URL, contractAddress ?? "");
  }, []);

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
      const b = await provider.getBalance(addr);
      setBalance(parseFloat(ethers.formatEther(b)).toFixed(4));
    } catch { setBalance("—"); }
  }, []);

  useEffect(() => {
    if (address && mode === "evm") {
      refreshBalance(address);
      const id = setInterval(() => refreshBalance(address), 15_000);
      return () => clearInterval(id);
    }
  }, [address, mode, refreshBalance]);

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
      finally { if (!cancelled) setAutoScanning(false); }
    })();
    return () => { cancelled = true; };
  }, [subSigner, keys, sourcePara, destPara, wasmReady]);

  // Auto-register meta address kad su keys + subSigner dostupni
  useEffect(() => {
    if (!subSigner || !keys || !wasmReady) return;
    let cancelled = false;
    (async () => {
      try {
        const api = await getApi(sourcePara);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existing = await (api.query.stealthAddresses as any).stealthMetaAddresses(subSigner.address);
        if (cancelled) return;
        if (existing.isNone || !existing.isSome) {
          await registerMetaAddress(api, subSigner, keys.K, keys.V);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [subSigner, keys, sourcePara, wasmReady]);

  useEffect(() => {
    setSubPas(null); setSubUsdc(null);
    if (!subSigner) return;
    let cancelled = false;
    (async () => {
      try {
        const api = await getApi(sourcePara);
        const pas = await getBalance(api, subSigner.address);
        const usdc = await getAssetBalance(api, subSigner.address, 1);
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

  // ── EVM connect ───────────────────────────────────────────────────────────

  async function handleMetaMask() {
    try {
      const { signer: s, address: a } = await connectMetaMask();
      setSigner(s); setAddress(a);
      setKeys(loadKeys(a));
      addToast("MetaMask connected!", "success");
    } catch (e: unknown) {
      addToast(e instanceof Error ? e.message : "MetaMask error", "error");
      setShowPrivInput(true);
    }
  }

  function handlePrivKey() {
    try {
      const w = signerFromPrivKey(privKeyInput.trim());
      setSigner(w); setAddress(w.address);
      setKeys(loadKeys(w.address));
      setShowPrivInput(false); setPrivKeyInput("");
      addToast("Wallet connected via private key", "success");
    } catch { addToast("Invalid private key", "error"); }
  }

  function disconnectEvm() { setSigner(null); setAddress(""); setBalance(""); setKeys(null); }

  // ── XCM / Substrate connect ───────────────────────────────────────────────

  function connectDevAccount(name: DevAccount) {
    const pair = getDevAccount(name);
    setSubSigner(pair);
    setSubAddress(pair.address);
    setDevAccount(name);
    setKeys(loadKeys(pair.address));
    addToast(`Connected as ${name.charAt(0).toUpperCase() + name.slice(1)}`, "success");
  }

  function connectMnemonic() {
    try {
      const pair = getAccountFromMnemonic(mnemonicInput.trim());
      setSubSigner(pair);
      setSubAddress(pair.address);
      setMnemonicInput(""); setShowMnemonicInput(false);
      setKeys(loadKeys(pair.address));
      addToast("Connected via mnemonic", "success");
    } catch { addToast("Invalid mnemonic", "error"); }
  }

  function disconnectXcm() {
    setSubSigner(null); setSubAddress(""); setKeys(null);
    setFoundAddresses([]); setSubPas(null); setSubUsdc(null);
    disconnectAll();
  }

  // ── Mode switch ───────────────────────────────────────────────────────────

  function switchMode(m: Mode) {
    setMode(m);
    setTab("keys");
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

        {/* Mode switcher */}
        <div className="ml-4 flex items-center gap-1 bg-white/[0.04] rounded-lg p-1 border border-white/[0.06]">
          <button
            onClick={() => switchMode("xcm")}
            className={`px-3 py-1 rounded text-xs font-medium transition-all ${
              isXcm ? "bg-accent-purple text-white" : "text-text-secondary hover:text-text-primary"
            }`}
          >
            XCM / Substrate
          </button>
          <button
            onClick={() => switchMode("evm")}
            className={`px-3 py-1 rounded text-xs font-medium transition-all ${
              !isXcm ? "bg-accent-purple text-white" : "text-text-secondary hover:text-text-primary"
            }`}
          >
            EVM (pallet-revive)
          </button>
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
          {!isXcm && contractAddress && (
            <span className="font-mono text-text-muted">{contractAddress.slice(0, 10)}…{contractAddress.slice(-6)}</span>
          )}
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
            {/* XCM signer */}
            {isXcm && (
              connectedAddress ? (
                <div className="space-y-2 px-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="w-2 h-2 rounded-full bg-accent-green shrink-0" />
                    <span className="font-mono text-text-secondary truncate">
                      {connectedAddress.slice(0, 6)}…{connectedAddress.slice(-4)}
                    </span>
                  </div>
                  <p className="text-xs text-text-muted pl-4 capitalize">{devAccount}</p>
                  <div className="pl-4 space-y-0.5">
                    {subPas !== null && <p className="text-xs text-zinc-300">{subPas} PAS</p>}
                    {subUsdc !== null && Number(subUsdc) > 0 && <p className="text-xs text-blue-400">{subUsdc} USDC</p>}
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
                        {totalPas > 0n && (
                          <p className="text-xs text-emerald-400 font-semibold">{(Number(totalPas) / 1e12).toFixed(4)} PAS</p>
                        )}
                        {totalUsdc > 0n && (
                          <p className="text-xs text-blue-400 font-semibold">{(Number(totalUsdc) / 1_000_000).toFixed(2)} USDC</p>
                        )}
                      </div>
                    );
                  })()}
                  <button onClick={disconnectXcm} className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary px-1">
                    <WifiOff size={11} /> Disconnect
                  </button>
                </div>
              ) : (
                <div className="space-y-2 px-1">
                  <p className="text-xs text-text-muted px-1">Dev account:</p>
                  <div className="flex flex-col gap-1">
                    {(["alice", "bob", "charlie"] as DevAccount[]).map(name => (
                      <button
                        key={name}
                        onClick={() => connectDevAccount(name)}
                        className="w-full text-left text-xs btn-secondary py-1.5 px-2 capitalize"
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => setShowMnemonicInput(v => !v)}
                    className="w-full text-xs text-text-muted hover:text-text-secondary text-center py-1"
                  >
                    Mnemonic…
                  </button>
                  {showMnemonicInput && (
                    <div className="space-y-1.5">
                      <textarea
                        value={mnemonicInput}
                        onChange={e => setMnemonicInput(e.target.value)}
                        className="input-field w-full text-xs py-1.5 h-16 resize-none"
                        placeholder="word1 word2 … word12"
                      />
                      <div className="flex gap-1">
                        <button onClick={connectMnemonic} className="btn-primary text-xs py-1 px-2 flex-1">Connect</button>
                        <button onClick={() => setShowMnemonicInput(false)} className="btn-secondary text-xs py-1 px-2">✕</button>
                      </div>
                    </div>
                  )}
                </div>
              )
            )}

            {/* EVM signer */}
            {!isXcm && (
              address ? (
                <div className="space-y-2 px-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="w-2 h-2 rounded-full bg-accent-green shrink-0" />
                    <span className="font-mono text-text-secondary truncate">{address.slice(0, 8)}…{address.slice(-4)}</span>
                  </div>
                  {balance && <p className="text-xs text-text-muted pl-4">{balance} UNIT</p>}
                  <button onClick={disconnectEvm} className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary px-1">
                    <WifiOff size={11} /> Disconnect
                  </button>
                </div>
              ) : (
                <div className="space-y-1.5 px-1">
                  <button onClick={handleMetaMask} className="w-full flex items-center justify-center gap-1.5 text-xs btn-secondary py-1.5">
                    <Wallet size={12} /> MetaMask
                  </button>
                  <button onClick={() => setShowPrivInput(v => !v)} className="w-full text-xs text-text-muted hover:text-text-secondary text-center py-1">
                    Private Key
                  </button>
                  {showPrivInput && (
                    <div className="space-y-1.5">
                      <input
                        type="password"
                        value={privKeyInput}
                        onChange={e => setPrivKeyInput(e.target.value)}
                        onKeyDown={e => e.key === "Enter" && handlePrivKey()}
                        className="input-field w-full text-xs py-1.5"
                        placeholder="0x private key…"
                      />
                      <div className="flex gap-1">
                        <button onClick={handlePrivKey} className="btn-primary text-xs py-1 px-2 flex-1">Connect</button>
                        <button onClick={() => setShowPrivInput(false)} className="btn-secondary text-xs py-1 px-2">✕</button>
                      </div>
                    </div>
                  )}
                </div>
              )
            )}
          </div>
        </nav>

        {/* Main content */}
        <main className="flex-1 px-6 py-4 overflow-y-auto max-w-2xl">
          {tab === "keys" && <KeysPanel keys={keys} address={connectedAddress} onKeysChange={onKeysChange} toast={addToast} />}
          {tab === "send" && <SendPanel mode={mode} signer={signer} subSigner={subSigner} sourcePara={sourcePara} destPara={destPara} toast={addToast} />}
          {tab === "scan" && <ScanPanel mode={mode} keys={keys} sourcePara={sourcePara} destPara={destPara} subSigner={subSigner} found={foundAddresses} setFound={setFoundAddresses} toast={addToast} />}
        </main>
      </div>

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