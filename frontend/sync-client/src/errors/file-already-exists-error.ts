export class FileAlreadyExistsError extends Error {
    public constructor(
        message: string,
        public readonly filePath: string
    ) {
        super(message);
        this.name = "FileAlreadyExistsError";
    }
}
