import type { Address, LocalAccount } from "viem";

import { ledgerAccount } from "./account.js";
import type { ApduTransport } from "./apdu.js";
import { isSupportedLedgerApp } from "./apps.js";
import { LedgerEthApp } from "./ledger-eth.js";
import { openLedgerHidraw } from "./ledger-hid.js";
import { openSpeculos } from "./speculos.js";

export { ApduStatusError } from "./apdu.js";
export { ledgerAccount, ledgerAppOf } from "./account.js";
export * from "./apps.js";
export { LedgerEthApp } from "./ledger-eth.js";

/**
 * `KOHAKU_LEDGER_SPECULOS=host:port` points the CLI at a Speculos emulator
 * instead of a USB device.
 */
async function openTransport(): Promise<ApduTransport> {
  const speculos = process.env.KOHAKU_LEDGER_SPECULOS?.trim();
  if (speculos) {
    const [host, port] = speculos.split(":");
    return openSpeculos(host || "127.0.0.1", Number(port || 9999));
  }
  return openLedgerHidraw();
}

/** Opens the Ledger and checks that the Ethereum (or Kohaku ETH) app is running. */
export async function openLedgerEthApp(): Promise<LedgerEthApp> {
  const app = new LedgerEthApp(await openTransport());
  try {
    const { name } = await app.appInfo();
    if (!isSupportedLedgerApp(name)) {
      throw new Error(
        name === "BOLOS"
          ? "Open the Ethereum app on your Ledger."
          : `Open the Ethereum app on your Ledger (currently open: ${name}).`
      );
    }
    app.appName = name;
  } catch (e) {
    await app.close();
    throw e;
  }
  return app;
}

let shared: Promise<LedgerEthApp> | null = null;

/** One device session per process, opened on first use. */
export function sharedLedgerEthApp(): Promise<LedgerEthApp> {
  shared ??= openLedgerEthApp().catch((e) => {
    shared = null;
    throw e;
  });
  return shared;
}

export async function closeSharedLedgerEthApp(): Promise<void> {
  const app = shared;
  shared = null;
  await (await app?.catch(() => null))?.close();
}

/** Ledger account for `path` that touches the device only when it signs. */
export function lazyLedgerAccount(path: string, address: Address): LocalAccount {
  return ledgerAccount(sharedLedgerEthApp, path, address);
}
