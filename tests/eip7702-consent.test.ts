import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { isAddressEqual, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { recoverAuthorizationAddress } from "viem/utils";

import { ApduStatusError } from "../src/hw/apdu.js";
import { ledgerAccount } from "../src/hw/account.js";
import {
  appAcceptsDelegate,
  KOHAKU_ETH_APP_NAME,
  LedgerAppLacksDelegateError,
  OFFICIAL_ETH_APP_NAME,
} from "../src/hw/apps.js";
import type { LedgerEthApp } from "../src/hw/ledger-eth.js";
import {
  delegationPreviewLine,
  signDelegation,
} from "../src/utils/eip7702-consent.js";
import { SIMPLE_7702_IMPLEMENTATION } from "../src/utils/simple-7702.js";

const KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const OFFICIAL_DELEGATE: Address = "0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9";
const PATH = "m/44'/60'/0'/0/0";
const request = { address: SIMPLE_7702_IMPLEMENTATION, chainId: sepolia.id, nonce: 3 };

/** Device stand-in: signs with KEY, as the Ethereum app would. */
function fakeLedger(appName: string, opts: { refuse?: number } = {}) {
  const signer = privateKeyToAccount(KEY);
  let signCalls = 0;
  const app = {
    appName,
    async getAddress() {
      return signer.address;
    },
    async signAuthorization(_path: string, auth: { delegate: Address; chainId: bigint; nonce: bigint }) {
      signCalls++;
      if (opts.refuse) throw new ApduStatusError(opts.refuse);
      const { r, s, yParity } = await signer.signAuthorization({
        address: auth.delegate,
        chainId: Number(auth.chainId),
        nonce: Number(auth.nonce),
      });
      return { r, s, yParity: yParity! };
    },
  } as unknown as LedgerEthApp;
  const account = ledgerAccount(async () => app, PATH, signer.address);
  return { account, signCalls: () => signCalls };
}

describe("EIP-7702 delegate whitelists", () => {
  it("official app accepts only its own Simple7702 deployment", () => {
    assert.ok(appAcceptsDelegate(OFFICIAL_ETH_APP_NAME, OFFICIAL_DELEGATE));
    assert.ok(!appAcceptsDelegate(OFFICIAL_ETH_APP_NAME, SIMPLE_7702_IMPLEMENTATION));
  });

  it("Kohaku ETH accepts both deployments", () => {
    assert.ok(appAcceptsDelegate(KOHAKU_ETH_APP_NAME, OFFICIAL_DELEGATE));
    assert.ok(appAcceptsDelegate(KOHAKU_ETH_APP_NAME, SIMPLE_7702_IMPLEMENTATION));
  });
});

describe("signDelegation (non-interactive)", () => {
  const write = process.stderr.write.bind(process.stderr);
  let stderr = "";
  const captureStderr = () => {
    stderr = "";
    process.stderr.write = ((chunk: string) => {
      stderr += chunk;
      return true;
    }) as typeof process.stderr.write;
  };
  afterEach(() => {
    process.stderr.write = write;
  });

  it("states the delegation on stderr and signs with a seed key", async () => {
    const owner = privateKeyToAccount(KEY);
    captureStderr();
    const signed = await signDelegation({ owner, request, chain: sepolia, nonInteractive: true });
    process.stderr.write = write;
    assert.match(stderr, /EIP-7702: delegating 0x\w+ to Simple7702Account 0xe6Ca.* on Sepolia \(11155111\)/);
    assert.ok(isAddressEqual(await recoverAuthorizationAddress({ authorization: signed }), owner.address));
  });

  it("stops before the device when the official app is open", async () => {
    const { account, signCalls } = fakeLedger(OFFICIAL_ETH_APP_NAME);
    await assert.rejects(
      signDelegation({ owner: account, request, chain: sepolia, nonInteractive: true }),
      (e) => e instanceof LedgerAppLacksDelegateError && /sideloader/.test(e.message)
    );
    assert.equal(signCalls(), 0);
  });

  it("signs on the Kohaku ETH app", async () => {
    const { account, signCalls } = fakeLedger(KOHAKU_ETH_APP_NAME);
    captureStderr();
    const signed = await signDelegation({ owner: account, request, chain: sepolia, nonInteractive: true });
    process.stderr.write = write;
    assert.equal(signCalls(), 1);
    assert.ok(isAddressEqual(await recoverAuthorizationAddress({ authorization: signed }), account.address));
  });

  it("explains a refusal caused by the Smart accounts setting", async () => {
    const { account } = fakeLedger(KOHAKU_ETH_APP_NAME, { refuse: 0x6980 });
    captureStderr();
    await assert.rejects(
      signDelegation({ owner: account, request, chain: sepolia, nonInteractive: true }),
      /enable "Smart accounts"/
    );
  });
});

describe("delegationPreviewLine", () => {
  it("says whether --broadcast would delegate", () => {
    assert.match(delegationPreviewLine("0xabc", true), /--broadcast delegates 0xabc .* after asking you to confirm/);
    assert.match(delegationPreviewLine("0xabc", false), /already delegates/);
  });
});
