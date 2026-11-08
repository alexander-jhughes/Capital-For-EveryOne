// Tiny typed helpers over node:sqlite with a per-connection prepared-statement cache.
import type { SQLInputValue, StatementSync } from "node:sqlite";
import type { Database } from "./sqlite";

const cache = new WeakMap<Database, Map<string, StatementSync>>();

function statement(db: Database, sql: string): StatementSync {
  let byDb = cache.get(db);
  if (!byDb) cache.set(db, (byDb = new Map()));
  let stmt = byDb.get(sql);
  if (!stmt) byDb.set(sql, (stmt = db.prepare(sql)));
  return stmt;
}

export type Param = SQLInputValue | boolean | undefined;

const bind = (params: Param[]): SQLInputValue[] => params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p));

export const queryAll = <T>(db: Database, sql: string, ...params: Param[]): T[] => statement(db, sql).all(...bind(params)) as unknown as T[];

export const queryOne = <T>(db: Database, sql: string, ...params: Param[]): T | undefined => statement(db, sql).get(...bind(params)) as unknown as T | undefined;

export const execute = (db: Database, sql: string, ...params: Param[]): number => Number(statement(db, sql).run(...bind(params)).changes);

/** Parses a JSON column. The column has a json_valid CHECK, so this only fails if the row was tampered with. */
export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
