/**
 * Sourcify (API v2) client. Blockscout explorers read their verified sources
 * from Sourcify, and Etherscan ones don't, so `verify` submits here as well as
 * to the chain's Etherscan-compatible explorer.
 */

import { requestJson, sleep } from "./http.js";
import { NetworkConfig } from "./networks.js";

interface SourcifyError {
  customCode?: string;
  message?: string;
}

interface SourcifyContract {
  /** "match", "exact_match", or null when not verified. */
  match: string | null;
}

interface VerificationJob extends SourcifyError {
  verificationId?: string;
}

interface VerificationJobStatus {
  isJobCompleted: boolean;
  error?: SourcifyError;
  contract?: SourcifyContract;
}

const SOURCIFY_API = "https://sourcify.dev/server/";

interface SourcifyChain {
  chainId: number;
  supported: boolean;
}

let supportedChainIds: Promise<Set<number>> | undefined;

/** Whether the Sourcify server verifies contracts on this chain. */
export async function isSupported(network: NetworkConfig): Promise<boolean> {
  supportedChainIds ??= fetchSupportedChainIds();
  try {
    return (await supportedChainIds).has(network.chainId);
  } catch (error) {
    // Let the next call ask again.
    supportedChainIds = undefined;
    throw error;
  }
}

async function fetchSupportedChainIds(): Promise<Set<number>> {
  const { status, body } = await requestJson<SourcifyChain[]>(
    new URL("chains", SOURCIFY_API)
  );
  if (status !== 200 || !Array.isArray(body)) {
    throw new Error(`Sourcify chain list failed: ${status}`);
  }
  return new Set(
    body.filter((chain) => chain.supported).map((chain) => chain.chainId)
  );
}

export async function isVerified({
  address,
  network,
}: {
  address: string;
  network: NetworkConfig;
}): Promise<boolean> {
  const { status, body } = await requestJson<SourcifyContract & SourcifyError>(
    endpoint(`v2/contract/${network.chainId}/${address}`)
  );

  // An unverified contract is a 404 that still carries the contract body.
  if (body && "match" in body && (status === 200 || status === 404)) {
    return body.match !== null;
  }
  throw new Error(failure("Sourcify lookup", status, body));
}

/** Submit a standard-JSON verification and wait for the job to settle. */
export async function verify({
  address,
  network,
  compilerInput,
  compilerVersion,
  contractIdentifier,
}: {
  address: string;
  network: NetworkConfig;
  compilerInput: unknown;
  /** As solc reports it; a leading `v` is accepted. */
  compilerVersion: string;
  /** `<sourceName>:<contractName>` */
  contractIdentifier: string;
}): Promise<void> {
  const { status, body } = await requestJson<VerificationJob>(
    endpoint(`v2/verify/${network.chainId}/${address}`),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stdJsonInput: compilerInput,
        compilerVersion,
        contractIdentifier,
      }),
    }
  );

  if (status === 409 && body?.customCode === "already_verified") return;
  if (status !== 202 || !body?.verificationId) {
    throw new Error(failure("Sourcify submission", status, body));
  }

  await waitForJob(body.verificationId);
}

async function waitForJob(verificationId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { status, body } = await requestJson<
      VerificationJobStatus & SourcifyError
    >(endpoint(`v2/verify/${verificationId}`));

    if (status !== 200 || !body) {
      throw new Error(failure("Sourcify job status", status, body));
    }
    if (!body.isJobCompleted) {
      await sleep(3_000);
      continue;
    }
    if (body.error || !body.contract?.match) {
      throw new Error(
        body.error?.message || body.error?.customCode || "no match"
      );
    }
    return;
  }
  throw new Error("verification timed out");
}

function endpoint(path: string): URL {
  return new URL(path, SOURCIFY_API);
}

function failure(
  what: string,
  status: number,
  body: SourcifyError | undefined
): string {
  const detail = body?.message || body?.customCode;
  return `${what} failed: ${status}${detail ? ` (${detail})` : ""}`;
}
