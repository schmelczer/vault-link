/**
 * Efficiently removes a specific item from an array by modifying it in place.
 * This is more efficient than using `.filter(item => item !== toRemove)` as it avoids creating a new array
 *
 * @param array The array to modify
 * @param item The item to remove
 * @returns true if the item was found and removed, false otherwise
 */
export function removeFromArray<T>(array: T[], item: T): boolean {
    const index = array.indexOf(item);
    if (index !== -1) {
        // eslint-disable-next-line no-restricted-syntax -- This is the implementation of the helper itself
        array.splice(index, 1);
        return true;
    }
    return false;
}
