import { isFileTypeMergable } from "./is-file-type-mergable";

describe("isFileTypeMergable", () => {
	it("should return true for .md files", () => {
		expect(isFileTypeMergable(".md")).toBe(true);
		expect(isFileTypeMergable("hi.md")).toBe(true);
		expect(isFileTypeMergable("my/path/to/my/document.md")).toBe(true);
	});

	it("should return true for .txt files", () => {
		expect(isFileTypeMergable(".txt")).toBe(true);
		expect(isFileTypeMergable("hi.txt")).toBe(true);
		expect(isFileTypeMergable("my/path/to/my/document.txt")).toBe(true);
	});

	it("should be case insensitive", () => {
		expect(isFileTypeMergable("hi.MD")).toBe(true);
		expect(isFileTypeMergable("my/path/to/my/DOCUMENT.MD")).toBe(true);
		expect(isFileTypeMergable("hi.TXT")).toBe(true);
		expect(isFileTypeMergable("my/path/to/my/DOCUMENT.TXT")).toBe(true);
	});

	it("should return false for non-mergable file types", () => {
		expect(isFileTypeMergable(".json")).toBe(false);
		expect(isFileTypeMergable("HELLO.JSON")).toBe(false);
		expect(isFileTypeMergable("my/config.yml")).toBe(false);
	});
});
