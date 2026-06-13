import { describe, it, expect } from "vitest";
import { kpi } from "./kpi";
import { emptyState } from "./empty-state";

const s = (h: unknown) => String(h);

describe("kpi", () => {
  it("renders the value, the uppercase label, and a tone dot", () => {
    const out = s(kpi({ value: 61, label: "Healthy", tone: "ok" }));
    expect(out).toContain("kpi");
    expect(out).toContain(">61<");
    expect(out).toContain("Healthy");
    expect(out).toContain("dot tone-ok");
  });

  it("applies the tone to the value class", () => {
    expect(s(kpi({ value: 2, label: "Failed · 24h", tone: "bad" }))).toContain("tone-bad");
    expect(s(kpi({ value: 3, label: "Needs reauth", tone: "warn" }))).toContain("tone-warn");
  });

  it("renders an optional mono sub caption", () => {
    const out = s(kpi({ value: 14, label: "Scheduled", tone: "info", sub: "next 22m" }));
    expect(out).toContain("kpi-sub");
    expect(out).toContain("next 22m");
  });

  it("omits the sub element when no sub is given", () => {
    expect(s(kpi({ value: 1, label: "X", tone: "neutral" }))).not.toContain("kpi-sub");
  });

  it("wraps the card in a link when href is given", () => {
    const out = s(kpi({ value: 61, label: "Healthy", tone: "ok", href: "/admin/channels" }));
    expect(out).toContain('href="/admin/channels"');
    expect(out).toContain("kpi");
  });

  it("escapes the label (no raw injection)", () => {
    const out = s(kpi({ value: 1, label: "<script>x</script>", tone: "ok" }));
    expect(out).not.toContain("<script>x</script>");
  });
});

describe("emptyState", () => {
  it("renders the title and body inside an .empty block", () => {
    const out = s(emptyState({ title: "All healthy ✓", body: "Nothing needs attention." }));
    expect(out).toContain("empty");
    expect(out).toContain("All healthy ✓");
    expect(out).toContain("Nothing needs attention.");
  });

  it("renders an optional action button", () => {
    const out = s(
      emptyState({
        title: "No channels",
        body: "Connect one to get started.",
        action: { label: "Connect channel", href: "/admin/channels" },
      }),
    );
    expect(out).toContain("Connect channel");
    expect(out).toContain('href="/admin/channels"');
  });

  it("omits the action when none is given", () => {
    const out = s(emptyState({ title: "Empty", body: "Nothing here." }));
    expect(out).not.toContain("btn-");
  });
});
