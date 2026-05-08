export class TestErrorTracker {
    private firstError: { agentName: string; message: string } | null = null;

    public recordError(agentName: string, message: string): void {
        this.firstError ??= { agentName, message };
    }

    /**
     * If an error was recorded, throw it. Call this at natural checkpoints:
     * after each iteration, before assertions, etc.
     */
    public checkAndThrow(): void {
        if (this.firstError !== null) {
            const { agentName, message } = this.firstError;
            throw new Error(`ERROR-level log from ${agentName}: ${message}`);
        }
    }

    /** Clear recorded errors. Call at the start of each test. */
    public reset(): void {
        this.firstError = null;
    }
}
