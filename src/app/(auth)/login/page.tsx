"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error?.message ?? "Login failed");
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
        <p style={{ color: "var(--muted-foreground)", marginTop: "0.25rem" }}>Sign in to your account</p>
      </div>

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <div>
          <label htmlFor="email" style={{ display: "block", marginBottom: "0.25rem", color: "var(--muted-foreground)", fontSize: "0.8rem" }}>
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ width: "100%", padding: "0.5rem 0.75rem", background: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem" }}
          />
        </div>

        <div>
          <label htmlFor="password" style={{ display: "block", marginBottom: "0.25rem", color: "var(--muted-foreground)", fontSize: "0.8rem" }}>
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: "100%", padding: "0.5rem 0.75rem", background: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem" }}
          />
        </div>

        {error && (
          <p style={{ color: "var(--destructive)", fontSize: "0.8rem" }}>{error}</p>
        )}

        <button
          type="submit"
          disabled={loading}
          style={{ padding: "0.6rem", background: "var(--primary)", color: "var(--primary-foreground)", border: "none", borderRadius: "var(--radius)", fontWeight: 600, cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.7 : 1 }}
        >
          {loading ? "Signing in..." : "Sign in"}
        </button>
      </form>

      <p style={{ marginTop: "1rem", textAlign: "center", color: "var(--muted-foreground)", fontSize: "0.8rem" }}>
        No account? <Link href="/register">Create one</Link>
      </p>
    </div>
  );
}
