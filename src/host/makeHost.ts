import type { Host } from "@kohaku-eth/plugins";
import { viem as kohakuViemProvider } from "@kohaku-eth/provider/viem";

import { withChunkedGetLogs, withTransactionCount } from "./chunked-get-logs";
import { makeKeystore, makeRailgunKeystore } from "./keystore";
import { makeLedgerTornadoKeystore } from "./ledger-tornado.js";
import { makeStealthAccountsStorage } from "../lib/stealth/storage";
import { makeStorage, type PluginId } from "./storage";
import { noteProtocolStorageFreshness } from "../utils/first-sync";
import { tornadoExternalSyncForChain } from "../utils/saga-external-sync";
import { kohakuFetch } from "../utils/tor";
import type { KohakuPublicClient } from "../utils/rpc.js";
import {
  asWalletKeys,
  HardwareWalletUnsupportedError,
  type WalletKeys,
} from "../utils/wallet-keys.js";

export type MakeHostOptions = {
  rpc: KohakuPublicClient;
  walletDir: string;
  password: string;
  /** Mnemonic, or the wallet's keys (Ledger wallets support Tornado only). */
  mnemonic: string | WalletKeys;
  pluginId: PluginId;
  chainId?: bigint;
  externalSyncProvider?: Host["externalSyncProvider"];
};

function makeNetwork(): Host["network"] {
  if (typeof globalThis.fetch !== "function") {
    throw new Error(
      "global fetch is not available in this Node runtime; cannot satisfy Host.network"
    );
  }

  // Always use kohakuFetch so an active Tor session is picked up dynamically
  // (Host may be created before or during withTor).
  return {
    fetch: kohakuFetch,
  };
}

export async function makeHost(options: MakeHostOptions): Promise<Host> {
  const {
    rpc,
    walletDir,
    password,
    mnemonic,
    pluginId,
    chainId,
    externalSyncProvider: externalSyncProviderIn,
  } = options;

  // Before anything (notably the Privacy Pools bundled snapshot) can seed storage.
  noteProtocolStorageFreshness(walletDir, pluginId);

  const provider = withChunkedGetLogs(
    withTransactionCount(kohakuViemProvider(rpc))
  );

  const keys = asWalletKeys(mnemonic);
  if (keys.kind === "ledger" && pluginId !== "tc") {
    throw new HardwareWalletUnsupportedError();
  }
  const stealthStorage = makeStealthAccountsStorage(walletDir, password);
  const keystore =
    keys.kind === "ledger"
      ? makeLedgerTornadoKeystore(keys)
      : pluginId === "rg"
        ? makeRailgunKeystore(keys.mnemonic)
        : makeKeystore(keys.mnemonic, {
            stealthDelegatorPriv: (stealthIndex) =>
              stealthStorage.getAccount(stealthIndex)?.priv ?? null,
          });
  const network = makeNetwork();
  const externalSyncProvider =
    externalSyncProviderIn ??
    (pluginId === "tc" && chainId != null
      ? tornadoExternalSyncForChain(chainId, network)
      : undefined);

  return {
    network,
    storage: makeStorage(walletDir, pluginId, password),
    keystore,
    provider,
    ...(externalSyncProvider ? { externalSyncProvider } : {}),
  };
}
