/**
 * EIP-7702 delegation turns an account into a smart account until it is
 * revoked, so the CLI never signs one silently: it says what gets delegated
 * where and asks first. For Ledger accounts it also checks that the open app
 * accepts the delegate, and only then asks the user to sideload the Kohaku
 * ETH app (the official app stays installed for everything else).
 */
import { log } from "@clack/prompts";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import {
  isAddressEqual,
  type Address,
  type AuthorizationRequest,
  type Chain,
  type LocalAccount,
  type SignedAuthorization,
} from "viem";

import {
  ApduStatusError,
  appAcceptsDelegate,
  closeSharedLedgerEthApp,
  KOHAKU_ETH_APP_NAME,
  KOHAKU_ETH_APP_SIDELOADER_URL,
  LedgerAppLacksDelegateError,
  ledgerAppOf,
  type LedgerEthApp,
} from "../hw/index.js";
import { SIMPLE_7702_IMPLEMENTATION } from "./simple-7702.js";

/** Ledger refusal when the app's "Smart accounts" setting is off. */
const SW_COMMAND_NOT_ALLOWED = 0x6980;

function delegateLabel(delegate: Address): string {
  return isAddressEqual(delegate, SIMPLE_7702_IMPLEMENTATION)
    ? `Simple7702Account ${delegate} (eth-infinitism, ERC-4337 EntryPoint v0.8)`
    : delegate;
}

async function retryOrCancel(message: string): Promise<void> {
  if (!(await confirm({ message, default: true }))) {
    throw new Error("Cancelled by user.");
  }
}

/** Interactive: guide the user to the Kohaku ETH app when the open app cannot sign. */
async function ensureLedgerAppAcceptsDelegate(
  getApp: () => Promise<LedgerEthApp>,
  delegate: Address,
  nonInteractive: boolean
): Promise<void> {
  for (;;) {
    let appName: string;
    try {
      appName = (await getApp()).appName;
    } catch (e) {
      if (nonInteractive) throw e;
      log.warn(e instanceof Error ? e.message : String(e));
      await retryOrCancel("Retry?");
      continue;
    }
    if (appAcceptsDelegate(appName, delegate)) return;
    if (nonInteractive) throw new LedgerAppLacksDelegateError(delegate, appName);

    log.warn(
      [
        `Your Ledger is running the official ${appName} app. Its EIP-7702 whitelist does not include`,
        `${delegate}, the Simple7702Account deployment Kohaku delegates to.`,
        `The "${KOHAKU_ETH_APP_NAME}" app accepts it and installs next to the official app, which stays as is:`,
        "",
        `  1. On the Ledger, quit the ${appName} app.`,
        `  2. In Chrome or Edge, open ${KOHAKU_ETH_APP_SIDELOADER_URL}`,
        `     and install "${KOHAKU_ETH_APP_NAME}" (the page covers the one-time device setup).`,
        `  3. Open ${KOHAKU_ETH_APP_NAME} on the Ledger and, in its settings, enable`,
        `     "Smart accounts" and "Blind signing".`,
      ].join("\n")
    );
    await retryOrCancel(`${KOHAKU_ETH_APP_NAME} is open on the Ledger. Continue?`);
    await closeSharedLedgerEthApp();
  }
}

/** States the delegation and asks for consent (stderr notice when non-interactive). */
async function confirmDelegation(opts: {
  account: Address;
  delegate: Address;
  chain: Chain;
  ledger: boolean;
  nonInteractive: boolean;
}): Promise<void> {
  const chain = `${opts.chain.name} (${opts.chain.id})`;
  if (opts.nonInteractive) {
    process.stderr.write(
      `EIP-7702: delegating ${opts.account} to ${delegateLabel(opts.delegate)} on ${chain}.\n`
    );
    return;
  }
  log.warn(
    [
      chalk.bold("EIP-7702 delegation"),
      `  Account   ${opts.account}`,
      `  Delegate  ${delegateLabel(opts.delegate)}`,
      `  Chain     ${chain}`,
      "The account becomes a smart account running that code. It keeps its",
      "address and key, and only signatures from this key can make it execute",
      "calls. The delegation stays until it is revoked.",
      ...(opts.ledger
        ? ["Confirm on the Ledger: it shows the delegate as Simple7702Account."]
        : []),
    ].join("\n")
  );
  if (!(await confirm({ message: "Sign this EIP-7702 delegation?", default: false }))) {
    throw new Error("Cancelled by user.");
  }
}

/**
 * The one place the CLI signs an EIP-7702 authorization: checks the Ledger
 * app when needed, asks for consent, then signs.
 */
export async function signDelegation(opts: {
  owner: LocalAccount;
  request: AuthorizationRequest & { address: Address };
  chain: Chain;
  nonInteractive: boolean;
}): Promise<SignedAuthorization> {
  const { owner, request, nonInteractive } = opts;
  if (!owner.signAuthorization) {
    throw new Error(`Account ${owner.address} cannot sign EIP-7702 authorizations.`);
  }
  const getLedgerApp = ledgerAppOf(owner);
  const ledger = getLedgerApp !== undefined;
  if (getLedgerApp) {
    await ensureLedgerAppAcceptsDelegate(getLedgerApp, request.address, nonInteractive);
  }
  await confirmDelegation({
    account: owner.address,
    delegate: request.address,
    chain: opts.chain,
    ledger,
    nonInteractive,
  });

  for (;;) {
    try {
      return await owner.signAuthorization(request);
    } catch (e) {
      const settingOff =
        ledger && e instanceof ApduStatusError && e.statusWord === SW_COMMAND_NOT_ALLOWED;
      if (!settingOff) throw e;
      const message = `The Ledger refused: enable "Smart accounts" in the ${KOHAKU_ETH_APP_NAME} app settings.`;
      if (nonInteractive) throw new Error(message);
      log.warn(message);
      await retryOrCancel("Enabled. Retry?");
    }
  }
}

/** Dry-run line: what `--broadcast` would delegate (consent is asked then). */
export function delegationPreviewLine(account: string, needsDelegation: boolean): string {
  return needsDelegation
    ? `EIP-7702: --broadcast delegates ${account} to ${delegateLabel(SIMPLE_7702_IMPLEMENTATION)}, after asking you to confirm.`
    : `EIP-7702: ${account} already delegates to ${delegateLabel(SIMPLE_7702_IMPLEMENTATION)}.`;
}
