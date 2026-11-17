import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import path from "path";
import { cwd } from "process";

import { getAddress } from "ethers";

import { CanonicalAddresses } from "../sdk/contracts.js";
import { predictAddress } from "./deployment.js";

/**
 * Artifacts written for a single asset (the main contract or a linked library)
 * under `mastercopies/<module>/<version>/<asset>/`. Each field maps to one file:
 * `abi.json`, `sourcecode.json`, `bytecode.json`.
 */

/** Contents of `sourcecode.json`. */
export interface SourceCodeFile {
  contractName: string;
  sourceName: string;
  compilerVersion: string;
  /** abi-encoded constructor arguments (hex, no leading 0x). */
  constructorArguments?: string;
  /** Solidity standard-JSON compiler input (verified source + settings). */
  input: any;
}

/**
 * A CREATE2 deployment through a singleton factory: relaying
 * `creationBytecode` with `salt` to `factory` puts `bytecode` at `address`,
 * on any chain. Stored in `bytecode.json`.
 */
export interface Create2Deployment {
  /** CREATE2 address. Reproduces on every chain from factory + salt + creationBytecode. */
  address: string;
  /** CREATE2 singleton factory the creation bytecode was relayed through. */
  factory: string;
  /** Salt recovered from the singleton-factory deployment transaction. */
  salt: string;
  /**
   * Creation bytecode: the exact init code (creation code + abi-encoded
   * constructor args, with any libraries linked). Relay this, with the same
   * factory + salt, to redeploy at `address` on any other network.
   */
  creationBytecode: string;
  /**
   * Deployed (runtime) bytecode stored at `address` (`eth_getCode`). Not used
   * to deploy — it's the on-chain identity, for comparison/verification.
   */
  bytecode: string;
}

/** A single fetched asset: one folder, three files. */
export interface Asset {
  /** Folder name: the main contract name or a linked-library name. */
  name: string;
  address: string;
  abi: any;
  sourceCode: SourceCodeFile;
  /**
   * Absent on a partial fetch: the ABI and source were verified but the
   * deployment couldn't be recovered from a known singleton factory. Such
   * assets' `bytecode.json` records only their `address`.
   */
  deployment?: Create2Deployment;
}

/**
 * The on-disk layout:
 *
 *   mastercopies/<module>/<version>/<asset>/abi.json
 *   mastercopies/<module>/<version>/<asset>/sourcecode.json
 *   mastercopies/<module>/<version>/<asset>/bytecode.json
 *
 * where <asset> is the main contract name or a linked-library name. Every
 * asset has a `bytecode.json` recording its address; a partial asset (no
 * recoverable factory deployment) records nothing else in it.
 */
export function defaultMastercopiesDir(): string {
  return path.join(cwd(), "mastercopies");
}

/** One `name@version`: the contract at the canonical address and its libraries. */
interface Artifact {
  main: Asset;
  /** Linked libraries, sorted by name. */
  libraries: Asset[];
}

const sameAddress = (a: string, b: string) => getAddress(a) === getAddress(b);

const subdirectories = (dir: string): string[] =>
  !existsSync(dir)
    ? []
    : readdirSync(dir, { withFileTypes: true })
        // Dot-prefixed folders are writeArtifact's staging leftovers.
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort();

function canonicalAddress(name: string, version: string): string {
  const versions: Record<string, string> | undefined =
    CanonicalAddresses[name as keyof typeof CanonicalAddresses];
  const address = versions?.[version];
  if (!address) {
    throw new Error(`${name}@${version} has no canonical address`);
  }
  return address;
}

/** Every `name@version` present on disk, sorted. */
export function listArtifacts(
  mastercopiesDir = defaultMastercopiesDir()
): { name: string; version: string }[] {
  return subdirectories(mastercopiesDir).flatMap((name) =>
    subdirectories(path.join(mastercopiesDir, name)).map((version) => ({
      name,
      version,
    }))
  );
}

/**
 * Load the artifact for `name@version`, or undefined when none is on disk.
 *
 * Nothing on disk is taken on trust: each asset's address is recomputed from
 * its factory, salt and creation bytecode, and the main asset must sit at the
 * canonical address. A mismatch throws.
 */
export function readArtifact(
  name: string,
  version: string,
  mastercopiesDir = defaultMastercopiesDir()
): Artifact | undefined {
  const dir = path.join(mastercopiesDir, name, version);
  if (!existsSync(dir)) return undefined;
  return loadArtifact(dir, name, version);
}

/**
 * Write the artifact for `name@version`, replacing any existing one.
 *
 * The assets are written to a staging folder, validated the same way
 * `readArtifact` does, and only then renamed into place, so a failure leaves
 * the previous files untouched.
 */
export function writeArtifact(
  name: string,
  version: string,
  assets: Iterable<Asset>,
  mastercopiesDir = defaultMastercopiesDir()
): Artifact {
  const dir = path.join(mastercopiesDir, name, version);
  const staging = path.join(mastercopiesDir, name, `.${version}.staging`);
  const previous = path.join(mastercopiesDir, name, `.${version}.previous`);

  rmSync(staging, { recursive: true, force: true });
  let artifact: Artifact;
  try {
    for (const asset of assets) writeAsset(staging, asset);
    artifact = loadArtifact(staging, name, version);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  // A directory can't be renamed over a non-empty one, so move the old one
  // aside first and put it back if the swap fails.
  rmSync(previous, { recursive: true, force: true });
  const replacing = existsSync(dir);
  if (replacing) renameSync(dir, previous);
  try {
    renameSync(staging, dir);
  } catch (error) {
    if (replacing) renameSync(previous, dir);
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  rmSync(previous, { recursive: true, force: true });

  return artifact;
}

function loadArtifact(dir: string, name: string, version: string): Artifact {
  const id = `${name}@${version}`;
  const canonical = canonicalAddress(name, version);
  const assets = subdirectories(dir).map((assetName) =>
    readAsset(path.join(dir, assetName), `${id} ${assetName}`)
  );

  const main = assets.find((asset) => sameAddress(asset.address, canonical));
  if (!main) {
    throw new Error(
      `${id}: no asset at the canonical address ${canonical} (found ${
        assets.map((a) => `${a.name} @ ${a.address}`).join(", ") || "none"
      })`
    );
  }
  return { main, libraries: assets.filter((asset) => asset !== main) };
}

function readAsset(dir: string, label: string): Asset {
  const read = (file: string) => {
    const filePath = path.join(dir, file);
    if (!existsSync(filePath)) throw new Error(`${label}: missing ${file}`);
    return JSON.parse(readFileSync(filePath, "utf8"));
  };

  const file = read("bytecode.json") as Partial<Create2Deployment>;
  const { address, factory, salt, creationBytecode, bytecode } = file;
  if (!address) throw new Error(`${label}: bytecode.json has no address`);

  const asset: Asset = {
    name: path.basename(dir),
    address,
    abi: read("abi.json"),
    sourceCode: read("sourcecode.json"),
  };

  if (creationBytecode !== undefined) {
    if (!factory || !salt || !bytecode) {
      throw new Error(`${label}: bytecode.json is incomplete`);
    }
    const predicted = predictAddress({ factory, salt, creationBytecode });
    if (!sameAddress(predicted, address)) {
      throw new Error(
        `${label}: creation bytecode deploys to ${predicted}, not the recorded ${address}`
      );
    }
    asset.deployment = { address, factory, salt, creationBytecode, bytecode };
  }

  return asset;
}

function writeAsset(artifactDir: string, asset: Asset): void {
  const dir = path.join(artifactDir, asset.name);
  mkdirSync(dir, { recursive: true });

  const write = (file: string, content: unknown) =>
    writeFileSync(
      path.join(dir, file),
      JSON.stringify(content, null, 2),
      "utf8"
    );
  write("abi.json", asset.abi);
  write("sourcecode.json", asset.sourceCode);
  write("bytecode.json", asset.deployment ?? { address: asset.address });
}
