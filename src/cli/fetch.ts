import { getAddress } from "ethers";

import { resolveNetwork, rpcUrlFor } from "./networks.js";
import {
  getContractCreation,
  getSourceCode,
  getTransaction,
} from "./etherscan.js";
import { getCode } from "./rpc.js";
import { predictAddress, recoverDeployment } from "./deployment.js";
import { Asset, Create2Deployment } from "./artifact.js";

export interface FetchedMastercopy {
  assets: Map<string, Asset>;
  errors: string[];
}

/**
 * Fetch an asset (and, recursively, every library it links) from a block
 * explorer.
 */
export async function fetchMastercopy({
  network,
  address,
  apiKey,
}: {
  network: string | number;
  address: string;
  apiKey?: string;
}): Promise<FetchedMastercopy | undefined> {
  const net = resolveNetwork(network);
  const visited = new Map<string, Asset>();
  const errors: string[] = [];
  const root = await fetchAsset({
    address,
    networkName: net.name,
    apiKey,
    visited,
    errors,
  });
  return root && { assets: visited, errors };
}

async function fetchAsset({
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
  visited: Map<string, Asset>;
  errors: string[];
}): Promise<Asset | undefined> {
  const key = getAddress(address).toLowerCase();
  const existing = visited.get(key);
  if (existing) return existing;

  const source = await getSourceCode({ address, network: networkName, apiKey });
  if (!source) return undefined;
  const name = nameHint || source.contractName;

  // Record the asset as soon as ABI and source are in hand — before recursing,
  // so shared libraries dedupe correctly, and before deployment recovery, so a
  // failure there yields a partial asset rather than losing the ABI.
  const asset: Asset = {
    name,
    address: getAddress(address),
    abi: source.abi,
    sourceCode: {
      contractName: source.contractName,
      sourceName: source.sourceName,
      compilerVersion: source.compilerVersion,
      constructorArguments: source.constructorArguments,
      input: source.compilerInput,
    },
  };
  visited.set(key, asset);

  try {
    asset.deployment = await recoverCreate2Deployment({
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
      const library = await fetchAsset({
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

  return asset;
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
  const recovered = tx && recoverDeployment(tx);
  if (!recovered) {
    throw new Error(
      `${name} @ ${address} was not deployed via a known singleton factory.`
    );
  }

  const { factory, creationBytecode, salt } = recovered;

  // Sanity Check
  const predicted = predictAddress({ factory, salt, creationBytecode });
  if (predicted.toLowerCase() !== key) {
    throw new Error(
      `${name} @ ${address}: recovered creation bytecode reproduces ` +
        `${predicted}, not the on-chain address. Refusing to write.`
    );
  }

  const bytecode = await getCode(
    rpcUrlFor(resolveNetwork(networkName)),
    address
  );

  return {
    address: predicted,
    factory,
    salt,
    creationBytecode,
    bytecode,
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
