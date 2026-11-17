import { compare, satisfies, valid } from "semver";

import { ABIs } from "./abis/index.js";
import {
  CanonicalAddresses,
  FaultyAddresses,
  MastercopyName,
} from "./contracts.js";

type VersionedAbis = Record<string, readonly unknown[]>;
type VersionedAddresses = Record<string, string>;

export function getZodiacModuleAbi(
  name: MastercopyName,
  versionRange = "*"
): readonly unknown[] {
  const versions: VersionedAbis = ABIs[name];

  const version = matchingVersion(versions, versionRange);

  if (!version) {
    throw new Error(`No ABI for ${name}@${versionRange}`);
  }

  const address = (
    CanonicalAddresses as Partial<Record<MastercopyName, VersionedAddresses>>
  )[name]?.[version];

  if (!address) {
    throw new Error(`No address for ${name}@${version}`);
  }

  sanityCheckZodiacModuleAddress(address);

  return versions[version];
}

export function getZodiacModuleAddress(
  name: MastercopyName,
  versionRange = "*"
): string {
  const versions = (
    CanonicalAddresses as Partial<Record<MastercopyName, VersionedAddresses>>
  )[name];

  if (!versions) {
    throw new Error(`No address registry for ${name}`);
  }

  const version = matchingVersion(versions, versionRange, Boolean);

  if (!version) {
    throw new Error(`No address for ${name}@${versionRange}`);
  }

  sanityCheckZodiacModuleAddress(versions[version]);

  return versions[version];
}

function sanityCheckZodiacModuleAddress(address: string): void {
  const normalizedAddress = address.toLowerCase();
  const canonicalAddresses = flattenAddresses(CanonicalAddresses);
  const faultyAddresses = flattenAddresses(FaultyAddresses);

  if (!canonicalAddresses.has(normalizedAddress)) {
    throw new Error(`Unknown Zodiac module address: ${address}`);
  }

  if (faultyAddresses.has(normalizedAddress)) {
    throw new Error(`Faulty Zodiac module address: ${address}`);
  }
}

function matchingVersion<T>(
  versions: Record<string, T>,
  versionRange: string,
  predicate: (value: T) => boolean = () => true
): string | undefined {
  return Object.entries(versions)
    .filter(([, value]) => predicate(value))
    .map(([entry]) => entry)
    .sort(compare)
    .reverse()
    .find((entry) =>
      satisfies(entry, valid(versionRange) ? `=${versionRange}` : versionRange)
    );
}

function flattenAddresses(
  addresses: Partial<Record<MastercopyName, Record<string, string>>>
): Set<string> {
  return new Set(
    Object.values(addresses)
      .flatMap((versions) => Object.values(versions ?? {}))
      .filter(Boolean)
      .map((address) => address.toLowerCase())
  );
}
