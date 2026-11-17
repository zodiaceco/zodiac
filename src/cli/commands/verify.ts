import { Asset, readArtifact, SourceCodeFile } from "../artifact.js";
import {
  checkVerificationStatus,
  getSourceCode,
  verifySourceCode,
} from "../etherscan.js";
import { getCode } from "../rpc.js";
import { MatrixTask, runMatrixCommand } from "./_table.js";
import { NetworkConfig, rpcUrlFor } from "../networks.js";
import { Mastercopy } from "../args.js";

export async function run(args: string[]): Promise<void> {
  await runMatrixCommand("verify", verify, args);
}

const verify: MatrixTask = {
  legend: {
    ok: "verified",
    missing: "not verified",
    unknown: "couldn't get status",
    failed: "failed verification",
  },

  async check(mastercopy, network) {
    // One unverified asset settles it, even if another couldn't be read.
    let firstError: unknown;
    for (const asset of verifiableAssets(mastercopy, network)) {
      try {
        if (!(await isVerified(asset, network))) return "missing";
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
    return "ok";
  },

  async apply(mastercopy, network) {
    for (const asset of verifiableAssets(mastercopy, network)) {
      if (await isVerified(asset, network)) continue;

      const code = await getCode(rpcUrlFor(network), asset.address);
      if (code === "0x") throw new Error(`${asset.name}: not deployed`);

      await submitAndWaitForVerification(network, asset);
    }
  },
};

function verifiableAssets(
  mastercopy: Mastercopy,
  network: NetworkConfig
): Asset[] {
  if (!network.etherscanApiUrl) throw new Error("no supported explorer");

  const artifact = readArtifact(mastercopy.contractName, mastercopy.version);
  if (!artifact) throw new Error("no local artifact");
  return [...artifact.libraries, artifact.main];
}

async function isVerified(
  asset: Asset,
  network: NetworkConfig
): Promise<boolean> {
  const source = await getSourceCode({
    address: asset.address,
    network: network.name,
  });
  return source !== undefined;
}

async function submitAndWaitForVerification(
  network: NetworkConfig,
  asset: Asset
): Promise<void> {
  const sourceCode = asset.sourceCode;
  const guid = await verifySourceCode({
    address: asset.address,
    network: network.name,
    sourceCode: JSON.stringify(sourceCode.input),
    contractName: `${sourceCode.sourceName}:${sourceCode.contractName}`,
    compilerVersion: sourceCode.compilerVersion,
    constructorArguments: sourceCode.constructorArguments || "",
    evmVersion: evmVersionFor(sourceCode),
  });
  if (guid.toLowerCase().includes("already verified")) return;

  const result = await waitForVerification(network, guid);
  if (!result.toLowerCase().includes("pass")) {
    throw new Error(`${asset.name}: ${result}`);
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

function evmVersionFor(sourceCode: SourceCodeFile): string {
  const evmVersion = sourceCode.input?.settings?.evmVersion;
  return evmVersion && evmVersion !== "Default" ? evmVersion : "default";
}
