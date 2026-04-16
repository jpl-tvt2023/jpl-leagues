import { NextResponse } from "next/server";

/**
 * POST /api/auction/trade/veto
 * DEPRECATED — Veto system removed. Trades now require admin approval.
 */
export async function POST() {
  return NextResponse.json(
    { error: "Veto system has been removed. Trades now require admin approval." },
    { status: 410 }
  );
}
