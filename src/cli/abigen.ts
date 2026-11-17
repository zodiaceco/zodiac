import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { format, resolveConfig } from "prettier";

import {
  defaultMastercopiesDir,
  listArtifacts,
  readArtifact,
} from "./artifact.js";

const DEFAULT_ABIS_DIR = path.join("src", "sdk", "abis");

const identifier = (v: string) => v.replace(/[^a-zA-Z0-9_$]/g, "_");

/**
 * Regenerate `src/sdk/abis` from the artifacts on disk: one module per
 * `name@version` exporting the main contract's ABI, plus an index of them all.
 */
export async function writeAbis({
  mastercopiesDir = defaultMastercopiesDir(),
  abisDir = DEFAULT_ABIS_DIR,
}: {
  mastercopiesDir?: string;
  abisDir?: string;
} = {}): Promise<void> {
  if (!existsSync(mastercopiesDir)) return;

  // Load everything before removing anything, so a bad artifact leaves the
  // existing exports alone.
  const abis = listArtifacts(mastercopiesDir).map(({ name, version }) => ({
    name,
    version,
    abi: readArtifact(name, version, mastercopiesDir)!.main.abi,
  }));

  rmSync(abisDir, { recursive: true, force: true });
  mkdirSync(abisDir, { recursive: true });

  const registry: Record<string, Record<string, string>> = {};

  for (const { name, version, abi } of abis) {
    const exportName = `${identifier(name)}_${version.replace(/\./g, "_")}_ABI`;

    mkdirSync(path.join(abisDir, name), { recursive: true });
    writeFileSync(
      path.join(abisDir, name, `${version}.ts`),
      `export const ${exportName} = ${JSON.stringify(abi, null, 2)} as const;\n`
    );

    (registry[name] ??= {})[version] = exportName;
  }

  const indexPath = path.join(abisDir, "index.ts");
  const prettierConfig = await resolveConfig(indexPath);
  const index = await format(renderIndex(registry), {
    ...prettierConfig,
    filepath: indexPath,
  });
  writeFileSync(indexPath, index);
}

function renderIndex(registry: Record<string, Record<string, string>>) {
  const entries = Object.entries(registry);
  const imports = entries
    .flatMap(([mod, vers]) =>
      Object.entries(vers).map(
        ([ver, name]) => `import { ${name} } from "./${mod}/${ver}.js";`
      )
    )
    .join("\n");

  const body = entries
    .map(
      ([mod, vers]) =>
        `  ${JSON.stringify(mod)}: {\n${Object.entries(vers)
          .map(([ver, name]) => `    ${JSON.stringify(ver)}: ${name},`)
          .join("\n")}\n  },`
    )
    .join("\n");

  // `satisfies` keeps the literal ABI types while checking that the keys are
  // exactly the known contracts: none missing, none unknown.
  return [
    `import { MastercopyName } from "../contracts.js";`,
    imports,
    "",
    `export const ABIs = {\n${body}\n} as const satisfies Record<MastercopyName, Record<string, readonly unknown[]>>;`,
    "",
  ].join("\n");
}
