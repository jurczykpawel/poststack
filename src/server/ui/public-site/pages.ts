export const PUBLIC_PAGES = [
  { path: "/", label: "Home", title: "Your publishing workspace" },
  { path: "/how-it-works", label: "How it works", title: "From your content to your channels" },
  { path: "/features", label: "Features", title: "Tools available in this instance" },
  { path: "/faq", label: "FAQ", title: "Frequently asked questions" },
  { path: "/about", label: "About", title: "About this instance" },
  { path: "/contact", label: "Contact", title: "Contact the instance operator" },
  { path: "/privacy", label: "Privacy", title: "Privacy Policy" },
  { path: "/terms", label: "Terms", title: "Terms of Service" },
  { path: "/data-deletion", label: "Data deletion", title: "Request and manage data deletion" },
] as const;
export type PublicPage = (typeof PUBLIC_PAGES)[number];
