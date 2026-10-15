import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ProjectivePoint } from "@noble/secp256k1";
import { Mnemonic } from "derive-railgun-keys";
import { bytesToHex, isAddressEqual } from "viem";
import { mnemonicToAccount } from "viem/accounts";

import { encodeBip32Path } from "../src/hw/apdu.js";
import { FrameReassembler, wrapApdu } from "../src/hw/ledger-hid.js";
import { resolveShieldSender } from "../src/lib/shield-flow.js";
import { readSeedKeystore, readWalletKeys } from "../src/utils/mnemonic.js";
import { makePublicAccountsStorage } from "../src/utils/public-accounts.js";
import { addressFromPrivateKey } from "../src/utils/viem-tx.js";
import {
  HardwareWalletUnsupportedError,
  ledgerAddressAt,
  PUBLIC_ACCOUNTS_PARENT_PATH,
  writeHardwareWallet,
  type LedgerKeys,
} from "../src/utils/wallet-keys.js";
import { listWalletDirNames } from "../src/utils/wallets-util.js";

const MNEMONIC = "test test test test test test test test test test test junk";

/** What a Ledger holding MNEMONIC returns for m/44'/60'/0'/0. */
function ledgerKeysFor(mnemonic: string): LedgerKeys {
  const hd = mnemonicToAccount(mnemonic, { path: PUBLIC_ACCOUNTS_PARENT_PATH as `m/44'/60'/${string}` }).getHdKey();
  return {
    kind: "ledger",
    publicKey: bytesToHex(ProjectivePoint.fromHex(hd.publicKey!).toRawBytes(false)),
    chainCode: bytesToHex(hd.chainCode!),
  };
}

describe("encodeBip32Path", () => {
  it("encodes hardened and normal segments big-endian", () => {
    assert.equal(
      bytesToHex(encodeBip32Path("m/44'/60'/0'/0/5")),
      "0x058000002c8000003c800000000000000000000005"
    );
  });

  it("rejects malformed paths", () => {
    assert.throws(() => encodeBip32Path("m/"));
    assert.throws(() => encodeBip32Path("m/44'/x"));
    assert.throws(() => encodeBip32Path("m/2147483648"));
  });
});

describe("Ledger HID framing", () => {
  it("round-trips a multi-frame APDU", () => {
    const apdu = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
    const frames = wrapApdu(apdu);
    // 2 length bytes + 300 data bytes over 59-byte frame bodies.
    assert.equal(frames.length, Math.ceil(302 / 59));
    assert.ok(frames.every((f) => f.length === 64));
    assert.deepEqual([...frames[1]!.subarray(0, 5)], [0x01, 0x01, 0x05, 0x00, 0x01]);

    const reassembler = new FrameReassembler();
    let out: Uint8Array | null = null;
    for (const f of frames) out = reassembler.push(f);
    assert.deepEqual(out, apdu);
  });

  it("rejects out-of-order frames", () => {
    const frames = wrapApdu(new Uint8Array(100));
    const reassembler = new FrameReassembler();
    assert.throws(() => reassembler.push(frames[1]!), /out of order/);
  });
});

describe("ledgerAddressAt", () => {
  it("matches seed derivation of m/44'/60'/0'/0/i", () => {
    const keys = ledgerKeysFor(MNEMONIC);
    for (const i of [0, 1, 2, 7, 1000]) {
      const fromSeed = addressFromPrivateKey(Mnemonic.to0xPrivateKeyByIndex(MNEMONIC, i));
      assert.ok(isAddressEqual(ledgerAddressAt(keys, i), fromSeed), `index ${i}`);
    }
  });
});

describe("hardware wallet storage", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kohaku-hw-"));
  const walletDir = join(dataDir, "nano");
  const keys = ledgerKeysFor(MNEMONIC);
  writeHardwareWallet(keys, "pw", walletDir);
  after(() => rmSync(dataDir, { recursive: true, force: true }));

  it("unlocks with the password and rejects a wrong one", () => {
    assert.deepEqual(readWalletKeys("pw", walletDir), keys);
    assert.throws(() => readWalletKeys("nope", walletDir), /Invalid wallet password/);
  });

  it("refuses seed-only operations with a dedicated error", () => {
    assert.throws(
      () => readSeedKeystore("pw", walletDir),
      (e) => e instanceof HardwareWalletUnsupportedError
    );
  });

  it("is listed among wallets", () => {
    assert.deepEqual(listWalletDirNames(dataDir), ["nano"]);
  });

  it("derives public accounts without private keys", () => {
    const [a0, a1] = makePublicAccountsStorage(walletDir, keys, "pw").addNextAccounts(2);
    assert.equal(a0!.priv, "");
    assert.ok(isAddressEqual(a1!.address as `0x${string}`, ledgerAddressAt(keys, 1)));
  });

  it("resolves a sender to a device-backed account without touching the device", () => {
    const { senderAddress, senderKey } = resolveShieldSender({
      fromValue: "1",
      walletDir,
      mnemonic: keys,
      password: "pw",
      dryRun: false,
      allowDeriveFromMnemonic: false,
    });
    assert.ok(isAddressEqual(senderAddress as `0x${string}`, ledgerAddressAt(keys, 1)));
    assert.equal(typeof senderKey, "object");
    assert.ok(isAddressEqual((senderKey as { address: `0x${string}` }).address, senderAddress as `0x${string}`));
  });
});
