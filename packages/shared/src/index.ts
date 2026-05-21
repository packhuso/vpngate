// VPN Hub — shared types & helpers (design Section 8.3 conventions)
export * from "./crypto";
export * from "./wg";

/** Money is always integer satang (1/100 baht). 100.50 ฿ = 10050. */
export type Satang = number;

export const bahtToSatang = (baht: number): Satang => Math.round(baht * 100);
export const satangToBaht = (s: Satang): number => s / 100;
export const formatBaht = (s: Satang): string =>
  `฿ ${satangToBaht(s).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/** Standard API error envelope (design Section 8.3 / API_README). */
export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export const ERROR_CODES = [
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "INSUFFICIENT_CREDIT",
  "RATE_LIMITED",
  "INVALID_CODE",
  "PER_USER_LIMIT",
  "NO_GATEWAY_AVAILABLE",
  "NO_IP_AVAILABLE",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Billing cycle: 31 days per resource (design Section 2.2). */
export const BILLING_CYCLE_DAYS = 31;
