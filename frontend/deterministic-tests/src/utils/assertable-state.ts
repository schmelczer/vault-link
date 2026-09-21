import assert from "node:assert/strict";
import type { ClientState, ExpectedDocument } from "../test-definition";

export class AssertableState {
    public readonly files: Map<string, string>;
    public readonly clientFiles: Map<string, string>[];
    public readonly manifests: Record<string, string>[];
    public readonly canonical: Record<string, string>;
    public readonly bytes: Map<string, Uint8Array>;

    public constructor(state: ClientState) {
        this.files = state.files;
        this.clientFiles = state.clientFiles;
        this.manifests = state.manifests;
        this.canonical = state.canonical;
        this.bytes = state.bytes;
    }

    public documentId(path: string): string {
        const id = Object.keys(this.canonical).find(
            (id) => this.canonical[id] === path
        );
        if (!id) throw new Error(`No document identity for ${path}`);
        return id;
    }

    public assertDocuments(
        expected: readonly ExpectedDocument[],
        identities: Map<string, string>
    ): this {
        this.assertFileCount(expected.length);
        assert.equal(
            new Set(expected.map((doc) => doc.key)).size,
            expected.length,
            "Duplicate expected identity key"
        );
        const next = new Map(identities);
        const paths = new Set<string>();
        for (const doc of expected) {
            const path = doc.conflict ? this.conflictPath(doc.path) : doc.path;
            assert(
                !paths.has(path),
                `Two expected documents resolved to ${path}`
            );
            paths.add(path);
            this.assertBytes(
                path,
                typeof doc.content === "string"
                    ? new TextEncoder().encode(doc.content)
                    : new Uint8Array(doc.content)
            );
            const id = this.documentId(path);
            const recorded = next.get(doc.key);
            if (recorded !== undefined) this.assertIdentity(path, recorded);
            else {
                assert(
                    ![...next.values()].includes(id),
                    `New document ${doc.key} reused an existing or deleted UUID`
                );
                next.set(doc.key, id);
            }
        }
        // A failed check must not establish a partial identity oracle.
        for (const [key, id] of next) identities.set(key, id);
        return this;
    }

    public conflictPath(original: string): string {
        const dot = original.lastIndexOf(".");
        const split =
            dot > original.lastIndexOf("/") + 1 ? dot : original.length;
        const matches = Object.entries(this.canonical).filter(
            ([id, path]) =>
                path ===
                `${original.slice(0, split)} (conflict ${id})${original.slice(split)}`
        );
        if (matches.length !== 1)
            throw new Error(
                `Expected one UUID-derived conflict path for ${original}, found ${matches.length}`
            );
        return matches[0][1];
    }

    public assertIdentity(path: string, id: string): this {
        if (this.documentId(path) !== id)
            throw new Error(
                `Document identity changed at ${path}: expected ${id}, got ${this.documentId(path)}`
            );
        return this;
    }

    public assertBytes(path: string, expected: Uint8Array): this {
        const actual = this.bytes.get(path);
        if (
            !actual ||
            actual.length !== expected.length ||
            actual.some((byte, i) => byte !== expected[i])
        )
            throw new Error(`Byte mismatch at ${path}`);
        return this;
    }

    public assertFileCount(expected: number): this {
        if (this.files.size !== expected) {
            const keys = Array.from(this.files.keys()).join(", ");
            throw new Error(
                `Expected ${expected} file(s), got ${this.files.size}: [${keys}]`
            );
        }
        return this;
    }

    public assertFileExists(path: string): this {
        if (!this.files.has(path)) {
            const keys = Array.from(this.files.keys()).join(", ");
            throw new Error(`Expected "${path}" to exist. Files: [${keys}]`);
        }
        return this;
    }

    public assertFileNotExists(path: string): this {
        if (this.files.has(path)) {
            const keys = Array.from(this.files.keys()).join(", ");
            throw new Error(
                `Expected "${path}" not to exist. Files: [${keys}]`
            );
        }
        return this;
    }

    public assertContent(path: string, expected: string): this {
        this.assertFileExists(path);
        const actual = this.files.get(path) ?? "";
        if (actual !== expected) {
            throw new Error(
                `Expected "${path}" to have content "${expected}", got: "${actual}"`
            );
        }
        return this;
    }

    public assertContains(path: string, ...substrings: string[]): this {
        this.assertFileExists(path);
        const content = this.files.get(path) ?? "";
        const missing = substrings.filter((s) => !content.includes(s));
        if (missing.length > 0) {
            throw new Error(
                `Expected "${path}" to contain ${missing.map((s) => `"${s}"`).join(", ")}. Content: "${content}"`
            );
        }
        return this;
    }

    public assertContainsAny(path: string, ...substrings: string[]): this {
        this.assertFileExists(path);
        const content = this.files.get(path) ?? "";
        const found = substrings.some((s) => content.includes(s));
        if (!found) {
            throw new Error(
                `Expected "${path}" to contain at least one of ${substrings.map((s) => `"${s}"`).join(", ")}. Content: "${content}"`
            );
        }
        return this;
    }

    public assertAnyFileContains(...substrings: string[]): this {
        const allContent = Array.from(this.files.values()).join("\n");
        const missing = substrings.filter((s) => !allContent.includes(s));
        if (missing.length > 0) {
            const dump = Array.from(this.files.entries())
                .map(([k, v]) => `  ${k}: "${v}"`)
                .join("\n");
            throw new Error(
                `Expected some file to contain ${missing.map((s) => `"${s}"`).join(", ")}.\nFiles:\n${dump}`
            );
        }
        return this;
    }

    public assertNoFileContains(...substrings: string[]): this {
        const offenders: { path: string; substring: string }[] = [];
        for (const [path, content] of this.files) {
            for (const s of substrings) {
                if (content.includes(s)) {
                    offenders.push({ path, substring: s });
                }
            }
        }
        if (offenders.length > 0) {
            const dump = Array.from(this.files.entries())
                .map(([k, v]) => `  ${k}: "${v}"`)
                .join("\n");
            throw new Error(
                `Expected no file to contain ${substrings.map((s) => `"${s}"`).join(", ")}, but found ${offenders.map((o) => `"${o.substring}" in "${o.path}"`).join(", ")}.\nFiles:\n${dump}`
            );
        }
        return this;
    }

    public assertSubstringCount(
        path: string,
        substring: string,
        expected: number
    ): this {
        this.assertFileExists(path);
        const content = this.files.get(path) ?? "";
        const actual = content.split(substring).length - 1;
        if (actual !== expected) {
            throw new Error(
                `Expected "${substring}" to appear ${expected} time(s) in "${path}", found ${actual}. Content: "${content}"`
            );
        }
        return this;
    }

    public assertContentInAtMostOneFile(substring: string): this {
        const matches = Array.from(this.files.entries()).filter(([, content]) =>
            content.includes(substring)
        );
        if (matches.length > 1) {
            const dump = Array.from(this.files.entries())
                .map(([k, v]) => `  ${k}: "${v}"`)
                .join("\n");
            throw new Error(
                `Expected "${substring}" in at most 1 file, found in ${matches.length}: [${matches.map(([p]) => p).join(", ")}].\nFiles:\n${dump}`
            );
        }
        return this;
    }

    public ifFileExists(path: string, fn: (state: this) => void): this {
        if (this.files.has(path)) {
            fn(this);
        }
        return this;
    }

    public getContent(path: string): string {
        return this.files.get(path) ?? "";
    }
}
