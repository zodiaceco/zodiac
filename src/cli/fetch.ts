import { getAddress } from "ethers";

import { resolveNetwork, rpcUrlFor } from "./networks.js";
import {
  getContractCreation,
  getSourceCode,
  getTransaction,
} from "./etherscan.js";
import { getCode } from "./rpc.js";
import { predictAddress, decodeFactoryCall } from "./create2.js";
import { ArtifactContract, Create2Deployment } from "./artifact.js";

export interface FetchedArtifact {
  contracts: Map<string, ArtifactContract>;
  errors: string[];
}

/**
 * Fetch a contract (and, recursively, every library it links) from a block
 * explorer.
 */
export async function fetchArtifact({
  network,
  address,
  apiKey,
}: {
  network: string | number;
  address: string;
  apiKey?: string;
}): Promise<FetchedArtifact | undefined> {
  const net = resolveNetwork(network);
  const visited = new Map<string, ArtifactContract>();
  const errors: string[] = [];
  const root = await fetchContract({
    address,
    networkName: net.name,
    apiKey,
    visited,
    errors,
  });
  return root && { contracts: visited, errors };
}

async function fetchContract({
  address,
  nameHint,
  networkName,
  apiKey,
  visited,
  errors,
}: {
  address: string;
  nameHint?: string;
  networkName: string;
  apiKey?: string;
  visited: Map<string, ArtifactContract>;
  errors: string[];
}): Promise<ArtifactContract | undefined> {
  const key = getAddress(address).toLowerCase();
  const existing = visited.get(key);
  if (existing) return existing;

  const source = await getSourceCode({ address, network: networkName, apiKey });
  if (!source) return undefined;
  const name = nameHint || source.contractName;

  // Record the contract as soon as ABI and source are in hand — before recursing,
  // so shared libraries dedupe correctly, and before deployment recovery, so a
  // failure there yields a partial contract rather than losing the ABI.
  const contract: ArtifactContract = {
    name,
    address: getAddress(address),
    abi: source.abi,
    source: {
      contractName: source.contractName,
      sourceName: source.sourceName,
      compilerVersion: source.compilerVersion,
      constructorArguments: source.constructorArguments,
      compilerInput: source.compilerInput,
    },
  };
  visited.set(key, contract);

  try {
    contract.deployment = await recoverCreate2Deployment({
      address,
      key,
      name,
      networkName,
      apiKey,
    });
  } catch (error) {
    errors.push((error as Error)?.message || String(error));
  }

  // Recurse into linked libraries.
  for (const lib of enumerateLibraries(source.compilerInput)) {
    try {
      const library = await fetchContract({
        address: lib.address,
        nameHint: lib.libraryName,
        networkName,
        apiKey,
        visited,
        errors,
      });
      if (!library) {
        errors.push(
          `${lib.libraryName} @ ${lib.address}: not verified on ${networkName}`
        );
      }
    } catch (error) {
      errors.push(
        `${lib.libraryName} @ ${lib.address}: ${
          (error as Error)?.message || String(error)
        }`
      );
    }
  }

  return contract;
}

/** Recover the reproducible factory-deployment metadata for an address. */
async function recoverCreate2Deployment({
  address,
  key,
  name,
  networkName,
  apiKey,
}: {
  address: string;
  key: string;
  name: string;
  networkName: string;
  apiKey?: string;
}): Promise<Create2Deployment> {
  const creation = await getContractCreation({
    address,
    network: networkName,
    apiKey,
  });
  const tx = creation?.txHash
    ? await getTransaction({
        txHash: creation.txHash,
        network: networkName,
      })
    : undefined;
  const recovered = tx && decodeFactoryCall(tx);
  if (!recovered) {
    throw new Error(
      `${name} @ ${address} was not deployed via a known singleton factory.`
    );
  }

  const { factory, initCode, salt } = recovered;

  // Sanity Check
  const predicted = predictAddress({ factory, salt, initCode });
  if (predicted.toLowerCase() !== key) {
    throw new Error(
      `${name} @ ${address}: recovered init code reproduces ` +
        `${predicted}, not the on-chain address. Refusing to write.`
    );
  }

  const runtimeCode = await getCode(
    rpcUrlFor(resolveNetwork(networkName)),
    address
  );

  return {
    address: predicted,
    factory,
    salt,
    initCode,
    runtimeCode,
  };
}

/**
 * The libraries linked in `settings.libraries` of a compiler input.
 * Shape: `settings.libraries = { [sourceName]: { [libName]: address } }`.
 * */
function enumerateLibraries(
  input: any
): { sourceName: string; libraryName: string; address: string }[] {
  const libraries = input?.settings?.libraries || {};
  const out: { sourceName: string; libraryName: string; address: string }[] =
    [];
  for (const sourceName of Object.keys(libraries)) {
    for (const libraryName of Object.keys(libraries[sourceName] || {})) {
      const address = libraries[sourceName][libraryName];
      if (address) out.push({ sourceName, libraryName, address });
    }
  }
  return out;
}
