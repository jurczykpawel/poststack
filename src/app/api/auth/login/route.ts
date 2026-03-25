import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/auth/password";
import { signSession } from "@/lib/auth";
import { ok, ApiErrors } from "@/lib/api/response";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const INVALID_MSG = "Invalid email or password";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.unauthorized(INVALID_MSG);
  }

  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    select: {
      id: true,
      email: true,
      name: true,
      password_hash: true,
      workspace_members: {
        select: { workspace_id: true },
        orderBy: { created_at: "asc" },
        take: 1,
      },
    },
  });

  if (!user?.password_hash) {
    return ApiErrors.unauthorized(INVALID_MSG);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return ApiErrors.unauthorized(INVALID_MSG);
  }

  const workspaceId = user.workspace_members[0]?.workspace_id;
  if (!workspaceId) {
    return ApiErrors.internal("Account has no workspace");
  }

  const token = await signSession(user.id, workspaceId);

  const response = ok({ id: user.id, email: user.email, name: user.name });
  response.cookies.set("rs_session", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return response;
}
