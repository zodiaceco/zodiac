import { ArtifactContract, readArtifact, VerifiedSource } from "../artifact.js";
import {
  checkVerificationStatus,
  getSourceCode,
  verifySourceCode,
} from "../etherscan.js";
import { getCode } from "../rpc.js";
import { MatrixTask, runMatrixCommand } from "./_matrix.js";
import { NetworkConfig, rpcUrlFor } from "../networks.js";
import { Mastercopy } from "../mastercopy.js";

export async function run(args: string[]): Promise<void> {
  await runMatrixCommand("verify", verify, args);
}

const verify: MatrixTask = {
  legend: {
    done: "verified",
    pending: "not verified",
    unknown: "couldn't get status",
    failed: "failed verification",
  },

  async check(mastercopy, network) {
    // One unverified contract settles it, even if another couldn't be read.
    let firstError: unknown;
    for (const contract of verifiableContracts(mastercopy, network)) {
      try {
        if (!(await isVerified(contract, network))) return "pending";
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
    return "done";
  },

  async apply(mastercopy, network) {
    for (const contract of verifiableContracts(mastercopy, network)) {
      if (await isVerified(contract, network)) continue;

      const code = await getCode(rpcUrlFor(network), contract.address);
      if (code === "0x") throw new Error(`${contract.name}: not deployed`);

      await submitAndWaitForVerification(network, contract);
    }
  },
};

function verifiableContracts(
  mastercopy: Mastercopy,
  network: NetworkConfig
): ArtifactContract[] {
  if (!network.etherscanApiUrl) throw new Error("no supported explorer");

  const artifact = readArtifact(mastercopy.name, mastercopy.version);
  if (!artifact) throw new Error("no local artifact");
  return [...artifact.libraries, artifact.main];
}

async function isVerified(
  contract: ArtifactContract,
  network: NetworkConfig
): Promise<boolean> {
  const source = await getSourceCode({
    address: contract.address,
    network: network.name,
  });
  return source !== undefined;
}

async function submitAndWaitForVerification(
  network: NetworkConfig,
  contract: ArtifactContract
): Promise<void> {
  const { source } = contract;
  const guid = await verifySourceCode({
    address: contract.address,
    network: network.name,
    sourceCode: JSON.stringify(source.compilerInput),
    contractName: `${source.sourceName}:${source.contractName}`,
    compilerVersion: source.compilerVersion,
    constructorArguments: source.constructorArguments || "",
    evmVersion: evmVersionFor(source),
  });
  if (guid.toLowerCase().includes("already verified")) return;

  const result = await waitForVerification(network, guid);
  if (!result.toLowerCase().includes("pass")) {
    throw new Error(`${contract.name}: ${result}`);
  }
}

async function waitForVerification(
  network: NetworkConfig,
  guid: string
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await checkVerificationStatus({
      network: network.name,
      guid,
    });
    const lower = result.toLowerCase();
    if (lower.includes("pending") || lower.includes("queued")) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      continue;
    }
    return result;
  }
  return "verification timed out";
}

function evmVersionFor(source: VerifiedSource): string {
  const evmVersion = source.compilerInput?.settings?.evmVersion;
  return evmVersion && evmVersion !== "Default" ? evmVersion : "default";
}
