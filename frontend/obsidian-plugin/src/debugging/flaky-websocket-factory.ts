import type { Logger } from "sync-client";
import { helpers } from "sync-client";

export function flakyWebSocketFactory(
	jitterScaleInSeconds: number,
	logger: Logger
): typeof WebSocket {
	// eslint-disable-next-line
	return class FlakyWebSocket extends WebSocket {
		private static readonly RECEIVE_KEY = "websocket-receive";
		private static readonly SEND_KEY = "websocket-send";

		private readonly locks = new helpers.Locks(logger);

		public set onopen(callback: (event: Event) => void) {
			super.onopen = async (event: Event): Promise<void> => {
				if (jitterScaleInSeconds > 0) {
					await sleep(Math.random() * jitterScaleInSeconds * 1000);
				}

				callback(event);
			};
		}

		public set onmessage(callback: (event: MessageEvent) => void) {
			super.onmessage = async (event: MessageEvent): Promise<void> => {
				await this.locks.waitForLock(FlakyWebSocket.RECEIVE_KEY);

				if (jitterScaleInSeconds > 0) {
					await sleep(Math.random() * jitterScaleInSeconds * 1000);
				}

				callback(event);

				this.locks.unlock(FlakyWebSocket.RECEIVE_KEY);
			};
		}

		public set onclose(callback: (event: CloseEvent) => void) {
			super.onclose = async (event: CloseEvent): Promise<void> => {
				if (jitterScaleInSeconds > 0) {
					await sleep(Math.random() * jitterScaleInSeconds * 1000);
				}
				callback(event);
			};
		}

		public set onerror(callback: (event: Event) => void) {
			super.onerror = async (event: Event): Promise<void> => {
				if (jitterScaleInSeconds > 0) {
					await sleep(Math.random() * jitterScaleInSeconds * 1000);
				}
				callback(event);
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
			await this.locks.waitForLock(FlakyWebSocket.SEND_KEY);

			if (jitterScaleInSeconds > 0) {
				await sleep(Math.random() * jitterScaleInSeconds * 1000);
			}

			super.send(data);

			this.locks.unlock(FlakyWebSocket.SEND_KEY);
		}
	} as unknown as typeof WebSocket;
}
