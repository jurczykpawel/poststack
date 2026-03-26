"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const widgetRef = useRef<HTMLElement>(null);
  const importedRef = useRef(false);

  useEffect(() => {
    if (importedRef.current) return;
    importedRef.current = true;
    import("altcha").catch(() => {});
  }, []);

  const handleStateChange = useCallback((ev: Event) => {
    const detail = (ev as CustomEvent).detail;
    if (detail?.state === "verified" && detail?.payload) {
      setCaptchaToken(detail.payload);
    }
  }, []);

  useEffect(() => {
    const el = widgetRef.current;
    if (!el) return;
    el.addEventListener("statechange", handleStateChange);
    return () => el.removeEventListener("statechange", handleStateChange);
  }, [handleStateChange]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password, captchaToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error?.message ?? "Registration failed");
        (widgetRef.current as any)?.reset?.();
        setCaptchaToken(null);
        return;
      }
      router.push("/inbox");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ width: "100%", maxWidth: 360 }}>
      <div style={{ marginBottom: "2rem", textAlign: "center" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700 }}>ReplyStack</h1>
        <p style={{ color: "var(--muted-foreground)", marginTop: "0.25rem" }}>Create your account</p>
      </div>

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <div>
          <label htmlFor="name" style={{ display: "block", marginBottom: "0.25rem", color: "var(--muted-foreground)", fontSize: "0.8rem" }}>Name</label>
          <input id="name" type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)}
            style={{ width: "100%", padding: "0.5rem 0.75rem", background: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem" }} />
        </div>

        <div>
          <label htmlFor="email" style={{ display: "block", marginBottom: "0.25rem", color: "var(--muted-foreground)", fontSize: "0.8rem" }}>Email</label>
          <input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            style={{ width: "100%", padding: "0.5rem 0.75rem", background: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem" }} />
        </div>

        <div>
          <label htmlFor="password" style={{ display: "block", marginBottom: "0.25rem", color: "var(--muted-foreground)", fontSize: "0.8rem" }}>Password</label>
          <input id="password" type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)}
            style={{ width: "100%", padding: "0.5rem 0.75rem", background: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem" }} />
        </div>

        <div style={{ display: "flex", justifyContent: "center" }}>
          <altcha-widget
            ref={widgetRef}
            challengeurl="/api/captcha/challenge"
            hidelogo
            hidefooter
            strings={JSON.stringify({
              label: "Security verification",
              verifying: "Verifying...",
              verified: "Verified",
              error: "Verification failed",
            })}
            style={{ maxWidth: "100%" }}
          />
        </div>

        {error && <p style={{ color: "var(--destructive)", fontSize: "0.8rem" }}>{error}</p>}

        <button type="submit" disabled={loading}
          style={{ padding: "0.6rem", background: "var(--primary)", color: "var(--primary-foreground)", border: "none", borderRadius: "var(--radius)", fontWeight: 600, cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.7 : 1 }}>
          {loading ? "Creating account..." : "Create account"}
        </button>
      </form>

      <p style={{ marginTop: "1rem", textAlign: "center", color: "var(--muted-foreground)", fontSize: "0.8rem" }}>
        Already have an account? <Link href="/login">Sign in</Link>
      </p>
    </div>
  );
}
