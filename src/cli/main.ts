#!/usr/bin/env node
import "dotenv/config";

import * as deploy from "./commands/deploy.js";
import * as extract from "./commands/extract.js";
import * as verify from "./commands/verify.js";

/** Every verb the CLI accepts. Each command module exports `run(argv)`. */
const COMMANDS: Record<string, { run(args: string[]): Promise<void> }> = {
  deploy,
  extract,
  verify,
};

const USAGE = `zodiac — mastercopy artifact tooling

Usage:
  zodiac deploy <name> <version> [--network a,b]
      Deploy the missing contracts of one version's local artifact across
      configured networks.

  zodiac deploy list <name> [version] [--network a,b]
      Check whether a known contract is already deployed on each configured
      network (every version unless [version] is given).

  zodiac extract <name> <version> [network]
      Extract one known mastercopy (ABI, source, deployment) into
      mastercopies/<name>/<version>/, replacing what is there once the new
      files are complete. The address comes from the canonical registry;
      source is read from [network] or, by default, the default explorer set.

  zodiac verify <name> <version> [--network a,b]
      Verify the deployed contracts of one version's local artifact across
      configured explorers.

  zodiac verify list <name> [version] [--network a,b]
      Check whether a known contract's local artifact is verified on each
      configured explorer (every version unless [version] is given).

--network limits deploy and verify to the given networks (names or chain ids).
deploy and verify exit non-zero when any mastercopy fails.

Environment:
  ALCHEMY_KEY                     enables Alchemy RPC endpoints
  MNEMONIC                        signer used by deploy
  DEPLOY_VIA_FRAME                sign deployments through Frame instead
  ETHERSCAN_API_KEY[_<NETWORK>]   explorer API key(s)
`;

async function main() {
  const [name, ...rest] = process.argv.slice(2);

  if (name === undefined || ["help", "--help", "-h"].includes(name)) {
    console.log(USAGE);
    return;
  }

  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) {
    console.error(`Unknown command: ${name}\n`);
    console.log(USAGE);
    process.exit(1);
  }

  await command.run(rest);
}

main().catch((error) => {
  console.error(`\n✘ ${error?.message || error}`);
  process.exit(1);
});
