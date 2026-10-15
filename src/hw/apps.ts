/**
 * Which Ledger app can sign what. Both run the same Ethereum app code, but
 * EIP-7702 delegation is limited to each app's whitelist: the official app
 * accepts one Simple7702Account deployment, while the Kohaku SDKs delegate to
 * another deployment of the same contract, which only the "Kohaku ETH" build
 * (an app-ethereum fork, sideloaded beside the official app) accepts.
 */
import { isAddressEqual, type Address } from "viem";

import { SIMPLE_7702_IMPLEMENTATION } from "../utils/simple-7702.js";

export const OFFICIAL_ETH_APP_NAME = "Ethereum";
export const KOHAKU_ETH_APP_NAME = "Kohaku ETH";
export const KOHAKU_ETH_APP_SIDELOADER_URL = "https://zknox.netlify.app/sideloader.html";

/** EIP-7702 whitelist of the official Ethereum app (all chains). */
const OFFICIAL_7702_DELEGATES: readonly Address[] = [
  "0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9",
];
const KOHAKU_7702_DELEGATES: readonly Address[] = [
  ...OFFICIAL_7702_DELEGATES,
  SIMPLE_7702_IMPLEMENTATION,
];

export function isSupportedLedgerApp(name: string): boolean {
  return name === OFFICIAL_ETH_APP_NAME || name === KOHAKU_ETH_APP_NAME;
}

export function appAcceptsDelegate(appName: string, delegate: Address): boolean {
  const whitelist =
    appName === KOHAKU_ETH_APP_NAME ? KOHAKU_7702_DELEGATES : OFFICIAL_7702_DELEGATES;
  return whitelist.some((d) => isAddressEqual(d, delegate));
}

/** Raised before anything is shown on the device. */
export class LedgerAppLacksDelegateError extends Error {
  readonly delegate: Address;
  readonly appName: string;
  constructor(delegate: Address, appName: string) {
    super(
      `The ${appName} app on your Ledger cannot delegate to ${delegate}. ` +
        `Install the ${KOHAKU_ETH_APP_NAME} app (${KOHAKU_ETH_APP_SIDELOADER_URL}), open it and retry.`
    );
    this.name = "LedgerAppLacksDelegateError";
    this.delegate = delegate;
    this.appName = appName;
  }
}
