// JPL Auction — Finance / Ledger Assembly
// Builds chronological transaction ledgers per team.

import { db, teams, leagues, auctionOwnership, auctionScores, tradeProposals, gameweeks } from "../../db";
import { eq, and, or } from "drizzle-orm";
import { calculateRefund } from "./economy";

export type TransactionType =
  | "initial_budget"
  | "purchase"
  | "release_refund"
  | "pending_release"
  | "gw_payout"
  | "trade_cash_out"
  | "trade_cash_in"
  | "transfer_fee";

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

  const [ownership, scores, allGws, trades, leagueTeams] = await Promise.all([
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
    entries.push({
      id: `payout-${s.id}`,
      type: "gw_payout",
      date: (gw?.deadline ?? s.createdAt).toISOString(),
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

  // 4. Completed trades with cash movement
  for (const t of trades) {
    if (t.status !== "completed") continue;
    if (t.cashOffered === 0) continue;
    const isProposer = t.proposerTeamId === teamId;
    const counterparty = isProposer ? t.targetTeamId : t.proposerTeamId;
    const counterpartyName = teamNameById.get(counterparty) ?? counterparty.slice(0, 6);
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

  // Sort ascending first (needed to compute correct running balance)
  entries.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  // Compute running balance forward (pending entries don't affect balance)
  let balance = 0;
  const withBalance = entries.map((e) => {
    if (!e.isPending) balance += e.amount;
    return { ...e, runningBalance: balance };
  });

  // Reverse to show newest transactions first (descending order)
  const ledger: TransactionEntry[] = withBalance.reverse();

  // Summary
  const totalSpent = ownership.reduce((s, o) => s + o.purchasePrice, 0);
  const totalIncome = scores.reduce((s, sc) => s + sc.payout, 0);
  const totalRefunds = ownership
    .filter((o) => o.status === "released")
    .reduce((s, o) => s + calculateRefund(o.purchasePrice), 0);
  const totalForfeited = ownership
    .filter((o) => o.status === "released")
    .reduce((s, o) => s + (o.purchasePrice - calculateRefund(o.purchasePrice)), 0);

  return {
    teamId,
    teamName: team.name,
    initialBudget,
    currentPurse: team.purse,
    summary: {
      totalSpent,
      totalIncome,
      totalRefunds,
      totalForfeited,
      netPnL: totalIncome + totalRefunds - totalSpent,
    },
    ledger,
  };
}

/**
 * Build a summary row for every team in the league — for the admin audit overview.
 */
export async function buildAllTeamsSummary(leagueId: string): Promise<TeamSummary[]> {
  const [leagueTeams, allOwnership, allScores] = await Promise.all([
    db.select().from(teams).where(and(eq(teams.leagueId, leagueId), eq(teams.isGhost, false))),
    db.select().from(auctionOwnership).where(eq(auctionOwnership.leagueId, leagueId)),
    db.select().from(auctionScores).where(eq(auctionScores.leagueId, leagueId)),
  ]);

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
      netPnL: totalIncome + totalRefunds - totalSpent,
    };
  });
}

function formatShort(amount: number): string {
  const abs = Math.abs(amount);
  if (abs >= 1_000_000) return `£${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `£${(abs / 1_000).toFixed(0)}K`;
  return `£${abs}`;
}
