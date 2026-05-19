import { neon } from "@neondatabase/serverless";

export type QueryResultRow = object;

export interface QueryResult<T extends QueryResultRow> {
  rows: T[];
}

export async function query<T extends QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<QueryResult<T>> {
  const sql = neon<false, true>(getPostgresUrl(), { fullResults: true });
  const result = await sql.query(text, values);
  return {
    rows: result.rows as T[]
  };
}

export async function one<T extends QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<T | undefined> {
  const result = await query<T>(text, values);
  return result.rows[0];
}

function getPostgresUrl(): string {
  const url = process.env.POSTGRES_URL;
  if (!url) {
    throw new Error("POSTGRES_URL is not configured.");
  }

  return url;
}
