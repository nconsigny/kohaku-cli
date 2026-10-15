import type { Command } from "commander";

import { cliOptions, passwordFileOption } from "../utils/cli-command-options";
import { cliError, cliErrorFromCaught } from "../utils/cli-errors";
import { makePublicAccountsStorage } from "../utils/public-accounts";
import { DEFAULT_DATA_DIR } from "../utils/rpc";
import {
  resolveWalletDir,
  resolveWalletNameOrPrompt,
  resolveWalletPassword,
} from "../utils/wallets-util";
import { readWalletKeys } from "../utils/mnemonic";
import { publicAccountPath, type WalletKeys } from "../utils/wallet-keys.js";
import { closeSharedLedgerEthApp, sharedLedgerEthApp } from "../hw/index.js";

type NextFreshAddressOpts = {
  wallet?: string;
  password?: string;
  passwordFile?: string;
  peek?: boolean;
  verify?: boolean;
  nonInteractive?: boolean;
  dataDir?: string;
};

export function registerNextFreshAddressCommand(program: Command): void {
  program
    .command("next-fresh-address")
    .description("Generate and persist the next public account address")
    .option("--wallet <name>", cliOptions.walletPickList)
    .option("--password <password>", cliOptions.password)
    .addOption(passwordFileOption())
    .option(
      "--peek",
      "Print the next fresh address without persisting it (useful for crafting payloads before --next)"
    )
    .option(
      "--verify",
      "Ledger wallets: also display the address on the device and check it matches"
    )
    .option("--non-interactive", cliOptions.nonInteractiveCompact)
    .option("--dataDir <path>", cliOptions.dataDir)
    .action(async (opts: NextFreshAddressOpts) => {
      const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
      const walletName = await resolveWalletNameOrPrompt({
        dataDir,
        wallet: opts.wallet,
        nonInteractive: opts.nonInteractive,
      });
      if (!walletName) return;

      let walletDir: string;
      try {
        walletDir = resolveWalletDir(dataDir, walletName);
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }

      const password = await resolveWalletPassword({
        flagPassword: opts.password,
        flagPasswordFile: opts.passwordFile,
        nonInteractive: opts.nonInteractive,
        validate: (candidate) => {
          readWalletKeys(candidate, walletDir);
        },
      });
      if (!password) return;

      let walletKeys: WalletKeys;
      try {
        walletKeys = readWalletKeys(password, walletDir);
      } catch (e) {
        cliErrorFromCaught(e);
        return;
      }
      if (opts.verify && walletKeys.kind !== "ledger") {
        cliError("--verify only applies to hardware wallets.");
        return;
      }

      const storage = makePublicAccountsStorage(walletDir, walletKeys, password);
      const [next] = storage.peekNextAccounts(1);

      if (opts.verify) {
        try {
          const app = await sharedLedgerEthApp();
          const onDevice = await app.getAddress(publicAccountPath(next!.index), {
            display: true,
          });
          if (onDevice !== next!.address) {
            cliError(
              `Device shows ${onDevice} but this wallet derives ${next!.address}. Do not use either; check the device and passphrase.`
            );
            return;
          }
        } catch (e) {
          cliErrorFromCaught(e);
          return;
        } finally {
          await closeSharedLedgerEthApp();
        }
      }

      const account = opts.peek ? next! : storage.addNextAccounts(1)[0]!;
      console.log(account.address);
    });
}
