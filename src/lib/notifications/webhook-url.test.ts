import { describe, it, expect } from "vitest";
import { isSafeAlertWebhookUrl } from "./webhook-url";

describe("isSafeAlertWebhookUrl", () => {
  it("allows https to a public host", () => {
    expect(isSafeAlertWebhookUrl("https://hooks.example.com/alert")).toBe(true);
  });

  it("allows http/https to a hostname (localhost, docker service name)", () => {
    expect(isSafeAlertWebhookUrl("http://localhost:3000/hook")).toBe(true);
    expect(isSafeAlertWebhookUrl("http://ntfy/notify")).toBe(true);
    expect(isSafeAlertWebhookUrl("https://n8n.internal-domain.test/webhook")).toBe(true);
  });

  it("allows loopback IP literals (parity with localhost)", () => {
    expect(isSafeAlertWebhookUrl("http://127.0.0.1:8080/hook")).toBe(true);
    expect(isSafeAlertWebhookUrl("http://[::1]:8080/hook")).toBe(true);
  });

  it("blocks the cloud metadata endpoint", () => {
    expect(isSafeAlertWebhookUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
  });

  it("blocks RFC1918 IP literals", () => {
    expect(isSafeAlertWebhookUrl("http://10.0.0.5/x")).toBe(false);
    expect(isSafeAlertWebhookUrl("http://172.16.3.4/x")).toBe(false);
    expect(isSafeAlertWebhookUrl("http://192.168.1.5/x")).toBe(false);
    expect(isSafeAlertWebhookUrl("https://192.168.1.5/x")).toBe(false); // even over https
  });

  it("blocks 0.0.0.0 and IPv6 ULA / link-local literals", () => {
    expect(isSafeAlertWebhookUrl("http://0.0.0.0/x")).toBe(false);
    expect(isSafeAlertWebhookUrl("http://[fd00::1]/x")).toBe(false);
    expect(isSafeAlertWebhookUrl("http://[fe80::1]/x")).toBe(false);
  });

  it("blocks non-http(s) schemes and malformed URLs", () => {
    expect(isSafeAlertWebhookUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeAlertWebhookUrl("gopher://10.0.0.1/")).toBe(false);
    expect(isSafeAlertWebhookUrl("not a url")).toBe(false);
    expect(isSafeAlertWebhookUrl("")).toBe(false);
  });
});
