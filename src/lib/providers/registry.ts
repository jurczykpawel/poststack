import type { Provider } from "./types";

export function createRegistry() {
  const map = new Map<string, Provider>();
  return {
    register(p: Provider): void {
      if (map.has(p.id)) throw new Error(`provider already registered: ${p.id}`);
      map.set(p.id, p);
    },
    get(id: string): Provider {
      const p = map.get(id);
      if (!p) throw new Error(`unknown provider: ${id}`);
      return p;
    },
    has(id: string): boolean {
      return map.has(id);
    },
    list(): Provider[] {
      return [...map.values()];
    },
  };
}

/** The process-wide registry (static — no lazy init; avoids ReplyStack FIX1 race). */
export const providers = createRegistry();
export const getProvider = (id: string) => providers.get(id);
export const isProvider = (id: string) => providers.has(id);
export const listProviders = () => providers.list();
