import type {
	MarkdownView,
	Editor,
	MarkdownFileInfo,
	TAbstractFile,
	WorkspaceLeaf
} from "obsidian";
import { Notice, Platform, Plugin, TFile } from "obsidian";
import "../manifest.json";
import { HistoryView } from "./views/history/history-view";
import { StatusBar } from "./views/status-bar/status-bar";
import { LogsView } from "./views/logs/logs-view";
import { StatusDescription } from "./views/status-description/status-description";
import {
	SyncClient,
	rateLimit,
	DEFAULT_SETTINGS,
	Logger,
	debugging
} from "sync-client";
import { ObsidianFileSystemOperations } from "./obsidian-file-system";
import { SyncSettingsTab } from "./views/settings/settings-tab";
import { EditorStatusDisplayManager } from "./views/editor-status-display-manager/editor-status-display-manager";
import { remoteCursorsTheme } from "./views/cursors/remote-cursor-theme";
import {
	remoteCursorsPlugin,
	RemoteCursorsPluginValue
} from "./views/cursors/remote-cursors-plugin";
import { LocalCursorUpdateListener } from "./views/cursors/local-cursor-update-listener";
import { renderCursorsInFileExplorer } from "./views/cursors/file-explorer";

const MIN_WAIT_BETWEEN_UPDATES_IN_MS = 250;
const IS_DEBUG_BUILD = process.env.NODE_ENV === "development";

export default class VaultLinkPlugin extends Plugin {
	private readonly rateLimitedUpdatesPerFile = new Map<
		string,
		() => Promise<unknown>
	>();

	private readonly syncClient: SyncClient | undefined;
	private settingsTab: SyncSettingsTab | undefined;

	public async onload(): Promise<void> {
		this.app.workspace.onLayoutReady(async () => {
			// eslint-disable-next-line
			if ((globalThis as any).VAULT_LINK_RUNNING_INSTANCE) {
				new Notice(
					"Another instance of VaultLink is already running. Please disable the duplicate instance."
				);
				throw new Error("VaultLink instance already running");
			}
			// eslint-disable-next-line
			(globalThis as any).VAULT_LINK_RUNNING_INSTANCE = this;

			const client = await this.createSyncClient();

			this.registerObsidianExtensions(client);

			this.registerEditorEvents(client);

			this.register(async () => {
				await client.waitUntilFinished();
				await client.destroy();
			});

			await client.start();
		});
	}

	public onUserEnable(): void {
		new Notice(
			"VaultLink has been enabled, check out the docs for tips on getting started!"
		);
		void this.activateView(HistoryView.TYPE).catch((e: unknown) => {
			this.syncClient?.logger.error(
				`Failed to open history view on enable: ${e}`
			);
		});
		void this.activateView(LogsView.TYPE).catch((e: unknown) => {
			this.syncClient?.logger.error(
				`Failed to open logs view on enable: ${e}`
			);
		});
		this.openSettings();
	}

	public openSettings(): void {
		// eslint-disable-next-line
		(this.app as any).setting.open(); // this is undocumented
		// eslint-disable-next-line
		(this.app as any).setting.openTab(this.settingsTab); // this is undocumented
	}

	public closeSettings(): void {
		// eslint-disable-next-line
		(this.app as any).setting.close(); // this is undocumented
	}

	public async activateView(type: string): Promise<void> {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(type);

		if (leaves.length > 0) {
			[leaf] = leaves;
		} else {
			leaf = workspace.getRightLeaf(false);
			await leaf?.setViewState({ type: type, active: true });
		}

		if (leaf) {
			await workspace.revealLeaf(leaf);
		}
	}

	private async createSyncClient(): Promise<SyncClient> {
		DEFAULT_SETTINGS.ignorePatterns.push(
			".obsidian/**",
			".git/**",
			".trash/**",
			"**/.DS_Store"
		);

		const client = await SyncClient.create({
			fs: new ObsidianFileSystemOperations(
				this.app.vault,
				this.app.workspace
			),
			persistence: {
				load: this.loadData.bind(this),
				save: this.saveData.bind(this)
			},
			nativeLineEndings: Platform.isWin ? "\r\n" : "\n",
			...(IS_DEBUG_BUILD
				? {
						fetch: debugging.slowFetchFactory(1),
						webSocket: debugging.slowWebSocketFactory(
							1,
							new Logger()
						)
					}
				: {})
		});

		if (IS_DEBUG_BUILD) {
			debugging.logToConsole(client);
		}

		return client;
	}

	private registerObsidianExtensions(client: SyncClient): void {
		const statusDescription = new StatusDescription(client);

		this.settingsTab = new SyncSettingsTab({
			app: this.app,
			plugin: this,
			syncClient: client,
			statusDescription
		});
		this.addSettingTab(this.settingsTab);

		new StatusBar(this, client);

		this.registerView(HistoryView.TYPE, (leaf) => {
			const view = new HistoryView(client, leaf);
			this.register(async () => view.onClose());
			return view;
		});

		this.registerView(LogsView.TYPE, (leaf) => new LogsView(client, leaf));

		this.registerEditorExtension([remoteCursorsTheme, remoteCursorsPlugin]);

		client.addRemoteCursorsUpdateListener((cursors) => {
			RemoteCursorsPluginValue.setCursors(cursors, this.app);
			renderCursorsInFileExplorer(cursors, this.app);
		});

		const cursorListener = new LocalCursorUpdateListener(
			client,
			this.app.workspace
		);
		this.register(() => {
			cursorListener.dispose();
		});

		this.app.workspace.updateOptions();

		this.addRibbonIcons();

		const editorStatusDisplayManager = new EditorStatusDisplayManager(
			this,
			this.app.workspace,
			client
		);
		this.register(() => {
			editorStatusDisplayManager.dispose();
		});

		this.register(() => {
			// eslint-disable-next-line
			(globalThis as any).VAULT_LINK_RUNNING_INSTANCE = null;
		});
	}

	private addRibbonIcons(): void {
		this.addRibbonIcon(
			HistoryView.ICON,
			"Open VaultLink events",
			async (_: MouseEvent) => this.activateView(HistoryView.TYPE)
		);

		this.addRibbonIcon(
			LogsView.ICON,
			"Open VaultLink logs",
			async (_: MouseEvent) => this.activateView(LogsView.TYPE)
		);
	}

	private registerEditorEvents(client: SyncClient): void {
		[
			this.app.workspace.on(
				"editor-change",
				async (
					_editor: Editor,
					info: MarkdownView | MarkdownFileInfo
				) => {
					const { file } = info;
					if (file) {
						await this.rateLimitedUpdate(file.path, client);
					}
				}
			),
			this.app.vault.on("create", async (file: TAbstractFile) => {
				if (file instanceof TFile) {
					await client.syncLocallyCreatedFile(file.path);
				}
			}),
			this.app.vault.on("modify", async (file: TAbstractFile) => {
				if (file instanceof TFile) {
					await this.rateLimitedUpdate(file.path, client);
				}
			}),
			this.app.vault.on("delete", async (file: TAbstractFile) => {
				await client.syncLocallyDeletedFile(file.path);
			}),
			this.app.vault.on(
				"rename",
				async (file: TAbstractFile, oldPath: string) => {
					if (file instanceof TFile) {
						await client.syncLocallyUpdatedFile({
							oldPath,
							relativePath: file.path
						});
					}
				}
			)
		].forEach((event) => {
			this.registerEvent(event);
		});
	}

	private async rateLimitedUpdate(
		path: string,
		client: SyncClient
	): Promise<void> {
		if (!this.rateLimitedUpdatesPerFile.has(path)) {
			this.rateLimitedUpdatesPerFile.set(
				path,
				rateLimit(
					async () =>
						client.syncLocallyUpdatedFile({
							relativePath: path
						}),
					MIN_WAIT_BETWEEN_UPDATES_IN_MS
				)
			);
		}
		await this.rateLimitedUpdatesPerFile.get(path)?.();
	}
}
