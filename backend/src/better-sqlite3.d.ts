declare module 'better-sqlite3' {
  interface RunResult {
    changes: number
    lastInsertRowid: number | bigint
  }

  interface Statement<BindParameters extends unknown[] | Record<string, unknown> = unknown[]> {
    run(...params: BindParameters extends unknown[] ? BindParameters : [BindParameters]): RunResult
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }

  class Database {
    constructor(filename: string)
    pragma(value: string): unknown
    exec(sql: string): void
    prepare(sql: string): Statement
  }

  export = Database
}
