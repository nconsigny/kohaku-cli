/**
 * Host side of the Ledger Ethereum app, limited to what the CLI signs:
 * addresses, EIP-1559/legacy transactions, personal_sign, EIP-712 (hash mode)
 * and EIP-7702 authorizations.
 *
 * Spec: https://github.com/LedgerHQ/app-ethereum/blob/master/doc/apdu.md
 */
import { bytesToHex, getAddress, type Address, type Hex } from "viem";

import {
  concatBytes,
  encodeBip32Path,
  sendApdu,
  type ApduTransport,
} from "./apdu.js";

const CLA = 0xe0;
const INS_GET_ADDRESS = 0x02;
const INS_SIGN_TX = 0x04;
const INS_GET_CONFIGURATION = 0x06;
const INS_PERSONAL_SIGN = 0x08;
const INS_SIGN_EIP712 = 0x0c;
const INS_SIGN_EIP7702_AUTHORIZATION = 0x34;
const MAX_CHUNK = 0xff;

/** v is 27/28 for messages, raw parity or EIP-155 v for transactions. */
export type LedgerSignature = { v: number; r: Hex; s: Hex };

export type LedgerAuthorizationSignature = { yParity: number; r: Hex; s: Hex };

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

function u16(n: number): Uint8Array {
  return new Uint8Array([n >> 8, n & 0xff]);
}

/** Minimal big-endian bytes of a non-negative integer (at least one byte). */
function uintBytes(n: bigint): Uint8Array {
  if (n < 0n) throw new Error("negative integer");
  const hex = n.toString(16);
  const padded = hex.length % 2 ? `0${hex}` : hex;
  return Uint8Array.from(padded.match(/../g)!.map((b) => parseInt(b, 16)));
}

function tlv(tag: number, value: Uint8Array): Uint8Array {
  if (value.length > 0x7f) throw new Error("TLV value too long");
  return concatBytes(new Uint8Array([tag, value.length]), value);
}

function parseVrs(res: Uint8Array): LedgerSignature {
  if (res.length < 65) {
    throw new Error(`Unexpected signature length ${res.length}`);
  }
  return {
    v: res[0]!,
    r: bytesToHex(res.subarray(1, 33)),
    s: bytesToHex(res.subarray(33, 65)),
  };
}

export class LedgerEthApp {
  /** Open app as reported by the device; set by `openLedgerEthApp`. */
  appName = "";

  constructor(private readonly transport: ApduTransport) {}

  close(): Promise<void> {
    return this.transport.close();
  }

  /** Sends `payload` in 255-byte chunks; returns the last response. */
  private async sendChunked(
    ins: number,
    payload: Uint8Array,
    p1First: number,
    p1Next: number
  ): Promise<Uint8Array> {
    let res: Uint8Array = new Uint8Array(0);
    for (let offset = 0; offset < payload.length; offset += MAX_CHUNK) {
      res = await sendApdu(
        this.transport,
        CLA,
        ins,
        offset === 0 ? p1First : p1Next,
        0x00,
        payload.subarray(offset, offset + MAX_CHUNK)
      );
    }
    return res;
  }

  /** Name and version of the open app (`BOLOS` on the dashboard). */
  async appInfo(): Promise<{ name: string; version: string }> {
    const res = await sendApdu(this.transport, 0xb0, 0x01, 0x00, 0x00);
    const dec = new TextDecoder();
    const nameLen = res[1]!;
    const name = dec.decode(res.subarray(2, 2 + nameLen));
    const versionLen = res[2 + nameLen]!;
    const version = dec.decode(
      res.subarray(3 + nameLen, 3 + nameLen + versionLen)
    );
    return { name, version };
  }

  /** App settings: flags byte (bit 0 = blind signing enabled) and version. */
  async configuration(): Promise<{ blindSigning: boolean; version: string }> {
    const res = await sendApdu(this.transport, CLA, INS_GET_CONFIGURATION, 0, 0);
    return {
      blindSigning: (res[0]! & 0x01) !== 0,
      version: `${res[1]}.${res[2]}.${res[3]}`,
    };
  }

  private async getPublicKey(path: string, display: boolean, chainCode: boolean) {
    const res = await sendApdu(
      this.transport,
      CLA,
      INS_GET_ADDRESS,
      display ? 0x01 : 0x00,
      chainCode ? 0x01 : 0x00,
      encodeBip32Path(path)
    );
    const pubLen = res[0]!;
    const addrLen = res[1 + pubLen]!;
    const addrEnd = 2 + pubLen + addrLen;
    const ascii = new TextDecoder().decode(res.subarray(2 + pubLen, addrEnd));
    return {
      publicKey: bytesToHex(res.subarray(1, 1 + pubLen)),
      address: getAddress(`0x${ascii}`),
      chainCode: chainCode ? bytesToHex(res.subarray(addrEnd, addrEnd + 32)) : undefined,
    };
  }

  /** With `display`, the user checks the address on the device screen first. */
  async getAddress(path: string, opts: { display?: boolean } = {}): Promise<Address> {
    return (await this.getPublicKey(path, !!opts.display, false)).address;
  }

  /** Uncompressed public key and chain code, for host-side child derivation. */
  async getExtendedPublicKey(path: string): Promise<{ publicKey: Hex; chainCode: Hex }> {
    const { publicKey, chainCode } = await this.getPublicKey(path, false, true);
    return { publicKey, chainCode: chainCode! };
  }

  /** `unsignedTx` is the serialized unsigned transaction (type byte included). */
  async signTransaction(path: string, unsignedTx: Uint8Array): Promise<LedgerSignature> {
    const res = await this.sendChunked(
      INS_SIGN_TX,
      concatBytes(encodeBip32Path(path), unsignedTx),
      0x00,
      0x80
    );
    return parseVrs(res);
  }

  async signPersonalMessage(path: string, message: Uint8Array): Promise<LedgerSignature> {
    const res = await this.sendChunked(
      INS_PERSONAL_SIGN,
      concatBytes(encodeBip32Path(path), u32(message.length), message),
      0x00,
      0x80
    );
    return parseVrs(res);
  }

  /** EIP-712 "V0": the device shows and signs the two hashes (blind signing). */
  async signTypedDataHashes(
    path: string,
    domainHash: Uint8Array,
    messageHash: Uint8Array
  ): Promise<LedgerSignature> {
    const res = await sendApdu(
      this.transport,
      CLA,
      INS_SIGN_EIP712,
      0x00,
      0x00,
      concatBytes(encodeBip32Path(path), domainHash, messageHash)
    );
    return parseVrs(res);
  }

  /**
   * Signs one EIP-7702 authorization tuple. The app refuses delegates that
   * are not on its whitelist (status 0x6980).
   */
  async signAuthorization(
    path: string,
    auth: { delegate: Address; chainId: bigint; nonce: bigint }
  ): Promise<LedgerAuthorizationSignature> {
    const delegate = Uint8Array.from(
      auth.delegate.slice(2).match(/../g)!.map((b) => parseInt(b, 16))
    );
    const struct = concatBytes(
      tlv(0x00, new Uint8Array([1])), // STRUCT_VERSION
      tlv(0x01, delegate), // DELEGATE_ADDR
      tlv(0x02, uintBytes(auth.chainId)), // CHAIN_ID
      tlv(0x03, uintBytes(auth.nonce)) // NONCE
    );
    const res = await this.sendChunked(
      INS_SIGN_EIP7702_AUTHORIZATION,
      concatBytes(encodeBip32Path(path), u16(struct.length), struct),
      0x01,
      0x00
    );
    const sig = parseVrs(res);
    return { yParity: sig.v, r: sig.r, s: sig.s };
  }
}
