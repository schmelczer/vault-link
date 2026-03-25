export interface ClientState {
    files: Map<string, string>;
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
    | { type: "assert-content"; client: number; path: string; content: string }
    | { type: "assert-exists"; client: number; path: string }
    | { type: "assert-not-exists"; client: number; path: string }
    | { type: "assert-consistent"; verify?: (state: ClientState) => void };

export interface TestDefinition {
    name: string;
    description?: string;
    clients: number;
    steps: TestStep[];
}

export interface TestResult {
    success: boolean;
    error?: string;
    duration?: number;
}
