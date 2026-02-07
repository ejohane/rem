import type { ServiceStatus } from "@rem/shared";

export const coreVersion = "0.0.0";

export function getCoreStatus(): ServiceStatus {
  return {
    ok: true,
    timestamp: new Date().toISOString(),
  };
}
