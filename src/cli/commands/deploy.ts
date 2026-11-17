import {
  BrowserProvider,
  type Eip1193Provider,
  JsonRpcProvider,
  type Signer,
  Wallet,
} from "ethers";
import ethProviderImport from "eth-provider";

import {
  ArtifactContract,
  Create2Deployment,
  readArtifact,
} from "../artifact.js";
import { MatrixTask, runMatrixCommand } from "./_matrix.js";
import { NetworkConfig, rpcUrlFor } from "../networks.js";
import { getCode } from "../rpc.js";
import { ERC2470_FACTORY, encodeFactoryCall } from "../create2.js";

export async function run(args: string[]): Promise<void> {
  await runMatrixCommand("deploy", deploy, args);
}

type FrameProvider = Eip1193Provider & {
  setChain: (chainId: string | number) => void;
  close: () => void;
};

const connectProvider = ethProviderImport as unknown as (
  targets?: string | string[]
) => FrameProvider;

// Sign through a local Frame wallet (https://frame.sh) instead of MNEMONIC.
const useFrame = ["1", "true", "yes", "on"].includes(
  (process.env.DEPLOY_VIA_FRAME ?? "").toLowerCase()
);

const deploy: MatrixTask = {
  legend: {
    done: "deployed",
    pending: "not deployed",
    unknown: "couldn't get status",
    failed: "failed deployment",
  },

  // Every contract, not just the main one: a library can be missing on its own.
  async check(mastercopy, network) {
    const artifact = readArtifact(mastercopy.name, mastercopy.version);
    const addresses = artifact
      ? [...artifact.libraries, artifact.main].map(
          (contract) => contract.address
        )
      : [mastercopy.address];

    const rpcUrl = rpcUrlFor(network);
    for (const address of addresses) {
      if ((await getCode(rpcUrl, address)) === "0x") return "pending";
    }
    return "done";
  },

  async apply(mastercopy, network) {
    const artifact = readArtifact(mastercopy.name, mastercopy.version);
    if (!artifact) throw new Error("no local artifact");

    const provider = new JsonRpcProvider(rpcUrlFor(network), network.chainId, {
      staticNetwork: true,
    });
    let disposeSigner: (() => void) | undefined;
    try {
      const missing: (ArtifactContract & { deployment: Create2Deployment })[] =
        [];
      for (const contract of [...artifact.libraries, artifact.main]) {
        if ((await provider.getCode(contract.address)) !== "0x") continue;
        const { deployment } = contract;
        if (!deployment) {
          throw new Error(
            `${contract.name}: no deployment in the local artifact`
          );
        }
        missing.push({ ...contract, deployment });
      }
      if (missing.length === 0) return;

      const { signer, dispose } = await createSigner(network, provider);
      disposeSigner = dispose;
      for (const contract of missing) {
        await deployContract(
          provider,
          signer,
          contract.name,
          contract.deployment
        );
      }
    } catch (error) {
      throw new Error(
        isInsufficientFundsError(error)
          ? "insufficient funds"
          : errorMessage(error)
      );
    } finally {
      disposeSigner?.();
      provider.destroy();
    }
  },
};

async function deployContract(
  provider: JsonRpcProvider,
  signer: Signer,
  name: string,
  deployment: Create2Deployment
): Promise<void> {
  if ((await provider.getCode(deployment.factory)) === "0x") {
    throw new Error(`factory ${deployment.factory} is not deployed`);
  }

  const data = encodeFactoryCall(deployment);
  const tx = await signer.sendTransaction({
    to: deployment.factory,
    data,
    gasLimit: await deploymentGasLimit(provider, deployment, data),
  });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`deployment transaction failed: ${tx.hash}`);
  }

  if (!(await waitForCode(provider, deployment.address))) {
    throw new Error(`${name} deployment produced no code: ${tx.hash}`);
  }
}

async function deploymentGasLimit(
  provider: JsonRpcProvider,
  deployment: Create2Deployment,
  data: string
): Promise<bigint> {
  const outerGas = await provider.estimateGas({
    to: deployment.factory,
    data,
  });

  if (deployment.factory.toLowerCase() !== ERC2470_FACTORY.toLowerCase()) {
    return outerGas;
  }

  // Some RPCs underestimate ERC-2470 deploys: the factory call succeeds even
  // when the inner CREATE2 runs out of gas. Add the inner estimate on top.
  const innerGas = await provider.estimateGas({
    data: deployment.initCode,
  });
  return outerGas + innerGas;
}

async function waitForCode(
  provider: JsonRpcProvider,
  address: string
): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = await provider.getCode(address);
    if (code !== "0x") return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

function errorMessage(error: unknown): string {
  return (error as Error)?.message || String(error);
}

function isInsufficientFundsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const maybeError = error as {
    code?: unknown;
    message?: unknown;
    shortMessage?: unknown;
    cause?: unknown;
    error?: unknown;
  };
  const message = `${maybeError.message ?? ""} ${
    maybeError.shortMessage ?? ""
  }`.toLowerCase();

  return (
    maybeError.code === "INSUFFICIENT_FUNDS" ||
    message.includes("insufficient funds") ||
    message.includes("not enough funds") ||
    isInsufficientFundsError(maybeError.cause) ||
    isInsufficientFundsError(maybeError.error)
  );
}

async function createSigner(
  network: NetworkConfig,
  provider: JsonRpcProvider
): Promise<{ signer: Signer; dispose?: () => void }> {
  if (useFrame) {
    try {
      const frame = connectProvider("frame");
      frame.setChain(network.chainId);
      const browserProvider = new BrowserProvider(frame, network.chainId);
      const signer = await browserProvider.getSigner();
      return { signer, dispose: () => frame.close() };
    } catch (error) {
      throw new Error(`Frame unavailable: ${errorMessage(error)}`);
    }
  }

  if (!process.env.MNEMONIC) throw new Error("missing MNEMONIC");
  try {
    return { signer: Wallet.fromPhrase(process.env.MNEMONIC, provider) };
  } catch {
    throw new Error("couldn't create signer");
  }
}
