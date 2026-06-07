import { randomBytes } from "crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, workspaces, workspaceMembers } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { signSession, sessionCookie } from "@/lib/auth";
import { ok, ApiErrors } from "@/lib/api/response";
import { rateLimit, getClientIp } from "@/lib/api/rate-limit";
import { parseJsonBody } from "@/lib/api/body-limit";
import { verifyCaptcha } from "@/lib/captcha/verify";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  // The register form posts via htmx json-enc, which always sends every field —
  // so a blank name arrives as "". Treat empty/whitespace as absent.
  name: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().min(1).max(100).optional(),
  ),
  captchaToken: z.string().optional(),
});

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "23505";
}

export async function POST(request: Request) {
  // Rate limit: 5 registrations per hour per IP
  const ip = getClientIp(request);
  const rl = await rateLimit(`rl:register:${ip}`, 5, 3600);
  if (!rl.allowed) {
    return ApiErrors.tooManyRequests(`Too many registration attempts. Try again in ${rl.retryAfter}s.`);
  }

  const body = await parseJsonBody(request, 4_096);
  if (body === null) {
    return ApiErrors.badRequest("Invalid or oversized request body");
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  const { email, password, name, captchaToken } = parsed.data;

  const captcha = await verifyCaptcha(captchaToken);
  if (!captcha.success) {
    return ApiErrors.badRequest(captcha.error ?? "Security verification failed");
  }

  const normalizedEmail = email.toLowerCase().trim();

  const existing = await db.query.users.findFirst({
    where: eq(users.email, normalizedEmail),
    columns: { id: true },
  });
  if (existing) {
    return ApiErrors.conflict("Could not create an account with these details. If you already have one, sign in instead.");
  }

  const passwordHash = await hashPassword(password);
  const slug =
    normalizedEmail.split("@")[0].replace(/[^a-z0-9]/g, "-") + "-" + randomBytes(4).toString("hex");

  let user: { id: string; email: string; name: string | null };
  let workspaceId: string;
  try {
    const result = await db.transaction(async (tx) => {
      const [ws] = await tx
        .insert(workspaces)
        .values({ name: name ? `${name}'s workspace` : "My workspace", slug })
        .returning({ id: workspaces.id });
      const [u] = await tx
        .insert(users)
        .values({ email: normalizedEmail, password_hash: passwordHash, name: name ?? normalizedEmail.split("@")[0] })
        .returning({ id: users.id, email: users.email, name: users.name });
      await tx.insert(workspaceMembers).values({ workspace_id: ws.id, user_id: u.id, role: "owner" });
      return { u, wsId: ws.id };
    });
    user = result.u;
    workspaceId = result.wsId;
  } catch (err) {
    if (isUniqueViolation(err)) {
      return ApiErrors.conflict("Could not create an account with these details. If you already have one, sign in instead.");
    }
    throw err;
  }

  const token = await signSession(user.id, workspaceId);

  const response = ok({ id: user.id, email: user.email, name: user.name }, undefined, 201);
  response.headers.set("set-cookie", sessionCookie(token, 60 * 60 * 24 * 7));
  return response;
}
