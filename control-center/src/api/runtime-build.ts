export interface RuntimeBuildInfo {
  schemaVersion: 1;
  buildId: string;
  generatedAt: string;
  sourceFileCount: number;
}

export interface RuntimeBuildStatus {
  status: "ok" | "degraded";
  runtimeMatchesDisk: boolean | null;
  runtimeBuildId: string | null;
  artifactBuildId: string | null;
  generatedAt: string | null;
  verification: "matched" | "mismatch" | "missing" | "development";
}

export function parseRuntimeBuildInfo(raw: string | null | undefined): RuntimeBuildInfo | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.buildId !== "string" ||
      !/^sha256:[a-f0-9]{64}$/i.test(value.buildId) ||
      typeof value.generatedAt !== "string" ||
      !Number.isInteger(value.sourceFileCount) ||
      Number(value.sourceFileCount) < 1
    ) return null;
    return {
      schemaVersion: 1,
      buildId: value.buildId,
      generatedAt: value.generatedAt,
      sourceFileCount: Number(value.sourceFileCount)
    };
  } catch {
    return null;
  }
}

export function compareRuntimeBuilds(
  runtime: RuntimeBuildInfo | null,
  artifact: RuntimeBuildInfo | null,
  nodeEnv: string
): RuntimeBuildStatus {
  const matches = Boolean(runtime && artifact && runtime.buildId === artifact.buildId);
  if (matches) {
    return {
      status: "ok",
      runtimeMatchesDisk: true,
      runtimeBuildId: runtime!.buildId,
      artifactBuildId: artifact!.buildId,
      generatedAt: artifact!.generatedAt,
      verification: "matched"
    };
  }

  if (nodeEnv !== "production") {
    return {
      status: "ok",
      runtimeMatchesDisk: null,
      runtimeBuildId: runtime?.buildId ?? null,
      artifactBuildId: artifact?.buildId ?? null,
      generatedAt: artifact?.generatedAt ?? null,
      verification: "development"
    };
  }

  return {
    status: "degraded",
    runtimeMatchesDisk: false,
    runtimeBuildId: runtime?.buildId ?? null,
    artifactBuildId: artifact?.buildId ?? null,
    generatedAt: artifact?.generatedAt ?? null,
    verification: runtime && artifact ? "mismatch" : "missing"
  };
}
