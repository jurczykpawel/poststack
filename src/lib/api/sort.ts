import { ApiError } from "./response";

export interface SortClause {
  column: string;
  dir: "asc" | "desc";
}

/** `-created_at,title` → ordered clauses; `-` prefix = descending. Each field is validated against
 *  `allowed`; an unknown field is a 422 (never interpolate raw input into ORDER BY). */
export function parseSort(raw: string | undefined, allowed: readonly string[]): SortClause[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((tok) => tok.trim())
    .filter(Boolean)
    .map((t) => {
      const dir = t.startsWith("-") ? "desc" : "asc";
      const column = t.replace(/^-/, "");
      if (!allowed.includes(column)) throw new ApiError("invalid_request", `Invalid sort field: ${column}`, 422);
      return { column, dir };
    });
}
