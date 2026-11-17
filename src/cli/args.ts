import { parseArgs } from "util";

import { CanonicalAddresses, KnownContracts } from "../sdk/contracts.js";
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

export interface Mastercopy {
  contractName: KnownContracts;
  version: string;
  address: string;
}

export function resolveMastercopy(name: string, version: string): Mastercopy {
  const contractName = resolveName(name);
  const addresses: Record<string, string> = CanonicalAddresses[contractName];
  const address = addresses[version];
  if (!address) {
    throw new Error(
      version in addresses
        ? `${contractName}@${version} has no canonical address on record`
        : `Unknown version "${version}". Known versions of ${contractName}: ${
            knownVersions(contractName).join(", ") || "(none)"
          }`
    );
  }
  return { contractName, version, address };
}

export function knownVersions(name: string): string[] {
  const addresses: Record<string, string> =
    CanonicalAddresses[resolveName(name)];
  return Object.keys(addresses).filter((version) => addresses[version]);
}

function resolveName(name: string): KnownContracts {
  const knownContracts = Object.values(KnownContracts);

  const contractName = knownContracts.find(
    (known) => known.toLowerCase() === name.toLowerCase()
  );
  if (!contractName) {
    throw new Error(
      `Unknown contract "${name}". Known contracts: ${knownContracts.join(", ")}`
    );
  }
  return contractName;
}
