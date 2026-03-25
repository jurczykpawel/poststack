"use client";
import { useState, useEffect, useCallback } from "react";

interface ConversationSummary {
  id: string;
  platform: string;
  status: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
  is_automation_paused: boolean;
  contact: {
    id: string;
    display_name: string | null;
    avatar_url: string | null;
    contact_channels: Array<{ platform_sender_id: string; platform_username: string | null }>;
  };
  channel: { id: string; display_name: string | null; platform: string };
}

interface Message {
  id: string;
  direction: "inbound" | "outbound";
  text: string | null;
  status: string;
  created_at: string;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export default function InboxPage() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selected, setSelected] = useState<ConversationSummary | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/v1/conversations?limit=50")
      .then((r) => r.json())
      .then((d) => setConversations(d.data ?? []))
      .finally(() => setLoading(false));
  }, []);

  const loadMessages = useCallback(async (conv: ConversationSummary) => {
    setSelected(conv);
    setMessages([]);
    const r = await fetch(`/api/v1/conversations/${conv.id}/messages?limit=50`);
    const d = await r.json();
    setMessages(d.data ?? []);
    // Mark as read
    await fetch(`/api/v1/conversations/${conv.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unread_count: 0 }),
    });
    setConversations((prev) =>
      prev.map((c) => (c.id === conv.id ? { ...c, unread_count: 0 } : c))
    );
  }, []);

  async function sendReply() {
    if (!selected || !reply.trim()) return;
    setSending(true);
    try {
      await fetch(`/api/v1/conversations/${selected.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: reply }),
      });
      setReply("");
      await loadMessages(selected);
    } finally {
      setSending(false);
    }
  }

  const contactName = (c: ConversationSummary) =>
    c.contact.display_name ??
    c.contact.contact_channels[0]?.platform_username ??
    c.contact.contact_channels[0]?.platform_sender_id ??
    "Unknown";

  return (
    <div style={{ display: "flex", height: "100%" }}>
      {/* Conversation list */}
      <div style={{
        width: 280, borderRight: "1px solid var(--border)",
        overflowY: "auto", flexShrink: 0,
      }}>
        <div style={{ padding: "1rem", borderBottom: "1px solid var(--border)", fontWeight: 700, fontSize: "0.875rem" }}>
          Inbox
        </div>
        {loading && (
          <p style={{ padding: "1rem", fontSize: "0.875rem", color: "var(--muted-foreground)" }}>Loading...</p>
        )}
        {!loading && conversations.length === 0 && (
          <p style={{ padding: "1rem", fontSize: "0.875rem", color: "var(--muted-foreground)" }}>
            No conversations yet. Connect a channel to start receiving messages.
          </p>
        )}
        {conversations.map((conv) => (
          <button key={conv.id} onClick={() => loadMessages(conv)}
            style={{
              display: "block", width: "100%", textAlign: "left",
              padding: "0.75rem 1rem", border: "none", borderBottom: "1px solid var(--border)",
              background: selected?.id === conv.id ? "var(--muted)" : "transparent",
              cursor: "pointer",
            }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.2rem" }}>
              <span style={{ fontWeight: conv.unread_count > 0 ? 700 : 400, fontSize: "0.875rem" }}>
                {contactName(conv)}
              </span>
              <span style={{ fontSize: "0.7rem", color: "var(--muted-foreground)" }}>
                {timeAgo(conv.last_message_at)}
              </span>
            </div>
            <div style={{ fontSize: "0.75rem", color: "var(--muted-foreground)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {conv.last_message_preview ?? "No messages"}
            </div>
            {conv.unread_count > 0 && (
              <span style={{ display: "inline-block", marginTop: "0.2rem", background: "var(--primary)", color: "var(--primary-foreground)", borderRadius: 99, padding: "0 0.4rem", fontSize: "0.7rem" }}>
                {conv.unread_count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Message thread */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        {!selected ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted-foreground)", fontSize: "0.875rem" }}>
            Select a conversation
          </div>
        ) : (
          <>
            {/* Header */}
            <div style={{ padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)", fontWeight: 600, fontSize: "0.875rem" }}>
              {contactName(selected)}
              <span style={{ fontWeight: 400, color: "var(--muted-foreground)", marginLeft: "0.5rem" }}>
                via {selected.channel.display_name ?? selected.channel.platform}
              </span>
            </div>

            {/* Messages */}
            <div style={{ flex: 1, overflowY: "auto", padding: "1rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {messages.map((msg) => (
                <div key={msg.id} style={{
                  display: "flex",
                  justifyContent: msg.direction === "outbound" ? "flex-end" : "flex-start",
                }}>
                  <div style={{
                    maxWidth: "70%", padding: "0.5rem 0.75rem", borderRadius: "var(--radius)",
                    background: msg.direction === "outbound" ? "var(--primary)" : "var(--muted)",
                    color: msg.direction === "outbound" ? "var(--primary-foreground)" : "var(--foreground)",
                    fontSize: "0.875rem",
                  }}>
                    {msg.text ?? "(attachment)"}
                  </div>
                </div>
              ))}
            </div>

            {/* Reply box */}
            <div style={{ padding: "0.75rem 1rem", borderTop: "1px solid var(--border)", display: "flex", gap: "0.5rem" }}>
              <textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendReply(); } }}
                placeholder="Type a reply... (Enter to send)"
                rows={2}
                style={{
                  flex: 1, resize: "none", padding: "0.5rem 0.75rem",
                  background: "var(--muted)", border: "1px solid var(--border)",
                  borderRadius: "var(--radius)", color: "var(--foreground)",
                  fontSize: "0.875rem",
                }}
              />
              <button onClick={sendReply} disabled={sending || !reply.trim()}
                style={{
                  padding: "0 1rem", background: "var(--primary)", color: "var(--primary-foreground)",
                  border: "none", borderRadius: "var(--radius)", cursor: sending ? "not-allowed" : "pointer",
                  opacity: sending ? 0.7 : 1, fontWeight: 600, fontSize: "0.875rem",
                }}>
                {sending ? "..." : "Send"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
