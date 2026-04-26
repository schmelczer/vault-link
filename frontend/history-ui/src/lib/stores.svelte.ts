import { ApiClient } from "./api";
import type {
    DocumentVersionWithoutContent,
    VaultInfo,
    VersionEvent,
    ActionType,
    TreeNode
} from "./types";

class AuthStore {
    token = $state("");
    userName = $state("");
    vaultId = $state("");
    serverVersion = $state("");
    availableVaults = $state<VaultInfo[]>([]);
    isAuthenticated = $state(false);
    api = $state<ApiClient | null>(null);

    authenticate(token: string, userName: string, vaults: VaultInfo[]) {
        this.token = token;
        this.userName = userName;
        this.availableVaults = vaults;
        sessionStorage.setItem("vaultlink_token", token);
    }

    selectVault(vaultId: string) {
        this.vaultId = vaultId;
        this.isAuthenticated = true;
        this.api = new ApiClient(vaultId, this.token);
        sessionStorage.setItem("vaultlink_vault", vaultId);
    }

    deselectVault() {
        this.vaultId = "";
        this.isAuthenticated = false;
        this.api = null;
        sessionStorage.removeItem("vaultlink_vault");
    }

    logout() {
        this.token = "";
        this.userName = "";
        this.vaultId = "";
        this.serverVersion = "";
        this.availableVaults = [];
        this.isAuthenticated = false;
        this.api = null;
        sessionStorage.removeItem("vaultlink_token");
        sessionStorage.removeItem("vaultlink_vault");
    }

    tryRestore(): { token: string; vaultId?: string } | null {
        const token = sessionStorage.getItem("vaultlink_token");
        if (!token) return null;
        const vaultId = sessionStorage.getItem("vaultlink_vault") ?? undefined;
        return { token, vaultId };
    }
}

export const auth = new AuthStore();

// Navigation
export type View =
    | { kind: "dashboard" }
    | { kind: "document"; documentId: string };

class NavStore {
    current = $state<View>({ kind: "dashboard" });

    goto(view: View) {
        this.current = view;
    }

    goHome() {
        this.current = { kind: "dashboard" };
    }
}

export const nav = new NavStore();

// Toasts
interface Toast {
    id: number;
    message: string;
    type: "success" | "error" | "info";
}

class ToastStore {
    items = $state<Toast[]>([]);
    private nextId = 0;

    add(message: string, type: Toast["type"] = "info") {
        const id = this.nextId++;
        this.items.push({ id, message, type });
        setTimeout(() => this.dismiss(id), 5000);
    }

    dismiss(id: number) {
        this.items = this.items.filter((t) => t.id !== id);
    }
}

export const toasts = new ToastStore();

// Utilities

export function inferAction(
    version: DocumentVersionWithoutContent,
    previousVersion?: DocumentVersionWithoutContent
): ActionType {
    if (version.isDeleted) return "deleted";
    if (!previousVersion) return "created";
    if (previousVersion.isDeleted && !version.isDeleted) return "restored";
    if (previousVersion.relativePath !== version.relativePath) return "renamed";
    return "updated";
}

export function enrichVersions(
    versions: DocumentVersionWithoutContent[]
): VersionEvent[] {
    // versions should be sorted by vaultUpdateId ascending
    const sorted = [...versions].sort(
        (a, b) => a.vaultUpdateId - b.vaultUpdateId
    );
    const byDoc = new Map<string, DocumentVersionWithoutContent[]>();
    for (const v of sorted) {
        let arr = byDoc.get(v.documentId);
        if (!arr) {
            arr = [];
            byDoc.set(v.documentId, arr);
        }
        arr.push(v);
    }

    return sorted.map((v) => {
        const docVersions = byDoc.get(v.documentId)!;
        const idx = docVersions.indexOf(v);
        const prev = idx > 0 ? docVersions[idx - 1] : undefined;
        const action = inferAction(v, prev);
        return {
            ...v,
            action,
            previousPath: action === "renamed" ? prev?.relativePath : undefined
        };
    });
}

export function buildTree(
    documents: DocumentVersionWithoutContent[],
    showDeleted: boolean
): TreeNode {
    const root: TreeNode = {
        name: "",
        path: "",
        isFolder: true,
        children: []
    };

    const filtered = showDeleted
        ? documents
        : documents.filter((d) => !d.isDeleted);

    for (const doc of filtered) {
        const parts = doc.relativePath.split("/");
        let current = root;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isFile = i === parts.length - 1;
            const path = parts.slice(0, i + 1).join("/");

            if (isFile) {
                current.children.push({
                    name: part,
                    path,
                    isFolder: false,
                    children: [],
                    document: doc,
                    isDeleted: doc.isDeleted
                });
            } else {
                let folder = current.children.find(
                    (c) => c.isFolder && c.name === part
                );
                if (!folder) {
                    folder = {
                        name: part,
                        path,
                        isFolder: true,
                        children: []
                    };
                    current.children.push(folder);
                }
                current = folder;
            }
        }
    }

    sortTree(root);
    return root;
}

function sortTree(node: TreeNode) {
    node.children.sort((a, b) => {
        if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    for (const child of node.children) {
        if (child.isFolder) sortTree(child);
    }
}

export function relativeTime(dateStr: string): string {
    const date = new Date(dateStr);
    const now = Date.now();
    const diff = now - date.getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (seconds < 60) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: days > 365 ? "numeric" : undefined
    });
}

export function absoluteTime(dateStr: string): string {
    return new Date(dateStr).toLocaleString();
}

export function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function fileExtension(path: string): string {
    const dot = path.lastIndexOf(".");
    return dot > -1 ? path.substring(dot + 1).toLowerCase() : "";
}

export function isTextFile(path: string): boolean {
    const textExts = new Set([
        "md",
        "txt",
        "json",
        "yaml",
        "yml",
        "toml",
        "xml",
        "html",
        "css",
        "js",
        "ts",
        "svelte",
        "rs",
        "py",
        "sh",
        "bash",
        "zsh",
        "csv",
        "svg",
        "log",
        "conf",
        "cfg",
        "ini",
        "env",
        "gitignore",
        "editorconfig"
    ]);
    return textExts.has(fileExtension(path));
}

export function isImageFile(path: string): boolean {
    const imageExts = new Set([
        "png",
        "jpg",
        "jpeg",
        "gif",
        "webp",
        "svg",
        "ico",
        "bmp"
    ]);
    return imageExts.has(fileExtension(path));
}
