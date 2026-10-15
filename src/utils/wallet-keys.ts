/**
 * What unlocks a wallet: an encrypted BIP-39 seed, or a hardware wallet whose
 * keys never leave the device.
 *
 * A hardware wallet stores only the extended public key of m/44'/60'/0'/0,
 * encrypted with the wallet password like the seed file. Public addresses
 * derive on the host from it; the device is needed only to sign.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ProjectivePoint } from "@noble/secp256k1";
import { Mnemonic } from "derive-railgun-keys";
import { bytesToHex, hexToBytes, type Address, type Hex } from "viem";
import { HDKey, publicKeyToAddress } from "viem/accounts";

import { lazyLedgerAccount, openLedgerEthApp } from "../hw/index.js";
import {
  decrypt,
  encrypt,
  generateSalt,
  isEncryptedEnvelopeV1,
  type EncryptedEnvelopeV1,
} from "./aes-storage";
import { addressFromPrivateKey, type SignerKey } from "./viem-tx.js";

export const HARDWARE_WALLET_FILENAME = ".hardware-wallet.json";
const HARDWARE_KIND = "kohaku-cli/hardware" as const;
const DOC_VERSION = 1 as const;

/** Parent of the public accounts m/44'/60'/0'/0/<index>. */
export const PUBLIC_ACCOUNTS_PARENT_PATH = "m/44'/60'/0'/0";

export type LedgerKeys = {
  kind: "ledger";
  /** Uncompressed secp256k1 public key of PUBLIC_ACCOUNTS_PARENT_PATH. */
  publicKey: Hex;
  chainCode: Hex;
};

export type WalletKeys = { kind: "seed"; mnemonic: string } | LedgerKeys;

type HardwareWalletDocV1 = {
  kind: typeof HARDWARE_KIND;
  version: typeof DOC_VERSION;
  device: "ledger";
  /** Encrypted JSON `{ publicKey, chainCode }`; see `aes-storage.ts`. */
  crypto: EncryptedEnvelopeV1;
};

/** Thrown when a seed-only operation is attempted on a hardware wallet. */
export class HardwareWalletUnsupportedError extends Error {
  constructor() {
    super(
      "This is a Ledger wallet: this command needs the seed, which stays on the device. It is not supported for hardware wallets yet."
    );
    this.name = "HardwareWalletUnsupportedError";
  }
}

export function isHardwareWallet(walletDir: string): boolean {
  return existsSync(join(walletDir, HARDWARE_WALLET_FILENAME));
}

export function writeHardwareWallet(
  keys: LedgerKeys,
  password: string,
  walletDir: string
): void {
  const filePath = join(walletDir, HARDWARE_WALLET_FILENAME);
  if (existsSync(filePath)) {
    throw new Error(`File at ${filePath} already exists. Refusing to overwrite.`);
  }
  const payload = JSON.stringify({
    publicKey: keys.publicKey,
    chainCode: keys.chainCode,
  });
  const doc: HardwareWalletDocV1 = {
    kind: HARDWARE_KIND,
    version: DOC_VERSION,
    device: "ledger",
    crypto: encrypt(payload, password, generateSalt()),
  };
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(doc, null, 2), { encoding: "utf-8" });
}

export function readHardwareWallet(password: string, walletDir: string): LedgerKeys {
  const parsed = JSON.parse(
    readFileSync(join(walletDir, HARDWARE_WALLET_FILENAME), "utf-8")
  ) as Partial<HardwareWalletDocV1>;
  if (
    parsed.kind !== HARDWARE_KIND ||
    parsed.version !== DOC_VERSION ||
    parsed.device !== "ledger" ||
    !isEncryptedEnvelopeV1(parsed.crypto)
  ) {
    throw new Error("Invalid or unsupported hardware wallet file");
  }
  let payload: { publicKey: Hex; chainCode: Hex };
  try {
    payload = JSON.parse(decrypt(parsed.crypto, password));
  } catch {
    throw new Error("Invalid wallet password.");
  }
  return { kind: "ledger", ...payload };
}

/** Accepts the legacy bare mnemonic so seed-only callers stay unchanged. */
export function asWalletKeys(keys: string | WalletKeys): WalletKeys {
  return typeof keys === "string" ? { kind: "seed", mnemonic: keys } : keys;
}

export function publicAccountPath(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error(`Invalid public account index: ${index}`);
  }
  return `${PUBLIC_ACCOUNTS_PARENT_PATH}/${index}`;
}

/** Address of m/44'/60'/0'/0/<index> from the stored extended public key. */
export function ledgerAddressAt(keys: LedgerKeys, index: number): Address {
  const compressed = ProjectivePoint.fromHex(keys.publicKey.slice(2)).toRawBytes(true);
  const child = new HDKey({
    publicKey: compressed,
    chainCode: hexToBytes(keys.chainCode),
  }).deriveChild(index);
  const uncompressed = ProjectivePoint.fromHex(child.publicKey!).toRawBytes(false);
  return publicKeyToAddress(bytesToHex(uncompressed));
}

/**
 * Reads the account xpub from the Ledger and checks that host-side derivation
 * reproduces the device's own first address.
 */
export async function readLedgerKeys(): Promise<LedgerKeys> {
  const app = await openLedgerEthApp();
  try {
    const xpub = await app.getExtendedPublicKey(PUBLIC_ACCOUNTS_PARENT_PATH);
    const keys: LedgerKeys = { kind: "ledger", ...xpub };
    const onDevice = await app.getAddress(publicAccountPath(0));
    if (onDevice !== ledgerAddressAt(keys, 0)) {
      throw new Error(
        `Device address ${onDevice} does not match the one derived from its public key. Refusing to create the wallet.`
      );
    }
    return keys;
  } finally {
    await app.close();
  }
}

export function publicAddressAt(keys: WalletKeys, index: number): Address {
  return keys.kind === "ledger"
    ? ledgerAddressAt(keys, index)
    : (addressFromPrivateKey(
        Mnemonic.to0xPrivateKeyByIndex(keys.mnemonic, index)
      ) as Address);
}

/**
 * Signing key for public account `index`: the stored private key for seed
 * wallets, or a Ledger account that opens the device on first signature.
 */
export function signerFor(
  keys: WalletKeys,
  index: number,
  address: string,
  priv: string
): SignerKey {
  if (keys.kind === "seed") {
    return priv || Mnemonic.to0xPrivateKeyByIndex(keys.mnemonic, index);
  }
  return lazyLedgerAccount(publicAccountPath(index), address as Address);
}
