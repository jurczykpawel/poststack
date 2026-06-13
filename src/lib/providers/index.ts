import { providers } from "./registry";
import { metaProvider } from "./meta";
import { youtubeProvider } from "./youtube";
import { tiktokProvider } from "./tiktok";
import { xProvider } from "./x";
import { linkedinProvider } from "./linkedin";
import { threadsProvider } from "./threads";

// The publish-side providers (one per platform). meta serves FB+IG publish; the inbound side lives
// in @/lib/platforms (facebook/instagram/youtube) and shares the Meta token/app-secret model. The
// channel-level unification (one account both publishes AND replies) is the Task 6 capability model.
providers.register(metaProvider);
providers.register(youtubeProvider);
providers.register(tiktokProvider);
providers.register(xProvider);
providers.register(linkedinProvider);
providers.register(threadsProvider);

export { getProvider, isProvider, listProviders, providers } from "./registry";
export type { Provider, FormatCapability, PublishRequest, AccountInfo } from "./types";
