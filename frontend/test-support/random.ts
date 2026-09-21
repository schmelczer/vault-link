/** A seed controls harness choices; production UUIDs and OS scheduling remain
 * nondeterministic. The concrete action trace is the stronger replay artifact. */
export class Random {
    private state: number;
    public constructor(seed: number) {
        if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
            throw new Error("Seed must be a uint32");
        this.state = seed;
    }
    public next(): number {
        this.state = (this.state + 0x6d2b79f5) >>> 0;
        let n = this.state;
        n = Math.imul(n ^ (n >>> 15), n | 1);
        n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
        return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
    }
    public int(max: number): number {
        if (!Number.isSafeInteger(max) || max < 1)
            throw new Error("Empty random choice");
        return Math.floor(this.next() * max);
    }
    public pick<T>(values: readonly T[]): T {
        return values[this.int(values.length)];
    }
}
