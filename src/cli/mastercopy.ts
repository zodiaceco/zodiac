import { CanonicalAddresses, MastercopyName } from "../sdk/contracts.js";

/** One registry entry: a known contract at one version. */
export interface Mastercopy {
  name: MastercopyName;
  version: string;
  address: string;
}

export function resolveMastercopy(name: string, version: string): Mastercopy {
  const resolved = resolveName(name);
  const addresses: Record<string, string> = CanonicalAddresses[resolved];
  const address = addresses[version];
  if (!address) {
    throw new Error(
      version in addresses
        ? `${resolved}@${version} has no canonical address on record`
        : `Unknown version "${version}". Known versions of ${resolved}: ${
            knownVersions(resolved).join(", ") || "(none)"
          }`
    );
  }
  return { name: resolved, version, address };
}

export function knownVersions(name: string): string[] {
  const addresses: Record<string, string> =
    CanonicalAddresses[resolveName(name)];
  return Object.keys(addresses).filter((version) => addresses[version]);
}

/** The canonical address of `name@version`, for a name read from disk. */
export function canonicalAddress(name: string, version: string): string {
  const versions: Record<string, string> | undefined =
    CanonicalAddresses[name as keyof typeof CanonicalAddresses];
  const address = versions?.[version];
  if (!address) {
    throw new Error(`${name}@${version} has no canonical address`);
  }
  return address;
}

function resolveName(name: string): MastercopyName {
  const knownNames = Object.values(MastercopyName);

  const resolved = knownNames.find(
    (known) => known.toLowerCase() === name.toLowerCase()
  );
  if (!resolved) {
    throw new Error(
      `Unknown contract "${name}". Known contracts: ${knownNames.join(", ")}`
    );
  }
  return resolved;
}
