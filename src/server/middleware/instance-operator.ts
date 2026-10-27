import type { MiddlewareHandler } from "hono";
import { authenticateSession } from "@/lib/auth";
import { isInstanceOperator } from "@/lib/auth/instance-operator";

export const requireInstanceOperator: MiddlewareHandler = async (c, next) => {
  const auth = await authenticateSession(c.req.raw);
  if (!auth || !await isInstanceOperator(auth)) {
    return c.text("Managed by the instance operator", 403);
  }
  return next();
};
