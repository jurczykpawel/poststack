import { describe, it, expect } from "vitest";
import { dataList, listHref, readListState } from "./data-list";

type Row = { id: string; name: string };
const COLS = [{ label: "Name", width: "100%", cell: (r: Row) => r.name, main: true }];
const page = { start: 1, end: 1, total: 1, older: null, newer: null };

async function render(over: Partial<Parameters<typeof dataList<Row>>[0]> = {}) {
  return String(await dataList<Row>({
    path: "/things", noun: "things", state: readListState("http://x/things", []), searchPlaceholder: "Search",
    columns: COLS, rows: [{ id: "r1", name: "One" }], rowId: (r) => r.id, page,
    emptyTitle: "Nothing yet", emptyBody: "Soon", ...over,
  }));
}

describe("readListState", () => {
  it("reads only the declared filters and trims the search", () => {
    const st = readListState("http://x/t?q=%20hi%20&area=post&evil=1&after=A&open=O", ["area"]);
    expect(st).toEqual({ q: "hi", filters: { area: "post" }, after: "A", before: "", open: "O", fixed: {} });
  });

  it("reads fixed params apart from filters, so a filter clear can never drop them", () => {
    const st = readListState("http://x/t?source=ai&area=post", ["area"], ["source"]);
    expect(st.fixed).toEqual({ source: "ai" });
    expect(st.filters).toEqual({ area: "post" });
  });

  it("bounds an oversized search", () => {
    expect(readListState(`http://x/t?q=${"a".repeat(500)}`, []).q).toHaveLength(200);
  });
});

describe("listHref", () => {
  const st = { q: "hi there", filters: { area: "post", kind: "" }, after: "A", before: "", open: "O" };

  it("omits empty values and encodes the rest", () => {
    expect(listHref("/t", { q: "", filters: { area: "" }, after: "", before: "", open: "" })).toBe("/t");
    expect(listHref("/t", st)).toBe("/t?q=hi+there&area=post&after=A&open=O");
  });

  it("changing a filter leaves the page and the open row behind", () => {
    expect(listHref("/t", st, { filter: { kind: "x" } })).toBe("/t?q=hi+there&area=post&kind=x");
  });

  it("closing details keeps the page", () => {
    expect(listHref("/t", st, { open: "" })).toBe("/t?q=hi+there&area=post&after=A");
  });

  it("moving a page closes details", () => {
    expect(listHref("/t", st, { before: "B" })).toBe("/t?q=hi+there&area=post&before=B");
  });
});

describe("fixed params", () => {
  const st = readListState("http://x/t?source=ai&q=hi&area=post&after=A", ["area"], ["source"]);

  it("lead every address and survive filter, page and close changes", () => {
    expect(listHref("/t", st)).toBe("/t?source=ai&q=hi&area=post&after=A");
    expect(listHref("/t", st, { filter: { area: "" } })).toBe("/t?source=ai&q=hi");
    expect(listHref("/t", st, { before: "B" })).toBe("/t?source=ai&q=hi&area=post&before=B");
  });

  it("stay in the filter form and on the Clear link", async () => {
    const out = await render({ path: "/t", state: st });
    expect(out).toContain('<input type="hidden" name="source" value="ai" />');
    expect(out).toContain('class="filter-clear" href="/t?source=ai"');
  });
});

describe("dataList", () => {
  it("makes each row a real link so it works by keyboard and without scripts", async () => {
    const out = await render();
    expect(out).toContain('href="/things?open=r1"');
    expect(out).toContain('data-row="r1"');
  });

  it("swaps only the list region and pushes the address", async () => {
    const out = await render();
    expect(out).toContain('id="data-list"');
    expect(out).toContain('hx-boost="true"');
    expect(out).toContain('hx-select="#data-list"');
    expect(out).toContain('hx-push-url="true"');
  });

  it("disables the page links at both ends", async () => {
    const out = await render();
    expect(out).not.toContain('rel="next"');
    expect(out).not.toContain('rel="prev"');
    expect(out.match(/aria-disabled="true"/g)).toHaveLength(2);
  });

  it("carries the active chip through the search form", async () => {
    const state = readListState("http://x/t?sev=bad", ["sev"]);
    const out = await render({ state, chips: { key: "sev", label: "Severity", all: 3, options: [{ value: "bad", label: "Bad", count: 1 }] } });
    expect(out).toContain('<input type="hidden" name="sev" value="bad"');
    expect(out).toContain('aria-current="true"');
  });

  it("shows the pristine empty state without filters and a clearing one with them", async () => {
    const pristine = await render({ rows: [], page: { ...page, total: 0, start: 0, end: 0 } });
    expect(pristine).toContain("Nothing yet");
    const filtered = await render({ rows: [], page: { ...page, total: 0, start: 0, end: 0 }, state: readListState("http://x/t?q=zz", []) });
    expect(filtered).toContain("No things match");
    expect(filtered).not.toContain("Nothing yet");
  });
});
