/**
 * Tornado Cash note secrets for Ledger wallets.
 *
 * The device will not export the BIP-32 keys seed wallets derive notes from,
 * so notes derive from one personal_sign of a fixed message instead. The
 * Ethereum app signs with RFC 6979 nonces, so the same seed always produces
 * the same signature and the same notes: they stay recoverable from the seed.
 *
 * This buys recoverability only, not device protection: the signature leaves
 * the device, and whoever holds it can spend every note. The message says so
 * on the device. The resulting root lives in memory for one CLI run; signing
 * it again costs one confirmation on the device.
 */
import type { Keystore } from "@kohaku-eth/plugins";
import {
  concat,
  hexToBigInt,
  keccak256,
  numberToHex,
  parseSignature,
  stringToHex,
  type Address,
  type Hex,
} from "viem";

import { lazyLedgerAccount } from "../hw/index.js";
import {
  HardwareWalletUnsupportedError,
  ledgerAddressAt,
  publicAccountPath,
  type LedgerKeys,
} from "../utils/wallet-keys.js";

/**
 * Shown in full on the device; changing it changes every derived note. Plain
 * ASCII, or the app shows a hash instead of the text.
 */
export const TORNADO_UNLOCK_MESSAGE =
  "Kohaku: unlock Tornado Cash notes (v1). This signature leaves the device: " +
  "the computer derives your notes from it. Its only purpose is making them " +
  "recoverable from this seed. Anyone holding it can spend them. Sign only in kohaku-cli.";

/** Parent of the Tornado SDK's note paths (`TORNADO_CASH_PATH`, not exported). */
const TORNADO_CASH_PATH = "m/29795'/1'";

const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * Root secret from the unlock signature. Uses r and the low-s form of s, so
 * signers that differ only in s normalization agree; the recovery bit is
 * ignored.
 */
export function tornadoRootFromSignature(signature: Hex): Hex {
  const { r, s } = parseSignature(signature);
  const sValue = hexToBigInt(s);
  const lowS = sValue > SECP256K1_N / 2n ? SECP256K1_N - sValue : sValue;
  return keccak256(
    concat([stringToHex("kohaku/tornado-notes/v1"), r, numberToHex(lowS, { size: 32 })])
  );
}

/** Secret for one SDK path: keccak256(root || path). */
export function tornadoSecretAt(root: Hex, path: string): Hex {
  return keccak256(concat([root, stringToHex(path)]));
}

const roots = new Map<Address, Promise<Hex>>();

/** One device confirmation per run, signed by public account 0. */
function ledgerTornadoRoot(keys: LedgerKeys): Promise<Hex> {
  const address = ledgerAddressAt(keys, 0);
  let root = roots.get(address);
  if (!root) {
    root = (async () => {
      process.stderr.write(
        "Ledger: approve the \"Kohaku: unlock Tornado Cash notes\" message on the device.\n" +
          "The signature is sent to this computer, which derives your Tornado notes from it. " +
          "It keeps them recoverable from your seed; it does not keep them on the device.\n"
      );
      const signature = await lazyLedgerAccount(publicAccountPath(0), address).signMessage({
        message: TORNADO_UNLOCK_MESSAGE,
      });
      return tornadoRootFromSignature(signature);
    })();
    root.catch(() => roots.delete(address));
    roots.set(address, root);
  }
  return root;
}

/**
 * Keystore for the Tornado plugin on a Ledger wallet. Only note paths are
 * served; wallet-account paths (used to sign multi-note consolidations) need
 * keys that stay on the device.
 */
export function makeLedgerTornadoKeystore(keys: LedgerKeys): Keystore {
  return {
    async deriveAt(path: string): Promise<Hex> {
      if (!path.startsWith(`${TORNADO_CASH_PATH}/`)) {
        throw new HardwareWalletUnsupportedError();
      }
      return tornadoSecretAt(await ledgerTornadoRoot(keys), path);
    },
  };
}
