import "./status-description.scss";

import type {
    HistoryStats,
    NetworkConnectionStatus,
    SyncClient
} from "sync-client";
import { utils } from "sync-client";

export class StatusDescription {
    private lastHistoryStats: HistoryStats | undefined;
    private lastRemaining: number | undefined;
    private lastConnectionState: NetworkConnectionStatus | undefined;

    private readonly statusChangeListeners: (() => unknown)[] = [];

    public constructor(private readonly syncClient: SyncClient) {
        void this.updateConnectionState();

        syncClient.addSyncHistoryUpdateListener((status) => {
            this.lastHistoryStats = status;
            this.updateDescription();
        });

        this.syncClient.addRemainingSyncOperationsListener(
            (remainingOperations) => {
                this.lastRemaining = remainingOperations;
                this.updateDescription();
            }
        );

        this.syncClient.addWebSocketStatusChangeListener(async () =>
            this.updateConnectionState()
        );

        this.syncClient.addOnSettingsChangeListener(async () =>
            this.updateConnectionState()
        );
    }

    public async updateConnectionState(): Promise<void> {
        this.lastConnectionState = await this.syncClient.checkConnection();
        this.updateDescription();
    }

    public addStatusChangeListener(listener: () => unknown): void {
        this.statusChangeListeners.push(listener);
    }
    public removeStatusChangeListener(listener: () => unknown): void {
        utils.removeFromArray(this.statusChangeListeners, listener);
    }

    public renderStatusDescription(container: HTMLElement): void {
        container.empty();
        container.addClass("status-description");

        if (this.lastConnectionState == undefined) {
            container.createSpan({
                text: "VaultLink is starting up…",
                cls: "warning"
            });
            return;
        }

        if (!this.lastConnectionState.isSuccessful) {
            container.createSpan({
                text: `VaultLink failed to connect to the remote server with error '${this.lastConnectionState.serverMessage}'`,
                cls: "error"
            });
            return;
        }

        if (!this.lastConnectionState.isWebSocketConnected) {
            container.createSpan({
                text: `${this.lastConnectionState.serverMessage} but the WebSocket connection could not be established.`,
                cls: "error"
            });
            return;
        }

        container.createSpan({ text: "VaultLink is connected to the server " });
        container.createEl("a", {
            text: this.syncClient.getSettings().remoteUri,
            href: this.syncClient.getSettings().remoteUri
        });

        container.createSpan({
            text: ` and has indexed approximately `
        });
        container.createSpan({
            text: `${this.syncClient.documentCount}`,
            cls: "number"
        });
        container.createSpan({
            text: ` documents. `
        });

        if (
            (this.lastRemaining ?? 0) === 0 &&
            (this.lastHistoryStats?.success ?? 0) === 0 &&
            (this.lastHistoryStats?.error ?? 0) === 0
        ) {
            if (this.syncClient.getSettings().isSyncEnabled) {
                container.createSpan({
                    text: "Syncing is enabled but VaultLink hasn't found anything to sync yet."
                });
            } else {
                container.createSpan({
                    text: "However, syncing is disabled right now.",
                    cls: "warning"
                });
            }
            return;
        }

        container.createSpan({
            text: "The plugin has "
        });
        container.createSpan({
            text: `${this.lastRemaining ?? 0}`,
            cls: "number"
        });
        container.createSpan({
            text: " outstanding operations while having succeeded "
        });
        container.createSpan({
            text: `${this.lastHistoryStats?.success ?? 0}`,
            cls: ["number", "good"]
        });
        container.createSpan({
            text: " times and failed "
        });
        container.createSpan({
            text: `${this.lastHistoryStats?.error ?? 0}`,
            cls: ["number", "bad"]
        });
        container.createSpan({
            text: " times."
        });
    }

    private updateDescription(): void {
        this.statusChangeListeners.forEach((listener) => {
            listener();
        });
    }
}
