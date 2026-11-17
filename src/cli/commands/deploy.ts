import {
  type Account,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  InsufficientFundsError,
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  http,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import ethProviderImport from "eth-provider";

import {
  ArtifactContract,
  Create2Deployment,
  readArtifact,
} from "../artifact.js";
import { MatrixTask, runMatrixCommand } from "./_matrix.js";
import { NetworkConfig, rpcUrlFor } from "../networks.js";
import { chainFor, getCode, readCode } from "../rpc.js";
import { ERC2470_FACTORY, encodeFactoryCall } from "../create2.js";

export async function run(args: string[]): Promise<void> {
  await runMatrixCommand("deploy", deploy, args);
}

type FrameProvider = EIP1193Provider & {
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

type Signer = WalletClient<Transport, Chain, Account>;

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
      : [getAddress(mastercopy.address)];

    for (const address of addresses) {
      if ((await getCode(network, address)) === "0x") return "pending";
    }
    return "done";
  },

  async apply(mastercopy, network) {
    const artifact = readArtifact(mastercopy.name, mastercopy.version);
    if (!artifact) throw new Error("no local artifact");

    const chain = chainFor(network);
    const client = createPublicClient({
      chain,
      transport: http(rpcUrlFor(network)),
    });
    let disposeSigner: (() => void) | undefined;
    try {
      const missing: (ArtifactContract & { deployment: Create2Deployment })[] =
        [];
      for (const contract of [...artifact.libraries, artifact.main]) {
        if (await hasCode(client, contract.address)) continue;
        const { deployment } = contract;
        if (!deployment) {
          throw new Error(
            `${contract.name}: no deployment in the local artifact`
          );
        }
        missing.push({ ...contract, deployment });
      }
      if (missing.length === 0) return;

      const { signer, dispose } = await createSigner(chain);
      disposeSigner = dispose;
      for (const contract of missing) {
        await deployContract(
          client,
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
    }
  },
};

async function deployContract(
  client: PublicClient,
  signer: Signer,
  name: string,
  deployment: Create2Deployment
): Promise<void> {
  if (!(await hasCode(client, deployment.factory))) {
    throw new Error(`factory ${deployment.factory} is not deployed`);
  }

  const data = encodeFactoryCall(deployment);
  const hash = await signer.sendTransaction({
    to: deployment.factory,
    data,
    gas: await deploymentGasLimit(client, deployment, data),
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`deployment transaction failed: ${hash}`);
  }

  if (!(await waitForCode(client, deployment.address))) {
    throw new Error(`${name} deployment produced no code: ${hash}`);
  }
}

async function deploymentGasLimit(
  client: PublicClient,
  deployment: Create2Deployment,
  data: Hex
): Promise<bigint> {
  const outerGas = await client.estimateGas({ to: deployment.factory, data });

  if (deployment.factory.toLowerCase() !== ERC2470_FACTORY.toLowerCase()) {
    return outerGas;
  }

  // Some RPCs underestimate ERC-2470 deploys: the factory call succeeds even
  // when the inner CREATE2 runs out of gas. Add the inner estimate on top.
  const innerGas = await client.estimateGas({ data: deployment.initCode });
  return outerGas + innerGas;
}

async function hasCode(
  client: PublicClient,
  address: Address
): Promise<boolean> {
  return (await readCode(client, address)) !== "0x";
}

async function waitForCode(
  client: PublicClient,
  address: Address
): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await hasCode(client, address)) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

// viem errors carry a one-line `shortMessage`; their `message` is a full report.
function errorMessage(error: unknown): string {
  return (
    (error as { shortMessage?: string })?.shortMessage ||
    (error as Error)?.message ||
    String(error)
  );
}

function isInsufficientFundsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (error instanceof InsufficientFundsError) return true;

  const maybeError = error as {
    message?: unknown;
    shortMessage?: unknown;
    details?: unknown;
    cause?: unknown;
  };
  const message = `${maybeError.message ?? ""} ${
    maybeError.shortMessage ?? ""
  } ${maybeError.details ?? ""}`.toLowerCase();

  return (
    message.includes("insufficient funds") ||
    message.includes("not enough funds") ||
    isInsufficientFundsError(maybeError.cause)
  );
}

async function createSigner(
  chain: Chain
): Promise<{ signer: Signer; dispose?: () => void }> {
  if (useFrame) {
    try {
      const frame = connectProvider("frame");
      frame.setChain(chain.id);
      const transport = custom(frame);
      const [account] = await createWalletClient({
        chain,
        transport,
      }).requestAddresses();
      if (!account) throw new Error("no account selected");
      return {
        signer: createWalletClient({ account, chain, transport }),
        dispose: () => frame.close(),
      };
    } catch (error) {
      throw new Error(`Frame unavailable: ${errorMessage(error)}`);
    }
  }

  if (!process.env.MNEMONIC) throw new Error("missing MNEMONIC");
  // viem derives the account from the exact string, so normalize it first.
  const mnemonic = process.env.MNEMONIC.trim()
    .toLowerCase()
    .split(/\s+/)
    .join(" ");
  return {
    signer: createWalletClient({
      account: mnemonicToAccount(mnemonic),
      chain,
      transport: http(chain.rpcUrls.default.http[0]),
    }),
  };
}
