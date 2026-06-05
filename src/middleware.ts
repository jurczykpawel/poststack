import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const PUBLIC_PATHS = [
  "/",
  "/login",
  "/register",
  "/api/auth/login",
  "/api/auth/register",
  "/api/health",
  "/api/docs",
  "/api/captcha",
  "/api/webhooks",
];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths and static assets
  if (
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/")) ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api/v1") // API v1 handles its own auth
  ) {
    return NextResponse.next();
  }

  const token = request.cookies.get("rs_session")?.value;
  if (!token) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET!);
    const { payload } = await jwtVerify(token, secret);

    // Note: the JWT denylist (Postgres) is NOT checked here because middleware
    // runs on the edge runtime where the database client is not available. The
    // denylist is enforced in API route handlers via authenticate(). After
    // logout, dashboard pages may render the HTML shell but all API calls will
    // fail (401). This is acceptable for a self-hosted tool.
    void payload;

    return NextResponse.next();
  } catch {
    const response = NextResponse.redirect(new URL("/login", request.url));
    response.cookies.set("rs_session", "", { maxAge: 0 });
    return response;
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
