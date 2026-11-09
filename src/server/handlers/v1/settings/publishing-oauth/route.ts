import { z } from "zod";
import { authenticateInstanceScope } from "@/lib/auth/instance-operator";
import { ok, ApiErrors } from "@/lib/api/response";
import { parseJsonBody } from "@/lib/api/body-limit";
import { configStatus, setConfigs } from "@/lib/settings/config";
import { PUBLISHING_OAUTH_KEYS } from "@/lib/settings/publishing-oauth";

const fields = Object.fromEntries(PUBLISHING_OAUTH_KEYS.map((key) => [key, z.string().trim().min(1).max(4096).optional()]));
const input = z.object(fields).strict();
const view = async () => (await configStatus()).filter((field) => PUBLISHING_OAUTH_KEYS.some((key) => key === field.key));

export async function GET(request: Request) {
  if (!(await authenticateInstanceScope(request, "instance_config:read"))) return ApiErrors.unauthorized();
  return ok(await view());
}

export async function PUT(request: Request) {
  if (!(await authenticateInstanceScope(request, "instance_config:write"))) return ApiErrors.unauthorized();
  const parsed = input.safeParse(await parseJsonBody(request, 65_536));
  if (!parsed.success) return ApiErrors.validationError(parsed.error);
  const entries = PUBLISHING_OAUTH_KEYS.flatMap((key) => parsed.data[key] ? [[key, parsed.data[key]] as const] : []);
  await setConfigs(entries);
  return ok(await view());
}
