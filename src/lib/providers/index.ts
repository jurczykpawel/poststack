import { providers } from "./registry";
import { tiktokProvider } from "./tiktok";
import { xProvider } from "./x";
import { linkedinProvider } from "./linkedin";
import { threadsProvider } from "./threads";

// Publish-only adapters RS lacked. meta + youtube get the publish capability folded into their
// existing inbound providers (Task 4b reconciliation) and are registered here once unified.
providers.register(tiktokProvider);
providers.register(xProvider);
providers.register(linkedinProvider);
providers.register(threadsProvider);

export { getProvider, isProvider, listProviders, providers } from "./registry";
export type { Provider, FormatCapability, PublishRequest, AccountInfo } from "./types";
