/**
 * A class that tracks the minimum covered value in a sequence of numbers.
 * It keeps track of a minimum value based on the seen values.
 *
 * It expects integers slightly out of order and makes sure that the value of `min` is
 * always the minimum of the seen values. This is done with bounded memory usage.
 *
 * @example
 * ```typescript
 * const covered = new MinCovered(0);
 * covered.add(2); // seenValues = [2], min = 0
 * covered.add(1); // seenValues = [], min = 2
 * covered.min; // returns 2
 * ```
 */
export class MinCovered {
    private seenValues: number[] = [];

    public constructor(private minValue: number) {}

    public get min(): number {
        return this.minValue;
    }

    public set min(value: number) {
        this.minValue = Math.max(value, this.minValue);
        this.seenValues = this.seenValues.filter((v) => v > this.minValue);
        this.advanceMinWhilePossible();
    }

    public add(value: number | undefined): void {
        if (value === undefined || value < this.minValue) {
            return;
        }

        let i = 0;
        while (i < this.seenValues.length && this.seenValues[i] < value) {
            i++;
        }

        if (i === this.seenValues.length) {
            this.seenValues.push(value);
        } else if (this.seenValues[i] === value) {
            return;
        } else {
            this.seenValues.splice(i, 0, value);
        }

        this.advanceMinWhilePossible();
    }

    public reset(minValue?: number): void {
        this.minValue = minValue ?? 0;
        this.seenValues = [];
    }

    private advanceMinWhilePossible(): void {
        while (
            this.seenValues.length > 0 &&
            this.seenValues[0] === this.minValue + 1
        ) {
            this.seenValues.shift();
            this.minValue++;
        }
    }
}
