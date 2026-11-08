import { formatMoney, type RefundBreakdown } from "@/lib/formats/auction/release-refund";

/**
 * How a release refund is worked out, line by line:
 *   rate × purchase price  +  FMV gain  =  refund
 * Used by the release dialog before confirming and by the pending-release card afterwards, so the
 * two can never explain the same refund differently.
 */
export function ReleaseRefundBreakdown({ breakdown: b }: { breakdown: RefundBreakdown }) {
  const pct = `${Math.round(b.rate * 100)}%`;
  return (
    <dl className="space-y-1.5 text-xs text-gray-300">
      <div className="flex justify-between gap-3">
        <dt>
          {pct} of purchase price ({formatMoney(b.purchasePrice)})
          <span className="text-gray-500"> · {b.deadwoodReason ? "deadwood rate" : "standard rate"}</span>
        </dt>
        <dd className="font-mono text-white shrink-0">{formatMoney(b.base)}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt>
          {b.gain >= 0 ? "+ FMV gain" : "− FMV loss"}
          <span className="text-gray-500"> · FMV {formatMoney(b.fmv)} − paid {formatMoney(b.purchasePrice)}, 100%</span>
        </dt>
        <dd className={`font-mono shrink-0 ${b.gain >= 0 ? "text-green-300" : "text-red-300"}`}>
          {b.gain >= 0 ? "+" : "−"}{formatMoney(Math.abs(b.gain))}
        </dd>
      </div>
      <div className="flex justify-between gap-3 border-t border-white/10 pt-1.5 font-semibold">
        <dt className="text-white">Refund</dt>
        <dd className="font-mono text-green-300 shrink-0">{formatMoney(b.refund)}</dd>
      </div>
      {b.forfeit > 0 && (
        <div className="flex justify-between gap-3 text-gray-400">
          <dt>Not recovered of what you paid</dt>
          <dd className="font-mono text-red-300 shrink-0">−{formatMoney(b.forfeit)}</dd>
        </div>
      )}
    </dl>
  );
}
