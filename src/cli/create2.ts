import {
  type Address,
  type Hex,
  concat,
  decodeFunctionData,
  encodeFunctionData,
  getContractAddress,
  isAddressEqual,
  isHex,
  parseAbi,
  slice,
} from "viem";

/**
 * Known CREATE2 singleton factories used across the Zodiac ecosystem. Both
 * yield identical addresses on every chain, which is what makes mastercopy
 * replication address-stable.
 */
export const ERC2470_FACTORY: Address =
  "0xce0042B868300000d44A59004Da54A005ffdcf9f";
const NICK_FACTORY: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

const erc2470Abi = parseAbi([
  "function deploy(bytes _initCode, bytes32 _salt) returns (address)",
]);

/** What a CREATE2 deployment is made from, before its outcome is known. */
interface Create2Params {
  factory: Address;
  salt: Hex;
  initCode: Hex;
}

function validateSalt(salt: Hex): void {
  if (!isHex(salt) || salt.length !== 66) {
    throw new Error(`CREATE2 salt must be 32 bytes, got ${salt}`);
  }
}

/**
 * Decode the init code and salt from a singleton-factory deployment
 * transaction. Supports the ERC-2470 factory (an abi-encoded `deploy` call)
 * and Nick's factory (raw `salt ++ initCode` calldata).
 *
 * Returns undefined when the transaction does not target a known factory, in
 * which case the deployment cannot be replicated address-stably.
 */
export function decodeFactoryCall({
  to,
  input,
}: {
  to: Address | null;
  input: Hex;
}): Create2Params | undefined {
  if (to && isAddressEqual(to, ERC2470_FACTORY)) {
    try {
      const {
        args: [initCode, salt],
      } = decodeFunctionData({ abi: erc2470Abi, data: input });
      return { factory: ERC2470_FACTORY, initCode, salt };
    } catch {
      return undefined;
    }
  }

  if (to && isAddressEqual(to, NICK_FACTORY)) {
    // Nick's factory: calldata is salt (32 bytes) followed by the init code.
    return {
      factory: NICK_FACTORY,
      salt: slice(input, 0, 32),
      initCode: slice(input, 32),
    };
  }

  return undefined;
}

/**
 * The inverse of `decodeFactoryCall`: calldata for the transaction, sent to
 * `factory`, that performs a deployment.
 */
export function encodeFactoryCall({
  factory,
  salt,
  initCode,
}: Create2Params): Hex {
  validateSalt(salt);
  if (isAddressEqual(factory, ERC2470_FACTORY)) {
    return encodeFunctionData({
      abi: erc2470Abi,
      functionName: "deploy",
      args: [initCode, salt],
    });
  }
  if (isAddressEqual(factory, NICK_FACTORY)) {
    return concat([salt, initCode]);
  }
  throw new Error(`unsupported singleton factory ${factory}`);
}

/** The CREATE2 address a deployment lands at, on any chain. */
export function predictAddress({
  factory,
  salt,
  initCode,
}: Create2Params): Address {
  validateSalt(salt);
  return getContractAddress({
    opcode: "CREATE2",
    from: factory,
    salt,
    bytecode: initCode,
  });
}
