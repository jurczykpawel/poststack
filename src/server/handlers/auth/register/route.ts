import { randomBytes } from "crypto";
import { z } from "zod";
import { eq, count, sql } from "drizzle-orm";
import { db, isUniqueViolation } from "@/lib/db";
import { users, workspaces, workspaceMembers } from "@/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { signSession, sessionCookie } from "@/lib/auth";
import { ok, ApiErrors } from "@/lib/api/response";
import { rateLimit, getClientIp } from "@/lib/api/rate-limit";
import { parseJsonBody } from "@/lib/api/body-limit";
import { verifyCaptcha } from "@/lib/captcha/verify";
import { getInstanceLicense } from "@/lib/license/gate";
import { env } from "@/lib/env";

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
    return ApiErrors.validationError(parsed.error);
  }

  const { email, password, name, captchaToken } = parsed.data;

  const captcha = await verifyCaptcha(captchaToken);
  if (!captcha.success) {
    return ApiErrors.badRequest(captcha.error ?? "Security verification failed");
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Hash up-front (outside the lock) so the response time does not reveal whether
  // the email exists, and so the expensive hash never runs while holding the lock.
  const passwordHash = await hashPassword(password);

  const slug =
    normalizedEmail.split("@")[0].replace(/[^a-z0-9]/g, "-") + "-" + randomBytes(4).toString("hex");

  // The closed-by-default gate and the bootstrap insert must be atomic: two
  // simultaneous first-account registrations on an empty instance must not both
  // see "0 accounts" and each create an owner. A transaction-scoped advisory lock
  // serializes them; the lock releases on commit, so the count check and insert
  // below act as one critical section.
  // Multitenancy is a licensed feature: a free instance is single-tenant. Resolve
  // the capability outside the registration lock (it's instance-global and cached),
  // then enforce it inside the critical section against the live workspace count.
  const canMultiWorkspace = (await getInstanceLicense()).features.has("multi_workspace");

  type Outcome =
    | { kind: "disabled" }
    | { kind: "multitenant_locked" }
    | { kind: "conflict" }
    | { kind: "ok"; user: { id: string; email: string; name: string | null }; workspaceId: string };

  let outcome: Outcome;
  try {
    outcome = await db.transaction(async (tx): Promise<Outcome> => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('stack:registration'))`);

      // Registration is closed by default. The first user (empty instance) may
      // always register to bootstrap the admin; after that REGISTRATION_ENABLED
      // must be "true".
      if (process.env.REGISTRATION_ENABLED !== "true") {
        const [{ n }] = await tx.select({ n: count() }).from(users);
        if (n > 0) return { kind: "disabled" };
      }

      // The first workspace always bootstraps; the 2nd+ requires multitenancy.
      const [{ wc }] = await tx.select({ wc: count() }).from(workspaces);
      if (wc > 0 && !canMultiWorkspace) return { kind: "multitenant_locked" };

      const existing = await tx.query.users.findFirst({
        where: eq(users.email, normalizedEmail),
        columns: { id: true },
      });
      if (existing) return { kind: "conflict" };

      const [ws] = await tx
        .insert(workspaces)
        .values({ name: name ? `${name}'s workspace` : "My workspace", slug })
        .returning({ id: workspaces.id });
      const [u] = await tx
        .insert(users)
        .values({ email: normalizedEmail, password_hash: passwordHash, name: name ?? normalizedEmail.split("@")[0] })
        .returning({ id: users.id, email: users.email, name: users.name });
      await tx.insert(workspaceMembers).values({ workspace_id: ws.id, user_id: u.id, role: "owner" });
      return { kind: "ok", user: u, workspaceId: ws.id };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return ApiErrors.conflict("Could not create an account with these details. If you already have one, sign in instead.");
    }
    throw err;
  }

  if (outcome.kind === "disabled") return ApiErrors.forbidden("Registration is disabled");
  if (outcome.kind === "multitenant_locked") {
    return ApiErrors.proRequired(
      "multi_workspace",
      env.LICENSE_UPGRADE_URL,
      "This instance is on the free plan (single workspace). Multitenancy requires a license.",
    );
  }
  if (outcome.kind === "conflict") {
    return ApiErrors.conflict("Could not create an account with these details. If you already have one, sign in instead.");
  }

  const { user, workspaceId } = outcome;

  const token = await signSession(user.id, workspaceId);

  const response = ok({ id: user.id, email: user.email, name: user.name }, undefined, 201);
  response.headers.set("set-cookie", sessionCookie(token, 60 * 60 * 24 * 7));
  return response;
}
