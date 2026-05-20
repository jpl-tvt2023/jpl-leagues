// JPL Auction — Finance / Ledger Assembly
// Builds chronological transaction ledgers per team.

import { db, teams, leagues, auctionOwnership, auctionScores, auctionClubOwnership, tradeProposals, gameweeks, teamPenalties, teamSlotUnlocks } from "../../db";
import { eq, and, or, isNotNull } from "drizzle-orm";
import { calculateRefund } from "./economy";
import { getPlTeamFullName } from "../../data/pl-team-full-names";

export type TransactionType =
  | "initial_budget"
  | "purchase"
  | "club_purchase"
  | "release_refund"
  | "pending_release"
  | "gw_payout"
  | "trade_cash_out"
  | "trade_cash_in"
  | "trade_swap"
  | "transfer_fee"
  | "slot_unlock"
  | "slot_redeem";

const TRANSFER_FEE_RATE = 0.05;

export interface TransactionEntry {
  id: string;
  type: TransactionType;
  date: string; // ISO timestamp
  gw: number | null;
  description: string;
  amount: number; // positive = in, negative = out, 0 = informational
  runningBalance: number;
  isPending: boolean;
  metadata?: {
    playerName?: string;
    purchasePrice?: number;
    refundAmount?: number;
    forfeitAmount?: number;
    rank?: number;
    payout?: number;
    counterpartyTeam?: string;
    tradeId?: string;
    ownershipId?: string;
  };
}

export interface LedgerSummary {
  totalSpent: number;
  totalIncome: number;
  totalRefunds: number;
  totalForfeited: number;
  netPnL: number;
}

export interface TeamLedger {
  teamId: string;
  teamName: string;
  initialBudget: number;
  currentPurse: number;
  summary: LedgerSummary;
  ledger: TransactionEntry[];
}

export interface TeamSummary {
  teamId: string;
  teamName: string;
  purse: number;
  totalSpent: number;
  totalIncome: number;
  totalRefunds: number;
  totalForfeited: number;
  releasedCount: number;
  pendingReleaseCount: number;
  activeCount: number;
  netPnL: number;
}

/**
 * Build a full chronological ledger for a single team.
 */
export async function buildTeamLedger(leagueId: string, teamId: string): Promise<TeamLedger | null> {
  const teamRow = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  if (teamRow.length === 0) return null;
  const team = teamRow[0];

  const leagueRow = await db.select().from(leagues).where(eq(leagues.id, leagueId)).limit(1);
  if (leagueRow.length === 0) return null;
  const league = leagueRow[0];
  const initialBudget = league.initialBudget;

  const [ownership, scores, allGws, trades, leagueTeams, clubOwnership, redeemedPenalties, slotUnlocks] = await Promise.all([
    db.select().from(auctionOwnership).where(
      and(eq(auctionOwnership.leagueId, leagueId), eq(auctionOwnership.teamId, teamId))
    ),
    db.select().from(auctionScores).where(
      and(eq(auctionScores.leagueId, leagueId), eq(auctionScores.teamId, teamId))
    ),
    db.select().from(gameweeks).where(eq(gameweeks.leagueId, leagueId)),
    db.select().from(tradeProposals).where(
      and(
        eq(tradeProposals.leagueId, leagueId),
        or(eq(tradeProposals.proposerTeamId, teamId), eq(tradeProposals.targetTeamId, teamId))
      )
    ),
    db.select().from(teams).where(eq(teams.leagueId, leagueId)),
    db.select().from(auctionClubOwnership).where(
      and(eq(auctionClubOwnership.leagueId, leagueId), eq(auctionClubOwnership.teamId, teamId))
    ),
    // Defensive: a missing/lagging migration on either of these audit tables would otherwise crash
    // the whole Finance + Dashboard pages (both consume this ledger). On error we degrade to an
    // empty slot section — admin sees the page load, sees the warning, runs the migration.
    db.select().from(teamPenalties).where(
      and(eq(teamPenalties.leagueId, leagueId), eq(teamPenalties.teamId, teamId), isNotNull(teamPenalties.redeemedAt))
    ).catch((err) => {
      console.warn("[buildTeamLedger] teamPenalties query failed (migration applied?)", err);
      return [] as Array<typeof teamPenalties.$inferSelect>;
    }),
    db.select().from(teamSlotUnlocks).where(
      and(eq(teamSlotUnlocks.leagueId, leagueId), eq(teamSlotUnlocks.teamId, teamId))
    ).catch((err) => {
      console.warn("[buildTeamLedger] teamSlotUnlocks query failed (migration applied?)", err);
      return [] as Array<typeof teamSlotUnlocks.$inferSelect>;
    }),
  ]);

  const gwById = new Map<string, { number: number; deadline: Date }>();
  for (const g of allGws) gwById.set(g.id, { number: g.number, deadline: g.deadline });

  const teamNameById = new Map<string, string>();
  for (const t of leagueTeams) teamNameById.set(t.id, t.name);

  const entries: Omit<TransactionEntry, "runningBalance">[] = [];

  // 1. Initial budget — earliest entry (league creation date)
  entries.push({
    id: `initial-${league.id}`,
    type: "initial_budget",
    date: league.createdAt.toISOString(),
    gw: 0,
    description: `Initial budget`,
    amount: initialBudget,
    isPending: false,
  });

  // 1b. PL Club purchase (one-time, non-tradeable). Sorts by acquiredAt so it shows pre-player-auction.
  for (const c of clubOwnership) {
    // Normalise legacy rows (stored as FPL short form) to the full PL name. Keeps the ledger
    // description and metadata consistent with what the UI shows everywhere else.
    const clubName = getPlTeamFullName(c.plTeamId, c.plTeamName);
    entries.push({
      id: `club-${c.id}`,
      type: "club_purchase",
      date: c.acquiredAt.toISOString(),
      gw: 0,
      description: `Bought ${clubName} (${c.tier})`,
      amount: -c.purchasePrice,
      isPending: false,
      metadata: {
        playerName: clubName,
        purchasePrice: c.purchasePrice,
      },
    });
  }

  // 2. Purchases + releases
  for (const o of ownership) {
    entries.push({
      id: `purchase-${o.id}`,
      type: "purchase",
      date: o.createdAt.toISOString(),
      gw: o.acquiredGw,
      description: `Purchased ${o.playerName}`,
      amount: -o.purchasePrice,
      isPending: false,
      metadata: {
        playerName: o.playerName,
        purchasePrice: o.purchasePrice,
        ownershipId: o.id,
      },
    });

    if (o.status === "released") {
      const refund = calculateRefund(o.purchasePrice);
      const forfeit = o.purchasePrice - refund;
      entries.push({
        id: `refund-${o.id}`,
        type: "release_refund",
        date: o.updatedAt.toISOString(),
        gw: o.releasedGw,
        description: `Released ${o.playerName} (50% refund, ${formatShort(forfeit)} forfeited)`,
        amount: refund,
        isPending: false,
        metadata: {
          playerName: o.playerName,
          purchasePrice: o.purchasePrice,
          refundAmount: refund,
          forfeitAmount: forfeit,
          ownershipId: o.id,
        },
      });
    } else if (o.status === "pending_release") {
      const refund = calculateRefund(o.purchasePrice);
      const forfeit = o.purchasePrice - refund;
      entries.push({
        id: `pending-${o.id}`,
        type: "pending_release",
        date: o.updatedAt.toISOString(),
        gw: null,
        description: `Pending release: ${o.playerName} (projected refund ${formatShort(refund)}, forfeit ${formatShort(forfeit)})`,
        amount: 0,
        isPending: true,
        metadata: {
          playerName: o.playerName,
          purchasePrice: o.purchasePrice,
          refundAmount: refund,
          forfeitAmount: forfeit,
          ownershipId: o.id,
        },
      });
    }
  }

  // 3. GW payouts
  for (const s of scores) {
    if (s.payout === 0) continue;
    const gw = gwById.get(s.gameweekId);
    // Use s.createdAt (when admin processed the payout) so the entry sorts to the
    // top of the descending ledger. gw.deadline is the historical FPL date and
    // would push payouts to the bottom of the table.
    entries.push({
      id: `payout-${s.id}`,
      type: "gw_payout",
      date: s.createdAt.toISOString(),
      gw: gw?.number ?? null,
      description: `GW${gw?.number ?? "?"} payout (rank ${s.rank ?? "—"})`,
      amount: s.payout,
      isPending: false,
      metadata: {
        rank: s.rank ?? undefined,
        payout: s.payout,
      },
    });
  }

  // 4. Completed trades — emit a swap entry (with player details) plus cash entries when applicable
  // Build a lookup of every ownership row in the league so we can resolve player names + prices
  // for both pre- and post-trade snapshots (trades reassign ownership rows).
  const allOwnership = await db
    .select({
      id: auctionOwnership.id,
      playerName: auctionOwnership.playerName,
      purchasePrice: auctionOwnership.purchasePrice,
    })
    .from(auctionOwnership)
    .where(eq(auctionOwnership.leagueId, leagueId));
  const ownershipById = new Map<string, { playerName: string; purchasePrice: number }>();
  for (const o of allOwnership) ownershipById.set(o.id, { playerName: o.playerName, purchasePrice: o.purchasePrice });

  function describePlayers(ids: string[]): string {
    if (ids.length === 0) return "—";
    return ids
      .map((id) => {
        const o = ownershipById.get(id);
        return o ? `${o.playerName} (${formatShort(o.purchasePrice)})` : "?";
      })
      .join(", ");
  }

  for (const t of trades) {
    if (t.status !== "completed") continue;
    const isProposer = t.proposerTeamId === teamId;
    const counterparty = isProposer ? t.targetTeamId : t.proposerTeamId;
    const counterpartyName = teamNameById.get(counterparty) ?? counterparty.slice(0, 6);

    // Player swap summary (always emitted, even when cashOffered is 0).
    // From this team's perspective: outgoing players = ones we offered (if proposer) or ones requested from us (if target).
    const offeredIds: string[] = JSON.parse(t.offeredPlayerIds ?? "[]");
    const requestedIds: string[] = JSON.parse(t.requestedPlayerIds ?? "[]");
    const myOutgoing = isProposer ? offeredIds : requestedIds;
    const myIncoming = isProposer ? requestedIds : offeredIds;

    if (myOutgoing.length > 0 || myIncoming.length > 0) {
      entries.push({
        id: `trade-swap-${t.id}`,
        type: "trade_swap",
        date: t.updatedAt.toISOString(),
        gw: null,
        description: `Trade with ${counterpartyName}: out ${describePlayers(myOutgoing)} ↔ in ${describePlayers(myIncoming)}`,
        amount: 0,
        isPending: false,
        metadata: {
          counterpartyTeam: counterpartyName,
          tradeId: t.id,
        },
      });
    }

    if (t.cashOffered === 0) continue;

    // cashOffered: positive = proposer pays target; negative = proposer receives
    let grossAmount: number;
    if (isProposer) {
      grossAmount = -t.cashOffered; // proposer: pays positive, receives if negative
    } else {
      grossAmount = t.cashOffered; // target: receives positive, pays if negative
    }

    // For cash-in, the actual amount received is net of the 5% transfer fee
    const isReceiver = grossAmount > 0;
    const feeAmount = isReceiver ? Math.round(grossAmount * TRANSFER_FEE_RATE) : 0;
    const netAmount = isReceiver ? grossAmount - feeAmount : grossAmount;

    entries.push({
      id: `trade-${t.id}`,
      type: netAmount >= 0 ? "trade_cash_in" : "trade_cash_out",
      date: t.updatedAt.toISOString(),
      gw: null,
      description: `Trade ${netAmount >= 0 ? "from" : "with"} ${counterpartyName}`,
      amount: netAmount,
      isPending: false,
      metadata: {
        counterpartyTeam: counterpartyName,
        tradeId: t.id,
      },
    });

    // Add transfer_fee entry for receiver
    if (isReceiver && feeAmount > 0) {
      entries.push({
        id: `trade-${t.id}-fee`,
        type: "transfer_fee",
        date: t.updatedAt.toISOString(),
        gw: null,
        description: `Transfer tax (5%) — trade with ${counterpartyName}`,
        amount: -feeAmount,
        isPending: false,
        metadata: {
          counterpartyTeam: counterpartyName,
          tradeId: t.id,
        },
      });
    }
  }

  // 5. Penalty slot redemptions — sourced from teamPenalties rows that have been redeemed.
  for (const p of redeemedPenalties) {
    if (!p.redeemedAt) continue; // defensive — the where clause already filters this
    entries.push({
      id: `slot-redeem-${p.id}`,
      type: "slot_redeem",
      date: p.redeemedAt.toISOString(),
      gw: null,
      description: `Penalty slot redemption (cycle ${p.incurredCycle})`,
      amount: -(p.redemptionPrice ?? 0),
      isPending: false,
    });
  }

  // 6. Bonus slot unlocks (slot 15 / 16) — sourced from teamSlotUnlocks audit table.
  for (const u of slotUnlocks) {
    entries.push({
      id: `slot-unlock-${u.id}`,
      type: "slot_unlock",
      date: u.unlockedAt.toISOString(),
      gw: null,
      description: `Unlocked slot ${u.slotNumber}`,
      amount: -u.cost,
      isPending: false,
    });
  }

  // Sort ascending first (needed to compute correct running balance)
  entries.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  // Compute running balance forward (pending entries don't affect balance)
  let balance = 0;
  const withBalance = entries.map((e) => {
    if (!e.isPending) balance += e.amount;
    return { ...e, runningBalance: balance };
  });

  // Derive every summary number from the assembled ledger — single source of truth so Finance,
  // Dashboard, and any future surface agree by construction. Previously totalSpent only summed
  // ownership tables, which excluded slot unlocks / redemptions / trade cash / transfer fees.
  let totalIncome = 0;
  let totalRefunds = 0;
  let totalSpent = 0;
  let totalForfeited = 0;
  for (const e of withBalance) {
    if (e.isPending) continue;
    if (e.type === "initial_budget") continue; // starting balance, not income
    if (e.type === "release_refund") {
      totalRefunds += e.amount;
      totalForfeited += e.metadata?.forfeitAmount ?? 0;
      continue;
    }
    if (e.amount > 0) totalIncome += e.amount;
    else if (e.amount < 0) totalSpent += Math.abs(e.amount);
  }

  // Current purse = the running balance after the most recent non-pending entry. By construction
  // this equals `initialBudget + totalIncome + totalRefunds - totalSpent`. We use the ledger's
  // running balance instead of reading `teams.purse` so the value can't drift from the math.
  const currentPurse = withBalance.length > 0
    ? withBalance[withBalance.length - 1].runningBalance
    : initialBudget;

  // Reverse to show newest transactions first (descending order)
  const ledger: TransactionEntry[] = withBalance.reverse();

  return {
    teamId,
    teamName: team.name,
    initialBudget,
    currentPurse,
    summary: {
      totalSpent,
      totalIncome,
      totalRefunds,
      totalForfeited,
      // Net P&L excludes initial budget so it actually measures profit/loss since the auction
      // started. (Previously the formula included initialBudget and was numerically equal to purse.)
      netPnL: totalIncome + totalRefunds - totalSpent,
    },
    ledger,
  };
}

/**
 * Build a summary row for every team in the league — for the admin audit overview.
 */
export async function buildAllTeamsSummary(leagueId: string): Promise<TeamSummary[]> {
  const [leagueRow, leagueTeams, allOwnership, allScores] = await Promise.all([
    db.select({ initialBudget: leagues.initialBudget }).from(leagues).where(eq(leagues.id, leagueId)).limit(1),
    db.select().from(teams).where(and(eq(teams.leagueId, leagueId), eq(teams.isGhost, false))),
    db.select().from(auctionOwnership).where(eq(auctionOwnership.leagueId, leagueId)),
    db.select().from(auctionScores).where(eq(auctionScores.leagueId, leagueId)),
  ]);
  const initialBudget = leagueRow[0]?.initialBudget ?? 0;

  const ownByTeam = new Map<string, typeof allOwnership>();
  for (const o of allOwnership) {
    const arr = ownByTeam.get(o.teamId) ?? [];
    arr.push(o);
    ownByTeam.set(o.teamId, arr);
  }
  const scoreByTeam = new Map<string, typeof allScores>();
  for (const s of allScores) {
    const arr = scoreByTeam.get(s.teamId) ?? [];
    arr.push(s);
    scoreByTeam.set(s.teamId, arr);
  }

  return leagueTeams.map((t) => {
    const own = ownByTeam.get(t.id) ?? [];
    const sc = scoreByTeam.get(t.id) ?? [];
    const totalSpent = own.reduce((s, o) => s + o.purchasePrice, 0);
    const totalIncome = sc.reduce((s, x) => s + x.payout, 0);
    const released = own.filter((o) => o.status === "released");
    const totalRefunds = released.reduce((s, o) => s + calculateRefund(o.purchasePrice), 0);
    const totalForfeited = released.reduce((s, o) => s + (o.purchasePrice - calculateRefund(o.purchasePrice)), 0);

    return {
      teamId: t.id,
      teamName: t.name,
      purse: t.purse,
      totalSpent,
      totalIncome,
      totalRefunds,
      totalForfeited,
      releasedCount: released.length,
      pendingReleaseCount: own.filter((o) => o.status === "pending_release").length,
      activeCount: own.filter((o) => o.status === "active" || o.status === "deadwood").length,
      netPnL: initialBudget + totalIncome + totalRefunds - totalSpent,
    };
  });
}

function formatShort(amount: number): string {
  const abs = Math.abs(amount);
  if (abs >= 1_000_000) return `£${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `£${(abs / 1_000).toFixed(0)}K`;
  return `£${abs}`;
}
