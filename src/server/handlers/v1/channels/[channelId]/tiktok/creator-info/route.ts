import { authenticateSession, authenticateWithScope } from "@/lib/auth";
import { ApiError, ApiErrors, apiErrorResponse, err, ok } from "@/lib/api/response";
import { isUuid } from "@/lib/api/identifiers";
import { getTikTokCreatorInfo } from "@/lib/channels/tiktok-creator-info";
import { PermanentError, RateLimitedError, TokenInvalidError } from "@/lib/providers/errors";

type Params = { params: Promise<{ channelId: string }> };

async function respond(request: Request, { params }: Params, sessionOnly: boolean): Promise<Response> {
  const auth = await (sessionOnly ? authenticateSession(request) : authenticateWithScope(request, "channels:read")).catch(() => null);
  if (!auth) return ApiErrors.unauthorized();
  const { channelId } = await params;
  if (!isUuid(channelId)) return ApiErrors.notFound("Channel");
  const refresh = new URL(request.url).searchParams.get("refresh");
  if (refresh !== null && refresh !== "true" && refresh !== "false") return ApiErrors.badRequest("refresh must be true or false");
  let response: Response;
  try {
    response = ok(await getTikTokCreatorInfo(auth.workspaceId, channelId, { refresh: refresh === "true" }));
  } catch (error) {
    if (error instanceof ApiError) response = apiErrorResponse(error);
    else if (error instanceof TokenInvalidError || error instanceof PermanentError) response = ApiErrors.badRequest(error.message);
    else if (error instanceof RateLimitedError) response = ApiErrors.tooManyRequests(error.message);
    else response = err("upstream_unavailable", "TikTok creator info unavailable. Try again later.", 503);
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function GET(request: Request, params: Params): Promise<Response> {
  return respond(request, params, false);
}

export function GET_DASHBOARD(request: Request, params: Params): Promise<Response> {
  return respond(request, params, true);
}
