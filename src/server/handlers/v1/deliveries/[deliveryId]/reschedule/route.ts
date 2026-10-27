import { z } from "zod";
import { authenticateWithScope } from "@/lib/auth";
import { ApiErrors, ok } from "@/lib/api/response";
import { camelizeKeys } from "@/lib/api/serialize";
import { rescheduleDelivery } from "@/lib/deliveries/service";

const input = z.object({ scheduledAt: z.string().datetime({ offset: true }) }).strict();

export async function POST(request: Request, ctx: { params: Promise<{ deliveryId: string }> }): Promise<Response> {
  const auth = await authenticateWithScope(request, "posts:write");
  if (!auth) return ApiErrors.unauthorized();
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return ApiErrors.validationError(parsed.error);
  const { deliveryId } = await ctx.params;
  return ok(camelizeKeys(await rescheduleDelivery(deliveryId, auth.workspaceId, parsed.data.scheduledAt)));
}
