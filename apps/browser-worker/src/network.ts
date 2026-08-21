import { lookup } from "node:dns/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, isIP } from "node:net";

export function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase();
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPrivateAddress(mapped);
  if (
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    /^fe[89ab]/.test(value) ||
    value.startsWith("ff")
  )
    return true;
  if (isIP(value) !== 4) return false;
  const [a = 0, b = 0, c = 0] = value.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Browser navigation only supports HTTP(S)");
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address)))
    throw new Error("Private or unresolved browser targets are blocked");
  return url;
}

export async function resolvePublicAddress(hostname: string): Promise<string> {
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address)))
    throw new Error("Private or unresolved browser targets are blocked");
  return addresses[0]?.address as string;
}

export interface ValidatingProxyOptions {
  validateUrl?: (raw: string) => Promise<URL>;
  resolveAddress?: (hostname: string) => Promise<string>;
}

export async function createValidatingProxy(
  options: ValidatingProxyOptions = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const validateUrl = options.validateUrl ?? assertPublicUrl;
  const resolveAddress = options.resolveAddress ?? resolvePublicAddress;
  const server = createHttpServer((request, response) => {
    void (async () => {
      if (!request.url) throw new Error("Proxy request URL is required");
      const target = await validateUrl(request.url);
      const address = await resolveAddress(target.hostname);
      const headers: Record<string, string | string[] | undefined> = {
        ...request.headers,
        host: target.host,
      };
      delete headers["proxy-connection"];
      const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
      const upstream = transport(
        {
          protocol: target.protocol,
          hostname: address,
          port: target.port || (target.protocol === "https:" ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: request.method,
          headers,
          ...(target.protocol === "https:" ? { servername: target.hostname } : {}),
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("error", () => response.writeHead(502).end());
      request.pipe(upstream);
    })().catch(() => response.writeHead(403).end());
  });
  server.on("connect", (request, client, head) => {
    void (async () => {
      const authority = new URL(`http://${request.url ?? ""}`);
      const port = Number(authority.port || 443);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid proxy port");
      const address = await resolveAddress(authority.hostname);
      const upstream = connect(port, address, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
    })().catch(() => {
      client.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      client.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Validating proxy failed to bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
