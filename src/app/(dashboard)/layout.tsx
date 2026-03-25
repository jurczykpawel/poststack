import Link from "next/link";

const NAV = [
  { href: "/inbox", label: "Inbox" },
  { href: "/rules", label: "Rules" },
  { href: "/channels", label: "Channels" },
  { href: "/contacts", label: "Contacts" },
  { href: "/sequences", label: "Sequences" },
  { href: "/settings", label: "Settings" },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <aside style={{
        width: 200,
        background: "var(--muted)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        padding: "1rem 0",
        flexShrink: 0,
      }}>
        <div style={{ padding: "0 1rem 1rem", borderBottom: "1px solid var(--border)", marginBottom: "0.5rem" }}>
          <span style={{ fontWeight: 700, fontSize: "1rem" }}>ReplyStack</span>
        </div>
        <nav style={{ display: "flex", flexDirection: "column", gap: "0.125rem", padding: "0 0.5rem" }}>
          {NAV.map((item) => (
            <Link key={item.href} href={item.href}
              style={{ padding: "0.5rem 0.75rem", borderRadius: "var(--radius)", color: "var(--foreground)", fontSize: "0.875rem" }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div style={{ marginTop: "auto", padding: "0 0.5rem" }}>
          <form action="/api/auth/logout" method="POST">
            <button type="submit"
              style={{ width: "100%", padding: "0.5rem 0.75rem", background: "none", border: "none", color: "var(--muted-foreground)", cursor: "pointer", textAlign: "left", borderRadius: "var(--radius)", fontSize: "0.875rem" }}>
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main style={{ flex: 1, overflow: "auto" }}>
        {children}
      </main>
    </div>
  );
}
