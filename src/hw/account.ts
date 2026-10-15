/**
 * A viem LocalAccount backed by the Ledger Ethereum app, so wallet clients,
 * Simple7702 smart accounts and the rest of the CLI can use it like a
 * private-key account.
 *
 * The device is opened on the first signature, and its address for `path` is
 * checked against `address` before anything is shown on screen. Every
 * signature's parity is also recovered against `address`.
 */
import {
  getTypesForEIP712Domain,
  hashDomain,
  hashMessage,
  hashStruct,
  hashTypedData,
  hexToBytes,
  isAddressEqual,
  keccak256,
  recoverAddress,
  serializeSignature,
  serializeTransaction,
  stringToBytes,
  type Address,
  type Hash,
  type Hex,
  type LocalAccount,
  type TypedDataDefinition,
} from "viem";
import { toAccount } from "viem/accounts";
import { recoverAuthorizationAddress } from "viem/utils";

import { appAcceptsDelegate, LedgerAppLacksDelegateError } from "./apps.js";
import type { LedgerEthApp, LedgerSignature } from "./ledger-eth.js";

async function parityFor(
  hash: Hash,
  sig: { r: Hex; s: Hex },
  expected: Address
): Promise<number> {
  for (const yParity of [0, 1]) {
    const signer = await recoverAddress({ hash, signature: { ...sig, yParity } });
    if (isAddressEqual(signer, expected)) return yParity;
  }
  throw new Error(
    `Ledger signature does not recover to ${expected}. Is the right seed or passphrase active on the device?`
  );
}

async function toSignature(
  hash: Hash,
  sig: LedgerSignature,
  expected: Address
): Promise<Hex> {
  const yParity = await parityFor(hash, sig, expected);
  return serializeSignature({ r: sig.r, s: sig.s, yParity });
}

export function ledgerAccount(
  getApp: () => Promise<LedgerEthApp>,
  path: string,
  address: Address
): LocalAccount {
  // Checked again after a reconnect, e.g. when the user switched apps.
  let verified: LedgerEthApp | null = null;
  const ready = async () => {
    const app = await getApp();
    if (verified !== app) {
      const onDevice = await app.getAddress(path);
      if (!isAddressEqual(onDevice, address)) {
        throw new Error(
          `This Ledger derives ${onDevice} at ${path}, not ${address}. Wrong device, seed or passphrase?`
        );
      }
      verified = app;
    }
    return app;
  };

  const account = toAccount({
    address,

    async signMessage({ message }) {
      const app = await ready();
      const bytes =
        typeof message === "string"
          ? stringToBytes(message)
          : typeof message.raw === "string"
            ? hexToBytes(message.raw)
            : message.raw;
      const sig = await app.signPersonalMessage(path, bytes);
      return toSignature(hashMessage(message), sig, address);
    },

    async signTransaction(transaction, options) {
      const app = await ready();
      const serializer = options?.serializer ?? serializeTransaction;
      const unsigned = await serializer(transaction);
      const sig = await app.signTransaction(path, hexToBytes(unsigned));
      const yParity = await parityFor(keccak256(unsigned), sig, address);
      return serializer(transaction, {
        r: sig.r,
        s: sig.s,
        yParity,
        v: 27n + BigInt(yParity),
      });
    },

    async signTypedData(parameters) {
      const app = await ready();
      const { domain = {}, message, primaryType } =
        parameters as TypedDataDefinition;
      if (primaryType === "EIP712Domain") {
        throw new Error("Ledger cannot sign a bare EIP712Domain");
      }
      const types = {
        EIP712Domain: getTypesForEIP712Domain({ domain }),
        ...parameters.types,
      } as Record<string, readonly { name: string; type: string }[]>;
      const domainHash = hashDomain({ domain, types });
      const messageHash = hashStruct({
        data: message as Record<string, unknown>,
        primaryType: primaryType as string,
        types,
      });
      const sig = await app.signTypedDataHashes(
        path,
        hexToBytes(domainHash),
        hexToBytes(messageHash)
      );
      return toSignature(
        hashTypedData(parameters as TypedDataDefinition),
        sig,
        address
      );
    },

    async signAuthorization(parameters) {
      const app = await ready();
      const delegate = parameters.contractAddress ?? parameters.address;
      if (!appAcceptsDelegate(app.appName, delegate)) {
        throw new LedgerAppLacksDelegateError(delegate, app.appName);
      }
      const { chainId, nonce } = parameters;
      const sig = await app.signAuthorization(path, {
        delegate,
        chainId: BigInt(chainId),
        nonce: BigInt(nonce),
      });
      const signed = {
        address: delegate,
        chainId,
        nonce,
        r: sig.r,
        s: sig.s,
        yParity: sig.yParity,
      };
      const signer = await recoverAuthorizationAddress({ authorization: signed });
      if (!isAddressEqual(signer, address)) {
        throw new Error(
          `Ledger authorization does not recover to ${address}. Is the right seed or passphrase active on the device?`
        );
      }
      return signed;
    },
  });
  ledgerAccounts.set(account, getApp);
  return account;
}

const ledgerAccounts = new WeakMap<object, () => Promise<LedgerEthApp>>();

/** The device behind a Ledger account, or undefined for any other account. */
export function ledgerAppOf(account: object): (() => Promise<LedgerEthApp>) | undefined {
  return ledgerAccounts.get(account);
}
