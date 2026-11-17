import { parseCliArgs } from "../args.js";
import { resolveMastercopy, Mastercopy } from "../mastercopy.js";
import { defaultMastercopiesDir, writeArtifact } from "../artifact.js";
import { fetchArtifact, FetchedArtifact } from "../fetch.js";

export async function run(args: string[]): Promise<void> {
  const { positionals } = parseCliArgs(args, []);
  const [name, version, network] = positionals;
  if (!name || !version) {
    throw new Error("Usage: zodiac extract <name> <version> [network]");
  }

  await extractMastercopy({
    mastercopy: resolveMastercopy(name, version),
    networks: network ? [network] : DEFAULT_NETWORKS,
    mastercopiesDir: defaultMastercopiesDir(),
  });
}

// Tried in order until one yields a complete artifact. Limited to networks
// whose explorer serves both the verified source and the creation transaction.
const DEFAULT_NETWORKS = [
  "mainnet",
  "gnosis",
  "arbitrum",
  "optimism",
  "base",
  "unichain",
  "polygon",
  "sonic",
  "worldchain",
  "hyperliquid",
  "megaeth",
  "mantle",
  "plasma",
  "celo",
  "ink",
  "linea",
  "berachain",
  "katana",
  "baseSepolia",
  "sepolia",
];

async function extractMastercopy({
  mastercopy: { name, version, address },
  networks,
  mastercopiesDir,
}: {
  mastercopy: Mastercopy;
  networks: string[];
  mastercopiesDir: string;
}): Promise<void> {
  const id = `${name}@${version}`;
  const failures: string[] = [];
  let best: FetchedArtifact | undefined;

  for (const network of networks) {
    let result: FetchedArtifact | undefined;
    try {
      result = await fetchArtifact({ network, address });
    } catch (error) {
      failures.push(`${network}: ${(error as Error)?.message || error}`);
      continue;
    }
    // Not verified on this network.
    if (!result) continue;

    // A partial result may be completed by another network's explorer.
    if (!best || isMoreComplete(result, best, address)) best = result;
    if (best.errors.length === 0) break;
  }

  if (!best) {
    throw new Error(
      failures.length === 0
        ? `${id}: not verified on ${networks.join(", ")}`
        : `${id}: couldn't be read (${failures.join("; ")})`
    );
  }

  writeArtifact(name, version, best.contracts.values(), mastercopiesDir);
  if (best.errors.length === 0) {
    console.log(`  ✔ ${id}: ${best.contracts.size} contract(s)`);
  } else {
    console.warn(
      `  ⚠ ${id}: partial — ${[...best.errors, ...failures].join("; ")}`
    );
  }
}

function isMoreComplete(
  candidate: FetchedArtifact,
  current: FetchedArtifact,
  rootAddress: string
): boolean {
  const rootKey = rootAddress.toLowerCase();
  const score = (result: FetchedArtifact): number[] => [
    result.contracts.get(rootKey)?.deployment ? 1 : 0,
    [...result.contracts.values()].filter((contract) => contract.deployment)
      .length,
    result.contracts.size,
    -result.errors.length,
  ];

  const candidateScore = score(candidate);
  const currentScore = score(current);
  for (let i = 0; i < candidateScore.length; i += 1) {
    if (candidateScore[i] !== currentScore[i]) {
      return candidateScore[i] > currentScore[i];
    }
  }
  return false;
}
