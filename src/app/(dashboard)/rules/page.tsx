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
      ? `${((rule.response_config as { messages?: string[] }).messages ?? []).length} random messages`
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

const defaultForm = {
  name: "",
  trigger_type: "keyword" as const,
  keywords: "",
  match_type: "contains" as const,
  response_type: "text" as const,
  response_text: "",
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

  useEffect(() => {
    fetch("/api/v1/rules")
      .then((r) => r.json())
      .then((d) => setRules(d.data ?? []))
      .finally(() => setLoading(false));
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

      const body = {
        name: form.name,
        trigger_type: form.trigger_type,
        trigger_config: keywords.length > 0 ? { keywords } : {},
        response_type: form.response_type,
        response_config: form.response_type === "text" ? { text: form.response_text } : {},
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
                <label style={{ display: "block", fontSize: "0.8rem", color: "var(--muted-foreground)", marginBottom: "0.25rem" }}>Keywords (comma separated)</label>
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

          <div>
            <label style={{ display: "block", fontSize: "0.8rem", color: "var(--muted-foreground)", marginBottom: "0.25rem" }}>Reply text</label>
            <textarea value={form.response_text} onChange={(e) => setForm({ ...form, response_text: e.target.value })} rows={3} required
              style={{ width: "100%", padding: "0.5rem", background: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem", resize: "vertical" }} />
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
