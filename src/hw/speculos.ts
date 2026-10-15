/**
 * TCP transport to the Speculos emulator's APDU port, for tests and dev.
 * Request: len(4, BE) || apdu. Response: len(4, BE, data only) || data || sw(2).
 */
import { connect, type Socket } from "node:net";

import type { ApduTransport } from "./apdu.js";

export async function openSpeculos(
  host = "127.0.0.1",
  port = 9999
): Promise<ApduTransport> {
  const socket: Socket = await new Promise((resolve, reject) => {
    const s = connect({ host, port }, () => resolve(s));
    s.once("error", reject);
  });

  let buffered = new Uint8Array(0);
  let waiter: (() => void) | null = null;
  let failure: Error | null = null;
  socket.on("data", (chunk: Buffer) => {
    const next = new Uint8Array(buffered.length + chunk.length);
    next.set(buffered);
    next.set(chunk, buffered.length);
    buffered = next;
    waiter?.();
  });
  socket.on("error", (e) => {
    failure = e;
    waiter?.();
  });
  socket.on("close", () => {
    failure ??= new Error("Speculos closed the connection");
    waiter?.();
  });

  async function take(n: number): Promise<Uint8Array> {
    while (buffered.length < n) {
      if (failure) throw failure;
      await new Promise<void>((resolve) => (waiter = resolve));
      waiter = null;
    }
    const out = buffered.slice(0, n);
    buffered = buffered.slice(n);
    return out;
  }

  return {
    async exchange(apdu) {
      const header = new Uint8Array(4);
      new DataView(header.buffer).setUint32(0, apdu.length);
      socket.write(header);
      socket.write(apdu);
      const size = new DataView((await take(4)).buffer).getUint32(0);
      return take(size + 2);
    },
    async close() {
      socket.destroy();
    },
  };
}
