import {
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  createPublicClient,
  defineChain,
  http,
  isHex,
} from "viem";

import { NetworkConfig, rpcUrlFor } from "./networks.js";

/** A viem chain for a configured network, pointing at its resolved RPC. */
export function chainFor(network: NetworkConfig): Chain {
  return defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrlFor(network)] } },
  });
}

/** A read client that fails fast: status checks fan out over every network. */
export function publicClient(network: NetworkConfig): PublicClient {
  return createPublicClient({
    chain: chainFor(network),
    transport: http(rpcUrlFor(network), { timeout: 5_000, retryCount: 0 }),
  });
}

/** The code at `address`, or `"0x"` when there is none. */
export async function getCode(
  network: NetworkConfig,
  address: Address
): Promise<Hex> {
  return readCode(publicClient(network), address);
}

/**
 * `eth_getCode` through `client`, with the response checked: viem hands back
 * whatever the node sent, and a malformed answer must not read as "has code".
 */
export async function readCode(
  client: PublicClient,
  address: Address
): Promise<Hex> {
  const code: unknown = await client.request({
    method: "eth_getCode",
    params: [address, "latest"],
  });
  if (!isHex(code) || code.length % 2 !== 0) {
    throw new Error("RPC returned an invalid eth_getCode response");
  }
  return code;
}
