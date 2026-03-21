import type { DocumentVersionWithoutContent } from "../services/types/DocumentVersionWithoutContent";

// ---------------------------------------------------------------------------
// Raw sync events — emitted by file watchers and WebSocket handlers
// ---------------------------------------------------------------------------

export type SyncEvent =
    | { type: "local-create"; path: string }
    | { type: "local-update"; path: string }
    | { type: "local-delete"; path: string }
    | { type: "local-move"; fromPath: string; toPath: string }
    | { type: "remote-update"; version: DocumentVersionWithoutContent }
    | { type: "remote-delete"; version: DocumentVersionWithoutContent };

// ---------------------------------------------------------------------------
// Coalesced actions — the result of merging multiple events on the same key
// ---------------------------------------------------------------------------

export type CoalescedAction =
    | { action: "create"; path: string }
    | { action: "update"; path: string }
    | { action: "delete"; path: string }
    | { action: "move"; fromPath: string; toPath: string }
    | { action: "move-and-update"; fromPath: string; toPath: string }
    | { action: "remote-update"; version: DocumentVersionWithoutContent }
    | { action: "remote-delete"; version: DocumentVersionWithoutContent }
    | { action: "noop" };

/**
 * Convert a single SyncEvent to its initial CoalescedAction.
 */
export function eventToInitialAction(event: SyncEvent): CoalescedAction {
    switch (event.type) {
        case "local-create":
            return { action: "create", path: event.path };
        case "local-update":
            return { action: "update", path: event.path };
        case "local-delete":
            return { action: "delete", path: event.path };
        case "local-move":
            return {
                action: "move",
                fromPath: event.fromPath,
                toPath: event.toPath
            };
        case "remote-update":
            return { action: "remote-update", version: event.version };
        case "remote-delete":
            return { action: "remote-delete", version: event.version };
    }
}

/**
 * Coalesce a new SyncEvent into an existing CoalescedAction.
 *
 * This implements the full transition table for combining sequential events
 * that target the same logical document. The goal is to reduce multiple
 * events into a single action that captures the net effect.
 *
 * Transition table (current action x new event -> result):
 *
 * | Current \ New Event | local-create | local-update | local-delete | local-move(to) | remote-update | remote-delete |
 * |---------------------|-------------|-------------|-------------|----------------|---------------|---------------|
 * | create              | create      | create      | noop        | create(to)     | create        | noop          |
 * | update              | update      | update      | delete      | move-and-update| remote-update | delete        |
 * | delete              | create      | update      | delete      | move           | remote-update | delete        |
 * | move                | move        | move-and-upd| delete      | move(orig,to)  | move          | delete        |
 * | move-and-update     | move-and-upd| move-and-upd| delete      | m-a-u(orig,to) | move-and-upd  | delete        |
 * | remote-update       | create      | remote-upd  | remote-del  | remote-upd     | remote-upd    | remote-del    |
 * | remote-delete       | create      | remote-del  | remote-del  | remote-del     | remote-upd    | remote-del    |
 * | noop                | create      | update      | delete      | move           | remote-update | remote-delete |
 */
export function coalesce(
    current: CoalescedAction,
    event: SyncEvent
): CoalescedAction {
    switch (current.action) {
        case "create":
            return coalesceFromCreate(current, event);
        case "update":
            return coalesceFromUpdate(current, event);
        case "delete":
            return coalesceFromDelete(event);
        case "move":
            return coalesceFromMove(current, event);
        case "move-and-update":
            return coalesceFromMoveAndUpdate(current, event);
        case "remote-update":
            return coalesceFromRemoteUpdate(current, event);
        case "remote-delete":
            return coalesceFromRemoteDelete(current, event);
        case "noop":
            return eventToInitialAction(event);
    }
}

function coalesceFromCreate(
    current: { action: "create"; path: string },
    event: SyncEvent
): CoalescedAction {
    switch (event.type) {
        case "local-create":
            // create + create = still create (idempotent)
            return current;
        case "local-update":
            // create + update = still create (content will be read at sync time)
            return current;
        case "local-delete":
            // create + delete = noop (file never reached server)
            return { action: "noop" };
        case "local-move":
            // create + move = create at new path
            return { action: "create", path: event.toPath };
        case "remote-update":
            // create + remote-update = still create (local create takes precedence)
            return current;
        case "remote-delete":
            // create + remote-delete = noop
            return { action: "noop" };
    }
}

function coalesceFromUpdate(
    current: { action: "update"; path: string },
    event: SyncEvent
): CoalescedAction {
    switch (event.type) {
        case "local-create":
            // update + create = update (file was already tracked)
            return current;
        case "local-update":
            // update + update = update
            return current;
        case "local-delete":
            // update + delete = delete
            return { action: "delete", path: current.path };
        case "local-move":
            // update + move = move-and-update
            return {
                action: "move-and-update",
                fromPath: event.fromPath,
                toPath: event.toPath
            };
        case "remote-update":
            // update + remote-update = remote-update (forces server fetch
            // so remote changes are applied even when there are no local edits)
            return { action: "remote-update", version: event.version };
        case "remote-delete":
            // update + remote-delete = delete
            return { action: "delete", path: current.path };
    }
}

function coalesceFromDelete(event: SyncEvent): CoalescedAction {
    switch (event.type) {
        case "local-create":
            // delete + create = create (file re-created)
            return { action: "create", path: event.path };
        case "local-update":
            // delete + update = update (file re-appeared with changes)
            return { action: "update", path: event.path };
        case "local-delete":
            // delete + delete = delete (idempotent)
            return { action: "delete", path: event.path };
        case "local-move":
            // delete + move = move (the original delete is superseded)
            return {
                action: "move",
                fromPath: event.fromPath,
                toPath: event.toPath
            };
        case "remote-update":
            // delete + remote-update = remote-update (server has new version)
            return { action: "remote-update", version: event.version };
        case "remote-delete":
            // delete + remote-delete = delete
            return { action: "delete", path: event.version.relativePath };
    }
}

function coalesceFromMove(
    current: { action: "move"; fromPath: string; toPath: string },
    event: SyncEvent
): CoalescedAction {
    switch (event.type) {
        case "local-create":
            // move + create = move (file already at destination)
            return current;
        case "local-update":
            // move + update = move-and-update
            return {
                action: "move-and-update",
                fromPath: current.fromPath,
                toPath: current.toPath
            };
        case "local-delete":
            // move + delete = delete (from original path)
            return { action: "delete", path: current.fromPath };
        case "local-move":
            // move(A->B) + move(B->C) = move(A->C)
            return {
                action: "move",
                fromPath: current.fromPath,
                toPath: event.toPath
            };
        case "remote-update":
            // move + remote-update = move (local move takes precedence)
            return current;
        case "remote-delete":
            // move + remote-delete = delete
            return { action: "delete", path: current.fromPath };
    }
}

function coalesceFromMoveAndUpdate(
    current: { action: "move-and-update"; fromPath: string; toPath: string },
    event: SyncEvent
): CoalescedAction {
    switch (event.type) {
        case "local-create":
            // move-and-update + create = move-and-update
            return current;
        case "local-update":
            // move-and-update + update = move-and-update
            return current;
        case "local-delete":
            // move-and-update + delete = delete (from original path)
            return { action: "delete", path: current.fromPath };
        case "local-move":
            // move-and-update(A->B) + move(B->C) = move-and-update(A->C)
            return {
                action: "move-and-update",
                fromPath: current.fromPath,
                toPath: event.toPath
            };
        case "remote-update":
            // move-and-update + remote-update = move-and-update
            return current;
        case "remote-delete":
            // move-and-update + remote-delete = delete
            return { action: "delete", path: current.fromPath };
    }
}

function coalesceFromRemoteUpdate(
    current: { action: "remote-update"; version: DocumentVersionWithoutContent },
    event: SyncEvent
): CoalescedAction {
    switch (event.type) {
        case "local-create":
            // remote-update + create = create (local create wins — will be
            // sent to server, which will merge or deconflict)
            return { action: "create", path: event.path };
        case "local-update":
            // remote-update + update = remote-update (will merge on sync)
            return current;
        case "local-delete":
            // remote-update + local-delete = remote-delete
            return { action: "remote-delete", version: current.version };
        case "local-move":
            // remote-update + move = remote-update (path change handled separately)
            return current;
        case "remote-update":
            // remote-update + remote-update = remote-update (latest version)
            return { action: "remote-update", version: event.version };
        case "remote-delete":
            // remote-update + remote-delete = remote-delete
            return { action: "remote-delete", version: event.version };
    }
}

function coalesceFromRemoteDelete(
    current: {
        action: "remote-delete";
        version: DocumentVersionWithoutContent;
    },
    event: SyncEvent
): CoalescedAction {
    switch (event.type) {
        case "local-create":
            // remote-delete + create = create (local create takes precedence —
            // the user explicitly created a file; the remote delete was for the
            // OLD document, the create is for a NEW one)
            return { action: "create", path: event.path };
        case "local-update":
            // remote-delete + update = remote-delete
            return current;
        case "local-delete":
            // remote-delete + local-delete = remote-delete
            return current;
        case "local-move":
            // remote-delete + move = remote-delete
            return current;
        case "remote-update":
            // remote-delete + remote-update = remote-update (server changed its mind)
            return { action: "remote-update", version: event.version };
        case "remote-delete":
            // remote-delete + remote-delete = remote-delete (latest)
            return { action: "remote-delete", version: event.version };
    }
}
