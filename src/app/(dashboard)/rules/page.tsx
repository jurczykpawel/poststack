"use client";
import { useState, useEffect } from "react";

interface Rule {
  id: string;
  name: string;
  is_active: boolean;
  priority: number;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  response_type: string;
  response_config: Record<string, unknown>;
  cooldown_seconds: number;
  created_at: string;
}

const TRIGGER_LABELS: Record<string, string> = {
  keyword: "Keyword (DM)",
  comment_keyword: "Keyword (Comment)",
  welcome: "Welcome Message",
  default: "Default Reply",
  story_reply: "Story Reply",
  story_mention: "Story Mention",
  postback: "Button Postback",
};

function RuleRow({ rule, onToggle, onDelete }: {
  rule: Rule;
  onToggle: (id: string, active: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const preview =
    rule.response_type === "text"
      ? String((rule.response_config as { text?: string }).text ?? "")
      : rule.response_type === "random_text"
      ? `${((rule.response_config as { messages?: string[] }).messages ?? []).length} random variants`
      : rule.response_type === "ai_rephrase"
      ? `AI rephrase: "${String((rule.response_config as { text?: string }).text ?? "").slice(0, 40)}..."`
      : rule.response_type;

  const triggerPreview = (() => {
    const cfg = rule.trigger_config as { keywords?: Array<{ value: string }> };
    if (cfg.keywords) return cfg.keywords.map((k) => `"${k.value}"`).join(", ");
    return "-";
  })();

  return (
    <div style={{
      display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto",
      alignItems: "center", gap: "0.75rem",
      padding: "0.75rem 1rem", background: rule.is_active ? "var(--muted)" : "transparent",
      border: "1px solid var(--border)", borderRadius: "var(--radius)",
      opacity: rule.is_active ? 1 : 0.6,
    }}>
      <div>
        <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>{rule.name}</div>
        <div style={{ fontSize: "0.75rem", color: "var(--muted-foreground)" }}>
          {TRIGGER_LABELS[rule.trigger_type] ?? rule.trigger_type} · {triggerPreview}
        </div>
      </div>
      <div style={{ fontSize: "0.875rem", color: "var(--muted-foreground)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {preview}
      </div>
      <div style={{ fontSize: "0.75rem", color: "var(--muted-foreground)" }}>
        Priority: {rule.priority}
        {rule.cooldown_seconds > 0 && ` · Cooldown: ${rule.cooldown_seconds}s`}
      </div>
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button onClick={() => onToggle(rule.id, !rule.is_active)}
          style={{ padding: "0.25rem 0.5rem", background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius)", cursor: "pointer", fontSize: "0.75rem", color: "var(--muted-foreground)" }}>
          {rule.is_active ? "Pause" : "Enable"}
        </button>
        <button onClick={() => { if (confirm("Delete this rule?")) onDelete(rule.id); }}
          style={{ padding: "0.25rem 0.5rem", background: "none", border: "1px solid var(--destructive)", borderRadius: "var(--radius)", cursor: "pointer", fontSize: "0.75rem", color: "var(--destructive)" }}>
          Delete
        </button>
      </div>
    </div>
  );
}

interface ChannelOption {
  id: string;
  platform: string;
  display_name: string | null;
}

interface PostOption {
  id: string;
  text: string;
  created_at: string;
  url: string | null;
}

const defaultForm = {
  name: "",
  channel_id: "" as string,
  trigger_type: "keyword" as string,
  keywords: "",
  match_type: "contains" as const,
  post_id: "" as string,
  post_id_mode: "none" as "none" | "select" | "custom",
  response_type: "text" as string,
  response_text: "",
  response_messages: [""] as string[],
  ai_tone: "friendly and professional",
  priority: 0,
  cooldown_seconds: 0,
};

export default function RulesPage() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(defaultForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [posts, setPosts] = useState<PostOption[]>([]);
  const [loadingPosts, setLoadingPosts] = useState(false);

  useEffect(() => {
    fetch("/api/v1/rules")
      .then((r) => r.json())
      .then((d) => setRules(d.data ?? []))
      .finally(() => setLoading(false));
    fetch("/api/v1/channels")
      .then((r) => r.json())
      .then((d) => setChannels(d.data ?? []));
  }, []);

  async function handleToggle(id: string, active: boolean) {
    await fetch(`/api/v1/rules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: active }),
    });
    setRules((prev) => prev.map((r) => r.id === id ? { ...r, is_active: active } : r));
  }

  async function handleDelete(id: string) {
    await fetch(`/api/v1/rules/${id}`, { method: "DELETE" });
    setRules((prev) => prev.filter((r) => r.id !== id));
  }

  async function loadPosts(channelId: string) {
    if (!channelId) { setPosts([]); return; }
    setLoadingPosts(true);
    try {
      const r = await fetch(`/api/v1/channels/${channelId}/posts`);
      const d = await r.json();
      setPosts(d.data ?? []);
    } catch {
      setPosts([]);
    } finally {
      setLoadingPosts(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      const keywords = form.keywords
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean)
        .map((value) => ({ value, match_type: form.match_type }));

      const triggerConfig: Record<string, unknown> = {};
      if (keywords.length > 0) triggerConfig.keywords = keywords;
      if (form.post_id) triggerConfig.post_id = form.post_id;

      const body = {
        name: form.name,
        channel_id: form.channel_id || undefined,
        trigger_type: form.trigger_type,
        trigger_config: triggerConfig,
        response_type: form.response_type,
        response_config:
          form.response_type === "text"
            ? { text: form.response_text }
            : form.response_type === "random_text"
            ? { messages: form.response_messages.filter((m) => m.trim()) }
            : form.response_type === "ai_rephrase"
            ? { text: form.response_text, tone: form.ai_tone }
            : {},
        priority: Number(form.priority),
        cooldown_seconds: Number(form.cooldown_seconds),
      };

      const res = await fetch("/api/v1/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error?.message ?? "Failed to create rule");
        return;
      }
      setRules((prev) => [...prev, data.data]);
      setShowForm(false);
      setForm(defaultForm);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ padding: "2rem", maxWidth: 900 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <div>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "0.25rem" }}>Auto-Reply Rules</h1>
          <p style={{ color: "var(--muted-foreground)", fontSize: "0.875rem" }}>
            Rules are evaluated in priority order. First match wins.
          </p>
        </div>
        <button onClick={() => setShowForm(!showForm)}
          style={{ padding: "0.5rem 1rem", background: "var(--primary)", color: "var(--primary-foreground)", border: "none", borderRadius: "var(--radius)", cursor: "pointer", fontWeight: 600, fontSize: "0.875rem" }}>
          {showForm ? "Cancel" : "+ New Rule"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} style={{ marginBottom: "1.5rem", padding: "1rem", border: "1px solid var(--border)", borderRadius: "var(--radius)", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <h2 style={{ fontSize: "1rem", fontWeight: 600, margin: 0 }}>New Rule</h2>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.8rem", color: "var(--muted-foreground)", marginBottom: "0.25rem" }}>Name</label>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required
                style={{ width: "100%", padding: "0.5rem", background: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem" }} />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.8rem", color: "var(--muted-foreground)", marginBottom: "0.25rem" }}>Trigger</label>
              <select value={form.trigger_type} onChange={(e) => setForm({ ...form, trigger_type: e.target.value as typeof form.trigger_type })}
                style={{ width: "100%", padding: "0.5rem", background: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem" }}>
                {Object.entries(TRIGGER_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
          </div>

          {(form.trigger_type === "keyword" || form.trigger_type === "comment_keyword") && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "0.75rem" }}>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--muted-foreground)", marginBottom: "0.25rem" }}>
                  Keywords (comma separated){form.trigger_type === "comment_keyword" ? " -- leave empty to match all comments" : ""}
                </label>
                <input value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} placeholder="buy, order, price"
                  style={{ width: "100%", padding: "0.5rem", background: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem" }} />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--muted-foreground)", marginBottom: "0.25rem" }}>Match type</label>
                <select value={form.match_type} onChange={(e) => setForm({ ...form, match_type: e.target.value as typeof form.match_type })}
                  style={{ padding: "0.5rem", background: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem" }}>
                  <option value="contains">Contains</option>
                  <option value="exact">Exact</option>
                  <option value="starts_with">Starts with</option>
                </select>
              </div>
            </div>
          )}

          {form.trigger_type === "comment_keyword" && (
            <>
              <div>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--muted-foreground)", marginBottom: "0.25rem" }}>Channel (required for post selection)</label>
                <select
                  value={form.channel_id}
                  onChange={(e) => {
                    const chId = e.target.value;
                    setForm({ ...form, channel_id: chId, post_id: "", post_id_mode: "none" });
                    setPosts([]);
                    if (chId) loadPosts(chId);
                  }}
                  style={{ width: "100%", padding: "0.5rem", background: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem" }}>
                  <option value="">All channels (no post filter)</option>
                  {channels.map((ch) => (
                    <option key={ch.id} value={ch.id}>{ch.display_name ?? ch.platform} ({ch.platform})</option>
                  ))}
                </select>
              </div>

              {form.channel_id && (
                <div>
                  <label style={{ display: "block", fontSize: "0.8rem", color: "var(--muted-foreground)", marginBottom: "0.25rem" }}>Scope to specific post</label>
                  <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
                    {(["none", "select", "custom"] as const).map((mode) => (
                      <label key={mode} style={{ display: "flex", alignItems: "center", gap: "0.25rem", fontSize: "0.8rem", cursor: "pointer" }}>
                        <input
                          type="radio"
                          name="post_id_mode"
                          value={mode}
                          checked={form.post_id_mode === mode}
                          onChange={() => setForm({ ...form, post_id_mode: mode, post_id: "" })}
                        />
                        {mode === "none" ? "Any post" : mode === "select" ? "Choose from recent" : "Enter post ID"}
                      </label>
                    ))}
                  </div>

                  {form.post_id_mode === "select" && (
                    loadingPosts ? (
                      <p style={{ fontSize: "0.8rem", color: "var(--muted-foreground)" }}>Loading posts...</p>
                    ) : posts.length === 0 ? (
                      <p style={{ fontSize: "0.8rem", color: "var(--muted-foreground)" }}>No posts found. Try entering a post ID manually.</p>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", maxHeight: 200, overflowY: "auto" }}>
                        {posts.map((p) => (
                          <label key={p.id} style={{
                            display: "flex", alignItems: "center", gap: "0.5rem",
                            padding: "0.5rem", background: form.post_id === p.id ? "var(--primary)" : "var(--muted)",
                            color: form.post_id === p.id ? "var(--primary-foreground)" : "var(--foreground)",
                            border: "1px solid var(--border)", borderRadius: "var(--radius)",
                            cursor: "pointer", fontSize: "0.8rem",
                          }}>
                            <input
                              type="radio"
                              name="post_select"
                              value={p.id}
                              checked={form.post_id === p.id}
                              onChange={() => setForm({ ...form, post_id: p.id })}
                              style={{ display: "none" }}
                            />
                            <div style={{ flex: 1 }}>
                              <div>{p.text}</div>
                              <div style={{ fontSize: "0.7rem", opacity: 0.7 }}>{new Date(p.created_at).toLocaleDateString()}</div>
                            </div>
                            {p.url && (
                              <a href={p.url} target="_blank" rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                style={{ fontSize: "0.7rem", color: "inherit", textDecoration: "underline" }}>
                                view
                              </a>
                            )}
                          </label>
                        ))}
                      </div>
                    )
                  )}

                  {form.post_id_mode === "custom" && (
                    <input
                      value={form.post_id}
                      onChange={(e) => setForm({ ...form, post_id: e.target.value })}
                      placeholder="e.g. 123456789_987654321"
                      style={{ width: "100%", padding: "0.5rem", background: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem", fontFamily: "monospace" }}
                    />
                  )}
                </div>
              )}
            </>
          )}

          <div>
            <label style={{ display: "block", fontSize: "0.8rem", color: "var(--muted-foreground)", marginBottom: "0.25rem" }}>Response type</label>
            <select value={form.response_type} onChange={(e) => setForm({ ...form, response_type: e.target.value })}
              style={{ width: "100%", padding: "0.5rem", background: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem", marginBottom: "0.5rem" }}>
              <option value="text">Single reply</option>
              <option value="random_text">Random from list</option>
              <option value="ai_rephrase">AI rephrase</option>
            </select>

            {form.response_type === "text" && (
              <>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--muted-foreground)", marginBottom: "0.25rem" }}>Reply text</label>
                <textarea value={form.response_text} onChange={(e) => setForm({ ...form, response_text: e.target.value })} rows={3} required
                  style={{ width: "100%", padding: "0.5rem", background: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem", resize: "vertical" }} />
              </>
            )}

            {form.response_type === "random_text" && (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                <label style={{ fontSize: "0.8rem", color: "var(--muted-foreground)" }}>Reply variants (one will be picked randomly)</label>
                {form.response_messages.map((msg, i) => (
                  <div key={i} style={{ display: "flex", gap: "0.5rem" }}>
                    <textarea
                      value={msg}
                      onChange={(e) => {
                        const updated = [...form.response_messages];
                        updated[i] = e.target.value;
                        setForm({ ...form, response_messages: updated });
                      }}
                      rows={2}
                      placeholder={`Variant ${i + 1}`}
                      style={{ flex: 1, padding: "0.5rem", background: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem", resize: "vertical" }}
                    />
                    {form.response_messages.length > 1 && (
                      <button type="button" onClick={() => setForm({ ...form, response_messages: form.response_messages.filter((_, j) => j !== i) })}
                        style={{ padding: "0.25rem 0.5rem", background: "none", border: "1px solid var(--destructive)", borderRadius: "var(--radius)", cursor: "pointer", fontSize: "0.75rem", color: "var(--destructive)", alignSelf: "flex-start" }}>
                        Remove
                      </button>
                    )}
                  </div>
                ))}
                <button type="button"
                  onClick={() => setForm({ ...form, response_messages: [...form.response_messages, ""] })}
                  style={{ alignSelf: "flex-start", padding: "0.25rem 0.75rem", background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius)", cursor: "pointer", fontSize: "0.75rem", color: "var(--foreground)" }}>
                  + Add variant
                </button>
              </div>
            )}

            {form.response_type === "ai_rephrase" && (
              <>
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--muted-foreground)", marginBottom: "0.25rem" }}>Base message (AI will rephrase each time)</label>
                <textarea value={form.response_text} onChange={(e) => setForm({ ...form, response_text: e.target.value })} rows={3} required
                  style={{ width: "100%", padding: "0.5rem", background: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem", resize: "vertical", marginBottom: "0.5rem" }} />
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--muted-foreground)", marginBottom: "0.25rem" }}>Tone</label>
                <input value={form.ai_tone} onChange={(e) => setForm({ ...form, ai_tone: e.target.value })}
                  placeholder="e.g. friendly, professional, casual, enthusiastic"
                  style={{ width: "100%", padding: "0.5rem", background: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem" }} />
                <p style={{ fontSize: "0.7rem", color: "var(--muted-foreground)", marginTop: "0.25rem" }}>
                  Requires OPENAI_API_KEY in .env. Without it, the base message is sent as-is.
                </p>
              </>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.8rem", color: "var(--muted-foreground)", marginBottom: "0.25rem" }}>Priority (higher = checked first)</label>
              <input type="number" min={0} max={999} value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
                style={{ width: "100%", padding: "0.5rem", background: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem" }} />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.8rem", color: "var(--muted-foreground)", marginBottom: "0.25rem" }}>Cooldown (seconds)</label>
              <input type="number" min={0} value={form.cooldown_seconds} onChange={(e) => setForm({ ...form, cooldown_seconds: Number(e.target.value) })}
                style={{ width: "100%", padding: "0.5rem", background: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem" }} />
            </div>
          </div>

          {error && <p style={{ color: "var(--destructive)", fontSize: "0.8rem" }}>{error}</p>}

          <button type="submit" disabled={saving}
            style={{ alignSelf: "flex-end", padding: "0.5rem 1.5rem", background: "var(--primary)", color: "var(--primary-foreground)", border: "none", borderRadius: "var(--radius)", cursor: saving ? "not-allowed" : "pointer", fontWeight: 600, fontSize: "0.875rem", opacity: saving ? 0.7 : 1 }}>
            {saving ? "Saving..." : "Create Rule"}
          </button>
        </form>
      )}

      {loading ? (
        <p style={{ color: "var(--muted-foreground)", fontSize: "0.875rem" }}>Loading...</p>
      ) : rules.length === 0 ? (
        <p style={{ color: "var(--muted-foreground)", fontSize: "0.875rem" }}>No rules yet. Create your first auto-reply rule.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {rules.map((r) => (
            <RuleRow key={r.id} rule={r} onToggle={handleToggle} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  );
}
