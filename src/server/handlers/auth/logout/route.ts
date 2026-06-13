import { invalidateSession, sessionCookie, readSessionCookie } from "@/lib/auth";

export async function POST(request: Request) {
  // Parse session cookie and add to denylist
  const token = readSessionCookie(request.headers.get("cookie"));

  if (token) {
    await invalidateSession(token);
  }

  return Response.json(
    { data: { ok: true }, error: null },
    { headers: { "set-cookie": sessionCookie("", 0) } },
  );
}
