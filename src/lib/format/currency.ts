// Shared currency formatter for purse / spend / income / payout values across the app.
// Pulled out of per-page local copies so admin + team-facing surfaces render values identically.
//
// Behavior:
//   - ≥£1M  → "£X.XXM" (2 decimals by default; pass `decimals: 1` for confirm-dialog brevity)
//   - ≥£1K  → "£XK"    (0 decimals)
//   - <£1K  → "£X"
//   - negative → "-£X..." prefix preserved

export interface FormatCurrencyOptions {
  /** Decimal places to show for the £M tier. 2 for tables/ledgers, 1 for compact confirm dialogs. */
  decimals?: 1 | 2;
}

export function formatCurrency(amount: number, opts?: FormatCurrencyOptions): string {
  const decimals = opts?.decimals ?? 2;
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}£${(abs / 1_000_000).toFixed(decimals)}M`;
  if (abs >= 1_000) return `${sign}£${(abs / 1_000).toFixed(0)}K`;
  return `${sign}£${abs}`;
}
