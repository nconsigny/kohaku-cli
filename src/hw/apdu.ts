/**
 * Minimal APDU plumbing shared by the hardware-wallet transports.
 *
 * A transport moves one command APDU to the device and returns the raw
 * response (data followed by the 2-byte status word).
 */

export type ApduTransport = {
  exchange(apdu: Uint8Array): Promise<Uint8Array>;
  close(): Promise<void>;
};

export const SW_OK = 0x9000;

const STATUS_HINTS: Record<number, string> = {
  0x5515: "device is locked",
  0x6980: "command not allowed (for EIP-7702: delegate not whitelisted in this app)",
  0x6985: "rejected on the device",
  0x6a80: "invalid data (is blind signing enabled in the app settings?)",
  0x6d00: "unknown instruction (wrong app open?)",
  0x6e00: "wrong app open",
  0x6e01: "app not open",
};

export class ApduStatusError extends Error {
  readonly statusWord: number;
  constructor(statusWord: number) {
    const hint = STATUS_HINTS[statusWord];
    super(
      `Device returned status 0x${statusWord.toString(16).padStart(4, "0")}` +
        (hint ? ` (${hint})` : "")
    );
    this.name = "ApduStatusError";
    this.statusWord = statusWord;
  }
}

/** Builds a short APDU (Lc ≤ 255). */
export function buildApdu(
  cla: number,
  ins: number,
  p1: number,
  p2: number,
  data: Uint8Array = new Uint8Array(0)
): Uint8Array {
  if (data.length > 0xff) {
    throw new Error(`APDU data too long: ${data.length} bytes`);
  }
  const out = new Uint8Array(5 + data.length);
  out.set([cla, ins, p1, p2, data.length]);
  out.set(data, 5);
  return out;
}

/** Sends one APDU and returns the response data; throws on a non-9000 status. */
export async function sendApdu(
  transport: ApduTransport,
  cla: number,
  ins: number,
  p1: number,
  p2: number,
  data?: Uint8Array
): Promise<Uint8Array> {
  const res = await transport.exchange(buildApdu(cla, ins, p1, p2, data));
  if (res.length < 2) {
    throw new Error("Device response shorter than a status word");
  }
  const sw = (res[res.length - 2]! << 8) | res[res.length - 1]!;
  if (sw !== SW_OK) {
    throw new ApduStatusError(sw);
  }
  return res.subarray(0, res.length - 2);
}

/**
 * Encodes a BIP-32 path (`m/44'/60'/0'/0/0`) as Ledger expects it:
 * one count byte followed by big-endian 32-bit indexes.
 */
export function encodeBip32Path(path: string): Uint8Array {
  const parts = path.replace(/^m\//, "").split("/").filter(Boolean);
  if (parts.length === 0 || parts.length > 10) {
    throw new Error(`Invalid BIP-32 path: ${path}`);
  }
  const out = new Uint8Array(1 + 4 * parts.length);
  const view = new DataView(out.buffer);
  out[0] = parts.length;
  parts.forEach((part, i) => {
    const hardened = part.endsWith("'") || part.endsWith("h");
    const index = Number(hardened ? part.slice(0, -1) : part);
    if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
      throw new Error(`Invalid BIP-32 path segment "${part}" in ${path}`);
    }
    view.setUint32(1 + 4 * i, hardened ? index + 0x80000000 : index);
  });
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
