import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const defaultUiHost = "127.0.0.1";
const defaultUiPort = 5173;

function resolveUiPort(rawPort: string | undefined): number {
  if (!rawPort) {
    return defaultUiPort;
  }

  const parsed = Number.parseInt(rawPort, 10);
  if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
    return defaultUiPort;
  }

  return parsed;
}

const devHost = process.env.REM_UI_HOST ?? defaultUiHost;
const devPort = resolveUiPort(process.env.REM_UI_PORT);

export default defineConfig({
  plugins: [react()],
  server: {
    host: devHost,
    port: devPort,
  },
});
