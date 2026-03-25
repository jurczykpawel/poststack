import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth/password";
import { signSession } from "@/lib/auth";
import { ok, ApiErrors } from "@/lib/api/response";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().min(1).max(100).optional(),
});

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  const { email, password, name } = parsed.data;
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
    "-" + Math.random().toString(36).slice(2, 7);

  const user = await prisma.user.create({
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
