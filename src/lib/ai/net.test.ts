import { describe, it, expect } from "vitest";
import { aiFetch, parseAllowedTargets } from "./net";
import type { Connector } from "@/lib/net/safe-fetch";

// AIPROVIDER1: private targets are blocked by default and only reachable through AI_ALLOWED_PRIVATE_TARGETS.
const connector = () => {
  const calls: Array<{ pinnedIp: string; hostname: string }> = [];
  const connect: Connector = async ({ pinnedIp, hostname }) => {
    calls.push({ pinnedIp, hostname });
    return new Response("{}");
  };
  return { calls, connect };
};
const resolveTo = (map: Record<string, string[]>) => async (h: string) => map[h] ?? [h];

describe("parseAllowedTargets", () => {
  it("parses hosts, IPs, CIDRs and optional ports; ignores blanks", () => {
    const t = parseAllowedTargets(" 127.0.0.1:11434, ollama:11434 ,10.0.0.0/8,[::1]:11434,, nas.lan ");
    expect(t).toEqual([
      { host: "127.0.0.1", port: 11434 },
      { host: "ollama", port: 11434 },
      { cidr: { base: 0x0a000000, bits: 8 } },
      { host: "::1", port: 11434 },
      { host: "nas.lan" },
    ]);
  });
});

describe("aiFetch — private target policy", () => {
  it("blocks loopback and private addresses by default", async () => {
    const { connect, calls } = connector();
    for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.9", "100.64.0.1"]) {
      await expect(aiFetch(`http://${ip}:11434/v1/models`, {}, { allowed: "", connect })).rejects.toThrow(/refused/);
    }
    expect(calls).toHaveLength(0);
  });

  it("allows a listed IP:port, but not the same IP on another port", async () => {
    const { connect, calls } = connector();
    await aiFetch("http://127.0.0.1:11434/v1/models", {}, { allowed: "127.0.0.1:11434", connect });
    expect(calls).toEqual([{ pinnedIp: "127.0.0.1", hostname: "127.0.0.1" }]);
    await expect(aiFetch("http://127.0.0.1:8080/v1/models", {}, { allowed: "127.0.0.1:11434", connect })).rejects.toThrow(/refused/);
  });

  it("allows a listed hostname (resolved to a private IP) and pins the resolved IP", async () => {
    const { connect, calls } = connector();
    await aiFetch("http://ollama:11434/v1/models", {}, { allowed: "ollama:11434", connect, resolve: resolveTo({ ollama: ["172.18.0.4"] }) });
    expect(calls).toEqual([{ pinnedIp: "172.18.0.4", hostname: "ollama" }]);
  });

  it("allows an IP inside a listed CIDR and refuses one outside it", async () => {
    const { connect } = connector();
    await aiFetch("http://10.1.2.3/v1/models", {}, { allowed: "10.0.0.0/8", connect });
    await expect(aiFetch("http://192.168.0.1/v1/models", {}, { allowed: "10.0.0.0/8", connect })).rejects.toThrow(/refused/);
  });

  it("never allows cloud metadata / link-local, even when listed explicitly", async () => {
    const { connect, calls } = connector();
    await expect(aiFetch("http://169.254.169.254/latest", {}, { allowed: "169.254.169.254", connect })).rejects.toThrow(/link_local/);
    await expect(aiFetch("http://169.254.169.254/latest", {}, { allowed: "169.254.0.0/16", connect })).rejects.toThrow(/link_local/);
    await expect(aiFetch("http://meta.internal/", {}, { allowed: "meta.internal", connect, resolve: resolveTo({ "meta.internal": ["169.254.169.254"] }) })).rejects.toThrow(/link_local/);
    expect(calls).toHaveLength(0);
  });

  it("always allows public addresses, with or without a list", async () => {
    const { connect, calls } = connector();
    await aiFetch("https://api.openai.com/v1/models", {}, { allowed: "", connect, resolve: resolveTo({ "api.openai.com": ["104.18.7.192"] }) });
    expect(calls).toHaveLength(1);
  });

  it("refuses a hostname that resolves to a private IP it was not listed for (DNS rebinding)", async () => {
    const { connect } = connector();
    await expect(aiFetch("https://evil.example/v1", {}, { allowed: "ollama", connect, resolve: resolveTo({ "evil.example": ["10.0.0.7"] }) })).rejects.toThrow(/refused/);
  });
});
