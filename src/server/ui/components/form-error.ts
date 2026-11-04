type Detail = { path?: unknown; message?: unknown };

const LABELS: Record<string, string> = { mediaUrl: "Media URL", coverUrl: "Cover URL", baseDescription: "Description", baseHashtags: "Hashtags", value: "Keyword", content: "Step text", text: "Reply text", custom_prompt: "Custom prompt" };

function field(path: unknown): string {
  const last = (Array.isArray(path) ? path : [path]).filter((p) => typeof p === "string" && p !== "").pop() as string | undefined;
  if (!last) return "Field";
  return LABELS[last] ?? last.charAt(0).toUpperCase() + last.slice(1).replace(/_/g, " ");
}

/** One sentence for a validation detail: zod's default size messages get the field name, custom ones pass through. */
function sentence(d: Detail): string {
  const m = String(d.message);
  if (/^Too small: expected string to have >=1 char/.test(m)) return `${field(d.path)} is required.`;
  const big = /^Too big: expected string to have <=(\d+) char/.exec(m);
  if (big) return `${field(d.path)} must be at most ${big[1]} characters.`;
  return m;
}

/** The text a form shows for a failed API call: the field messages when there are any, else the envelope message. */
export function formErrorText(body: unknown, fallback: string): string {
  const e = (body as { error?: { message?: string; details?: unknown } } | null)?.error;
  if (!e) return fallback;
  const parts = Array.isArray(e.details) ? (e.details as Detail[]).filter((d) => typeof d?.message === "string").map(sentence) : [];
  return parts.length ? [...new Set(parts)].slice(0, 3).join(" ") : e.message ?? fallback;
}
