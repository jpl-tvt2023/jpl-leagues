import { creditedRefund } from "@/lib/formats/auction/economy";
import {
  breakdownFromSnapshot,
  describeDeadwoodReason,
  describeReleaseConfirmation,
  formatMoney,
  formatRefundBreakdown,
} from "@/lib/formats/auction/release-refund";

export interface PendingReleaseRow {
  ownershipId: string;
  playerName: string;
  teamName: string;
  purchasePrice: number;
  releaseRefund: number | null;
  releaseFmv: number | null;
  deadwoodReason: string | null;
}

/**
 * Every pending release in a league with its full refund breakdown —
 * rate × purchase price + 100% of FMV gain = refund — column by column, plus when it confirms.
 * Shared by the admin Marketplace tab and the league Marketplace so both explain refunds the same way.
 * On phones the breakdown columns fold into one line under the refund.
 */
export function PendingReleasesTable({
  rows,
  nextReleaseGw,
}: {
  rows: PendingReleaseRow[];
  nextReleaseGw: number | null;
}) {
  const priced = rows.map((r) => ({ row: r, refund: creditedRefund(r), breakdown: breakdownFromSnapshot(r) }));
  const totalRefund = priced.reduce((s, p) => s + p.refund, 0);
  const deadwoodCount = priced.filter((p) => p.breakdown?.deadwoodReason).length;

  return (
    <div>
      <p className="text-xs text-gray-400">
        {describeReleaseConfirmation(nextReleaseGw)} Refund = rate × purchase price + 100% of the FMV gain
        (50% standard, 80% deadwood). The player keeps scoring for his team until then.
      </p>

      {rows.length === 0 ? (
        <div className="text-center text-gray-400 py-8">No pending releases</div>
      ) : (
        <>
          <p className="mt-2 mb-3 text-xs text-gray-300">
            <span className="font-semibold text-white">{rows.length}</span> pending ·{" "}
            <span className="text-yellow-300">{deadwoodCount} deadwood</span> ·{" "}
            <span className="font-mono text-green-300">{formatMoney(totalRefund)}</span> to be refunded
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-xs uppercase text-gray-400">
                  <th className="text-left py-2 px-2">Player</th>
                  <th className="hidden sm:table-cell text-left py-2 px-2">Team</th>
                  <th className="hidden md:table-cell text-right py-2 px-2" title="What the team paid.">Purchase</th>
                  <th className="hidden md:table-cell text-right py-2 px-2" title="Fair Market Value when the release was marked.">FMV</th>
                  <th className="hidden md:table-cell text-right py-2 px-2" title="50% standard, 80% deadwood.">Rate</th>
                  <th className="hidden md:table-cell text-right py-2 px-2" title="Rate × purchase price.">Base</th>
                  <th className="hidden md:table-cell text-right py-2 px-2" title="FMV − purchase price, refunded in full.">+ FMV gain</th>
                  <th className="text-right py-2 px-2" title="Base + FMV gain — credited when the release is confirmed.">Refund</th>
                  <th className="hidden sm:table-cell text-right py-2 px-2" title="Part of the purchase price not coming back.">Forfeit</th>
                </tr>
              </thead>
              <tbody>
                {priced.map(({ row: r, refund, breakdown: b }) => {
                  const deadwood = b?.deadwoodReason ?? null;
                  return (
                    <tr key={r.ownershipId} className="border-b border-white/5 align-top">
                      <td className="py-2 px-2">
                        <div className="text-white font-semibold">{r.playerName}</div>
                        <div className={`text-[11px] ${deadwood ? "text-yellow-300" : "text-gray-400"}`}>
                          {deadwood
                            ? `Deadwood — ${describeDeadwoodReason(deadwood)}`
                            : b
                              ? "Standard release"
                              : "Old rule (50% of FMV)"}
                        </div>
                        <div className="sm:hidden text-[11px] text-gray-400">{r.teamName}</div>
                      </td>
                      <td className="hidden sm:table-cell py-2 px-2 text-gray-300">{r.teamName}</td>
                      <td className="hidden md:table-cell py-2 px-2 text-right font-mono text-white">{formatMoney(r.purchasePrice)}</td>
                      <td className="hidden md:table-cell py-2 px-2 text-right font-mono text-gray-300">{b ? formatMoney(b.fmv) : "—"}</td>
                      <td className={`hidden md:table-cell py-2 px-2 text-right font-mono ${deadwood ? "text-yellow-300" : "text-gray-300"}`}>
                        {b ? `${Math.round(b.rate * 100)}%` : "—"}
                      </td>
                      <td className="hidden md:table-cell py-2 px-2 text-right font-mono text-gray-300">{b ? formatMoney(b.base) : "—"}</td>
                      <td className="hidden md:table-cell py-2 px-2 text-right font-mono text-gray-300">
                        {b ? `${b.gain >= 0 ? "+" : "−"}${formatMoney(Math.abs(b.gain))}` : "—"}
                      </td>
                      <td className="py-2 px-2 text-right">
                        <div className="font-mono font-semibold text-green-300">+{formatMoney(refund)}</div>
                        {b && <div className="md:hidden text-[10px] text-gray-400">{formatRefundBreakdown(b)}</div>}
                      </td>
                      <td className="hidden sm:table-cell py-2 px-2 text-right font-mono text-red-300">
                        −{formatMoney(Math.max(0, r.purchasePrice - refund))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
