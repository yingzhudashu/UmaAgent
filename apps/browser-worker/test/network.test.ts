import { createServer, get } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup }));

import {
  assertPublicUrl,
  createValidatingProxy,
  isPrivateAddress,
  resolvePublicAddress,
} from "../src/network.js";

beforeEach(() => {
  lookup.mockImplementation(async (hostname: string) => {
    if (hostname === "private.example" || hostname === "127.0.0.1")
      return [{ address: "127.0.0.1", family: 4 }];
    if (hostname === "empty.example") return [];
    return [{ address: "93.184.216.34", family: 4 }];
  });
});

describe("browser network policy", () => {
  it("blocks private, reserved, and mapped addresses", () => {
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "100.127.255.255",
      "127.0.0.1",
      "169.254.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "198.18.0.1",
      "198.19.0.1",
      "192.0.0.1",
      "192.0.2.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "fc00::1",
      "fd00::1",
      "fe80::1",
      "fea0::1",
      "ff00::1",
      "::ffff:127.0.0.1",
    ])
      expect(isPrivateAddress(address)).toBe(true);
    for (const address of [
      "8.8.8.8",
      "100.63.255.255",
      "100.128.0.1",
      "172.15.255.255",
      "172.32.0.1",
      "198.17.0.1",
      "2001:4860:4860::8888",
      "not-an-ip",
    ])
      expect(isPrivateAddress(address)).toBe(false);
  });

  it("rejects non-HTTP navigation before DNS lookup", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow("HTTP");
  });

  it("resolves only public DNS answers", async () => {
    await expect(assertPublicUrl("https://public.example/path")).resolves.toMatchObject({
      hostname: "public.example",
    });
    await expect(assertPublicUrl("https://private.example")).rejects.toThrow("Private");
    await expect(resolvePublicAddress("public.example")).resolves.toBe("93.184.216.34");
    await expect(resolvePublicAddress("private.example")).rejects.toThrow("Private");
    await expect(resolvePublicAddress("empty.example")).rejects.toThrow("unresolved");
  });

  it("pins browser traffic behind a proxy that rejects private destinations", async () => {
    const proxy = await createValidatingProxy();
    try {
      const target = new URL(proxy.url);
      const status = await new Promise<number>((resolve, reject) => {
        const request = get(
          {
            host: target.hostname,
            port: target.port,
            path: "http://127.0.0.1:3210/api/v7/health/live",
          },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        request.on("error", reject);
      });
      expect(status).toBe(403);
    } finally {
      await proxy.close();
    }
  });

  it("forwards validated HTTP traffic to the pinned address and preserves the Host header", async () => {
    const upstream = createServer((request, response) => {
      response.writeHead(201, { "content-type": "text/plain", "x-upstream-host": request.headers.host });
      response.end(`forwarded:${request.url}`);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("upstream did not bind");
    const proxy = await createValidatingProxy({
      validateUrl: async (raw) => new URL(raw),
      resolveAddress: async () => "127.0.0.1",
    });
    try {
      const target = new URL(proxy.url);
      const result = await new Promise<{ status: number; body: string; host?: string }>((resolve, reject) => {
        const request = get(
          {
            host: target.hostname,
            port: target.port,
            path: `http://public.example:${upstreamAddress.port}/hello?source=test`,
            headers: { "proxy-connection": "keep-alive" },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
                host: response.headers["x-upstream-host"] as string | undefined,
              }),
            );
          },
        );
        request.on("error", reject);
      });
      expect(result).toEqual({
        status: 201,
        body: "forwarded:/hello?source=test",
        host: `public.example:${upstreamAddress.port}`,
      });
    } finally {
      await proxy.close();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("pins CONNECT tunnels to the validated address", async () => {
    const upstream = createTcpServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("upstream did not bind");
    const proxy = await createValidatingProxy({ resolveAddress: async () => "127.0.0.1" });
    try {
      const proxyAddress = new URL(proxy.url);
      await new Promise<void>((resolve, reject) => {
        const socket = connect(Number(proxyAddress.port), proxyAddress.hostname);
        let buffer = Buffer.alloc(0);
        let established = false;
        socket.on("connect", () =>
          socket.write(
            `CONNECT public.example:${upstreamAddress.port} HTTP/1.1\r\nHost: public.example:${upstreamAddress.port}\r\n\r\n`,
          ),
        );
        socket.on("data", (chunk) => {
          buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
          if (!established) {
            const boundary = buffer.indexOf("\r\n\r\n");
            if (boundary < 0) return;
            expect(buffer.subarray(0, boundary).toString("utf8")).toContain("200 Connection Established");
            buffer = buffer.subarray(boundary + 4);
            established = true;
            socket.write("pinned");
          }
          if (established && buffer.toString("utf8").includes("pinned")) {
            socket.end();
            resolve();
          }
        });
        socket.on("error", reject);
      });
    } finally {
      await proxy.close();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
