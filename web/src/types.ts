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
}

export interface Toast {
  id: number;
  type: "success" | "error" | "info";
  message: string;
}