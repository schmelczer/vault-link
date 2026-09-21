import type {
    ExpectedDocument,
    TestDefinition,
    TestStep
} from "../../deterministic-tests/src/test-definition";
import { Random } from "../../test-support/random";

export interface Trace {
    version: 1;
    seed: number;
    iterations: number;
    /** Old traces omit this and retain their original two-client behavior. */
    clients?: number;
    steps: TestStep[];
}

type Document = ExpectedDocument & { content: string };

/** Concrete actions and independent expected states are serialized together.
 * Every round checks the whole history, including earlier bytes and UUIDs.
 * A shuffled cycle covers nine actions; most revisit existing documents.
 */
export function generateTrace(seed: number, iterations: number): Trace {
    const random = new Random(seed);
    const clients = 2 + random.int(2);
    const steps: TestStep[] = [];
    const documents: Document[] = [];
    const markers: string[] = [];
    const removed: string[] = [];
    let serial = 0;
    const newDocument = (path: string): Document => {
        const key = `seed-${seed}-document-${serial++}`;
        const marker = `[${key}]`;
        markers.push(marker);
        return {
            key,
            path,
            content: `${marker}\n\nfirst paragraph\n\nlast paragraph\n`
        };
    };
    const all = (type: "enable-sync" | "disable-sync") => {
        for (let client = 0; client < clients; client++)
            steps.push({ type, client });
    };
    const expected = () =>
        steps.push({
            type: "assert-documents",
            expected: structuredClone(documents)
        });
    const barrier = () => {
        steps.push({ type: "barrier" });
        expected();
    };
    const forget = (doc: Document) => {
        for (const marker of markers)
            if (doc.content.includes(marker) && !removed.includes(marker))
                removed.push(marker);
        documents.splice(documents.indexOf(doc), 1);
    };
    all("enable-sync");
    steps.push({ type: "barrier" });
    // A lasting pool makes later actions interact with earlier versions/moves.
    for (const path of ["shared/a.md", "日本語/b.md", "café/c.md"]) {
        const doc = newDocument(path);
        documents.push(doc);
        steps.push({ type: "create", client: 0, path, content: doc.content });
    }
    barrier();
    let choices: number[] = [];
    for (let round = 0; round < iterations; round++) {
        if (!choices.length) {
            choices = Array.from({ length: 9 }, (_, i) => i);
            for (let i = choices.length - 1; i > 0; i--) {
                const j = random.int(i + 1);
                [choices[i], choices[j]] = [choices[j], choices[i]];
            }
        }
        const kind = choices.pop()!;
        const writer = random.int(clients);
        const other = (writer + 1 + random.int(clients - 1)) % clients;
        const doc = random.pick(documents.filter((entry) => !entry.conflict));
        const directory = `round-${round}/${random.pick(["nested", "日本語", "café", "space folder"])}`;
        if (kind === 0) {
            all("disable-sync");
            const first = newDocument(`${directory}/same.md`);
            const second = { ...newDocument(first.path), conflict: true };
            steps.push(
                {
                    type: "create",
                    client: writer,
                    path: first.path,
                    content: first.content
                },
                {
                    type: "create",
                    client: other,
                    path: second.path,
                    content: second.content
                },
                {
                    type: "drop-response",
                    client: writer,
                    kind: random.pick(["create", "manifest"] as const),
                    point: random.pick(["before", "after"] as const)
                },
                { type: "enable-sync", client: writer },
                { type: "sync", client: writer },
                { type: "wait-for-response-drop", client: writer }
            );
            all("enable-sync");
            documents.push(first, second);
        } else if (kind === 1) {
            // Both clients edit the same established version, at opposite ends.
            all("disable-sync");
            const prefix = `remote prefix ${round}\n\n`;
            const suffix = `\n\nlocal suffix ${round}\n`;
            steps.push(
                {
                    type: "update",
                    client: writer,
                    path: doc.path,
                    content: doc.content + suffix
                },
                {
                    type: "update",
                    client: other,
                    path: doc.path,
                    content: prefix + doc.content
                },
                { type: "enable-sync", client: writer }
            );
            all("enable-sync");
            doc.content = prefix + doc.content + suffix;
        } else if (kind === 2) {
            all("disable-sync");
            const target = `${directory}/moved.md`;
            doc.content += `\nremote addition ${round}\n`;
            steps.push(
                {
                    type: "rename",
                    client: writer,
                    oldPath: doc.path,
                    newPath: target
                },
                {
                    type: "update",
                    client: other,
                    path: doc.path,
                    content: doc.content
                },
                { type: "enable-sync", client: writer }
            );
            all("enable-sync");
            doc.path = target;
        } else if (kind === 3) {
            const second = random.pick(
                documents.filter((entry) => !entry.conflict && entry !== doc)
            );
            steps.push(
                { type: "disable-sync", client: writer },
                {
                    type: "rename",
                    client: writer,
                    oldPath: doc.path,
                    newPath: `${directory}/temporary.md`
                },
                {
                    type: "rename",
                    client: writer,
                    oldPath: second.path,
                    newPath: doc.path
                },
                {
                    type: "rename",
                    client: writer,
                    oldPath: `${directory}/temporary.md`,
                    newPath: second.path
                },
                { type: "enable-sync", client: writer }
            );
            [doc.path, second.path] = [second.path, doc.path];
        } else if (kind === 4) {
            // Reuse the same path but require a new UUID, even in later rounds.
            steps.push({ type: "delete", client: writer, path: doc.path });
            forget(doc);
            barrier();
            const replacement = newDocument(doc.path);
            steps.push({
                type: "create",
                client: other,
                path: replacement.path,
                content: replacement.content
            });
            documents.push(replacement);
        } else if (kind === 5) {
            const target = `${directory}/rapid.md`;
            steps.push(
                {
                    type: "rename",
                    client: writer,
                    oldPath: doc.path,
                    newPath: target
                },
                {
                    type: "rename",
                    client: writer,
                    oldPath: target,
                    newPath: doc.path
                },
                {
                    type: "rename",
                    client: writer,
                    oldPath: doc.path,
                    newPath: target
                }
            );
            doc.path = target;
            doc.content += `\nrapid edit ${round}\n`;
            steps.push({
                type: "update",
                client: writer,
                path: doc.path,
                content: doc.content
            });
        } else if (kind === 6) {
            steps.push({
                type: "drop-response",
                client: writer,
                kind: "content",
                point: random.pick(["before", "after"] as const)
            });
            doc.content += `\nretry edit ${round}\n`;
            steps.push(
                {
                    type: "update",
                    client: writer,
                    path: doc.path,
                    content: doc.content
                },
                { type: "wait-for-response-drop", client: writer }
            );
        } else if (kind === 7) {
            // Keep an editor event delayed across reconnection and another edit.
            steps.push(
                { type: "disable-sync", client: writer },
                { type: "delay-notifications", client: writer }
            );
            doc.content += `\ndelayed local edit ${round}\n`;
            steps.push(
                {
                    type: "update",
                    client: writer,
                    path: doc.path,
                    content: doc.content
                },
                { type: "enable-sync", client: writer }
            );
            barrier();
            doc.content += `\nlater remote edit ${round}\n`;
            steps.push({
                type: "update",
                client: other,
                path: doc.path,
                content: doc.content
            });
            barrier();
            steps.push({ type: "flush-notifications", client: writer });
        } else {
            // Explicit replacement retains the UUID. Only markers in the
            // overwritten bytes are exempted from preservation.
            for (const marker of markers)
                if (doc.content.includes(marker) && !removed.includes(marker))
                    removed.push(marker);
            doc.content = newDocument(doc.path).content;
            steps.push({
                type: "update",
                client: writer,
                path: doc.path,
                content: doc.content
            });
        }
        barrier();
        steps.push({
            type: "assert-markers",
            markers: [...markers],
            removed: [...removed]
        });
        if (random.int(4) === 0) {
            steps.push({ type: "reset", client: random.int(clients) });
            barrier();
        }
    }
    return { version: 1, seed, iterations, clients, steps };
}

export function traceTest(trace: Trace): TestDefinition {
    if (
        trace.version !== 1 ||
        !Array.isArray(trace.steps) ||
        !trace.steps.length ||
        (trace.clients !== undefined &&
            (!Number.isInteger(trace.clients) || trace.clients < 2))
    )
        throw new Error("Invalid/empty replay trace");
    return {
        clients: trace.clients ?? 2,
        description: `Seed ${trace.seed}; ${trace.iterations} generated conflict scenarios`,
        steps: trace.steps
    };
}
