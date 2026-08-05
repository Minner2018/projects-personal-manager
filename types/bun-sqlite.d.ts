declare module "bun:sqlite" {
  export interface RunResult {
    lastInsertRowid: number;
    changes: number;
  }

  export interface Statement<ReturnType = unknown, Params extends unknown[] = unknown[]> {
    all(...params: Params): ReturnType[];
    get(...params: Params): ReturnType | null;
    run(...params: unknown[]): RunResult;
    finalize(): void;
  }

  export type TransactionFunction<ReturnType> = (() => ReturnType) & {
    deferred(): ReturnType;
    immediate(): ReturnType;
    exclusive(): ReturnType;
  };

  export class Database {
    constructor(
      filename?: string,
      options?: {
        readonly?: boolean;
        create?: boolean;
        readwrite?: boolean;
        safeIntegers?: boolean;
        strict?: boolean;
      },
    );
    run(sql: string): RunResult;
    query<ReturnType = unknown, Params extends unknown[] = unknown[]>(
      sql: string,
    ): Statement<ReturnType, Params>;
    transaction<ReturnType>(
      operation: () => ReturnType,
    ): TransactionFunction<ReturnType>;
    close(throwOnError?: boolean): void;
  }
}
