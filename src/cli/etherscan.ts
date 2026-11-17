import type { Address, Hex } from "viem";

import { requestJson, sleep } from "./http.js";
import { resolveNetwork } from "./networks.js";
import { publicClient } from "./rpc.js";

interface SourceCode {
  contractName: string;
  sourceName: string;
  compilerVersion: string;
  compilerInput: any;
  abi: any;
  /** Hex, no leading 0x. */
  constructorArguments: string;
}

interface ContractCreation {
  txHash?: string;
  creationBytecode?: string;
}

interface VerificationRequest {
  address: string;
  network: string | number;
  sourceCode: string;
  contractName: string;
  compilerVersion: string;
  constructorArguments?: string;
  evmVersion?: string;
  licenseType?: string;
  apiKey?: string;
}

export async function getSourceCode({
  address,
  network,
  apiKey,
}: {
  address: string;
  network: string | number;
  apiKey?: string;
}): Promise<SourceCode | undefined> {
  const { status, message, result } = await explorerRequest<ExplorerEntry[]>(
    "GET",
    network,
    {
      module: "contract",
      action: "getsourcecode",
      address,
    },
    apiKey
  );

  if (!isOk(status)) {
    // Some explorers report an unverified contract as a failed request.
    if (`${message} ${result}`.toLowerCase().includes("not verified")) {
      return undefined;
    }
    throw new Error(
      `getsourcecode failed for ${address}: ${message}${
        result ? ` (${result})` : ""
      }`
    );
  }

  const entry = result[0];
  if (!entry?.SourceCode) return undefined;

  const { compilerInput, sourceName } = compilerInputFromExplorerEntry(entry);

  return {
    contractName: entry.ContractName,
    sourceName,
    compilerVersion: entry.CompilerVersion,
    compilerInput,
    abi: entry.ABI ? safeJsonParse(entry.ABI) : undefined,
    constructorArguments: entry.ConstructorArguments || "",
  };
}

/**
 * Get creation metadata (tx hash and bytecode) for a contract.
 */
export async function getContractCreation({
  address,
  network,
  apiKey,
}: {
  address: string;
  network: string | number;
  apiKey?: string;
}): Promise<ContractCreation | undefined> {
  const { status, result } = await explorerRequest<any[]>(
    "GET",
    network,
    {
      module: "contract",
      action: "getcontractcreation",
      contractaddresses: address,
    },
    apiKey
  );

  if (!isOk(status) || !Array.isArray(result) || result.length === 0) {
    return undefined;
  }
  return {
    txHash: result[0].txHash,
    creationBytecode: result[0].creationBytecode,
  };
}

/** Over RPC: not every explorer has the `proxy` module (Blockscout doesn't). */
export async function getTransaction({
  txHash,
  network,
}: {
  txHash: string;
  network: string | number;
}): Promise<{ to: Address | null; input: Hex } | undefined> {
  // The raw request: viem's `getTransaction` throws when there is none.
  const result = await publicClient(resolveNetwork(network)).request({
    method: "eth_getTransactionByHash",
    params: [txHash as Hex],
  });

  if (!result?.input) return undefined;
  return { to: result.to ?? null, input: result.input };
}

export async function verifySourceCode({
  address,
  network,
  sourceCode,
  contractName,
  compilerVersion,
  constructorArguments = "",
  evmVersion = "default",
  licenseType = "1",
  apiKey,
}: VerificationRequest): Promise<string> {
  const { status, message, result } = await explorerRequest<string>(
    "POST",
    network,
    {
      module: "contract",
      action: "verifysourcecode",
      contractaddress: address,
      sourceCode,
      codeformat: "solidity-standard-json-input",
      contractname: contractName,
      compilerversion: compilerVersion,
      optimizationUsed: "0",
      runs: "200",
      constructorArguments,
      evmVersion,
      licenseType,
    },
    apiKey
  );

  if (!isOk(status)) {
    if (
      typeof result === "string" &&
      result.toLowerCase().includes("already")
    ) {
      return result;
    }
    throw new Error(`${message}${result ? ` (${result})` : ""}`);
  }
  return result;
}

export async function checkVerificationStatus({
  guid,
  network,
  apiKey,
}: {
  guid: string;
  network: string | number;
  apiKey?: string;
}): Promise<string> {
  const { status, message, result } = await explorerRequest<string>(
    "POST",
    network,
    {
      module: "contract",
      action: "checkverifystatus",
      guid,
    },
    apiKey
  );

  if (!isOk(status)) {
    if (typeof result === "string" && result) return result;
    throw new Error(`${message}${result ? ` (${result})` : ""}`);
  }
  return result;
}

interface ExplorerEntry {
  SourceCode: string;
  ContractName: string;
  ContractFileName?: string;
  OptimizationUsed: string;
  Runs: string;
  EVMVersion: string;
  Library?: string;
  CompilerVersion: string;
  ABI: string;
  ConstructorArguments: string;
}

interface ExplorerResponse<T = any> {
  status: string;
  message: string;
  result: T;
}

async function explorerRequest<T = any>(
  method: "GET" | "POST",
  networkOrChainId: string | number,
  params: Record<string, string>,
  apiKey?: string
): Promise<ExplorerResponse<T>> {
  const network = resolveNetwork(networkOrChainId);
  if (!network.etherscanApiUrl) {
    throw new Error(
      `${network.name} (chain ${network.chainId}) has no Etherscan-compatible explorer.`
    );
  }

  // The configured URL may carry its own query (Etherscan V2's `chainid`).
  const url = new URL(network.etherscanApiUrl);
  const query = new URLSearchParams(url.search);
  query.set("apikey", resolveApiKey(network.name, apiKey));
  for (const [key, value] of Object.entries(params)) {
    query.set(key, value);
  }
  if (method === "GET") url.search = query.toString();

  const { status, body } = await requestJson<ExplorerResponse<T>>(
    url,
    method === "GET" ? {} : { method, body: query },
    { beforeAttempt: queueRequest, isRateLimited }
  );

  if (status < 200 || status >= 300 || !body) {
    throw new Error(`Explorer request failed: ${status}`);
  }
  return body;
}

// Etherscan allows 3 calls/s per API key, shared by every chain on V2.
const REQUEST_INTERVAL_MS = 400;
let nextRequestAt = 0;

async function queueRequest(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextRequestAt);
  nextRequestAt = slot + REQUEST_INTERVAL_MS;
  await sleep(slot - now);
}

function isRateLimited(body: any): boolean {
  const text = `${body?.message ?? ""} ${body?.result ?? ""}`.toLowerCase();
  // "rate limit" is Etherscan phrasing, "too many requests" is Blockscout's.
  return text.includes("rate limit") || text.includes("too many requests");
}

function resolveApiKey(network: string, explicit?: string): string {
  return (
    explicit ||
    process.env[`ETHERSCAN_API_KEY_${network.toUpperCase()}`] ||
    process.env.ETHERSCAN_API_KEY ||
    ""
  );
}

function isOk(status: unknown): boolean {
  return String(status) === "1";
}

// Etherscan double-wraps standard-JSON source in extra braces: `{{...}}`.
function safeJsonParse(input: string): any {
  const trimmed = input.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return JSON.parse(trimmed.replace(/^\{|\}$/g, "").trim());
  }
}

function compilerInputFromExplorerEntry(entry: ExplorerEntry): {
  compilerInput: any;
  sourceName: string;
} {
  const sourceCode = entry.SourceCode.trim();
  const contractName = entry.ContractName;

  if (sourceCode.startsWith("{")) {
    const compilerInput = safeJsonParse(sourceCode);
    return {
      compilerInput,
      sourceName: sourceNameFor(compilerInput, contractName),
    };
  }

  const sourceName = entry.ContractFileName || `${contractName}.sol`;
  const settings: any = {};

  if (entry.OptimizationUsed !== "") {
    settings.optimizer = {
      enabled: String(entry.OptimizationUsed) === "1",
      runs: Number(entry.Runs) || 200,
    };
  }
  if (entry.EVMVersion && entry.EVMVersion !== "Default") {
    settings.evmVersion = entry.EVMVersion;
  }

  const libraries = parseLibraries(entry.Library);
  if (Object.keys(libraries).length > 0) {
    settings.libraries = { [sourceName]: libraries };
  }

  return {
    sourceName,
    compilerInput: {
      language: "Solidity",
      sources: {
        [sourceName]: { content: sourceCode },
      },
      settings,
    },
  };
}

function sourceNameFor(compilerInput: any, contractName: string): string {
  const sources = compilerInput?.sources || {};
  const match = Object.keys(sources).find(
    (path) =>
      path
        .split("/")
        .pop()
        ?.replace(/\.sol$/, "") === contractName
  );
  if (match) return match;
  const [only] = Object.keys(sources);
  if (only) return only;
  throw new Error(`Could not resolve sourceName for ${contractName}`);
}

function parseLibraries(input: string | undefined): Record<string, string> {
  const libraries: Record<string, string> = {};
  for (const entry of (input || "").split(/[;,]/)) {
    const match = entry.trim().match(/^(.+?)(?::|\s)+(0x[0-9a-fA-F]{40})$/);
    if (match) libraries[match[1].trim()] = match[2];
  }
  return libraries;
}
