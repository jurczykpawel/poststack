import { and, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { decodeCursor, encodeCursor, type Cursor } from "@/lib/api/pagination";

/** What the pager needs. `start`/`end` are 1-based positions under the current filters. */
export interface ListPage<R> {
  rows: R[];
  start: number;
  end: number;
  total: number;
  older: string | null;
  newer: string | null;
}

export interface ListPageArgs<R> {
  table: PgTable;
  /** Full filter, workspace scope included. */
  where: SQL | undefined;
  /** `timestamp(3)` without time zone, as every list table uses. */
  time: AnyColumn;
  /** The time may be NULL; those rows sort after every dated one (`desc nulls last`) and are ordered by id. */
  nullable?: boolean;
  id: AnyColumn;
  limit: number;
  /** Raw URL values; a malformed one is treated as absent. */
  after?: string;
  before?: string;
  keyOf: (row: R) => { at: Date | null; id: string };
  /** Runs the select with the given where/orderBy/limit, so a section can pick columns and joins. */
  fetch: (q: { where: SQL | undefined; orderBy: SQL[]; limit: number }) => Promise<R[]>;
}

/** Newest-first keyset page with exact position and total, stable while new rows keep arriving. */
export async function listPage<R>(a: ListPageArgs<R>): Promise<ListPage<R>> {
  const after = a.after ? decodeCursor(a.after, a.nullable) : null;
  const before = !after && a.before ? decodeCursor(a.before, a.nullable) : null;
  // Rows strictly older/newer than a cursor ("" = the NULL group, which is the oldest).
  const seek = (c: Cursor, dir: "older" | "newer"): SQL => {
    const cmp = dir === "older" ? sql`<` : sql`>`;
    if (!a.nullable) return sql`(${a.time}, ${a.id}) ${cmp} (${c.createdAt}::timestamp, ${c.id}::uuid)`;
    const none = sql`${a.time} is null`;
    if (c.createdAt === "") return dir === "older" ? sql`(${none} and ${a.id} < ${c.id}::uuid)` : sql`(not ${none} or (${none} and ${a.id} > ${c.id}::uuid))`;
    const same = sql`${a.time} = ${c.createdAt}::timestamp and ${a.id} ${cmp} ${c.id}::uuid`;
    return sql`(${a.time} ${cmp} ${c.createdAt}::timestamp or (${same})${dir === "older" ? sql` or ${none}` : sql``})`;
  };
  const tuple = (c: Cursor) => seek(c, before ? "newer" : "older");
  const newestFirst = [sql`${a.time} desc${a.nullable ? sql` nulls last` : sql``}`, sql`${a.id} desc`];
  const take = a.limit + 1;

  const first = () => a.fetch({ where: a.where, orderBy: newestFirst, limit: take });
  let rows: R[];
  let hasOlder: boolean;
  if (before) {
    const ascending = await a.fetch({ where: and(a.where, tuple(before)), orderBy: [sql`${a.time} asc${a.nullable ? sql` nulls first` : sql``}`, sql`${a.id} asc`], limit: take });
    // At the newest end a short page would be left over; the first page is the honest one.
    if (ascending.length > a.limit) {
      rows = ascending.slice(0, a.limit).reverse();
      hasOlder = true;
    } else {
      rows = await first();
      hasOlder = rows.length > a.limit;
    }
  } else {
    rows = after ? await a.fetch({ where: and(a.where, tuple(after)), orderBy: newestFirst, limit: take }) : await first();
    // Everything older was pruned since the link was made.
    if (after && rows.length === 0) rows = await first();
    hasOlder = rows.length > a.limit;
  }

  const pageRows = rows.slice(0, a.limit);
  const top = pageRows[0];
  const bottom = pageRows[pageRows.length - 1];
  const cursorOf = (r: R): Cursor => {
    const k = a.keyOf(r);
    return { createdAt: k.at?.toISOString() ?? "", id: k.id };
  };
  const topCursor = top ? cursorOf(top) : null;

  const newerThanTop = topCursor
    ? sql<number>`count(*) filter (where ${seek(topCursor, "newer")})::int`
    : sql<number>`0`;
  const [counts] = await db.select({ total: sql<number>`count(*)::int`, newer: newerThanTop }).from(a.table).where(a.where);
  const newer = counts?.newer ?? 0;

  return {
    rows: pageRows,
    start: pageRows.length ? newer + 1 : 0,
    end: newer + pageRows.length,
    total: counts?.total ?? 0,
    older: hasOlder && bottom ? encodeCursor(cursorOf(bottom)) : null,
    newer: newer > 0 && topCursor ? encodeCursor(topCursor) : null,
  };
}

/** Rows per distinct value of `expr` under `where`; NULL values are not counted. */
export async function countBy(table: PgTable, expr: SQL | AnyColumn, where: SQL | undefined): Promise<Map<string, number>> {
  const rows = await db.select({ value: sql<string | null>`${expr}`, n: sql<number>`count(*)::int` }).from(table).where(where).groupBy(sql`1`);
  return new Map(rows.filter((r) => r.value !== null).map((r) => [r.value as string, r.n]));
}

/** A `%…%` ILIKE pattern that matches the user's text literally. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, "\\$&")}%`;
}
