import { E2EEError } from "./errors";
import type { E2EEProtocolController, E2EEProtocolControllerOptions } from "./protocol";

const LIBSIGNAL_PACKAGE = "@signalapp/libsignal-client";

export interface LibsignalCapabilityReport {
  packageName: string;
  available: boolean;
  detectedAt: string;
  version?: string;
  reason?: string;
}

export type ProtocolControllerFactory = (input: {
  userId: string;
  deviceId?: string;
  options?: E2EEProtocolControllerOptions;
}) => Promise<E2EEProtocolController>;

export interface SignalProtocolAdapter {
  readonly provider: "libsignal" | "webcrypto-ratchet";
  readonly available: boolean;
  readonly report: LibsignalCapabilityReport;
  createController: ProtocolControllerFactory;
}

export async function detectLibsignalCapability(): Promise<LibsignalCapabilityReport> {
  const detectedAt = new Date().toISOString();
  try {
    const moduleName = LIBSIGNAL_PACKAGE;
    const libsignalModule = await import(/* @vite-ignore */ moduleName);
    const maybeVersion = typeof libsignalModule?.version === "string"
      ? libsignalModule.version
      : typeof libsignalModule?.default?.version === "string"
        ? libsignalModule.default.version
        : undefined;

    return {
      packageName: LIBSIGNAL_PACKAGE,
      available: true,
      detectedAt,
      version: maybeVersion,
    };
  } catch (error) {
    return {
      packageName: LIBSIGNAL_PACKAGE,
      available: false,
      detectedAt,
      reason: error instanceof Error ? error.message : "libsignal package is not installed.",
    };
  }
}

export async function createSignalProtocolAdapter(
  fallbackFactory: ProtocolControllerFactory,
): Promise<SignalProtocolAdapter> {
  const report = await detectLibsignalCapability();
  if (!report.available) {
    return {
      provider: "webcrypto-ratchet",
      available: true,
      report,
      createController: fallbackFactory,
    };
  }

  return {
    provider: "libsignal",
    available: true,
    report,
    createController: (...args) => {
      // Placeholder for production migration: keeps call sites stable while libsignal bindings are wired.
      return fallbackFactory(...args);
    },
  };
}

export function assertLibsignalAvailable(report: LibsignalCapabilityReport): void {
  if (!report.available) {
    throw new E2EEError(
      "unsupported_runtime",
      `libsignal integration is unavailable (${report.packageName}). ${report.reason ?? "Unknown reason."}`,
    );
  }
}
