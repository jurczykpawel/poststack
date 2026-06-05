"use client";
import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";

interface Channel {
  id: string;
  platform: "facebook" | "instagram";
  platform_id: string;
  display_name: string | null;
  username: string | null;
  profile_picture: string | null;
  status: "active" | "needs_reauth" | "paused" | "disabled";
  is_active: boolean;
  created_at: string;
}

const PLATFORM_LABELS: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
};

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Access denied — you cancelled the connection.",
  no_pages: "No Facebook Pages found. Make sure you manage at least one Page.",
  no_ig_accounts: "No Instagram Business accounts found linked to your Pages.",
  oauth_failed: "Connection failed. Please try again.",
  invalid_state: "Invalid request state. Please try again.",
  missing_params: "Missing parameters from platform. Please try again.",
};

function ChannelsContent() {
  const searchParams = useSearchParams();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);

  const connected = searchParams.get("connected");
  const count = searchParams.get("count");
  const errorKey = searchParams.get("error");

  useEffect(() => {
    fetch("/api/v1/channels")
      .then((r) => r.json())
      .then((d) => setChannels(d.data ?? []))
      .finally(() => setLoading(false));
  }, []);

  async function disconnect(id: string) {
    if (!confirm("Disconnect this channel? Auto-replies will stop for this account.")) return;
    await fetch(`/api/v1/channels/${id}`, { method: "DELETE" });
    setChannels((prev) => prev.filter((c) => c.id !== id));
  }

  return (
    <div style={{ padding: "2rem", maxWidth: 720 }}>
      <h1 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "0.25rem" }}>Channels</h1>
      <p style={{ color: "var(--muted-foreground)", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
        Connect your Facebook Pages and Instagram Business accounts.
      </p>

      {errorKey && (
        <div style={{ background: "var(--destructive)", color: "#fff", padding: "0.75rem 1rem", borderRadius: "var(--radius)", marginBottom: "1rem", fontSize: "0.875rem" }}>
          {ERROR_MESSAGES[errorKey] ?? "Something went wrong."}
        </div>
      )}

      {connected && count && (
        <div style={{ background: "var(--primary)", color: "var(--primary-foreground)", padding: "0.75rem 1rem", borderRadius: "var(--radius)", marginBottom: "1rem", fontSize: "0.875rem" }}>
          {Number(count) === 1
            ? `1 ${PLATFORM_LABELS[connected] ?? connected} account connected.`
            : `${count} ${PLATFORM_LABELS[connected] ?? connected} accounts connected.`}
        </div>
      )}

      <div style={{ display: "flex", gap: "0.75rem", marginBottom: "2rem" }}>
        <a href="/api/oauth/facebook"
          style={{ padding: "0.5rem 1rem", background: "#1877f2", color: "#fff", borderRadius: "var(--radius)", textDecoration: "none", fontSize: "0.875rem", fontWeight: 600 }}>
          + Facebook
        </a>
        <a href="/api/oauth/instagram"
          style={{ padding: "0.5rem 1rem", background: "linear-gradient(135deg,#f09433,#e6683c,#dc2743,#cc2366,#bc1888)", color: "#fff", borderRadius: "var(--radius)", textDecoration: "none", fontSize: "0.875rem", fontWeight: 600 }}>
          + Instagram
        </a>
      </div>

      {loading ? (
        <p style={{ color: "var(--muted-foreground)", fontSize: "0.875rem" }}>Loading...</p>
      ) : channels.length === 0 ? (
        <p style={{ color: "var(--muted-foreground)", fontSize: "0.875rem" }}>No channels connected yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {channels.map((ch) => (
            <div key={ch.id} style={{
              display: "flex", alignItems: "center", gap: "0.75rem",
              padding: "0.75rem 1rem", background: "var(--muted)",
              border: "1px solid var(--border)", borderRadius: "var(--radius)",
            }}>
              {ch.profile_picture && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={ch.profile_picture} alt="" width={36} height={36}
                  style={{ borderRadius: "50%", flexShrink: 0 }} />
              )}
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>
                  {ch.display_name ?? ch.username ?? ch.platform_id}
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--muted-foreground)" }}>
                  {PLATFORM_LABELS[ch.platform] ?? ch.platform}
                  {ch.username ? ` · @${ch.username}` : ""}
                  {ch.status === "needs_reauth" && " · ⚠ Needs reconnect"}
                  {ch.status === "paused" && " · Paused"}
                  {ch.status === "disabled" && " · Disabled"}
                </div>
              </div>
              <button onClick={() => disconnect(ch.id)}
                style={{ padding: "0.25rem 0.75rem", background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius)", cursor: "pointer", fontSize: "0.75rem", color: "var(--muted-foreground)" }}>
                Disconnect
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ChannelsPage() {
  return (
    <Suspense>
      <ChannelsContent />
    </Suspense>
  );
}
