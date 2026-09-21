import type { AssertableState } from "./utils/assertable-state";

export interface ClientState {
    files: Map<string, string>;
    clientFiles: Map<string, string>[];
    manifests: Record<string, string>[];
    canonical: Record<string, string>;
    bytes: Map<string, Uint8Array>;
}

/** A scenario's independent, complete expected state. Keys survive moves;
 * a new key must receive a previously unseen UUID, including after deletion. */
export interface ExpectedDocument {
    key: string;
    path: string;
    conflict?: boolean;
    content: string | number[];
}

export type TestStep =
    | { type: "create"; client: number; path: string; content: string }
    | { type: "update"; client: number; path: string; content: string }
    | { type: "rename"; client: number; oldPath: string; newPath: string }
    | {
          type: "rename-next-write";
          client: number;
          oldPath: string;
          newPath: string;
      }
    | { type: "delete"; client: number; path: string }
    | { type: "sync"; client?: number }
    | { type: "disable-sync"; client: number }
    | { type: "enable-sync"; client: number }
    | { type: "pause-server" }
    | { type: "resume-server" }
    | {
          type: "resume-server-until-history-then-pause";
          client: number;
          syncType: "CREATE" | "UPDATE" | "DELETE";
          path: string;
      }
    | { type: "barrier" }
    | { type: "assert-consistent"; verify?: (state: AssertableState) => void }
    | { type: "pause-websocket"; client: number }
    | { type: "resume-websocket"; client: number }
    | {
          type:
              | "pause-observation"
              | "resume-observation"
              | "wait-for-observation";
          client: number;
      }
    | { type: "drop-next-create-response"; client: number }
    | { type: "wait-for-dropped-create-response"; client: number }
    | { type: "sleep"; ms: number }
    | { type: "reset"; client: number }
    | { type: "create-bytes"; client: number; path: string; bytes: number[] }
    | {
          type: "drop-response";
          client: number;
          kind: "create" | "content" | "manifest";
          point?: "before" | "after";
      }
    | { type: "wait-for-response-drop"; client: number }
    | { type: "delay-notifications" | "flush-notifications"; client: number }
    | {
          type: "remember-identity" | "assert-identity";
          path: string;
          key: string;
      }
    | {
          type: "assert-files";
          expected: Record<string, string>;
          absent?: string[];
          count?: number;
      }
    | { type: "assert-markers"; markers: string[]; removed?: string[] }
    | { type: "assert-documents"; expected: ExpectedDocument[] }
    | { type: "crash-server" }
    | { type: "restart-server" };

export interface TestDefinition {
    description?: string;
    clients: number;
    steps: TestStep[];
}

export interface TestResult {
    success: boolean;
    error?: string;
    duration?: number;
    diagnostics?: unknown;
}
