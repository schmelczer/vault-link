import "./settings-tab.scss";

import type { App } from "obsidian";
import { Notice, PluginSettingTab, Setting } from "obsidian";
import type VaultLinkPlugin from "src/vault-link-plugin";
import type { SyncClient, SyncSettings } from "sync-client";
import { HistoryView } from "../history/history-view";
import { LogsView } from "../logs/logs-view";
import type { StatusDescription } from "../status-description/status-description";

export class SyncSettingsTab extends PluginSettingTab {
    private editedServerUri: string;
    private editedToken: string;
    private editedVaultName: string;

    private _isApplyingChanges = false;
    private syncEnabledOverride: boolean | undefined = undefined;

    private readonly plugin: VaultLinkPlugin;
    private readonly syncClient: SyncClient;
    private readonly statusDescription: StatusDescription;
    private statusDescriptionSubscription: (() => unknown) | undefined;

    public constructor({
        app,
        plugin,
        syncClient,
        statusDescription
    }: {
        app: App;
        plugin: VaultLinkPlugin;
        syncClient: SyncClient;
        statusDescription: StatusDescription;
    }) {
        super(app, plugin);
        this.plugin = plugin;
        this.syncClient = syncClient;
        this.statusDescription = statusDescription;

        this.editedServerUri = this.syncClient.getSettings().remoteUri;
        this.editedToken = this.syncClient.getSettings().token;
        this.editedVaultName = this.syncClient.getSettings().vaultName;

        this.syncClient.onSettingsChanged.add((newSettings, oldSettings) => {
            let hasChanged = false;

            if (newSettings.remoteUri !== oldSettings.remoteUri) {
                this.editedServerUri = newSettings.remoteUri;
                hasChanged = true;
            }

            if (newSettings.token !== oldSettings.token) {
                this.editedToken = newSettings.token;
                hasChanged = true;
            }

            if (newSettings.vaultName !== oldSettings.vaultName) {
                this.editedVaultName = newSettings.vaultName;
                hasChanged = true;
            }

            if (hasChanged) {
                this.display();
            }
        });
    }

    private get isApplyingChanges(): boolean {
        return this._isApplyingChanges;
    }

    private set isApplyingChanges(value: boolean) {
        this._isApplyingChanges = value;
        this.display();
    }

    public display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass("vault-link-settings");
        containerEl.parentElement?.addClass("vault-link-settings-container");

        if (this.isApplyingChanges) {
            containerEl.addClass("applying-changes");
        } else {
            containerEl.removeClass("applying-changes");
        }

        this.renderApplyingChanges(containerEl);
        this.renderSettingsHeader(containerEl);
        this.renderConnectionSettings(containerEl);
        this.renderSyncSettings(containerEl);
        this.renderMiscSettings(containerEl);
    }

    public hide(): void {
        super.hide();
        this.setStatusDescriptionSubscription();
    }

    private renderApplyingChanges(containerEl: HTMLElement): void {
        if (this.isApplyingChanges) {
            const overlay = containerEl.createDiv({
                cls: "applying-changes-overlay"
            });

            const spinnerContainer = overlay.createDiv({
                cls: "spinner-container"
            });

            spinnerContainer.createDiv({
                cls: "spinner"
            });

            spinnerContainer.createDiv({
                text: "Applying changes...",
                cls: "spinner-text"
            });

            spinnerContainer.createDiv({
                text: "You can exit, but changes won't be saved",
                cls: "spinner-warning"
            });
        }
    }

    private renderSettingsHeader(containerEl: HTMLElement): void {
        containerEl.createEl("h2", { text: "VaultLink" }).createSpan({
            text: this.plugin.manifest.version,
            cls: "version"
        });

        containerEl.createDiv(
            {
                cls: "description"
            },
            (descriptionContainer) => {
                this.setStatusDescriptionSubscription(
                    this.statusDescription.renderStatusDescription.bind(
                        this.statusDescription,
                        descriptionContainer
                    )
                );
            }
        );

        containerEl.createDiv(
            {
                cls: "button-container"
            },
            (buttonContainer) => {
                buttonContainer.createEl(
                    "button",
                    {
                        text: "Show history"
                    },
                    (button) =>
                        (button.onclick = async (): Promise<void> => {
                            this.plugin.closeSettings();
                            await this.plugin.activateView(HistoryView.TYPE);
                        })
                );

                buttonContainer.createEl(
                    "button",
                    {
                        text: "Show logs"
                    },
                    (button) =>
                        (button.onclick = async (): Promise<void> => {
                            this.plugin.closeSettings();
                            await this.plugin.activateView(LogsView.TYPE);
                        })
                );
            }
        );
    }

    private renderConnectionSettings(containerEl: HTMLElement): void {
        containerEl.createEl("h3", { text: "Connection" });

        const [title, updateTitle] = this.unsavedAwareSettingName(
            "Server address",
            "remoteUri"
        );
        new Setting(containerEl)
            .setName(title)
            .setDesc(
                "Your VaultLink server's URL including the protocol and full path."
            )
            .setTooltip("This is the URL of the server you want to sync with.")
            .addText((text) =>
                text
                    .setPlaceholder("https://example.com:3000")
                    .setValue(this.editedServerUri.toLowerCase().trim())
                    .onChange((value) => {
                        this.editedServerUri = value.toLowerCase().trim();
                        updateTitle(value.toLowerCase().trim());
                    })
            );

        const [tokenTitle, updateTokenTitle] = this.unsavedAwareSettingName(
            "Access token",
            "token"
        );
        new Setting(containerEl)
            .setName(tokenTitle)
            .setClass("sync-settings-access-token")
            .setDesc(
                "Set the access token for the server that you can get from the server"
            )
            .setTooltip("todo, links to dcocs")
            .addTextArea((text) =>
                text
                    .setPlaceholder("ey...")
                    .setValue(this.editedToken.trim())
                    .onChange((value) => {
                        this.editedToken = value.trim();
                        updateTokenTitle(value.trim());
                    })
            );

        const [vaultNameTitle, updateVaultNameTitle] =
            this.unsavedAwareSettingName("Vault name", "vaultName");
        new Setting(containerEl)
            .setName(vaultNameTitle)
            .setDesc(
                "Set the name of the remote vault that you want to sync with"
            )
            .setTooltip("todo, links to dcocs")
            .addText((text) =>
                text
                    .setPlaceholder("My Obsidian Vault")
                    .setValue(this.editedVaultName.toLowerCase().trim())
                    .onChange((value) => {
                        this.editedVaultName = value.toLowerCase().trim();
                        updateVaultNameTitle(value.toLowerCase().trim());
                    })
            );

        new Setting(containerEl).addButton((button) =>
            button
                .setButtonText("Apply & test connection")
                .setDisabled(this.isApplyingChanges)
                .setTooltip(
                    this.isApplyingChanges
                        ? "Waiting for applying changes to finish..."
                        : "Apply the changes made to the connection settings and test the connection to the server."
                )
                .onClick(() => {
                    // don't show loader within the button
                    void (async (): Promise<void> => {
                        if (this.areThereUnsavedChanges()) {
                            new Notice("Applying changes to the server...");

                            this.isApplyingChanges = true;
                            try {
                                await this.syncClient.setSettings({
                                    vaultName: this.editedVaultName,
                                    remoteUri: this.editedServerUri,
                                    token: this.editedToken
                                });
                            } finally {
                                this.isApplyingChanges = false;
                            }

                            new Notice("Checking connection to the server...");
                            new Notice(
                                (
                                    await this.syncClient.checkConnection()
                                ).serverMessage
                            );
                            await this.statusDescription.updateConnectionState();
                        } else {
                            new Notice("No changes to apply");
                        }
                    })();
                })
        );
    }

    private areThereUnsavedChanges(): boolean {
        return (
            this.editedServerUri !== this.syncClient.getSettings().remoteUri ||
            this.editedToken !== this.syncClient.getSettings().token ||
            this.editedVaultName !== this.syncClient.getSettings().vaultName
        );
    }

    private renderSyncSettings(containerEl: HTMLElement): void {
        containerEl.createEl("h3", { text: "Sync" });

        new Setting(containerEl)
            .setName("Enable sync")
            .setDesc(
                "Enable pulling and pushing changes to the remote server. The first time it's enabled, or after the sync state has been reset, all local files will be pushed to the server."
            )
            .setTooltip(
                "Enable pulling and pushing changes to the remote server."
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(
                        this.syncEnabledOverride ??
                            this.syncClient.getSettings().isSyncEnabled
                    )
                    .setDisabled(this.isApplyingChanges)
                    .setTooltip(
                        this.isApplyingChanges
                            ? "Waiting for applying changes to finish..."
                            : "Enable or disable syncing."
                    )
                    .onChange(
                        (value) =>
                            void (async (): Promise<void> => {
                                this.syncEnabledOverride = value;
                                this.isApplyingChanges = true;
                                try {
                                    await this.syncClient.setSetting(
                                        "isSyncEnabled",
                                        value
                                    );
                                } finally {
                                    this.syncEnabledOverride = undefined;
                                    this.isApplyingChanges = false;
                                }
                            })()
                    )
            );

        new Setting(containerEl)
            .setName("Ignore patterns")
            .setDesc(
                "Patterns to ignore when syncing. Each line is a separate glob pattern. Patterns are matched against the relative path of the file. For example, to ignore all files in a folder named 'ignore', enter 'ignore/*'. To ignore all files with the extension '.log', enter '*.log'."
            )
            .addTextArea((text) =>
                text
                    .setValue(
                        this.syncClient.getSettings().ignorePatterns.join("\n")
                    )
                    .setPlaceholder("Enter patterns to ignore, one per line")
                    .onChange(async (value) => {
                        const patterns = value
                            .split("\n")
                            .map((pattern) => pattern.trim())
                            .filter((pattern) => pattern.length > 0);
                        return this.syncClient.setSetting(
                            "ignorePatterns",
                            patterns
                        );
                    })
            );

        new Setting(containerEl)
            .setName("Maximum file size to be uploaded (MB)")
            .setDesc(
                "Set the maximum file size that can be uploaded to the server. Files larger than this size will be ignored."
            )
            .addText((input) =>
                input
                    .setValue(
                        this.syncClient.getSettings().maxFileSizeMB.toString()
                    )
                    .onChange(async (value) => {
                        if (value === "") {
                            return;
                        }
                        let parsedValue = Number.parseFloat(value);
                        if (Number.isNaN(parsedValue) || parsedValue < 0) {
                            parsedValue =
                                this.syncClient.getSettings().maxFileSizeMB;
                        }

                        if (value !== parsedValue.toString()) {
                            input.setValue(parsedValue.toString());
                        }

                        return this.syncClient.setSetting(
                            "maxFileSizeMB",
                            parsedValue
                        );
                    })
            );

        new Setting(containerEl)
            .setName("Danger zone")
            .setDesc(
                "Delete the local metadata database while leaving the local and remote files intact."
            )
            .addButton((button) =>
                button
                    .setDisabled(this.isApplyingChanges)
                    .setTooltip(
                        this.isApplyingChanges
                            ? "Waiting for applying changes to finish..."
                            : "Reset sync state"
                    )
                    .setButtonText("Reset sync state")
                    .onClick(
                        () =>
                            void (async (): Promise<void> => {
                                this.isApplyingChanges = true;
                                try {
                                    await this.syncClient.reset();
                                } finally {
                                    this.isApplyingChanges = false;
                                }

                                new Notice(
                                    "Sync state has been reset, you will need to resync"
                                );
                            })()
                    )
            );
    }

    private renderMiscSettings(containerEl: HTMLElement): void {
        containerEl.createEl("h3", { text: "Other" });

        new Setting(containerEl)
            .setName("Enable telemetry")
            .setDesc(
                "Allow sending anonymous usage data & error reports to help improve the plugin. The data collected is never shared with third parties."
            )
            .setTooltip(
                "Allow sending anonymous usage data & error reports to help improve the plugin. The data collected is never shared with third parties."
            )
            .addToggle((toggle) =>
                toggle
                    .setValue(this.syncClient.getSettings().enableTelemetry)
                    .onChange(async (value) =>
                        this.syncClient.setSetting("enableTelemetry", value)
                    )
            );

        containerEl.createEl("h3", { text: "Advanced" });

        new Setting(containerEl)
            .setName("Request timeout (ms)")
            .setDesc(
                "The maximum time to wait for a server request, in milliseconds."
            )
            .addText((input) =>
                input
                    .setValue(
                        this.syncClient
                            .getSettings()
                            .requestTimeoutMs.toString()
                    )
                    .onChange(async (value) => {
                        if (value === "") {
                            return;
                        }
                        let parsedValue = Number(value);
                        if (
                            !Number.isSafeInteger(parsedValue) ||
                            parsedValue <= 0
                        ) {
                            parsedValue =
                                this.syncClient.getSettings().requestTimeoutMs;
                        }

                        if (value !== parsedValue.toString()) {
                            input.setValue(parsedValue.toString());
                        }

                        return this.syncClient.setSetting(
                            "requestTimeoutMs",
                            parsedValue
                        );
                    })
            );

        new Setting(containerEl)
            .setName("Network retry interval (ms)")
            .setDesc(
                "The time to wait between retrying failed network requests, in milliseconds."
            )
            .addText((input) =>
                input
                    .setValue(
                        this.syncClient
                            .getSettings()
                            .networkRetryIntervalMs.toString()
                    )
                    .onChange(async (value) => {
                        if (value === "") {
                            return;
                        }
                        let parsedValue = Number.parseInt(value, 10);
                        if (Number.isNaN(parsedValue) || parsedValue < 0) {
                            parsedValue =
                                this.syncClient.getSettings()
                                    .networkRetryIntervalMs;
                        }

                        if (value !== parsedValue.toString()) {
                            input.setValue(parsedValue.toString());
                        }

                        return this.syncClient.setSetting(
                            "networkRetryIntervalMs",
                            parsedValue
                        );
                    })
            );

        new Setting(containerEl)
            .setName("Sync interval (ms)")
            .setDesc(
                "How often to reconcile when no changes are detected. Leave blank to rely on change notifications."
            )
            .addText((input) =>
                input
                    .setPlaceholder("Disabled")
                    .setValue(
                        this.syncClient
                            .getSettings()
                            .syncIntervalMs?.toString() ?? ""
                    )
                    .onChange(async (value) => {
                        if (value === "") {
                            return this.syncClient.setSetting(
                                "syncIntervalMs",
                                undefined
                            );
                        }

                        const parsedValue = Number(value);
                        if (
                            !Number.isSafeInteger(parsedValue) ||
                            parsedValue <= 0
                        ) {
                            input.setValue(
                                this.syncClient
                                    .getSettings()
                                    .syncIntervalMs?.toString() ?? ""
                            );
                            return;
                        }

                        return this.syncClient.setSetting(
                            "syncIntervalMs",
                            parsedValue
                        );
                    })
            );
    }

    private setStatusDescriptionSubscription(
        newSubscription?: () => unknown
    ): void {
        if (this.statusDescriptionSubscription) {
            this.statusDescription.removeStatusChangeListener(
                this.statusDescriptionSubscription
            );
        }
        this.statusDescriptionSubscription = newSubscription;
        if (this.statusDescriptionSubscription) {
            this.statusDescriptionSubscription();
            this.statusDescription.addStatusChangeListener(
                this.statusDescriptionSubscription
            );
        }
    }

    private unsavedAwareSettingName(
        name: string,
        settingName: keyof SyncSettings
    ): [
        DocumentFragment,
        (newValue: SyncSettings[keyof SyncSettings]) => unknown
    ] {
        const titleContainer = document.createDocumentFragment();
        const title = titleContainer.createEl("div", {
            text: name,
            cls: "setting-item-name"
        });

        const updateTitle = (
            currentValue: SyncSettings[keyof SyncSettings]
        ): void => {
            title.innerText = `${name}${
                currentValue !== this.syncClient.getSettings()[settingName]
                    ? " (unsaved)"
                    : ""
            }`;
        };

        return [titleContainer, updateTitle];
    }
}
