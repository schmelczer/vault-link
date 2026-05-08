import * as net from "node:net";

interface PortReservation {
    port: number;
    release: () => void;
}

/**
 * Find a free port and keep it reserved until the caller explicitly releases it.
 */
export async function findFreePort(): Promise<PortReservation> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            if (addr === null || typeof addr === "string") {
                server.close();
                reject(new Error("Failed to get port from server"));
                return;
            }
            const { port } = addr;
            resolve({
                port,
                release: () => server.close()
            });
        });
        server.on("error", reject);
    });
}
