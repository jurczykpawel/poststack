import { authenticate, authenticateWithScope } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ok, created, ApiErrors } from "@/lib/api/response";
import { z } from "zod";

export const runtime = "nodejs";

// GET /api/v1/tags
export async function GET(request: Request) {
  const auth = await authenticateWithScope(request, "tags:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const tags = await prisma.tag.findMany({
    where: { workspace_id: auth.workspaceId },
    orderBy: { name: "asc" },
    take: 500,
    select: {
      id: true,
      name: true,
      color: true,
      _count: { select: { contacts: true } },
    },
  });

  return ok(tags);
}

const createSchema = z.object({
  name: z.string().min(1).max(50),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#6366f1"),
});

// POST /api/v1/tags
export async function POST(request: Request) {
  const auth = await authenticateWithScope(request, "tags:write").catch(() => null);
  if (!auth) return ApiErrors.unauthorized();

  const body = await request.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return ApiErrors.validationError(parsed.error.flatten().fieldErrors);
  }

  const existing = await prisma.tag.findFirst({
    where: { workspace_id: auth.workspaceId, name: { equals: parsed.data.name, mode: "insensitive" } },
    select: { id: true },
  });
  if (existing) return ApiErrors.conflict("Tag with this name already exists");

  const tag = await prisma.tag.create({
    data: {
      workspace_id: auth.workspaceId,
      name: parsed.data.name,
      color: parsed.data.color,
    },
  });

  return created(tag);
}
