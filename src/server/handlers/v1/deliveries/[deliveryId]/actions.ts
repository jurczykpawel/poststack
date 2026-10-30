import { authenticateWithScope } from "@/lib/auth";
import { ApiErrors, noContent, ok } from "@/lib/api/response";
import { camelizeKeys } from "@/lib/api/serialize";
import { cancelDelivery, publishDeliveryNow } from "@/lib/deliveries/service";

export async function POST(request: Request, ctx: { params: Promise<{ deliveryId: string }> }, action: "cancel" | "publish-now"): Promise<Response> {
  const auth = await authenticateWithScope(request, "posts:write");
  if (!auth) return ApiErrors.unauthorized();
  const { deliveryId } = await ctx.params;
  if (action === "cancel") {
    await cancelDelivery(deliveryId, auth.workspaceId);
    return noContent();
  }
  return ok(camelizeKeys(await publishDeliveryNow(deliveryId, auth.workspaceId)));
}
