import { NextResponse } from "next/server";
import { invalidateSession } from "@/lib/auth";

export async function POST(request: Request) {
  // Parse session cookie and add to denylist
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("rs_session="));
  const token = match ? decodeURIComponent(match.slice("rs_session=".length)) : null;

  if (token) {
    await invalidateSession(token);
  }

  const response = NextResponse.json({ data: { ok: true }, error: null });
  response.cookies.set("rs_session", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
