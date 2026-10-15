/**
 * Ledger USB HID transport for Linux, through /dev/hidraw* and node:fs only
 * (no native addon). The APDU interface is the one whose report descriptor
 * declares the vendor usage page 0xFFA0; the other Ledger HID interface is FIDO.
 *
 * Access needs Ledger's udev rules: https://github.com/LedgerHQ/udev-rules
 */
import { open, readdir, readFile, type FileHandle } from "node:fs/promises";

import type { ApduTransport } from "./apdu.js";

export const LEDGER_VENDOR_ID = 0x2c97;

const PACKET_SIZE = 64;
const HEADER_SIZE = 5;
const CHANNEL = 0x0101;
const TAG_APDU = 0x05;
const USAGE_PAGE_FFA0 = [0x06, 0xa0, 0xff];

/** Splits `len(2) || apdu` into 64-byte HID frames (channel, tag, sequence). */
export function wrapApdu(apdu: Uint8Array, channel = CHANNEL): Uint8Array[] {
  const stream = new Uint8Array(2 + apdu.length);
  stream[0] = apdu.length >> 8;
  stream[1] = apdu.length & 0xff;
  stream.set(apdu, 2);

  const frames: Uint8Array[] = [];
  for (let offset = 0, seq = 0; offset < stream.length; seq++) {
    const frame = new Uint8Array(PACKET_SIZE);
    frame[0] = channel >> 8;
    frame[1] = channel & 0xff;
    frame[2] = TAG_APDU;
    frame[3] = seq >> 8;
    frame[4] = seq & 0xff;
    const chunk = stream.subarray(offset, offset + PACKET_SIZE - HEADER_SIZE);
    frame.set(chunk, HEADER_SIZE);
    offset += chunk.length;
    frames.push(frame);
  }
  return frames;
}

/** Reassembles a response from 64-byte frames; returns null until complete. */
export class FrameReassembler {
  private expected = -1;
  private seq = 0;
  private chunks: Uint8Array[] = [];
  private received = 0;

  constructor(private readonly channel = CHANNEL) {}

  push(frame: Uint8Array): Uint8Array | null {
    const channel = (frame[0]! << 8) | frame[1]!;
    const seq = (frame[3]! << 8) | frame[4]!;
    if (channel !== this.channel || frame[2] !== TAG_APDU) {
      throw new Error("Unexpected HID frame from device");
    }
    if (seq !== this.seq) {
      throw new Error(`HID frame out of order: got ${seq}, want ${this.seq}`);
    }
    let body = frame.subarray(HEADER_SIZE);
    if (seq === 0) {
      this.expected = (body[0]! << 8) | body[1]!;
      body = body.subarray(2);
    }
    const take = body.subarray(0, this.expected - this.received);
    this.chunks.push(take);
    this.received += take.length;
    this.seq++;
    if (this.received < this.expected) return null;

    const out = new Uint8Array(this.expected);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }
}

function hasUsagePageFFA0(descriptor: Uint8Array): boolean {
  for (let i = 0; i + 2 < descriptor.length; i++) {
    if (USAGE_PAGE_FFA0.every((b, k) => descriptor[i + k] === b)) return true;
  }
  return false;
}

/** `/dev/hidrawN` nodes of connected Ledger devices' APDU interface. */
export async function findLedgerHidraw(): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir("/sys/class/hidraw");
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names.sort()) {
    const base = `/sys/class/hidraw/${name}/device`;
    try {
      const uevent = await readFile(`${base}/uevent`, "utf-8");
      // HID_ID=<bus>:<vendor>:<product>, all hex.
      const vendor = /^HID_ID=[0-9A-Fa-f]+:([0-9A-Fa-f]+):/m.exec(uevent)?.[1];
      if (!vendor || parseInt(vendor, 16) !== LEDGER_VENDOR_ID) continue;
      const descriptor = await readFile(`${base}/report_descriptor`);
      if (hasUsagePageFFA0(descriptor)) found.push(`/dev/${name}`);
    } catch {
      continue;
    }
  }
  return found;
}

async function readFrame(fh: FileHandle): Promise<Uint8Array> {
  const buf = new Uint8Array(PACKET_SIZE);
  const { bytesRead } = await fh.read({
    buffer: buf,
    offset: 0,
    length: PACKET_SIZE,
    position: null,
  });
  if (bytesRead !== PACKET_SIZE) {
    throw new Error(`Short HID read: ${bytesRead} bytes`);
  }
  return buf;
}

export async function openLedgerHidraw(devicePath?: string): Promise<ApduTransport> {
  if (process.platform !== "linux") {
    throw new Error(
      "Ledger over USB is only implemented for Linux (/dev/hidraw) so far."
    );
  }
  const path = devicePath ?? (await findLedgerHidraw())[0];
  if (!path) {
    throw new Error(
      "No Ledger found. Plug it in, unlock it and open the Ethereum app."
    );
  }
  let fh: FileHandle;
  try {
    fh = await open(path, "r+");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EACCES") {
      throw new Error(
        `No permission on ${path}. Install Ledger's udev rules (https://github.com/LedgerHQ/udev-rules) and replug the device.`
      );
    }
    throw e;
  }

  return {
    async exchange(apdu) {
      for (const frame of wrapApdu(apdu)) {
        // hidraw expects a leading report ID; Ledger uses unnumbered reports.
        const report = new Uint8Array(PACKET_SIZE + 1);
        report.set(frame, 1);
        await fh.write(report);
      }
      const reassembler = new FrameReassembler();
      for (;;) {
        const done = reassembler.push(await readFrame(fh));
        if (done) return done;
      }
    },
    async close() {
      await fh.close();
    },
  };
}
