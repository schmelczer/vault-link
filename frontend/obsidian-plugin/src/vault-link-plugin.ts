import type {
	MarkdownView,
	Editor,
	MarkdownFileInfo,
	TAbstractFile,
	WorkspaceLeaf
} from "obsidian";
import { Platform, Plugin, TFile } from "obsidian";
import "../manifest.json";
import { HistoryView } from "./views/history/history-view";
import { StatusBar } from "./views/status-bar/status-bar";
import { LogsView } from "./views/logs/logs-view";
import { StatusDescription } from "./views/status-description/status-description";
import * as Sentry from "@sentry/browser";
import { init as plausibleInit } from "@plausible-analytics/tracker";
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

export default class VaultLinkPlugin extends Plugin {
	private readonly disposables: (() => unknown)[] = [];

	private settingsTab: SyncSettingsTab | undefined;
	private client!: SyncClient;
	private readonly rateLimitedUpdatesPerFile = new Map<
		string,
		() => Promise<unknown>
	>();

	public async onload(): Promise<void> {
		DEFAULT_SETTINGS.ignorePatterns.push(
			".obsidian/**",
			".git/**",
			".trash/**"
		);

		const isDebugBuild = process.env.NODE_ENV === "development";

		if (!isDebugBuild) {
			plausibleInit({
				domain: "vault-link",
				endpoint: "https://stats.schmelczer.dev/status",
				autoCapturePageviews: true,
				captureOnLocalhost: true,
				logging: true
			});

			Sentry.init({
				dsn: "https://56accd39d92442e788a457a04623cf57@bugs.schmelczer.dev/1",
				skipBrowserExtensionCheck: false
			});

			const onError = (event: ErrorEvent): void => {
				Sentry.captureException(event.error, {
					extra: {
						message: event.message,
						filename: event.filename,
						lineno: event.lineno,
						colno: event.colno
					}
				});
			};
			window.addEventListener("error", onError);
			this.disposables.push(() => {
				window.removeEventListener("error", onError);
			});

			const onUnhandledRejection = (
				event: PromiseRejectionEvent
			): void => {
				Sentry.captureException(event.reason);
			};
			window.addEventListener("unhandledrejection", onUnhandledRejection);
			this.disposables.push(() => {
				window.removeEventListener(
					"unhandledrejection",
					onUnhandledRejection
				);
			});
		}

		const debugOptions = isDebugBuild
			? {
					fetch: debugging.slowFetchFactory(1),
					webSocket: debugging.slowWebSocketFactory(1, new Logger())
				}
			: {};

		this.client = await SyncClient.create({
			fs: new ObsidianFileSystemOperations(
				this.app.vault,
				this.app.workspace
			),
			persistence: {
				load: this.loadData.bind(this),
				save: this.saveData.bind(this)
			},
			nativeLineEndings: Platform.isWin ? "\r\n" : "\n",
			...debugOptions
		});

		if (isDebugBuild) {
			debugging.logToConsole(this.client);
		}

		const statusDescription = new StatusDescription(this.client);

		this.settingsTab = new SyncSettingsTab({
			app: this.app,
			plugin: this,
			syncClient: this.client,
			statusDescription
		});
		this.addSettingTab(this.settingsTab);

		new StatusBar(this, this.client);

		this.registerView(
			HistoryView.TYPE,
			(leaf) => new HistoryView(this.client, leaf)
		);

		this.registerView(
			LogsView.TYPE,
			(leaf) => new LogsView(this.client, leaf)
		);

		this.registerEditorExtension([remoteCursorsTheme, remoteCursorsPlugin]);

		this.client.addRemoteCursorsUpdateListener((cursors) => {
			RemoteCursorsPluginValue.setCursors(cursors, this.app);
			renderCursorsInFileExplorer(cursors, this.app);
		});

		const cursorListener = new LocalCursorUpdateListener(
			this.client,
			this.app.workspace
		);
		this.disposables.push(() => {
			cursorListener.dispose();
		});

		this.app.workspace.updateOptions();

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

		this.app.workspace.onLayoutReady(async () => {
			this.registerEditorEvents();
			await this.client.start();

			const editorStatusDisplayManager = new EditorStatusDisplayManager(
				this,
				this.app.workspace,
				this.client
			);
			this.disposables.push(() => {
				editorStatusDisplayManager.stop();
			});
		});
	}

	public onunload(): void {
		this.client.waitAndStop().catch((err: unknown) => {
			this.client.logger.error(
				`Error while stopping the sync client: ${err}`
			);
		});
		this.disposables.forEach((disposable) => {
			disposable();
		});
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

	private registerEditorEvents(): void {
		[
			this.app.workspace.on(
				"editor-change",
				async (
					_editor: Editor,
					info: MarkdownView | MarkdownFileInfo
				) => {
					const { file } = info;
					if (file) {
						await this.rateLimitedUpdate(file.path);
					}
				}
			),
			this.app.vault.on("create", async (file: TAbstractFile) => {
				if (file instanceof TFile) {
					await this.client.syncLocallyCreatedFile(file.path);
				}
			}),
			this.app.vault.on("modify", async (file: TAbstractFile) => {
				if (file instanceof TFile) {
					await this.rateLimitedUpdate(file.path);
				}
			}),
			this.app.vault.on("delete", async (file: TAbstractFile) => {
				await this.client.syncLocallyDeletedFile(file.path);
			}),
			this.app.vault.on(
				"rename",
				async (file: TAbstractFile, oldPath: string) => {
					if (file instanceof TFile) {
						await this.client.syncLocallyUpdatedFile({
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

	private async rateLimitedUpdate(path: string): Promise<void> {
		if (!this.rateLimitedUpdatesPerFile.has(path)) {
			this.rateLimitedUpdatesPerFile.set(
				path,
				rateLimit(
					async () =>
						this.client.syncLocallyUpdatedFile({
							relativePath: path
						}),
					MIN_WAIT_BETWEEN_UPDATES_IN_MS
				)
			);
		}
		await this.rateLimitedUpdatesPerFile.get(path)?.();
	}
}
