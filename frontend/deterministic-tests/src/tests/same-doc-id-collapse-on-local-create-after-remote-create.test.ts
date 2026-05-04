import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const sameDocIdCollapseOnLocalCreateAfterRemoteCreateTest: TestDefinition =
    {
        description:
            "Client B creates X with content C2; the server commits and " +
            "broadcasts. Client A's WS is paused so the RemoteCreate buffers. " +
            "Server is then paused so A's about-to-POST LocalCreate will " +
            "hang. A creates X with content C1: file lands on disk, " +
            "LocalCreate enqueues, drain starts the POST, the POST stalls " +
            "at the paused server. A's WS is resumed: the buffered " +
            "RemoteCreate for doc-X is delivered to A and enqueues behind " +
            "the in-flight LocalCreate. Per the lazy-paths model, when " +
            "the RemoteCreate is processed it observes that path X is " +
            "occupied locally by A's pending-create bytes, so it tracks " +
            "doc-X with `localPath = undefined` / `remoteRelativePath = " +
            "X` and does NOT fetch content. The server is then resumed: " +
            "A's LocalCreate POST returns. The server, finding X already " +
            "taken by doc-X, replies with doc-X's existing documentId " +
            "(typically a MergingUpdate carrying the merged bytes). A's " +
            "processCreate handler detects that response.documentId " +
            "matches the no-localPath record built from the RemoteCreate " +
            "and collapses the two: it sets localPath = X on that " +
            "record, writes the merged bytes, and resolves the pending " +
            "create promise. Final state: exactly one file at X on both " +
            "clients, both pointing at doc-X's documentId, content " +
            "carrying both contributions, and no conflict-<uuid>- " +
            "stash anywhere.",
        clients: 2,
        steps: [
            { type: "enable-sync", client: 0 },
            { type: "enable-sync", client: 1 },
            { type: "barrier" },

            // Buffer broadcasts to client 0 (A) so client 1's create
            // doesn't reach A's WS handler until we say so.
            { type: "pause-websocket", client: 0 },

            // Client 1 (B) commits doc-X at path X with content C2.
            // The server commits, broadcasts (broadcast queued at A's
            // paused WS).
            {
                type: "create",
                client: 1,
                path: "X.md",
                content: "from-client-1 "
            },
            { type: "sync", client: 1 },

            // Pause the server so A's upcoming LocalCreate POST hangs.
            // This holds A's drain on the in-flight POST while we
            // release the WS so the RemoteCreate enqueues behind it.
            { type: "pause-server" },

            // Client 0 (A) creates X locally with content C1. The
            // file lands on A's disk; LocalCreate enqueues; drain
            // starts the POST; POST stalls at the paused server.
            {
                type: "create",
                client: 0,
                path: "X.md",
                content: "from-client-0 "
            },

            // Release A's WS. The buffered RemoteCreate for doc-X is
            // delivered to A and enqueues behind the in-flight
            // LocalCreate. Whichever of (RemoteCreate processed first
            // → no-localPath record, then LocalCreate POST returns
            // with merging response that collapses) or (LocalCreate
            // POST returns first with merging response that creates
            // the canonical record, then RemoteCreate finds the doc
            // already tracked by id and no-ops) actually plays out
            // depends on the fine-grained interleaving the runtime
            // produces, but both paths are required to converge to
            // the same single-record same-docId state.
            { type: "resume-websocket", client: 0 },

            // Resume the server: A's LocalCreate POST completes.
            // Server returns doc-X's existing documentId (MergingUpdate
            // with merged content). processCreate runs the collapse
            // path.
            { type: "resume-server" },

            { type: "barrier" },

            {
                type: "assert-consistent",
                verify: (state: AssertableState): void => {
                    state.assertFileCount(1);
                    state.assertFileExists("X.md");
                    // Server-side merge of the two text creates must
                    // carry both contributions through to the
                    // converged file.
                    state.assertContains(
                        "X.md",
                        "from-client-0",
                        "from-client-1"
                    );
                    // The lazy-paths collapse path must not leave a
                    // conflict-<uuid>- stash on either client.
                    for (const path of state.files.keys()) {
                        if (path.startsWith("conflict-")) {
                            throw new Error(
                                `Unexpected conflict-uuid stash on a converged client: ${path}`
                            );
                        }
                    }
                    for (const perClient of state.clientFiles) {
                        for (const path of perClient.keys()) {
                            if (path.startsWith("conflict-")) {
                                throw new Error(
                                    `Unexpected conflict-uuid stash on a per-client view: ${path}`
                                );
                            }
                        }
                    }
                }
            }
        ]
    };
