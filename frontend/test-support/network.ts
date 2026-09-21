import assert from "node:assert/strict";

export type RequestKind = "create" | "content" | "manifest";
export interface RequestRecord {
    kind: RequestKind;
    method: string;
    url: string;
    body: Record<string, unknown>;
    status?: number;
}

interface InjectedFault {
    kind: RequestKind;
    point: "before" | "after";
    fired: boolean;
    interrupted?: RequestRecord;
    retried: boolean;
    reached: Promise<void>;
    resolve: () => void;
}

export function classifyRequest(
    input: RequestInfo | URL,
    init?: RequestInit
): RequestRecord | undefined {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (method !== "PUT") return undefined;
    // The engine passes JSON strings. Fail loudly if that contract changes.
    if (!/\/(documents\/[^/]+|file-manifest)\/?$/.test(url.pathname))
        return undefined;
    assert.equal(
        typeof init?.body,
        "string",
        "CAS request body must be observable JSON"
    );
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    const kind = /\/file-manifest\/?$/.test(url.pathname)
        ? "manifest"
        : body.parentVersionId === null
          ? "create"
          : "content";
    assert.equal(
        typeof body.requestId,
        "string",
        "CAS request missing requestId"
    );
    return { kind, method, url: url.href, body };
}

export class NetworkFaults {
    public readonly requests: RequestRecord[] = [];
    private observation?: {
        released: boolean;
        fired: boolean;
        held: Promise<void>;
        release: () => void;
        reached: Promise<void>;
        reach: () => void;
    };
    public pauseObservation(): void {
        assert(
            !this.observation || this.observation.released,
            "Observation already paused"
        );
        let release!: () => void, reach!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const reached = new Promise<void>((resolve) => {
            reach = resolve;
        });
        this.observation = {
            released: false,
            fired: false,
            held,
            release,
            reached,
            reach
        };
    }
    public async waitForObservation(): Promise<void> {
        assert(this.observation, "No observation checkpoint armed");
        await this.observation.reached;
    }
    public resumeObservation(): void {
        if (this.observation) {
            this.observation.released = true;
            this.observation.release();
        }
    }
    private async observationCheckpoint(
        signal?: AbortSignal | null
    ): Promise<void> {
        const gate = this.observation;
        if (!gate || gate.released) return;
        gate.fired = true;
        gate.reach();
        signal?.throwIfAborted();
        let abort = () => {};
        try {
            await Promise.race([
                gate.held,
                new Promise<never>((_, reject) => {
                    abort = () =>
                        reject(
                            signal?.reason ?? new Error("Observation aborted")
                        );
                    signal?.addEventListener("abort", abort, { once: true });
                })
            ]);
        } finally {
            signal?.removeEventListener("abort", abort);
        }
    }
    private armed?: InjectedFault;
    private readonly faults: InjectedFault[] = [];
    public isExpectedFailure(message: string): boolean {
        return this.faults.some(
            (fault) =>
                fault.fired &&
                message.includes(
                    `Injected ${fault.point}-commit ${fault.kind} network failure`
                )
        );
    }
    public arm(kind: RequestKind, point: "before" | "after" = "after"): void {
        assert(
            !this.armed || (this.armed.fired && this.armed.retried),
            "Previous network fault was not exercised and retried"
        );
        let resolve!: () => void;
        const reached = new Promise<void>((r) => {
            resolve = r;
        });
        this.armed = {
            kind,
            point,
            fired: false,
            retried: false,
            reached,
            resolve
        };
        this.faults.push(this.armed);
    }
    public async wait(): Promise<void> {
        assert(this.armed, "No network fault armed");
        await this.armed.reached;
    }
    public assertConsumed(): void {
        assert(
            !this.observation ||
                (this.observation.fired && this.observation.released),
            "Observation checkpoint was not exercised and released"
        );
        for (const fault of this.faults) {
            assert(fault.fired, "Armed network fault never fired");
            assert(fault.retried, "Interrupted CAS request was never retried");
        }
    }
    public wrap(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
        return async (input, init) => {
            const url = new URL(
                input instanceof Request ? input.url : String(input)
            );
            const observing =
                (
                    init?.method ??
                    (input instanceof Request ? input.method : "GET")
                ).toUpperCase() === "GET" && !url.pathname.endsWith("/ping");
            const signal =
                init?.signal ??
                (input instanceof Request ? input.signal : undefined);
            if (observing) await this.observationCheckpoint(signal);
            const record = classifyRequest(input, init);
            if (record) {
                // A client serializes its persisted CAS requests. Its next CAS
                // after a lost response must replay the interrupted operation,
                // even if it has since observed newer remote state.
                const interrupted = this.armed?.interrupted;
                if (interrupted && !this.armed!.retried) {
                    assert.equal(
                        record.url,
                        interrupted.url,
                        "Retry changed target"
                    );
                    assert.deepEqual(
                        record.body,
                        interrupted.body,
                        "Retry changed payload/request identity"
                    );
                    this.armed!.retried = true;
                }
                const previous = this.requests.find(
                    (r) => r.body.requestId === record.body.requestId
                );
                if (previous) {
                    assert.equal(
                        record.url,
                        previous.url,
                        "Retry changed target"
                    );
                    assert.deepEqual(
                        record.body,
                        previous.body,
                        "Retry changed payload/request identity"
                    );
                }
                this.requests.push(record);
            }
            const fault = this.armed;
            const matches =
                record && fault && !fault.fired && fault.kind === record.kind;
            const fail = () => {
                fault!.interrupted = structuredClone(record!);
                fault!.fired = true;
                fault!.resolve();
                throw new TypeError(
                    `Injected ${fault!.point}-commit ${fault!.kind} network failure`
                );
            };
            if (matches && fault.point === "before") fail();
            const response = await fetch(input, init);
            if (observing) await this.observationCheckpoint(signal);
            if (record) record.status = response.status;
            // Only drop accepted replies, never confuse a rejected CAS with commit.
            if (
                matches &&
                !fault.fired &&
                fault.point === "after" &&
                response.ok &&
                ((await response.clone().json()) as { type?: string }).type ===
                    "Accepted"
            ) {
                await response.body?.cancel();
                fail();
            }
            return response;
        };
    }
}
