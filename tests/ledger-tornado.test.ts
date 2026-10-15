import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SecretManager } from "@kohaku-eth/tornado-cash";
import {
  hexToBigInt,
  numberToHex,
  parseSignature,
  serializeSignature,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

import {
  makeLedgerTornadoKeystore,
  TORNADO_UNLOCK_MESSAGE,
  tornadoRootFromSignature,
  tornadoSecretAt,
} from "../src/host/ledger-tornado.js";
import { HardwareWalletUnsupportedError, type LedgerKeys } from "../src/utils/wallet-keys.js";

const MNEMONIC = "test test test test test test test test test test test junk";
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const POOL = BigInt("0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc");

async function seedUnlockSignature(): Promise<Hex> {
  return mnemonicToAccount(MNEMONIC).signMessage({ message: TORNADO_UNLOCK_MESSAGE });
}

describe("TORNADO_UNLOCK_MESSAGE", () => {
  it("is printable ASCII, so the device shows the text rather than a hash", () => {
    assert.match(TORNADO_UNLOCK_MESSAGE, /^[\x20-\x7e]+$/);
  });

  it("tells the signer the signature leaves the device", () => {
    assert.match(TORNADO_UNLOCK_MESSAGE, /leaves the device/);
    assert.match(TORNADO_UNLOCK_MESSAGE, /only purpose is making them recoverable/);
  });
});

describe("tornadoRootFromSignature", () => {
  it("ignores s normalization and the recovery bit", async () => {
    const sig = await seedUnlockSignature();
    const { r, s, yParity } = parseSignature(sig);
    const highS = serializeSignature({
      r,
      s: numberToHex(N - hexToBigInt(s), { size: 32 }),
      yParity: yParity === 0 ? 1 : 0,
    });
    assert.equal(tornadoRootFromSignature(highS), tornadoRootFromSignature(sig));
  });

  it("depends on the signature", async () => {
    const other = await mnemonicToAccount(MNEMONIC, { addressIndex: 1 }).signMessage({
      message: TORNADO_UNLOCK_MESSAGE,
    });
    assert.notEqual(tornadoRootFromSignature(other), tornadoRootFromSignature(await seedUnlockSignature()));
  });
});

describe("Ledger Tornado secrets", () => {
  it("gives every SDK path its own secret", async () => {
    const root = tornadoRootFromSignature(await seedUnlockSignature());
    const a = tornadoSecretAt(root, "m/29795'/1'/0'/0'/0'");
    const b = tornadoSecretAt(root, "m/29795'/1'/0'/1'/0'");
    assert.notEqual(a, b);
    assert.equal(a, tornadoSecretAt(root, "m/29795'/1'/0'/0'/0'"));
  });

  it("feeds the Tornado SDK's note derivation", async () => {
    const root = tornadoRootFromSignature(await seedUnlockSignature());
    const manager = await SecretManager({
      host: { keystore: { deriveAt: async (path: string) => tornadoSecretAt(root, path) } },
      accountIndex: 0,
    });
    const first = await manager.getDepositSecrets({ chainId: 11155111n, poolAddress: POOL, depositIndex: 0 });
    const again = await manager.getDepositSecrets({ chainId: 11155111n, poolAddress: POOL, depositIndex: 0 });
    const second = await manager.getDepositSecrets({ chainId: 11155111n, poolAddress: POOL, depositIndex: 1 });
    assert.equal(first.commitment, again.commitment);
    assert.notEqual(first.commitment, second.commitment);
  });

  it("refuses wallet-account paths without touching the device", async () => {
    const keys = { kind: "ledger", publicKey: "0x04", chainCode: "0x00" } as LedgerKeys;
    await assert.rejects(
      makeLedgerTornadoKeystore(keys).deriveAt("m/44'/60'/0'/0/3"),
      (e) => e instanceof HardwareWalletUnsupportedError
    );
  });
});
