import { pages } from "./locales/en";
export const PUBLIC_PAGES = pages;
export type PublicPage = (typeof PUBLIC_PAGES)[number];

export { publicSiteOrigin } from "./origin";
