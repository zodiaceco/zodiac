/**
 * The chains Zodiac mastercopies are maintained on, by name. The single source
 * of chain ids: the maintenance CLI keys its RPC and explorer endpoints off
 * this list.
 */
export const SupportedNetworks = Object.freeze({
  MAINNET: 1,
  OPTIMISM: 10,
  BSC: 56,
  BNB: 56,
  GNOSIS: 100,
  UNICHAIN: 130,
  POLYGON: 137,
  SONIC: 146,
  WORLDCHAIN: 480,
  HYPEREVM: 999,
  HYPERLIQUID: 999,
  MEGAETH: 4326,
  ROBINHOOD: 4663,
  MANTLE: 5000,
  BASE: 8453,
  PLASMA: 9745,
  ARBITRUM: 42161,
  CELO: 42220,
  AVALANCHE: 43114,
  INK: 57073,
  LINEA: 59144,
  BOB: 60808,
  BERACHAIN: 80094,
  BASE_SEPOLIA: 84532,
  SCROLL: 534352,
  KATANA: 747474,
  SEPOLIA: 11155111,
} as const);

export type SupportedNetworks =
  (typeof SupportedNetworks)[keyof typeof SupportedNetworks];
