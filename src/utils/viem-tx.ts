import {
  createWalletClient,
  encodeFunctionData,
  http,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { KohakuPublicClient } from "./rpc.js";

export type KohakuWalletClient = ReturnType<typeof createWalletClient>;

/** A raw private key (seed wallets) or a signing account (hardware wallets). */
export type SignerKey = string | LocalAccount;

function normalizePrivateKey(priv: string): Hex {
  const hex = priv.startsWith("0x") ? priv : `0x${priv}`;
  return hex as Hex;
}

export function toLocalAccount(key: SignerKey): LocalAccount {
  return typeof key === "string"
    ? privateKeyToAccount(normalizePrivateKey(key))
    : key;
}

export function addressFromPrivateKey(priv: string): Address {
  return privateKeyToAccount(normalizePrivateKey(priv)).address;
}

export function makeWalletClient(
  key: SignerKey,
  publicClient: KohakuPublicClient,
  rpcUrl: string
): KohakuWalletClient {
  const account = toLocalAccount(key);
  return createWalletClient({
    account,
    chain: publicClient.chain as Chain,
    transport: http(rpcUrl),
  });
}

export function encodeContractCall(
  abi: Abi | readonly unknown[],
  functionName: string,
  args: readonly unknown[]
): Hex {
  return encodeFunctionData({
    abi: abi as Abi,
    functionName,
    args,
  });
}

export async function simulateCallOrThrow(
  client: KohakuPublicClient,
  tx: {
    to: Address | string;
    from: Address | string;
    data?: Hex | string;
    value?: bigint;
    gas?: bigint;
  },
  stepLabel: string
): Promise<void> {
  try {
    await client.call({
      to: tx.to as Address,
      account: tx.from as Address,
      data: (tx.data ?? "0x") as Hex,
      value: tx.value,
      gas: tx.gas,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${stepLabel} simulation failed: ${msg}`);
  }
}

export async function sendTransactionAndWait(
  walletClient: KohakuWalletClient,
  publicClient: KohakuPublicClient,
  tx: {
    to: Address | string;
    data?: Hex | string;
    value?: bigint;
    gas?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  }
): Promise<`0x${string}`> {
  const hash = await walletClient.sendTransaction({
    account: walletClient.account!,
    chain: walletClient.chain,
    to: tx.to as Address,
    data: (tx.data ?? "0x") as Hex,
    value: tx.value ?? 0n,
    gas: tx.gas,
    ...(tx.maxFeePerGas != null ? { maxFeePerGas: tx.maxFeePerGas } : {}),
    ...(tx.maxPriorityFeePerGas != null
      ? { maxPriorityFeePerGas: tx.maxPriorityFeePerGas }
      : {}),
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
