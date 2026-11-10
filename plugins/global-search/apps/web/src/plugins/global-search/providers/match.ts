/**
 * Name matching for the entity providers: a case-insensitive substring match in SQL, ranked
 * exact → prefix → word start → anywhere. No embeddings — a person, an agent or a chat is found by
 * what it is called.
 *
 * `%`, `_` and `\` in the query are escaped, so a reader typing `50%` matches the text "50%" and
 * never every row.
 */
import { type SQL, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'

/** `%`, `_` and the escape itself, escaped for `ILIKE … ESCAPE '\'`. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, c => `\\${c}`)
}

/** `column ILIKE '%q%'`, escaped. */
export function containsText(column: AnyPgColumn | SQL, q: string): SQL {
  return sql`${column} ILIKE ${`%${escapeLike(q)}%`} ESCAPE '\\'`
}

/**
 * The rank of a match in `column` (lower is better): 0 exact, 1 prefix, 2 a word starts with it,
 * 3 anywhere, 4 not in this column. Sort ascending, then by the column.
 */
export function matchRank(column: AnyPgColumn | SQL, q: string): SQL<number> {
  const e = escapeLike(q)
  return sql<number>`CASE
    WHEN lower(${column}) = lower(${q}) THEN 0
    WHEN ${column} ILIKE ${`${e}%`} ESCAPE '\\' THEN 1
    WHEN ${column} ILIKE ${`% ${e}%`} ESCAPE '\\' THEN 2
    WHEN ${column} ILIKE ${`%${e}%`} ESCAPE '\\' THEN 3
    ELSE 4 END`
}

/** The same ranking for text already in memory (the agent catalogue). */
export function textRank(text: string, q: string): number {
  const t = text.toLowerCase()
  const n = q.toLowerCase()
  if (t === n) return 0
  if (t.startsWith(n)) return 1
  if (t.includes(` ${n}`)) return 2
  if (t.includes(n)) return 3
  return 4
}
