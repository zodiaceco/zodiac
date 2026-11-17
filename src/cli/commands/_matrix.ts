import { clearLine, cursorTo } from "readline";

import { parseCliArgs } from "../args.js";
import { knownVersions, resolveMastercopy, Mastercopy } from "../mastercopy.js";
import { NetworkConfig, networks as configuredNetworks } from "../networks.js";
import { readArtifact } from "../artifact.js";

type Status = "done" | "pending" | "unknown" | "failed";

export interface MatrixTask {
  /** Read-only. Throws when it can't tell, which `list` shows as `?`. */
  check(
    mastercopy: Mastercopy,
    network: NetworkConfig
  ): Promise<"done" | "pending">;
  apply(mastercopy: Mastercopy, network: NetworkConfig): Promise<void>;
  legend: Record<Status, string>;
}

export async function runMatrixCommand(
  commandName: string,
  task: MatrixTask,
  args: string[]
): Promise<void> {
  const { positionals, networks } = parseCliArgs(args, ["network"]);
  const checkOnly = positionals[0] === "list";
  const [name, version] = checkOnly ? positionals.slice(1) : positionals;
  if (!name || (!version && !checkOnly)) {
    throw new Error(
      `Usage: zodiac ${commandName} <name> <version> [--network a,b]\n` +
        `       zodiac ${commandName} list <name> [version] [--network a,b]`
    );
  }

  const versions = version ? [version] : knownVersions(name);
  const mastercopies = versions.map((v) => resolveMastercopy(name, v));
  // Surface a corrupt local artifact once, before touching any network.
  for (const mastercopy of mastercopies) {
    readArtifact(mastercopy.name, mastercopy.version);
  }

  await runMatrix(task, mastercopies, networks ?? configuredNetworks, {
    checkOnly,
  });
}

const SYMBOLS: Record<Status, string> = {
  done: "\u001b[32m✓\u001b[0m",
  pending: "\u001b[31m✗\u001b[0m",
  unknown: "\u001b[33m?\u001b[0m",
  failed: "\u001b[31m✗\u001b[0m",
};

// One column wide on screen, despite the escape codes.
const SYMBOL_WIDTH = 1;

// viem errors carry a one-line `shortMessage`; their `message` is a full report.
const errorMessage = (error: unknown): string =>
  (error as { shortMessage?: string })?.shortMessage ||
  (error as Error)?.message ||
  String(error);

async function runMatrix(
  task: MatrixTask,
  mastercopies: Mastercopy[],
  networks: NetworkConfig[],
  { checkOnly }: { checkOnly: boolean }
): Promise<void> {
  const total = networks.length * mastercopies.length;
  let completed = 0;
  const progress = () =>
    transient(`${checkOnly ? "Checking" : "Running"}: ${completed}/${total}`);

  const runCell = async (
    mastercopy: Mastercopy,
    network: NetworkConfig
  ): Promise<Status> => {
    const id = `${mastercopy.name}@${mastercopy.version}`;
    let reason: string;
    try {
      const status = await task.check(mastercopy, network);
      if (checkOnly || status === "done") return status;

      transient(`${id} on ${network.name}...`);
      await task.apply(mastercopy, network);
      printLine(
        `${SYMBOLS.done} ${id} ${task.legend.done} on ${network.name}: ${mastercopy.address}`
      );
      return "done";
    } catch (error) {
      if (checkOnly) return "unknown";
      reason = errorMessage(error);
    }
    printLine(`${SYMBOLS.failed} ${id} failed on ${network.name}: ${reason}`);
    return "failed";
  };

  const runNetwork = async (network: NetworkConfig) => {
    const statuses: Status[] = [];
    for (const mastercopy of mastercopies) {
      statuses.push(await runCell(mastercopy, network));
      completed += 1;
      progress();
    }
    return { network: network.name, statuses };
  };

  progress();
  // Checks run in parallel; changes go one network at a time, since each may
  // need a signature.
  const rows: { network: string; statuses: Status[] }[] = [];
  if (checkOnly) {
    rows.push(...(await Promise.all(networks.map(runNetwork))));
  } else {
    for (const network of networks) rows.push(await runNetwork(network));
  }
  clearTransient();

  printTable(["network", ...mastercopies.map(({ version }) => version)], rows);
  console.log();
  console.log(
    (checkOnly
      ? (["done", "pending", "unknown"] as const)
      : (["done", "failed"] as const)
    )
      .map((status) => `${SYMBOLS[status]} ${task.legend[status]}`)
      .join("  ")
  );

  if (rows.some((row) => row.statuses.includes("failed"))) {
    process.exitCode = 1;
  }
}

function printTable(
  headers: string[],
  rows: { network: string; statuses: Status[] }[]
): void {
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...rows.map((row) => (index === 0 ? row.network.length : SYMBOL_WIDTH))
    )
  );
  const line = (cells: string[], lengths: number[]) =>
    cells
      .map((cell, index) => cell + " ".repeat(widths[index] - lengths[index]))
      .join("  ");

  console.log(
    line(
      headers,
      headers.map((header) => header.length)
    )
  );
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(
      line(
        [row.network, ...row.statuses.map((status) => SYMBOLS[status])],
        [row.network.length, ...row.statuses.map(() => SYMBOL_WIDTH)]
      )
    );
  }
}

function transient(message: string): void {
  if (!process.stderr.isTTY) return;
  clearTransient();
  process.stderr.write(message);
}

function clearTransient(): void {
  if (!process.stderr.isTTY) return;
  cursorTo(process.stderr, 0);
  clearLine(process.stderr, 0);
}

/** Print a line that stays, above the transient progress line. */
export function printLine(message: string): void {
  clearTransient();
  console.log(message);
}
