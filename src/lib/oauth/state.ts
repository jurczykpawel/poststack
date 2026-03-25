import { cookies } from "next/headers";
import { randomBytes } from "crypto";

const COOKIE_NAME = "rs_oauth_state";
const COOKIE_MAX_AGE = 10 * 60; // 10 minutes

/**
 * Generate a random state value and store it in a short-lived cookie.
 * Returns the state string to embed in the OAuth URL.
 */
export async function generateOAuthState(): Promise<string> {
  const state = randomBytes(16).toString("hex");
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });
  return state;
}

/**
 * Verify the state returned in the OAuth callback matches the cookie.
 * Throws if invalid.
 */
export async function verifyOAuthState(state: string): Promise<void> {
  const cookieStore = await cookies();
  const stored = cookieStore.get(COOKIE_NAME)?.value;
  // Clear it immediately after checking (one-time use)
  cookieStore.delete(COOKIE_NAME);

  if (!stored || stored !== state) {
    throw new Error("Invalid OAuth state — possible CSRF attack");
  }
}
