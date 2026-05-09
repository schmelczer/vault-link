#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Healthcheck script for Docker container
 * Checks if the sync client is connected to the server
 */

import * as fs from "fs";
import type { NetworkConnectionStatus } from "sync-client";

function isHealthStatus(value: unknown): value is NetworkConnectionStatus {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    return (
        "isSuccessful" in value &&
        typeof value.isSuccessful === "boolean" &&
        "isWebSocketConnected" in value &&
        typeof value.isWebSocketConnected === "boolean" &&
        "serverMessage" in value &&
        typeof value.serverMessage === "string"
    );
}

function main(): void {
    if (process.argv.length < 3) {
        console.error("Usage: healthcheck <path-to-health-file>");
        process.exit(1);
    }
    const [, , healthFile] = process.argv;

    try {
        // Check if health file exists
        if (!fs.existsSync(healthFile)) {
            console.error(`Health file does not exist: ${healthFile}`);
            process.exit(1);
        }

        // Read and parse health status
        const content = fs.readFileSync(healthFile, "utf-8");
        const parsed: unknown = JSON.parse(content);

        // Validate the parsed object using type guard
        if (!isHealthStatus(parsed)) {
            throw new Error("Invalid health status format");
        }

        const status = parsed;

        if (!status.isSuccessful || !status.isWebSocketConnected) {
            console.error("Not connected to server: " + status.serverMessage);
            process.exit(1);
        }

        console.log("Healthy: Connected to server");
        process.exit(0);
    } catch (error) {
        console.error(
            `Health check failed: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exit(1);
    }
}

main();
