/**
 * Deterministic test framework for VaultLink sync testing.
 * Allows defining exact sequences of operations to test specific scenarios.
 */

export type TestStep =
    | { type: "create"; client: number; path: string; content: string }
    | { type: "update"; client: number; path: string; content: string }
    | { type: "rename"; client: number; oldPath: string; newPath: string }
    | { type: "delete"; client: number; path: string }
    | { type: "sync"; client?: number } // wait for sync (specific client or all if undefined)
    | { type: "disable-sync"; client: number }
    | { type: "enable-sync"; client: number }
    | { type: "wait"; duration: number } // wait N milliseconds
    | { type: "pause-server" }
    | { type: "resume-server" }
    | { type: "barrier" } // wait for all clients to finish pending operations
    | { type: "assert-content"; client: number; path: string; content: string }
    | { type: "assert-exists"; client: number; path: string }
    | { type: "assert-not-exists"; client: number; path: string }
    | { type: "assert-consistent" }; // all clients have same files and content

export interface TestDefinition {
    name: string;
    description?: string;
    clients: number;
    steps: TestStep[];
}

export interface TestResult {
    success: boolean;
    error?: string;
    stepsFailed?: number;
    duration: number;
}
