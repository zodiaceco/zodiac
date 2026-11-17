import { ArtifactContract, readArtifact, VerifiedSource } from "../artifact.js";
import {
  checkVerificationStatus,
  getSourceCode,
  verifySourceCode,
} from "../etherscan.js";
import * as sourcify from "../sourcify.js";
import { getCode } from "../rpc.js";
import { MatrixTask, printLine, runMatrixCommand } from "./_matrix.js";
import { NetworkConfig } from "../networks.js";
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
    const explorers = await explorersFor(network);
    let firstError: unknown;
    for (const contract of verifiableContracts(mastercopy)) {
      for (const explorer of explorers) {
        try {
          if (!(await explorer.isVerified(contract))) return "pending";
        } catch (error) {
          if (explorer.primary) firstError ??= error;
        }
      }
    }
    if (firstError) throw firstError;
    return "done";
  },

  async apply(mastercopy, network) {
    const explorers = await explorersFor(network);
    // The primary explorer decides the outcome; a failure on a secondary one
    // is reported and left for the next run.
    const attempt = async <T>(
      explorer: Explorer,
      contract: ArtifactContract,
      action: () => Promise<T>
    ): Promise<T | undefined> => {
      try {
        return await action();
      } catch (error) {
        const reason = `${contract.name}: ${(error as Error).message}`;
        if (explorer.primary) throw new Error(reason);
        printLine(
          `${WARNING} ${mastercopy.name}@${mastercopy.version} not verified ` +
            `on ${explorer.name} for ${network.name}: ${reason}`
        );
      }
    };

    for (const contract of verifiableContracts(mastercopy)) {
      const unverified: Explorer[] = [];
      for (const explorer of explorers) {
        const verified = await attempt(explorer, contract, () =>
          explorer.isVerified(contract)
        );
        if (verified === false) unverified.push(explorer);
      }
      if (unverified.length === 0) continue;

      const code = await getCode(network, contract.address);
      if (code === "0x") throw new Error(`${contract.name}: not deployed`);

      for (const explorer of unverified) {
        await attempt(explorer, contract, () => explorer.verify(contract));
      }
    }
  },
};

const WARNING = "\u001b[33m!\u001b[0m";

interface Explorer {
  name: string;
  /** Whether a failure here fails the network. */
  primary: boolean;
  isVerified(contract: ArtifactContract): Promise<boolean>;
  verify(contract: ArtifactContract): Promise<void>;
}

/**
 * Where a network's contracts get verified: its Etherscan-compatible explorer,
 * and Sourcify where Sourcify supports the chain. Neither imports from the
 * other, and Blockscout explorers read from Sourcify, so both are submitted to.
 * The first one is primary.
 */
async function explorersFor(network: NetworkConfig): Promise<Explorer[]> {
  const explorers: Omit<Explorer, "primary">[] = [];

  if (network.etherscanApiUrl) {
    explorers.push({
      name: "Etherscan",
      isVerified: async (contract) =>
        (await getSourceCode({
          address: contract.address,
          network: network.name,
        })) !== undefined,
      verify: (contract) => verifyOnEtherscan(network, contract),
    });
  }

  // When the chain list can't be read, keep Sourcify in: its requests will
  // report the outage.
  const onSourcify = await sourcify.isSupported(network).catch(() => true);
  if (onSourcify) {
    explorers.push({
      name: "Sourcify",
      isVerified: (contract) =>
        sourcify.isVerified({ address: contract.address, network }),
      verify: ({ address, source }) =>
        sourcify.verify({
          address,
          network,
          compilerInput: source.compilerInput,
          compilerVersion: source.compilerVersion,
          contractIdentifier: `${source.sourceName}:${source.contractName}`,
        }),
    });
  }

  if (explorers.length === 0) throw new Error("no supported explorer");
  return explorers.map((explorer, index) => ({
    ...explorer,
    primary: index === 0,
  }));
}

function verifiableContracts(mastercopy: Mastercopy): ArtifactContract[] {
  const artifact = readArtifact(mastercopy.name, mastercopy.version);
  if (!artifact) throw new Error("no local artifact");
  return [...artifact.libraries, artifact.main];
}

async function verifyOnEtherscan(
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
  if (!result.toLowerCase().includes("pass")) throw new Error(result);
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
