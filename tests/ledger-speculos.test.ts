/**
 * Ledger Ethereum app end to end, against the Speculos emulator. Opt-in:
 *
 *   KOHAKU_TEST_SPECULOS=1 npm test
 *
 * expects Speculos with the default seed on 127.0.0.1:9999 (APDU) and
 * http://127.0.0.1:5000 (REST, override with KOHAKU_SPECULOS_API), running a
 * Nano S+ build of either the official Ethereum app or the Kohaku ETH fork
 * (whose EIP-7702 whitelist adds SIMPLE_7702_IMPLEMENTATION). Button presses
 * go through the REST API, so no human is needed.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  createPublicClient,
  custom,
  isAddressEqual,
  parseEther,
  recoverAddress,
  recoverTransactionAddress,
  verifyMessage,
  verifyTypedData,
  type Address,
} from "viem";
import {
  getUserOperationHash,
  toSimple7702SmartAccount,
} from "viem/account-abstraction";
import { mnemonicToAccount, type PrivateKeyAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { recoverAuthorizationAddress } from "viem/utils";

import { ApduStatusError } from "../src/hw/apdu.js";
import { ledgerAccount } from "../src/hw/account.js";
import {
  isSupportedLedgerApp,
  KOHAKU_ETH_APP_NAME,
  LedgerAppLacksDelegateError,
} from "../src/hw/apps.js";
import { LedgerEthApp } from "../src/hw/ledger-eth.js";
import { openSpeculos } from "../src/hw/speculos.js";
import {
  TORNADO_UNLOCK_MESSAGE,
  tornadoRootFromSignature,
} from "../src/host/ledger-tornado.js";
import { signDelegation } from "../src/utils/eip7702-consent.js";
import { SIMPLE_7702_IMPLEMENTATION } from "../src/utils/simple-7702.js";
import { ledgerAddressAt, publicAccountPath } from "../src/utils/wallet-keys.js";

const API = process.env.KOHAKU_SPECULOS_API ?? "http://127.0.0.1:5000";
/** Speculos's default seed. */
const DEFAULT_SEED =
  "glory promote mansion idle axis finger extra february uncover one trip resource lawn turtle enact monster seven myth punch hobby comfort wild raise skin";
/** DEFAULT_SEED, m/44'/60'/0'/0/0. */
const DEFAULT_SEED_ADDRESS = "0xDad77910DbDFdE764fC21FCD4E74D71bBACA6D8D";
const PATH = publicAccountPath(0);
/** The one delegate the official app whitelists. */
const OFFICIAL_DELEGATE = "0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function screen(): Promise<string> {
  const res = await fetch(`${API}/events?currentscreenonly=true`);
  const { events } = (await res.json()) as { events: { text: string }[] };
  // Lines of one screen, joined: "To accept risk, press" + "both buttons".
  return events.map((e) => e.text.trim()).join(" ");
}

async function eventCount(): Promise<number> {
  const res = await fetch(`${API}/events`);
  return ((await res.json()) as { events: unknown[] }).events.length;
}

async function textsSince(count: number): Promise<string[]> {
  const res = await fetch(`${API}/events`);
  const { events } = (await res.json()) as { events: { text: string }[] };
  return events.slice(count).map((e) => e.text);
}

async function press(button: "left" | "right" | "both"): Promise<void> {
  await fetch(`${API}/button/${button}`, {
    method: "POST",
    body: JSON.stringify({ action: "press-and-release" }),
  });
  await sleep(150);
}

/** Walks review screens to the approval one while `pending` is unresolved. */
async function approve<T>(pending: Promise<T>): Promise<T> {
  let settled = false;
  const watched = pending.finally(() => {
    settled = true;
  });
  const seen: string[] = [];
  for (let i = 0; i < 80 && !settled; i++) {
    await sleep(200);
    if (settled) break;
    const text = await screen();
    seen.push(text);
    // Blind-signing warnings are accepted with both buttons too.
    if (/^(Sign|Accept|Approve|Confirm)\b|press both buttons/i.test(text)) {
      await press("both");
    } else {
      await press("right");
    }
  }
  if (!settled) throw new Error(`No approval screen reached. Saw:\n${seen.join("\n")}`);
  return watched;
}

/** From the app home screen, turns a Settings switch on if it is off. */
async function enableSetting(label: string): Promise<void> {
  for (let i = 0; i < 6 && !(await screen()).startsWith("App settings"); i++) {
    await press("right");
  }
  await press("both");
  for (let i = 0; i < 10 && !(await screen()).startsWith(label); i++) {
    await press("right");
  }
  if ((await screen()).includes("Disabled")) await press("both");
  assert.match(await screen(), /Enabled/, `${label} should be enabled`);
  for (let i = 0; i < 10 && !(await screen()).startsWith("Back"); i++) {
    await press("right");
  }
  await press("both");
}

describe("Ledger Ethereum app (Speculos)", { skip: !process.env.KOHAKU_TEST_SPECULOS }, () => {
  let app: LedgerEthApp;
  let address: Address;

  before(async () => {
    app = new LedgerEthApp(await openSpeculos());
    app.appName = (await app.appInfo()).name;
    address = await app.getAddress(PATH);
    await enableSetting("Blind signing");
    await enableSetting("Smart accounts");
  });
  after(async () => {
    await app?.close();
  });

  const account = () => ledgerAccount(async () => app, PATH, address);

  const kohaku = () => app.appName === KOHAKU_ETH_APP_NAME;

  it("runs a supported Ethereum app with the default seed", () => {
    assert.ok(isSupportedLedgerApp(app.appName), app.appName);
    assert.equal(address, DEFAULT_SEED_ADDRESS);
  });

  it("derives the same addresses on the host from the xpub", async () => {
    const xpub = await app.getExtendedPublicKey("m/44'/60'/0'/0");
    for (const i of [0, 1, 5]) {
      assert.equal(
        ledgerAddressAt({ kind: "ledger", ...xpub }, i),
        await app.getAddress(publicAccountPath(i))
      );
    }
  });

  it("signs an EIP-1559 transaction", async () => {
    const signed = await approve(
      account().signTransaction({
        chainId: sepolia.id,
        type: "eip1559",
        to: "0x000000000000000000000000000000000000dEaD",
        value: parseEther("0.01"),
        nonce: 3,
        gas: 21_000n,
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000n,
      })
    );
    assert.equal(
      await recoverTransactionAddress({ serializedTransaction: signed as `0x02${string}` }),
      address
    );
  });

  it("signs a personal message", async () => {
    const message = "kohaku hardware test";
    const signature = await approve(account().signMessage({ message }));
    assert.ok(await verifyMessage({ address, message, signature }));
  });

  it("signs EIP-712 typed data", async () => {
    const typedData = {
      domain: { name: "Kohaku", version: "1", chainId: sepolia.id },
      types: { Mail: [{ name: "contents", type: "string" }] },
      primaryType: "Mail",
      message: { contents: "hello" },
    } as const;
    const signature = await approve(account().signTypedData(typedData));
    assert.ok(await verifyTypedData({ address, signature, ...typedData }));
  });

  it("signs a Simple7702 user operation (EntryPoint v0.8)", async () => {
    const client = createPublicClient({
      chain: sepolia,
      transport: custom({
        request: async () => {
          throw new Error("offline");
        },
      }),
    });
    const smart = await toSimple7702SmartAccount({
      client,
      owner: account() as PrivateKeyAccount,
      implementation: SIMPLE_7702_IMPLEMENTATION,
    });
    const userOp = {
      sender: address,
      nonce: 0n,
      callData: "0x" as const,
      callGasLimit: 100_000n,
      verificationGasLimit: 100_000n,
      preVerificationGas: 50_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
      signature: "0x" as const,
    };
    const signature = await approve(smart.signUserOperation({ ...userOp, chainId: sepolia.id }));
    const hash = getUserOperationHash({
      userOperation: userOp,
      entryPointAddress: smart.entryPoint.address,
      entryPointVersion: "0.8",
      chainId: sepolia.id,
    });
    assert.equal(await recoverAddress({ hash, signature }), address);
  });

  it("signs an EIP-7702 authorization to the official delegate", async () => {
    const auth = await approve(
      account().signAuthorization!({ address: OFFICIAL_DELEGATE, chainId: sepolia.id, nonce: 7 })
    );
    assert.equal(await recoverAuthorizationAddress({ authorization: auth }), address);
  });

  it("delegates to the Kohaku delegate only on Kohaku ETH", async () => {
    const request = { address: SIMPLE_7702_IMPLEMENTATION, chainId: sepolia.id, nonce: 7 };
    const before = await eventCount();
    const pending = signDelegation({
      owner: account(),
      request,
      chain: sepolia,
      nonInteractive: true,
    });
    if (!kohaku()) {
      // Refused on the host, before anything shows on the device.
      await assert.rejects(pending, (e) => e instanceof LedgerAppLacksDelegateError);
      const shown = await textsSince(before);
      assert.ok(!shown.some((t) => /Review|authorization/i.test(t)), shown.join(" | "));
      return;
    }
    const auth = await approve(pending);
    assert.ok(isAddressEqual(auth.address, SIMPLE_7702_IMPLEMENTATION));
    assert.equal(await recoverAuthorizationAddress({ authorization: auth }), address);
  });

  it("device refuses a delegate outside its whitelist", async () => {
    await assert.rejects(
      app.signAuthorization(PATH, {
        delegate: "0x1111111111111111111111111111111111111111",
        chainId: BigInt(sepolia.id),
        nonce: 0n,
      }),
      (e) => e instanceof ApduStatusError && e.statusWord === 0x6980
    );
    // Dismiss the refusal screen ("Back to safety").
    for (let i = 0; i < 6 && !/Back to safety/.test(await screen()); i++) {
      await press("right");
    }
    await press("both");
  });

  it("derives the same Tornado notes as software holding the seed", async () => {
    const onDevice = await approve(account().signMessage({ message: TORNADO_UNLOCK_MESSAGE }));
    const inSoftware = await mnemonicToAccount(DEFAULT_SEED).signMessage({
      message: TORNADO_UNLOCK_MESSAGE,
    });
    assert.equal(tornadoRootFromSignature(onDevice), tornadoRootFromSignature(inSoftware));
  });

  it("checks the device address before asking for a signature", async () => {
    const wrong = ledgerAccount(async () => app, PATH, "0x000000000000000000000000000000000000dEaD");
    await assert.rejects(wrong.signMessage({ message: "x" }), /derives .* not 0x/);
  });
});
