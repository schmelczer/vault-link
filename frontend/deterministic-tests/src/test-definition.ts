import type { AssertableState } from "./utils/assertable-state";

export interface ClientState {
    files: Map<string, string>;
    clientFiles: Map<string, string>[];
}

export type TestStep =
    | { type: "create"; client: number; path: string; content: string }
    | { type: "update"; client: number; path: string; content: string }
    | { type: "rename"; client: number; oldPath: string; newPath: string }
    | { type: "delete"; client: number; path: string }
    | { type: "sync"; client?: number }
    | { type: "disable-sync"; client: number }
    | { type: "enable-sync"; client: number }
    | { type: "pause-server" }
    | { type: "resume-server" }
    | { type: "barrier" }
    | { type: "assert-consistent"; verify?: (state: AssertableState) => void };

export interface TestDefinition {
    description?: string;
    clients: number;
    steps: TestStep[];
}

export interface TestResult {
    success: boolean;
    error?: string;
    duration?: number;
}
