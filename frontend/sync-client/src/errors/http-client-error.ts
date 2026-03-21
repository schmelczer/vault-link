export class HttpClientError extends Error {
    public readonly status: number;
    public constructor(status: number, message: string) {
        super(message);
        this.name = "HttpClientError";
        this.status = status;
    }
}
