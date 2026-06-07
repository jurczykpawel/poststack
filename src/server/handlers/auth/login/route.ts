import { z } from "zod";
import { eq, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, workspaceMembers } from "@/db/schema";
import { verifyPassword } from "@/lib/auth/password";
import { signSession, sessionCookie } from "@/lib/auth";
import { ok, ApiErrors } from "@/lib/api/response";
import { rateLimit, getClientIp } from "@/lib/api/rate-limit";
import { parseJsonBody } from "@/lib/api/body-limit";
import { verifyCaptcha } from "@/lib/captcha/verify";
import { sanitizeForLog } from "@/lib/api/safe-log";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  captchaToken: z.string().optional(),
});

const INVALID_MSG = "Invalid email or password";

export async function POST(request: Request) {
  // Rate limit: 10 attempts per 15 minutes per IP
  const ip = getClientIp(request);
  const rl = await rateLimit(`rl:login:${ip}`, 10, 900);
  if (!rl.allowed) {
    return ApiErrors.tooManyRequests(`Too many login attempts. Try again in ${rl.retryAfter}s.`);
  }

  const body = await parseJsonBody(request, 4_096);
  if (body === null) {
    return ApiErrors.badRequest("Invalid or oversized request body");
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.unauthorized(INVALID_MSG);
  }

  const { email, password, captchaToken } = parsed.data;

  // Verify captcha (skipped if ALTCHA_HMAC_KEY not set)
  const captcha = await verifyCaptcha(captchaToken);
  if (!captcha.success) {
    return ApiErrors.badRequest(captcha.error ?? "Security verification failed");
  }

  const user = await db.query.users.findFirst({
    where: eq(users.email, email.toLowerCase().trim()),
    columns: { id: true, email: true, name: true, password_hash: true },
  });

  if (!user?.password_hash) {
    console.warn(`[auth] Failed login: unknown email, ip=${sanitizeForLog(ip)}`);
    return ApiErrors.unauthorized(INVALID_MSG);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    console.warn(`[auth] Failed login: wrong password, ip=${sanitizeForLog(ip)}`);
    return ApiErrors.unauthorized(INVALID_MSG);
  }

  const member = await db.query.workspaceMembers.findFirst({
    where: eq(workspaceMembers.user_id, user.id),
    orderBy: asc(workspaceMembers.created_at),
    columns: { workspace_id: true },
  });
  if (!member) {
    return ApiErrors.internal("Account has no workspace");
  }

  const token = await signSession(user.id, member.workspace_id);

  const response = ok({ id: user.id, email: user.email, name: user.name });
  response.headers.set("set-cookie", sessionCookie(token, 60 * 60 * 24 * 7));
  return response;
}
