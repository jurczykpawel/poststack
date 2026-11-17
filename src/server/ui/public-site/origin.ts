export function publicSiteOrigin() {
  return new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
}
