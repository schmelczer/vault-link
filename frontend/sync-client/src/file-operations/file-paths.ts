import { FileKind } from "./filesystem-operations";
import { v4 as uuid } from "uuid";
import type { FileSystemOperations } from "./filesystem-operations";
import type { FileApplication } from "./file-application";
import { posix } from "path";
import type {
    DocumentId,
    StoredDatabase,
    RelativePath
} from "../persistence/database";
import { allocatePortablePath, isInternalPath } from "../utils/portable-path";

interface PathObstruction {
    path: RelativePath;
    kind: FileKind;
}

interface Occupant {
    id: DocumentId;
    path: RelativePath;
}

// Resolve occupied rename destinations without discarding another file.
export class FilePaths {
    public constructor(
        private readonly fs: FileSystemOperations,
        private readonly isProtectedFile: (
            path: RelativePath,
            size: number
        ) => boolean
    ) {}

    public async prepareDestination(
        application: FileApplication,
        id: DocumentId,
        path: RelativePath
    ): Promise<RelativePath> {
        const { current, next } = application;
        for (;;) {
            const obstruction = await this.findObstruction(path);
            if (!obstruction) {
                break;
            }

            const occupants = await this.findMovableOccupants(
                obstruction,
                current,
                next
            );

            if (occupants === undefined) {
                path = await this.allocateConflictPath(next, id, path);
                continue;
            }

            await this.relocateOccupants(occupants, application);

            if (obstruction.kind === FileKind.Directory) {
                application.beginFileChanges();
                await this.fs.deleteDirectory(obstruction.path);
            }
        }

        application.assertPlanCurrent();
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

    private async findObstruction(
        path: RelativePath
    ): Promise<PathObstruction | undefined> {
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
        obstruction: PathObstruction,
        current: StoredDatabase,
        next: StoredDatabase
    ): Promise<Occupant[] | undefined> {
        const children =
            obstruction.kind === FileKind.File
                ? [obstruction.path]
                : await this.fs.listFilesRecursively(obstruction.path);

        const occupants = [];
        for (const child of children) {
            const occupant = Object.keys(current.local).find(
                (key) =>
                    current.documents[key]?.observedHash !== undefined &&
                    current.local[key] === child
            );
            const info = await this.fs.stat(child);

            if (
                !info || // doesn't exist anymore
                this.isProtectedFile(child, info.size) ||
                (obstruction.kind === FileKind.Directory &&
                    (occupant === undefined || next.local[occupant] === child))
            ) {
                return undefined;
            }

            occupants.push({ id: occupant ?? uuid(), path: child });
        }

        return occupants;
    }

    private async allocateConflictPath(
        next: StoredDatabase,
        id: DocumentId,
        path: RelativePath
    ): Promise<RelativePath> {
        const occupied = Object.entries(next.local).flatMap(
            ([other, occupiedPath]) => (other === id ? [] : [occupiedPath])
        );

        const files = (await this.fs.listFilesRecursively()).filter(
            (diskPath) => !isInternalPath(diskPath)
        );

        return allocatePortablePath(path, id, [...occupied, ...files]);
    }

    private async relocateOccupants(
        occupants: Occupant[],
        application: FileApplication
    ): Promise<void> {
        const { current, next } = application;
        for (const occupant of occupants) {
            const displaced = await this.allocateConflictPath(
                next,
                occupant.id,
                posix.basename(occupant.path)
            );

            application.beginFileChanges();
            current.local[occupant.id] = displaced;
            await this.fs.rename(occupant.path, displaced);

            if (!current.documents[occupant.id]) {
                current.documents[occupant.id] = { observedHash: "" };
                next.documents[occupant.id] = { observedHash: "" };
                next.local[occupant.id] = displaced;
            } else if (next.local[occupant.id] === occupant.path) {
                next.local[occupant.id] = displaced;
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
