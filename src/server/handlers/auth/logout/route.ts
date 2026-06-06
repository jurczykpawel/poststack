import { invalidateSession, sessionCookie } from "@/lib/auth";

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

  return Response.json(
    { data: { ok: true }, error: null },
    { headers: { "set-cookie": sessionCookie("", 0) } },
  );
}
