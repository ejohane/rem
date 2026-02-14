#!/usr/bin/env bun
import { createServer } from "node:net";

const defaultApiHost = "127.0.0.1";
const defaultUiHost = "127.0.0.1";
const defaultApiPort = 8787;
const defaultUiPort = 5173;
const maxPreferredPortScan = 50;
const maxEphemeralAttempts = 20;

function parsePreferredPort(
  rawValue: string | undefined,
  fallback: number,
  envName: string,
): number {
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
    process.stderr.write(`warning: ignoring invalid ${envName}=${rawValue}; using ${fallback}\n`);
    return fallback;
  }

  return parsed;
}

function canBindPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    let finalized = false;

    const finalize = (result: boolean): void => {
      if (finalized) {
        return;
      }
      finalized = true;
      resolve(result);
    };

    server.once("error", () => {
      finalize(false);
    });

    server.listen(port, host, () => {
      server.close(() => {
        finalize(true);
      });
    });
  });
}

function claimEphemeralPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", (error) => {
      reject(error);
    });

    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to determine ephemeral port")));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function findOpenPort(
  host: string,
  preferredPort: number,
  excludedPorts: Set<number> = new Set(),
): Promise<number> {
  for (let offset = 0; offset < maxPreferredPortScan; offset += 1) {
    const candidate = preferredPort + offset;
    if (candidate > 65535) {
      break;
    }
    if (excludedPorts.has(candidate)) {
      continue;
    }
    if (await canBindPort(host, candidate)) {
      return candidate;
    }
  }

  for (let attempt = 0; attempt < maxEphemeralAttempts; attempt += 1) {
    const candidate = await claimEphemeralPort(host);
    if (!excludedPorts.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Unable to find open port on host ${host}`);
}

async function main(): Promise<void> {
  const apiHost = process.env.REM_API_HOST?.trim() || defaultApiHost;
  const uiHost = process.env.REM_UI_HOST?.trim() || defaultUiHost;
  const preferredApiPort = parsePreferredPort(
    process.env.REM_API_PORT,
    defaultApiPort,
    "REM_API_PORT",
  );
  const preferredUiPort = parsePreferredPort(process.env.REM_UI_PORT, defaultUiPort, "REM_UI_PORT");

  const apiPort = await findOpenPort(apiHost, preferredApiPort);
  const uiPort = await findOpenPort(uiHost, preferredUiPort, new Set([apiPort]));
  const apiBaseUrl = `http://${apiHost}:${apiPort}`;
  const uiBaseUrl = `http://${uiHost}:${uiPort}`;

  process.stdout.write(`dev ports selected api=${apiPort} ui=${uiPort}\n`);
  process.stdout.write(`ui: ${uiBaseUrl}\n`);
  process.stdout.write(`api: ${apiBaseUrl}\n`);

  const child = Bun.spawn(["bun", "run", "dev:stack"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      REM_API_HOST: apiHost,
      REM_API_PORT: String(apiPort),
      REM_UI_HOST: uiHost,
      REM_UI_PORT: String(uiPort),
      VITE_REM_API_BASE_URL: apiBaseUrl,
    },
  });

  const handleInterrupt = () => {
    child.kill();
  };

  process.on("SIGINT", handleInterrupt);
  process.on("SIGTERM", handleInterrupt);

  const exitCode = await child.exited;

  process.off("SIGINT", handleInterrupt);
  process.off("SIGTERM", handleInterrupt);

  process.exit(exitCode);
}

main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
