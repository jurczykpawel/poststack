import { describe, it, expect, beforeEach } from "vitest";
import { subscribe, dispatch, subscriberCount, __resetHub, type RealtimeSignal } from "./hub";

beforeEach(() => __resetHub());

describe("realtime hub fan-out", () => {
  it("delivers a workspace's notify to that workspace's subscriber", () => {
    const got: RealtimeSignal[] = [];
    subscribe("ws-A", (s) => got.push(s));
    dispatch(JSON.stringify({ ws: "ws-A", kind: "comment", id: "c1" }));
    expect(got).toEqual([{ kind: "comment", id: "c1" }]);
  });

  it("NEVER delivers workspace B's notify to a workspace A subscriber (isolation invariant)", () => {
    const a: RealtimeSignal[] = [];
    const b: RealtimeSignal[] = [];
    subscribe("ws-A", (s) => a.push(s));
    subscribe("ws-B", (s) => b.push(s));
    dispatch(JSON.stringify({ ws: "ws-B", kind: "message", id: "m1" }));
    expect(b).toHaveLength(1);
    expect(a).toHaveLength(0); // A must never see B's event
    dispatch(JSON.stringify({ ws: "ws-A", kind: "reaction", id: "r1" }));
    expect(a).toEqual([{ kind: "reaction", id: "r1" }]);
    expect(b).toHaveLength(1); // B unchanged by A's event
  });

  it("removes the subscriber on unsubscribe (no delivery after disconnect)", () => {
    const got: RealtimeSignal[] = [];
    const off = subscribe("ws-A", (s) => got.push(s));
    expect(subscriberCount("ws-A")).toBe(1);
    off();
    expect(subscriberCount("ws-A")).toBe(0);
    dispatch(JSON.stringify({ ws: "ws-A", kind: "comment", id: "c1" }));
    expect(got).toHaveLength(0);
  });

  it("supports multiple subscribers on the same workspace; all receive the signal", () => {
    const a1: RealtimeSignal[] = [];
    const a2: RealtimeSignal[] = [];
    subscribe("ws-A", (s) => a1.push(s));
    subscribe("ws-A", (s) => a2.push(s));
    dispatch(JSON.stringify({ ws: "ws-A", kind: "comment", id: "c9" }));
    expect(a1).toHaveLength(1);
    expect(a2).toHaveLength(1);
  });

  it("ignores malformed / incomplete payloads without throwing", () => {
    subscribe("ws-A", () => { throw new Error("should not be called"); });
    expect(() => dispatch("not json")).not.toThrow();
    expect(() => dispatch(JSON.stringify({ ws: "ws-A" }))).not.toThrow(); // missing kind → dropped
    expect(() => dispatch(JSON.stringify({ kind: "comment", id: "x" }))).not.toThrow(); // missing ws → dropped
  });

  it("one throwing subscriber never blocks the others (fan-out is isolated)", () => {
    const ok: RealtimeSignal[] = [];
    subscribe("ws-A", () => { throw new Error("boom"); });
    subscribe("ws-A", (s) => ok.push(s));
    dispatch(JSON.stringify({ ws: "ws-A", kind: "comment", id: "c1" }));
    expect(ok).toHaveLength(1);
  });
});
