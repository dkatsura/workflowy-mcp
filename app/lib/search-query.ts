// Keep literal substring matching alongside PostgreSQL full-text ranking:
// the simple text-search dictionary does not segment Japanese sentences.
export type SearchSql = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;

export function queryCachedNodes(
  sql: SearchSql,
  accountKey: string,
  query: string,
  includeCompleted: boolean,
  limit: number,
): Promise<unknown[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) throw new Error("query must contain non-whitespace text");

  return sql`
    WITH search_query AS (
      SELECT websearch_to_tsquery('simple', ${normalizedQuery}) AS query
    )
    SELECT id, name, note, parent_id, completed, children_count, priority,
      created_at, updated_at, completed_at,
      ts_rank_cd(
        to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(note, '')),
        search_query.query
      ) AS relevance_score
    FROM workflowy_nodes, search_query
    WHERE account_key = ${accountKey}
      AND (${includeCompleted} OR completed = FALSE)
      AND (
        to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(note, ''))
          @@ search_query.query
        OR strpos(lower(coalesce(name, '')), lower(${normalizedQuery})) > 0
        OR strpos(lower(coalesce(note, '')), lower(${normalizedQuery})) > 0
      )
    ORDER BY relevance_score DESC, updated_at DESC NULLS LAST, priority ASC
    LIMIT ${limit}
  `;
}
