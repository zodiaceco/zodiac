export async function rpcCall<T = unknown>(
  rpcUrl: string,
  method: string,
  params: unknown[]
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`RPC returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as {
      result?: unknown;
      error?: { message?: string } | unknown;
    };
    if (payload.error) {
      const message =
        (payload.error as { message?: string })?.message ?? "unknown error";
      throw new Error(`RPC ${method} failed: ${message}`);
    }
    return payload.result as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getCode(
  rpcUrl: string,
  address: string
): Promise<string> {
  const result = await rpcCall<unknown>(rpcUrl, "eth_getCode", [
    address,
    "latest",
  ]);
  if (typeof result !== "string") {
    throw new Error("RPC returned an invalid eth_getCode response");
  }
  return result;
}
