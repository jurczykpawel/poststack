"use client";
import { useState, useEffect } from "react";

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  key?: string; // only present right after creation
}

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString();
}

export default function SettingsPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKeyName, setNewKeyName] = useState("");
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState<ApiKey | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/v1/api-keys")
      .then((r) => r.json())
      .then((d) => setKeys(d.data ?? []))
      .finally(() => setLoading(false));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newKeyName.trim()) return;
    setError("");
    setCreating(true);
    try {
      const res = await fetch("/api/v1/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error?.message ?? "Failed to create key");
        return;
      }
      setJustCreated(data.data);
      setKeys((prev) => [data.data, ...prev]);
      setNewKeyName("");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string) {
    if (!confirm("Revoke this API key? This cannot be undone.")) return;
    await fetch(`/api/v1/api-keys/${id}`, { method: "DELETE" });
    setKeys((prev) => prev.filter((k) => k.id !== id));
    if (justCreated?.id === id) setJustCreated(null);
  }

  return (
    <div style={{ padding: "2rem", maxWidth: 720 }}>
      <h1 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "0.25rem" }}>Settings</h1>
      <p style={{ color: "var(--muted-foreground)", fontSize: "0.875rem", marginBottom: "2rem" }}>
        Manage your workspace settings and API access.
      </p>

      <section>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.75rem" }}>API Keys</h2>
        <p style={{ fontSize: "0.875rem", color: "var(--muted-foreground)", marginBottom: "1rem" }}>
          Use API keys to authenticate requests from external services.
          Keys are shown once on creation — store them securely.
        </p>

        {justCreated?.key && (
          <div style={{
            padding: "1rem", marginBottom: "1rem",
            background: "#dcfce7", border: "1px solid #86efac", borderRadius: "var(--radius)",
          }}>
            <p style={{ fontSize: "0.875rem", fontWeight: 600, color: "#166534", marginBottom: "0.5rem" }}>
              Your new API key — copy it now, it will not be shown again:
            </p>
            <code style={{
              display: "block", padding: "0.5rem", background: "#f0fdf4",
              border: "1px solid #86efac", borderRadius: "var(--radius)",
              fontSize: "0.8rem", fontFamily: "monospace", wordBreak: "break-all",
              color: "#166534",
            }}>
              {justCreated.key}
            </code>
            <button
              onClick={() => { navigator.clipboard.writeText(justCreated.key!); }}
              style={{ marginTop: "0.5rem", padding: "0.25rem 0.75rem", background: "#166534", color: "#fff", border: "none", borderRadius: "var(--radius)", cursor: "pointer", fontSize: "0.75rem" }}>
              Copy to clipboard
            </button>
          </div>
        )}

        <form onSubmit={handleCreate} style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
          <input
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="Key name (e.g. Production webhook)"
            style={{
              flex: 1, padding: "0.5rem 0.75rem",
              background: "var(--muted)", border: "1px solid var(--border)",
              borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem",
            }}
          />
          <button type="submit" disabled={creating || !newKeyName.trim()}
            style={{
              padding: "0.5rem 1rem", background: "var(--primary)", color: "var(--primary-foreground)",
              border: "none", borderRadius: "var(--radius)", cursor: creating ? "not-allowed" : "pointer",
              fontWeight: 600, fontSize: "0.875rem", opacity: creating ? 0.7 : 1,
            }}>
            {creating ? "Creating..." : "Create"}
          </button>
        </form>

        {error && <p style={{ color: "var(--destructive)", fontSize: "0.8rem", marginBottom: "1rem" }}>{error}</p>}

        {loading ? (
          <p style={{ color: "var(--muted-foreground)", fontSize: "0.875rem" }}>Loading...</p>
        ) : keys.length === 0 ? (
          <p style={{ color: "var(--muted-foreground)", fontSize: "0.875rem" }}>No API keys yet.</p>
        ) : (
          <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", overflow: "hidden" }}>
            {keys.map((k, i) => (
              <div key={k.id} style={{
                display: "grid", gridTemplateColumns: "1fr auto auto auto",
                gap: "1rem", padding: "0.75rem 1rem", alignItems: "center",
                borderTop: i > 0 ? "1px solid var(--border)" : "none",
              }}>
                <div>
                  <div style={{ fontWeight: 500, fontSize: "0.875rem" }}>{k.name}</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--muted-foreground)", fontFamily: "monospace" }}>
                    {k.key_prefix}...
                  </div>
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--muted-foreground)", textAlign: "right" }}>
                  Last used: {formatDate(k.last_used_at)}
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--muted-foreground)", textAlign: "right" }}>
                  {k.expires_at ? `Expires ${formatDate(k.expires_at)}` : "No expiry"}
                </div>
                <button onClick={() => handleRevoke(k.id)}
                  style={{
                    padding: "0.25rem 0.5rem", background: "none",
                    border: "1px solid var(--destructive)", borderRadius: "var(--radius)",
                    cursor: "pointer", fontSize: "0.75rem", color: "var(--destructive)",
                  }}>
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section style={{ marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600, marginBottom: "0.75rem" }}>Webhook</h2>
        <p style={{ fontSize: "0.875rem", color: "var(--muted-foreground)", marginBottom: "0.5rem" }}>
          Configure Meta webhook to receive messages and comments.
        </p>
        <div style={{ padding: "0.75rem", background: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", fontSize: "0.875rem", fontFamily: "monospace" }}>
          {typeof window !== "undefined" ? window.location.origin : ""}/api/webhooks/meta
        </div>
      </section>
    </div>
  );
}
