export function randomCasing(str: string, random: () => number = Math.random): string {
    const chars = str.split("");
    const randomCasedChars = chars.map((char) => {
        if (random() < 0.5) {
            return char.toUpperCase();
        }
        return char.toLowerCase();
    });
    return randomCasedChars.join("");
}
