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

import { type Address, type Hex, getAddress } from "viem";

import { predictAddress } from "./create2.js";
import { canonicalAddress } from "./mastercopy.js";

/**
 * The on-disk layout:
 *
 *   mastercopies/<name>/<version>/<contract>/abi.json
 *   mastercopies/<name>/<version>/<contract>/source.json
 *   mastercopies/<name>/<version>/<contract>/deployment.json
 *
 * where <contract> is the main contract name or a linked-library name. Every
 * contract has a `deployment.json` recording its address; a partial one (no
 * recoverable factory deployment) records nothing else in it.
 */

/** Contents of `source.json`: what an explorer needs to verify the contract. */
export interface VerifiedSource {
  contractName: string;
  sourceName: string;
  compilerVersion: string;
  /** abi-encoded constructor arguments (hex, no leading 0x). */
  constructorArguments?: string;
  /** Solidity standard-JSON compiler input (verified source + settings). */
  compilerInput: any;
}

/**
 * A CREATE2 deployment through a singleton factory: relaying `initCode` with
 * `salt` to `factory` puts `runtimeCode` at `address`, on any chain. Stored
 * in `deployment.json`.
 */
export interface Create2Deployment {
  /** CREATE2 address. Reproduces on every chain from factory + salt + initCode. */
  address: Address;
  /** CREATE2 singleton factory the init code was relayed through. */
  factory: Address;
  /** Salt recovered from the singleton-factory deployment transaction. */
  salt: Hex;
  /**
   * The exact init code (creation code + abi-encoded constructor args, with
   * any libraries linked). Relay this, with the same factory + salt, to
   * redeploy at `address` on any other network.
   */
  initCode: Hex;
  /**
   * Runtime code stored at `address` (`eth_getCode`). Not used to deploy —
   * it's the on-chain identity, for comparison/verification.
   */
  runtimeCode: Hex;
}

/** One contract of an artifact: one folder, three files. */
export interface ArtifactContract {
  /** Folder name: the main contract name or a linked-library name. */
  name: string;
  address: Address;
  abi: any;
  source: VerifiedSource;
  /**
   * Absent on a partial fetch: the ABI and source were verified but the
   * deployment couldn't be recovered from a known singleton factory. Such a
   * contract's `deployment.json` records only its `address`.
   */
  deployment?: Create2Deployment;
}

export function defaultMastercopiesDir(): string {
  return path.join(cwd(), "mastercopies");
}

/** One `name@version`: the contract at the canonical address and its libraries. */
interface Artifact {
  main: ArtifactContract;
  /** Linked libraries, sorted by name. */
  libraries: ArtifactContract[];
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
 * Nothing on disk is taken on trust: each contract's address is recomputed from
 * its factory, salt and init code, and the main contract must sit at the
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
 * The contracts are written to a staging folder, validated the same way
 * `readArtifact` does, and only then renamed into place, so a failure leaves
 * the previous files untouched.
 */
export function writeArtifact(
  name: string,
  version: string,
  contracts: Iterable<ArtifactContract>,
  mastercopiesDir = defaultMastercopiesDir()
): Artifact {
  const dir = path.join(mastercopiesDir, name, version);
  const staging = path.join(mastercopiesDir, name, `.${version}.staging`);
  const previous = path.join(mastercopiesDir, name, `.${version}.previous`);

  rmSync(staging, { recursive: true, force: true });
  let artifact: Artifact;
  try {
    for (const contract of contracts) writeContract(staging, contract);
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
  const contracts = subdirectories(dir).map((folder) =>
    readContract(path.join(dir, folder), `${id} ${folder}`)
  );

  const main = contracts.find((contract) =>
    sameAddress(contract.address, canonical)
  );
  if (!main) {
    throw new Error(
      `${id}: no contract at the canonical address ${canonical} (found ${
        contracts.map((a) => `${a.name} @ ${a.address}`).join(", ") || "none"
      })`
    );
  }
  return { main, libraries: contracts.filter((contract) => contract !== main) };
}

function readContract(dir: string, label: string): ArtifactContract {
  const read = (file: string) => {
    const filePath = path.join(dir, file);
    if (!existsSync(filePath)) throw new Error(`${label}: missing ${file}`);
    return JSON.parse(readFileSync(filePath, "utf8"));
  };

  const file = read("deployment.json") as Partial<Create2Deployment>;
  const { address, factory, salt, initCode, runtimeCode } = file;
  if (!address) throw new Error(`${label}: deployment.json has no address`);

  const contract: ArtifactContract = {
    name: path.basename(dir),
    address,
    abi: read("abi.json"),
    source: read("source.json"),
  };

  if (initCode !== undefined) {
    if (!factory || !salt || !runtimeCode) {
      throw new Error(`${label}: deployment.json is incomplete`);
    }
    const predicted = predictAddress({ factory, salt, initCode });
    if (!sameAddress(predicted, address)) {
      throw new Error(
        `${label}: init code deploys to ${predicted}, not the recorded ${address}`
      );
    }
    contract.deployment = { address, factory, salt, initCode, runtimeCode };
  }

  return contract;
}

function writeContract(artifactDir: string, contract: ArtifactContract): void {
  const dir = path.join(artifactDir, contract.name);
  mkdirSync(dir, { recursive: true });

  const write = (file: string, content: unknown) =>
    writeFileSync(
      path.join(dir, file),
      JSON.stringify(content, null, 2),
      "utf8"
    );
  write("abi.json", contract.abi);
  write("source.json", contract.source);
  write(
    "deployment.json",
    contract.deployment ?? { address: contract.address }
  );
}
