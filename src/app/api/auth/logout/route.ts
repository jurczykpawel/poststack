import { NextResponse } from "next/server";

export async function POST() {
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
