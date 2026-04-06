export class HttpClientError extends Error {
    public constructor(
        public readonly statusCode: number,
        message: string
    ) {
        super(message);
        this.name = "HttpClientError";
    }
}
