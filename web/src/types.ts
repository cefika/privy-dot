export interface KeyPairs {
  k: string;
  v: string;
  K: string;
  V: string;
}

export interface SendResult {
  r: string;
  R: string;
  viewTag: string;
  spendingPubKey: string;
}

export interface ScanResult {
  spendingPubKeys: string[];
  spendingPrivKeys: string[];
}

export interface FoundAddress {
  stealthAddress: string;
  spendingPrivKey: string;
  spendingPubKey: string;
  balance: string;
  balancePlanck?: bigint;
  usdcBalance?: bigint;
  addressType?: "evm" | "substrate";
}

export interface Toast {
  id: number;
  type: "success" | "error" | "info";
  message: string;
}

export interface HistoryEntry {
  id: string;              // stealthAddress + scannedAt
  stealthAddress: string;
  balancePas: string;      // formatted, e.g. "1.5000"
  balanceUsdc: string;     // formatted, e.g. "100.00"
  scannedAt: string;       // ISO string
  sourcePara: number;
  spendingPubKey: string;
}