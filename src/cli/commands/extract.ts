import { parseCliArgs, resolveMastercopy, Mastercopy } from "../args.js";
import { defaultMastercopiesDir, writeArtifact } from "../artifact.js";
import { fetchMastercopy, FetchedMastercopy } from "../fetch.js";
import { writeAbis } from "../abigen.js";

export async function run(args: string[]): Promise<void> {
  const { positionals } = parseCliArgs(args, []);
  const [name, version, network] = positionals;
  if (!name || !version) {
    throw new Error("Usage: zodiac extract <name> <version> [network]");
  }

  const mastercopiesDir = defaultMastercopiesDir();
  await extractMastercopy({
    mastercopy: resolveMastercopy(name, version),
    networks: network ? [network] : DEFAULT_NETWORKS,
    mastercopiesDir,
  });
  await writeAbis({ mastercopiesDir });
  console.log("  ✔ ABI exports updated");
}

const DEFAULT_NETWORKS = ["mainnet", "gnosis", "arbitrum", "optimism", "base"];

async function extractMastercopy({
  mastercopy: { contractName, version, address },
  networks,
  mastercopiesDir,
}: {
  mastercopy: Mastercopy;
  networks: string[];
  mastercopiesDir: string;
}): Promise<void> {
  const id = `${contractName}@${version}`;
  const failures: string[] = [];
  let best: FetchedMastercopy | undefined;

  for (const network of networks) {
    let result: FetchedMastercopy | undefined;
    try {
      result = await fetchMastercopy({ network, address });
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

  writeArtifact(contractName, version, best.assets.values(), mastercopiesDir);
  if (best.errors.length === 0) {
    console.log(`  ✔ ${id}: ${best.assets.size} asset(s)`);
  } else {
    console.warn(
      `  ⚠ ${id}: partial — ${[...best.errors, ...failures].join("; ")}`
    );
  }
}

function isMoreComplete(
  candidate: FetchedMastercopy,
  current: FetchedMastercopy,
  rootAddress: string
): boolean {
  const rootKey = rootAddress.toLowerCase();
  const score = (result: FetchedMastercopy): number[] => [
    result.assets.get(rootKey)?.deployment ? 1 : 0,
    [...result.assets.values()].filter((asset) => asset.deployment).length,
    result.assets.size,
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
