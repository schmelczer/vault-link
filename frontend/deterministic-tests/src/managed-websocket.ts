/**
 * A WebSocket wrapper that can pause and resume message delivery.
 * When paused, incoming messages are buffered. When resumed, buffered
 * messages are delivered in order via the onmessage handler.
 *
 * Member layout follows typescript-eslint default member-ordering: all
 * accessor properties are declared with `declare` and wired through the
 * constructor using Object.defineProperty so we don't need conflicting
 * get/set accessor pairs.
 */
class ManagedWebSocket implements WebSocket {
    public static readonly CONNECTING = WebSocket.CONNECTING;
    public static readonly OPEN = WebSocket.OPEN;
    public static readonly CLOSING = WebSocket.CLOSING;
    public static readonly CLOSED = WebSocket.CLOSED;

    public readonly CONNECTING = WebSocket.CONNECTING;
    public readonly OPEN = WebSocket.OPEN;
    public readonly CLOSING = WebSocket.CLOSING;
    public readonly CLOSED = WebSocket.CLOSED;

    declare public readonly readyState: number;
    declare public readonly url: string;
    declare public readonly protocol: string;
    declare public readonly extensions: string;
    declare public readonly bufferedAmount: number;
    declare public binaryType: BinaryType;
    declare public onopen: ((this: WebSocket, ev: Event) => unknown) | null;
    declare public onclose:
        | ((this: WebSocket, ev: CloseEvent) => unknown)
        | null;
    declare public onerror: ((this: WebSocket, ev: Event) => unknown) | null;
    declare public onmessage:
        | ((this: WebSocket, ev: MessageEvent) => unknown)
        | null;

    private readonly ws: WebSocket;
    private readonly bufferedMessages: MessageEvent[] = [];
    private paused = false;
    private externalOnMessage: ((event: MessageEvent) => unknown) | null = null;

    public constructor(url: string | URL, protocols?: string | string[]) {
        this.ws = new WebSocket(url, protocols);

        const { ws } = this;
        Object.defineProperties(this, {
            readyState: {
                get: (): number => ws.readyState,
                enumerable: true,
                configurable: true
            },
            url: {
                get: (): string => ws.url,
                enumerable: true,
                configurable: true
            },
            protocol: {
                get: (): string => ws.protocol,
                enumerable: true,
                configurable: true
            },
            extensions: {
                get: (): string => ws.extensions,
                enumerable: true,
                configurable: true
            },
            bufferedAmount: {
                get: (): number => ws.bufferedAmount,
                enumerable: true,
                configurable: true
            },
            binaryType: {
                get: (): BinaryType => ws.binaryType,
                set: (v: BinaryType): void => {
                    ws.binaryType = v;
                },
                enumerable: true,
                configurable: true
            },
            onopen: {
                get: (): ((this: WebSocket, ev: Event) => unknown) | null =>
                    ws.onopen,
                set: (
                    h: ((this: WebSocket, ev: Event) => unknown) | null
                ): void => {
                    ws.onopen = h;
                },
                enumerable: true,
                configurable: true
            },
            onclose: {
                get: ():
                    | ((this: WebSocket, ev: CloseEvent) => unknown)
                    | null => ws.onclose,
                set: (
                    h: ((this: WebSocket, ev: CloseEvent) => unknown) | null
                ): void => {
                    ws.onclose = h;
                },
                enumerable: true,
                configurable: true
            },
            onerror: {
                get: (): ((this: WebSocket, ev: Event) => unknown) | null =>
                    ws.onerror,
                set: (
                    h: ((this: WebSocket, ev: Event) => unknown) | null
                ): void => {
                    ws.onerror = h;
                },
                enumerable: true,
                configurable: true
            },
            onmessage: {
                get: ():
                    | ((this: WebSocket, ev: MessageEvent) => unknown)
                    | null => this.externalOnMessage,
                set: (
                    h: ((this: WebSocket, ev: MessageEvent) => unknown) | null
                ): void => {
                    this.externalOnMessage = h;
                },
                enumerable: true,
                configurable: true
            }
        });

        this.ws.onmessage = (event: MessageEvent): void => {
            if (this.paused) {
                this.bufferedMessages.push(event);
            } else {
                this.externalOnMessage?.(event);
            }
        };
    }

    public pause(): void {
        this.paused = true;
    }

    public resume(): void {
        this.paused = false;
        const messages = this.bufferedMessages.splice(0);
        for (const msg of messages) {
            this.externalOnMessage?.(msg);
        }
    }

    public send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        this.ws.send(data);
    }

    public close(code?: number, reason?: string): void {
        this.ws.close(code, reason);
    }

    public addEventListener(
        ...args: Parameters<WebSocket["addEventListener"]>
    ): void {
        // Only the `.onmessage` setter routes through the pause buffer.
        // If sync-client ever attaches "message" listeners via
        // addEventListener instead, those messages would bypass pause/resume
        // and deterministic tests would silently lose their fault injection.
        if (args[0] === "message") {
            throw new Error(
                "ManagedWebSocket: addEventListener('message') bypasses the " +
                    "pause buffer. Use the .onmessage setter instead, or " +
                    "extend ManagedWebSocket to route message listeners."
            );
        }
        this.ws.addEventListener(...args);
    }

    public removeEventListener(
        ...args: Parameters<WebSocket["removeEventListener"]>
    ): void {
        this.ws.removeEventListener(...args);
    }

    public dispatchEvent(event: Event): boolean {
        return this.ws.dispatchEvent(event);
    }
}

/**
 * Factory that creates ManagedWebSocket instances and tracks them
 * for pause/resume control from the test harness
 */
export class ManagedWebSocketFactory {
    // Append-only: closed sockets stay tracked. Bounded per test (one
    // factory per agent, each test discards its agents on cleanup), so
    // not a real leak — but iterating over closed instances on
    // pause/resume is a deliberate no-op since their `.onmessage` is
    // already detached.
    private readonly instances: ManagedWebSocket[] = [];
    // Sticky pause state: applied to current instances on `pause()` AND
    // to any new instance created later (e.g. WS reconnect after a
    // `disable-sync` / `reset` cycle). Without this, a test pausing the
    // WS before the agent reconnects would silently see the new socket
    // start un-paused and miss the messages it meant to buffer.
    private currentlyPaused = false;

    public get constructorFn(): typeof globalThis.WebSocket {
        const trackInstance = (instance: ManagedWebSocket): void => {
            this.instances.push(instance);
            if (this.currentlyPaused) {
                instance.pause();
            }
        };
        class TrackedManagedWebSocket extends ManagedWebSocket {
            public constructor(
                url: string | URL,
                protocols?: string | string[]
            ) {
                super(url, protocols);
                trackInstance(this);
            }
        }
        return TrackedManagedWebSocket;
    }

    public pause(): void {
        this.currentlyPaused = true;
        for (const ws of this.instances) {
            ws.pause();
        }
    }

    public resume(): void {
        this.currentlyPaused = false;
        for (const ws of this.instances) {
            ws.resume();
        }
    }
}
