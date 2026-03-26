import { NextResponse } from "next/server";

export function apiError(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export function apiOk<T>(data: T): NextResponse {
  return NextResponse.json(data);
}
