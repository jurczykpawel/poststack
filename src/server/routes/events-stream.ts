import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { authenticate } from "@/lib/auth";
import { subscribe, startRealtimeListener } from "@/lib/realtime/hub";

// REALTIME1 · R3 — the SSE endpoint. authenticate() → workspaceId → register with the hub → stream
// workspace-scoped signals server→client. STRICTLY workspace-scoped: the stream only ever carries the
// caller's own workspace events (the hub keys fan-out by workspaceId — never leaks cross-workspace).
// Heartbeat keeps the connection alive through proxies; the hub subscription is removed on close.
const HEARTBEAT_MS = 20_000;

export async function GET(c: Context): Promise<Response> {
  const auth = await authenticate(c.req.raw).catch(() => null);
  if (!auth) return c.text("Unauthorized", 401);
  const workspaceId = auth.workspaceId;

  // Ensure this web process is LISTENing (idempotent; lazy on the first SSE connection).
  await startRealtimeListener();

  return streamSSE(c, async (stream) => {
    // Queue signals from the hub; the writer loop drains them. (streamSSE wants awaited writes.)
    const pending: { event: string; data: string }[] = [];
    let notify: (() => void) | null = null;
    const unsubscribe = subscribe(workspaceId, (signal) => {
      pending.push({ event: signal.kind, data: signal.id });
      notify?.();
    });

    let open = true;
    stream.onAbort(() => {
      open = false;
      unsubscribe();
      notify?.();
    });

    // Initial comment so the client knows the stream is live (and to flush proxy buffers).
    await stream.writeSSE({ event: "ready", data: "ok" });

    let lastBeat = Date.now();
    while (open) {
      // Drain everything the hub queued for this workspace.
      while (pending.length && open) {
        const msg = pending.shift()!;
        await stream.writeSSE(msg);
      }
      if (!open) break;
      // Heartbeat comment on idle, so proxies don't time the connection out.
      if (Date.now() - lastBeat >= HEARTBEAT_MS) {
        await stream.writeSSE({ event: "heartbeat", data: String(Date.now()) });
        lastBeat = Date.now();
      }
      // Wait for the next signal or a short tick (so heartbeat + abort are responsive).
      await new Promise<void>((resolve) => {
        notify = resolve;
        setTimeout(resolve, 1000);
      });
      notify = null;
    }
    unsubscribe();
  });
}
