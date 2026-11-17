import { parseArgs } from "util";

import { NetworkConfig, resolveNetwork } from "./networks.js";

const FLAGS = {
  network: { type: "string" },
} as const;

interface CliArgs {
  positionals: string[];
  networks?: NetworkConfig[];
}

export function parseCliArgs(
  args: string[],
  allowed: (keyof typeof FLAGS)[]
): CliArgs {
  const { values, positionals } = parseArgs({
    args,
    options: Object.fromEntries(allowed.map((flag) => [flag, FLAGS[flag]])),
    allowPositionals: true,
  }) as {
    values: { network?: string };
    positionals: string[];
  };

  const networks = values.network
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map(resolveNetwork);
  if (networks?.length === 0) {
    throw new Error("--network needs at least one network name or chain id");
  }

  return {
    positionals,
    networks: networks && [...new Set(networks)],
  };
}
