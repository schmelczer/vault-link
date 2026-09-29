import { FileKind } from "./filesystem-operations";
import { v4 as uuid } from "uuid";
import type { FileSystemOperations } from "./filesystem-operations";
import type { FileChangeSession } from "./file-change-session";
import { posix } from "path";
import type {
    DocumentId,
    StoredDatabase,
    RelativePath
} from "../persistence/database";
import { allocatePortablePath, isInternalPath } from "../utils/portable-path";

interface PathCollision {
    path: RelativePath;
    kind: FileKind;
}

interface Occupant {
    id: DocumentId;
    path: RelativePath;
}

/**
 * A collision-free target manifest can still collide with files on disk: rename swaps
 * and cycles leave old paths occupied, and files or directories can block a new
 * destination. FileRenamer renames local files while dealing with temporary conflicts.
 */
export class FileRenamer {
    public constructor(
        private readonly fs: FileSystemOperations,
        private readonly isProtectedFile: (
            path: RelativePath,
            size: number
        ) => boolean
    ) { }

    public async prepareDestination(
        session: FileChangeSession,
        id: DocumentId,
        path: RelativePath
    ): Promise<RelativePath> {
        const { current, planned } = session;
        for (; ;) {
            const collision = await this.findCollision(path);
            if (!collision) {
                break;
            }

            const occupants = await this.findMovableOccupants(
                collision,
                current,
                planned
            );

            if (occupants === undefined) {
                // path must be occupied by an ignored file which we can't move
                path = await this.allocateConflictPath(planned, id, path);
                continue;
            }

            await this.relocateOccupants(occupants, session);

            if (collision.kind === FileKind.Directory) {
                session.beforeFileMutation();
                await this.fs.deleteDirectory(collision.path);
            }
        }

        session.abortIfStale();
        await this.createParentDirectories(path);

        return path;
    }

    public async removeEmptyParents(path: RelativePath): Promise<void> {
        let parent = posix.dirname(path);

        while (parent !== "." && !isInternalPath(parent)) {
            if ((await this.fs.listFilesRecursively(parent)).length) {
                break;
            }

            try {
                await this.fs.deleteDirectory(parent);
            } catch {
                break;
            }

            parent = posix.dirname(parent);
        }
    }

    private async findCollision(
        path: RelativePath
    ): Promise<PathCollision | undefined> {
        const parts = path.split("/");
        for (let i = 0; i < parts.length; i++) {
            const prefix = parts.slice(0, i + 1).join("/");
            const info = await this.fs.stat(prefix);

            if (
                info &&
                (info.kind === FileKind.File || i === parts.length - 1)
            ) {
                return { path: prefix, kind: info.kind };
            }
        }
    }

    private async findMovableOccupants(
        collision: PathCollision,
        current: StoredDatabase,
        planned: StoredDatabase
    ): Promise<Occupant[] | undefined> {
        const children =
            collision.kind === FileKind.File
                ? [collision.path]
                : await this.fs.listFilesRecursively(collision.path);

        const occupants = [];
        for (const child of children) {
            const occupant = Object.keys(current.actualFileManifest).find(
                (key) =>
                    current.documents[key]?.observedHash !== undefined &&
                    current.actualFileManifest[key] === child
            );
            const info = await this.fs.stat(child);

            if (
                !info || // doesn't exist anymore
                this.isProtectedFile(child, info.size) ||
                (collision.kind === FileKind.Directory &&
                    (occupant === undefined || planned.actualFileManifest[occupant] === child))
            ) {
                return undefined;
            }

            occupants.push({ id: occupant ?? uuid(), path: child });
        }

        return occupants;
    }

    private async allocateConflictPath(
        planned: StoredDatabase,
        id: DocumentId,
        path: RelativePath
    ): Promise<RelativePath> {
        const occupied = Object.entries(planned.actualFileManifest).flatMap(
            ([other, occupiedPath]) => (other === id ? [] : [occupiedPath])
        );

        const files = (await this.fs.listFilesRecursively()).filter(
            (diskPath) => !isInternalPath(diskPath)
        );

        return allocatePortablePath(path, id, [...occupied, ...files]);
    }

    private async relocateOccupants(
        occupants: Occupant[],
        session: FileChangeSession
    ): Promise<void> {
        const { current, planned } = session;
        for (const occupant of occupants) {
            const displaced = await this.allocateConflictPath(
                planned,
                occupant.id,
                posix.basename(occupant.path)
            );

            session.beforeFileMutation();
            current.actualFileManifest[occupant.id] = displaced;
            await this.fs.rename(occupant.path, displaced);

            if (!current.documents[occupant.id]) {
                current.documents[occupant.id] = { observedHash: "" };
                planned.documents[occupant.id] = { observedHash: "" };
                planned.actualFileManifest[occupant.id] = displaced;
            } else if (planned.actualFileManifest[occupant.id] === occupant.path) {
                planned.actualFileManifest[occupant.id] = displaced;
            }
        }
    }

    private async createParentDirectories(path: RelativePath): Promise<void> {
        const parent = posix.dirname(path);

        if (parent !== ".") {
            await this.fs.createDirectory(parent);
        }
    }
}
