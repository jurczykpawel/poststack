"use client";
import { useState, useEffect } from "react";

interface Tag {
  tag: { id: string; name: string; color: string };
}

interface ContactChannel {
  platform_sender_id: string;
  platform_username: string | null;
  channel: { platform: string };
}

interface Contact {
  id: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  is_subscribed: boolean;
  last_interaction_at: string | null;
  contact_channels: ContactChannel[];
  tags: Tag[];
}

function timeAgo(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

const PLATFORM_ICONS: Record<string, string> = {
  facebook: "FB",
  instagram: "IG",
  telegram: "TG",
};

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    const controller = new AbortController();
    const url = `/api/v1/contacts?limit=50${debouncedSearch ? `&q=${encodeURIComponent(debouncedSearch)}` : ""}`;
    fetch(url, { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => {
        setContacts(d.data ?? []);
        setLoading(false);
      })
      .catch(() => {/* aborted */});
    return () => controller.abort();
  }, [debouncedSearch]);

  function contactName(c: Contact): string {
    return (
      c.display_name ??
      c.contact_channels[0]?.platform_username ??
      c.contact_channels[0]?.platform_sender_id ??
      "Unknown"
    );
  }

  return (
    <div style={{ padding: "2rem", maxWidth: 900 }}>
      <div style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "0.25rem" }}>Contacts</h1>
        <p style={{ color: "var(--muted-foreground)", fontSize: "0.875rem", marginBottom: "1rem" }}>
          Everyone who has messaged your connected pages.
        </p>
        <input
          type="text"
          placeholder="Search by name, email, username..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: "100%", maxWidth: 400, padding: "0.5rem 0.75rem",
            background: "var(--muted)", border: "1px solid var(--border)",
            borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem",
          }}
        />
      </div>

      {loading ? (
        <p style={{ color: "var(--muted-foreground)", fontSize: "0.875rem" }}>Loading...</p>
      ) : contacts.length === 0 ? (
        <p style={{ color: "var(--muted-foreground)", fontSize: "0.875rem" }}>
          {search ? "No contacts match your search." : "No contacts yet. Connect a channel and start receiving messages."}
        </p>
      ) : (
        <div>
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr auto auto",
            gap: "0.75rem",
            padding: "0.5rem 0.75rem",
            fontSize: "0.75rem",
            color: "var(--muted-foreground)",
            fontWeight: 600,
            borderBottom: "1px solid var(--border)",
          }}>
            <span>Contact</span>
            <span>Channels</span>
            <span>Tags</span>
            <span>Last seen</span>
          </div>
          {contacts.map((c) => (
            <div key={c.id} style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr auto auto",
              gap: "0.75rem",
              padding: "0.75rem",
              borderBottom: "1px solid var(--border)",
              alignItems: "center",
            }}>
              <div>
                <div style={{ fontWeight: 500, fontSize: "0.875rem" }}>{contactName(c)}</div>
                {c.email && <div style={{ fontSize: "0.75rem", color: "var(--muted-foreground)" }}>{c.email}</div>}
                {!c.is_subscribed && (
                  <span style={{ fontSize: "0.7rem", color: "var(--destructive)" }}>Unsubscribed</span>
                )}
              </div>
              <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                {c.contact_channels.map((cc, i) => (
                  <span key={i} style={{
                    fontSize: "0.7rem", fontWeight: 600,
                    padding: "0.1rem 0.4rem", borderRadius: 99,
                    background: "var(--muted)", border: "1px solid var(--border)",
                    color: "var(--muted-foreground)",
                  }}>
                    {PLATFORM_ICONS[cc.channel.platform] ?? cc.channel.platform}
                  </span>
                ))}
              </div>
              <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                {c.tags.map((t, i) => (
                  <span key={i} style={{
                    fontSize: "0.7rem", padding: "0.1rem 0.5rem",
                    borderRadius: 99, background: t.tag.color + "33",
                    color: t.tag.color, fontWeight: 600,
                  }}>
                    {t.tag.name}
                  </span>
                ))}
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--muted-foreground)", whiteSpace: "nowrap" }}>
                {timeAgo(c.last_interaction_at)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
