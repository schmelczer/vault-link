/**
 * A WebSocket wrapper that can pause and resume message delivery.
 * When paused, incoming messages are buffered. When resumed, buffered
 * messages are delivered in order via the onmessage handler.
 */
export class ManagedWebSocket implements WebSocket {
    private readonly ws: WebSocket;
    private paused = false;
    private readonly bufferedMessages: MessageEvent[] = [];
    private externalOnMessage: ((event: MessageEvent) => unknown) | null = null;

    public constructor(url: string | URL, protocols?: string | string[]) {
        this.ws = new WebSocket(url, protocols);

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

    get readyState(): number {
        return this.ws.readyState;
    }

    get url(): string {
        return this.ws.url;
    }

    get protocol(): string {
        return this.ws.protocol;
    }

    get extensions(): string {
        return this.ws.extensions;
    }

    get bufferedAmount(): number {
        return this.ws.bufferedAmount;
    }

    get binaryType(): BinaryType {
        return this.ws.binaryType;
    }

    set binaryType(value: BinaryType) {
        this.ws.binaryType = value;
    }

    get onopen(): ((this: WebSocket, ev: Event) => unknown) | null {
        return this.ws.onopen;
    }

    set onopen(handler: ((this: WebSocket, ev: Event) => unknown) | null) {
        this.ws.onopen = handler;
    }

    get onclose(): ((this: WebSocket, ev: CloseEvent) => unknown) | null {
        return this.ws.onclose;
    }

    set onclose(handler: ((this: WebSocket, ev: CloseEvent) => unknown) | null) {
        this.ws.onclose = handler;
    }

    get onerror(): ((this: WebSocket, ev: Event) => unknown) | null {
        return this.ws.onerror;
    }

    set onerror(handler: ((this: WebSocket, ev: Event) => unknown) | null) {
        this.ws.onerror = handler;
    }

    get onmessage(): ((this: WebSocket, ev: MessageEvent) => unknown) | null {
        return this.externalOnMessage;
    }

    set onmessage(
        handler: ((this: WebSocket, ev: MessageEvent) => unknown) | null
    ) {
        this.externalOnMessage = handler;
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

    static readonly CONNECTING = WebSocket.CONNECTING;
    static readonly OPEN = WebSocket.OPEN;
    static readonly CLOSING = WebSocket.CLOSING;
    static readonly CLOSED = WebSocket.CLOSED;

    readonly CONNECTING = WebSocket.CONNECTING;
    readonly OPEN = WebSocket.OPEN;
    readonly CLOSING = WebSocket.CLOSING;
    readonly CLOSED = WebSocket.CLOSED;
}

/**
 * Factory that creates ManagedWebSocket instances and tracks them
 * for pause/resume control from the test harness
 */
export class ManagedWebSocketFactory {
    private readonly instances: ManagedWebSocket[] = [];

    public get constructorFn(): typeof globalThis.WebSocket {
        const factory = this;
        const ctor = function ManagedWS(
            url: string | URL,
            protocols?: string | string[]
        ): ManagedWebSocket {
            const ws = new ManagedWebSocket(url, protocols);
            factory.instances.push(ws);
            return ws;
        } as unknown as typeof globalThis.WebSocket;

        Object.defineProperty(ctor, "CONNECTING", { value: WebSocket.CONNECTING });
        Object.defineProperty(ctor, "OPEN", { value: WebSocket.OPEN });
        Object.defineProperty(ctor, "CLOSING", { value: WebSocket.CLOSING });
        Object.defineProperty(ctor, "CLOSED", { value: WebSocket.CLOSED });

        return ctor;
    }

    public pause(): void {
        for (const ws of this.instances) {
            ws.pause();
        }
    }

    public resume(): void {
        for (const ws of this.instances) {
            ws.resume();
        }
    }
}
