import { NextResponse } from "next/server";
import { createChallenge } from "altcha-lib";

export const runtime = "nodejs";

export async function GET() {
  const hmacKey = process.env.ALTCHA_HMAC_KEY;
  if (!hmacKey) {
    return NextResponse.json(
      { error: "Captcha not configured" },
      { status: 503 }
    );
  }

  try {
    const challenge = await createChallenge({
      hmacKey,
      maxNumber: 100_000,
    });

    return NextResponse.json(challenge, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("[captcha/challenge] Failed:", err);
    return NextResponse.json(
      { error: "Failed to generate challenge" },
      { status: 500 }
    );
  }
}
