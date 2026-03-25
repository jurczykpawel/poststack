"use client";
import { useState, useEffect } from "react";

interface Step {
  type: "message" | "delay";
  content?: string;
  delay_minutes?: number;
}

interface Sequence {
  id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  steps: Step[];
  created_at: string;
  _count: { enrollments: number };
}

const STATUS_COLORS: Record<string, string> = {
  draft: "#94a3b8",
  active: "#22c55e",
  archived: "#f59e0b",
};

function StepEditor({
  steps,
  onChange,
}: {
  steps: Step[];
  onChange: (steps: Step[]) => void;
}) {
  function addMessage() {
    onChange([...steps, { type: "message", content: "" }]);
  }
  function addDelay() {
    onChange([...steps, { type: "delay", delay_minutes: 60 }]);
  }
  function update(i: number, patch: Partial<Step>) {
    onChange(steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function remove(i: number) {
    onChange(steps.filter((_, idx) => idx !== i));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      {steps.map((step, i) => (
        <div key={i} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
          <div style={{
            flex: 1, padding: "0.5rem", border: "1px solid var(--border)",
            borderRadius: "var(--radius)", background: "var(--muted)",
          }}>
            {step.type === "message" ? (
              <textarea
                value={step.content ?? ""}
                onChange={(e) => update(i, { content: e.target.value })}
                placeholder="Message text..."
                rows={2}
                style={{ width: "100%", border: "none", background: "transparent", color: "var(--foreground)", fontSize: "0.875rem", resize: "vertical" }}
              />
            ) : (
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.875rem" }}>
                <span style={{ color: "var(--muted-foreground)" }}>Wait</span>
                <input
                  type="number"
                  min={1}
                  value={step.delay_minutes ?? 60}
                  onChange={(e) => update(i, { delay_minutes: Number(e.target.value) })}
                  style={{ width: 60, padding: "0.25rem", background: "var(--background)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem" }}
                />
                <span style={{ color: "var(--muted-foreground)" }}>minutes</span>
              </div>
            )}
          </div>
          <button onClick={() => remove(i)}
            style={{ padding: "0.25rem 0.5rem", background: "none", border: "1px solid var(--destructive)", borderRadius: "var(--radius)", cursor: "pointer", fontSize: "0.75rem", color: "var(--destructive)" }}>
            Remove
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button type="button" onClick={addMessage}
          style={{ padding: "0.25rem 0.75rem", background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius)", cursor: "pointer", fontSize: "0.75rem", color: "var(--foreground)" }}>
          + Message
        </button>
        <button type="button" onClick={addDelay}
          style={{ padding: "0.25rem 0.75rem", background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius)", cursor: "pointer", fontSize: "0.75rem", color: "var(--muted-foreground)" }}>
          + Delay
        </button>
      </div>
    </div>
  );
}

const defaultForm = { name: "", description: "", steps: [] as Step[] };

export default function SequencesPage() {
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(defaultForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/v1/sequences")
      .then((r) => r.json())
      .then((d) => setSequences(d.data ?? []))
      .finally(() => setLoading(false));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (form.steps.length === 0) { setError("Add at least one step"); return; }
    setError("");
    setSaving(true);
    try {
      const res = await fetch("/api/v1/sequences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name, description: form.description || undefined, steps: form.steps }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error?.message ?? "Failed"); return; }
      setSequences((prev) => [data.data, ...prev]);
      setShowForm(false);
      setForm(defaultForm);
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(id: string, status: string) {
    await fetch(`/api/v1/sequences/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setSequences((prev) => prev.map((s) => s.id === id ? { ...s, status: status as Sequence["status"] } : s));
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this sequence?")) return;
    await fetch(`/api/v1/sequences/${id}`, { method: "DELETE" });
    setSequences((prev) => prev.filter((s) => s.id !== id));
  }

  return (
    <div style={{ padding: "2rem", maxWidth: 800 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <div>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "0.25rem" }}>Sequences</h1>
          <p style={{ color: "var(--muted-foreground)", fontSize: "0.875rem" }}>
            Automated drip message sequences for contacts.
          </p>
        </div>
        <button onClick={() => setShowForm(!showForm)}
          style={{ padding: "0.5rem 1rem", background: "var(--primary)", color: "var(--primary-foreground)", border: "none", borderRadius: "var(--radius)", cursor: "pointer", fontWeight: 600, fontSize: "0.875rem" }}>
          {showForm ? "Cancel" : "+ New Sequence"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} style={{ marginBottom: "1.5rem", padding: "1rem", border: "1px solid var(--border)", borderRadius: "var(--radius)", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <div>
            <label style={{ display: "block", fontSize: "0.8rem", color: "var(--muted-foreground)", marginBottom: "0.25rem" }}>Name</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required
              style={{ width: "100%", padding: "0.5rem", background: "var(--muted)", border: "1px solid var(--border)", borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem" }} />
          </div>
          <div>
            <label style={{ display: "block", fontSize: "0.8rem", color: "var(--muted-foreground)", marginBottom: "0.25rem" }}>Steps</label>
            <StepEditor steps={form.steps} onChange={(steps) => setForm({ ...form, steps })} />
          </div>
          {error && <p style={{ color: "var(--destructive)", fontSize: "0.8rem" }}>{error}</p>}
          <button type="submit" disabled={saving}
            style={{ alignSelf: "flex-end", padding: "0.5rem 1.5rem", background: "var(--primary)", color: "var(--primary-foreground)", border: "none", borderRadius: "var(--radius)", cursor: saving ? "not-allowed" : "pointer", fontWeight: 600, fontSize: "0.875rem" }}>
            {saving ? "Saving..." : "Create"}
          </button>
        </form>
      )}

      {loading ? (
        <p style={{ color: "var(--muted-foreground)", fontSize: "0.875rem" }}>Loading...</p>
      ) : sequences.length === 0 ? (
        <p style={{ color: "var(--muted-foreground)", fontSize: "0.875rem" }}>No sequences yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {sequences.map((seq) => (
            <div key={seq.id} style={{ padding: "0.75rem 1rem", border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "var(--muted)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>{seq.name}</span>
                  <span style={{ marginLeft: "0.5rem", fontSize: "0.7rem", fontWeight: 600, color: STATUS_COLORS[seq.status] }}>
                    {seq.status.toUpperCase()}
                  </span>
                </div>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  {seq.status === "draft" && (
                    <button onClick={() => handleStatusChange(seq.id, "active")}
                      style={{ padding: "0.25rem 0.5rem", background: "none", border: "1px solid #22c55e", borderRadius: "var(--radius)", cursor: "pointer", fontSize: "0.75rem", color: "#22c55e" }}>
                      Activate
                    </button>
                  )}
                  {seq.status === "active" && (
                    <button onClick={() => handleStatusChange(seq.id, "archived")}
                      style={{ padding: "0.25rem 0.5rem", background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius)", cursor: "pointer", fontSize: "0.75rem", color: "var(--muted-foreground)" }}>
                      Archive
                    </button>
                  )}
                  <button onClick={() => handleDelete(seq.id)}
                    style={{ padding: "0.25rem 0.5rem", background: "none", border: "1px solid var(--destructive)", borderRadius: "var(--radius)", cursor: "pointer", fontSize: "0.75rem", color: "var(--destructive)" }}>
                    Delete
                  </button>
                </div>
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--muted-foreground)", marginTop: "0.25rem" }}>
                {seq.steps.length} steps · {seq._count.enrollments} enrolled
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
