import { Users, Building2, ArrowRight, Landmark } from "lucide-react";

interface Props {
  onSelect: (mode: "employee" | "business" | "government") => void;
}

export default function ModeSelector({ onSelect }: Props) {
  return (
    <div className="min-h-screen bg-pattern flex flex-col items-center justify-center p-6 relative">
      <div className="gradient-orb" style={{ background: "#e6007a", top: "-200px", right: "-100px" }} />
      <div className="gradient-orb" style={{ background: "#4cc2ff", bottom: "-200px", left: "-100px" }} />

      <div className="relative z-10 w-full max-w-3xl space-y-10">
        {/* Logo */}
        <div className="text-center space-y-3">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-polka-500 to-polka-700 flex items-center justify-center shadow-glow mx-auto">
            <svg viewBox="0 0 16 16" className="w-8 h-8" fill="white">
              <circle cx="8" cy="3" r="2" /><circle cx="3" cy="8" r="2" />
              <circle cx="13" cy="8" r="2" /><circle cx="8" cy="13" r="2" />
              <circle cx="8" cy="8" r="1.5" opacity="0.6" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold text-text-primary font-display tracking-tight">Privy Dot</h1>
          <p className="text-text-secondary text-sm">Private payments on Polkadot — stealth addresses for everyone</p>
        </div>

        {/* Mode cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {/* Employee */}
          <button
            onClick={() => onSelect("employee")}
            className="group relative text-left p-6 rounded-2xl border border-white/[0.08] bg-surface-900/60 backdrop-blur-sm hover:border-polka-500/40 hover:bg-surface-900/80 transition-all duration-200 shadow-lg"
          >
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-polka-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            <div className="relative space-y-4">
              <div className="w-10 h-10 rounded-xl bg-polka-500/10 border border-polka-500/20 flex items-center justify-center group-hover:bg-polka-500/20 transition-colors">
                <Users size={20} className="text-polka-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-text-primary mb-1">Employee</h2>
                <p className="text-sm text-text-secondary leading-relaxed">
                  Receive private salary payments. Generate stealth keys, share your meta address with HR, and scan for incoming payments.
                </p>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-polka-400 font-medium">
                Get started <ArrowRight size={13} className="group-hover:translate-x-1 transition-transform" />
              </div>
            </div>
          </button>

          {/* Business */}
          <button
            onClick={() => onSelect("business")}
            className="group relative text-left p-6 rounded-2xl border border-white/[0.08] bg-surface-900/60 backdrop-blur-sm hover:border-accent-blue/40 hover:bg-surface-900/80 transition-all duration-200 shadow-lg"
          >
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-accent-blue/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            <div className="relative space-y-4">
              <div className="w-10 h-10 rounded-xl bg-accent-blue/10 border border-accent-blue/20 flex items-center justify-center group-hover:bg-accent-blue/20 transition-colors">
                <Building2 size={20} className="text-accent-blue" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-text-primary mb-1">Business</h2>
                <p className="text-sm text-text-secondary leading-relaxed">
                  Send payroll privately. Upload a CSV with employee meta addresses and amounts, preview the batch, and execute in one click.
                </p>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-accent-blue font-medium">
                Open payroll dashboard <ArrowRight size={13} className="group-hover:translate-x-1 transition-transform" />
              </div>
            </div>
          </button>

          {/* Government */}
          <button
            onClick={() => onSelect("government")}
            className="group relative text-left p-6 rounded-2xl border border-white/[0.08] bg-surface-900/60 backdrop-blur-sm hover:border-amber-500/40 hover:bg-surface-900/80 transition-all duration-200 shadow-lg"
          >
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-amber-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            <div className="relative space-y-4">
              <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center group-hover:bg-amber-500/20 transition-colors">
                <Landmark size={20} className="text-amber-400" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-text-primary mb-1">Government</h2>
                <p className="text-sm text-text-secondary leading-relaxed">
                  Audit payment history using a viewing key provided by the employee. View all transactions without access to funds.
                </p>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-amber-400 font-medium">
                Open audit dashboard <ArrowRight size={13} className="group-hover:translate-x-1 transition-transform" />
              </div>
            </div>
          </button>
        </div>

        <p className="text-center text-xs text-text-muted">
          Powered by ECPDKSAP · BN254 + SECP256k1 · Polkadot parachains
        </p>
      </div>
    </div>
  );
}