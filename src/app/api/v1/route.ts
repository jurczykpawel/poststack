import { NextResponse } from "next/server";
import { openApiSpec } from "@/lib/api/openapi";

/**
 * GET /api/v1
 * Returns the OpenAPI spec as JSON.
 * Consumed by /api/docs (Scalar UI).
 */
export async function GET() {
  return NextResponse.json(openApiSpec, {
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
  });
}
