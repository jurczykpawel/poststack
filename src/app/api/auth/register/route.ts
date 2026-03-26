import { randomBytes } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { hashPassword } from "@/lib/auth/password";
import { signSession } from "@/lib/auth";
import { ok, ApiErrors } from "@/lib/api/response";
import { rateLimit, getClientIp } from "@/lib/api/rate-limit";
import { parseJsonBody } from "@/lib/api/body-limit";
import { verifyCaptcha } from "@/lib/captcha/verify";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().min(1).max(100).optional(),
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
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  const { email, password, name, captchaToken } = parsed.data;

  const captcha = await verifyCaptcha(captchaToken);
  if (!captcha.success) {
    return ApiErrors.badRequest(captcha.error ?? "Security verification failed");
  }

  const normalizedEmail = email.toLowerCase().trim();

  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });
  if (existing) {
    return ApiErrors.conflict("An account with this email already exists");
  }

  const passwordHash = await hashPassword(password);
  const slug = normalizedEmail.split("@")[0].replace(/[^a-z0-9]/g, "-") +
    "-" + randomBytes(4).toString("hex");

  let user;
  try {
  user = await prisma.user.create({
    data: {
      email: normalizedEmail,
      password_hash: passwordHash,
      name: name ?? normalizedEmail.split("@")[0],
      workspace_members: {
        create: {
          role: "owner",
          workspace: {
            create: {
              name: name ? `${name}'s workspace` : "My workspace",
              slug,
            },
          },
        },
      },
    },
    select: {
      id: true,
      email: true,
      name: true,
      workspace_members: { select: { workspace_id: true }, take: 1 },
    },
  });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return ApiErrors.conflict("An account with this email already exists");
    }
    throw err;
  }

  const workspaceId = user.workspace_members[0].workspace_id;
  const token = await signSession(user.id, workspaceId);

  const response = ok({ id: user.id, email: user.email, name: user.name }, undefined, 201);
  response.cookies.set("rs_session", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return response;
}
