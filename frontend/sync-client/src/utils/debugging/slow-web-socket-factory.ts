import { sleep } from "../sleep";
import { Lock } from "../data-structures/locks";
import type { Logger } from "../../tracing/logger";

export function slowWebSocketFactory(
    jitterScaleInSeconds: number,
    logger: Logger
): typeof WebSocket {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return class FlakyWebSocket extends WebSocket {
        private readonly receiving = new Lock();
        private readonly sending = new Lock();

        public set onopen(callback: ((event: Event) => void) | null) {
            super.onopen = async (event: Event): Promise<void> => {
                if (jitterScaleInSeconds > 0) {
                    await sleep(Math.random() * jitterScaleInSeconds * 1000);
                }

                callback?.(event);
            };
        }

        public set onmessage(callback: ((event: MessageEvent) => void) | null) {
            super.onmessage = async (event: MessageEvent): Promise<void> => {
                await this.receiving.withLock(async () => {
                    if (jitterScaleInSeconds > 0) {
                        await sleep(
                            Math.random() * jitterScaleInSeconds * 1000
                        );
                    }

                    callback?.(event);
                });
            };
        }

        public set onclose(callback: ((event: CloseEvent) => void) | null) {
            super.onclose = async (event: CloseEvent): Promise<void> => {
                if (jitterScaleInSeconds > 0) {
                    await sleep(Math.random() * jitterScaleInSeconds * 1000);
                }
                callback?.(event);
            };
        }

        public set onerror(callback: ((event: Event) => void) | null) {
            super.onerror = async (event: Event): Promise<void> => {
                if (jitterScaleInSeconds > 0) {
                    await sleep(Math.random() * jitterScaleInSeconds * 1000);
                }
                callback?.(event);
            };
        }

        public send(
            data: string | ArrayBufferLike | Blob | ArrayBufferView
        ): void {
            this.waitingSend(data).catch((error: unknown) => {
                logger.error(`Error sending WebSocket message: ${error}`);
            });
        }

        private async waitingSend(
            data: string | ArrayBufferLike | Blob | ArrayBufferView
        ): Promise<void> {
            // maintain message order
            await this.sending.withLock(async () => {
                if (jitterScaleInSeconds > 0) {
                    await sleep(Math.random() * jitterScaleInSeconds * 1000);
                }
                super.send(data);
            });
        }
    } as unknown as typeof WebSocket;
}
