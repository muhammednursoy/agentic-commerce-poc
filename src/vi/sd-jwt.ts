import { createHash, randomBytes } from "node:crypto";

export interface Disclosure {
  raw: string;
  hash: string;
  value: unknown[];
}

export interface ParsedSdJwt {
  jwt: string;
  disclosures: Disclosure[];
}

export function b64u(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

export function sha256B64u(ascii: string): string {
  return b64u(createHash("sha256").update(ascii, "ascii").digest());
}

export function createDisclosure(value: unknown, claimName?: string): Disclosure {
  const array = claimName === undefined ? [b64u(randomBytes(16)), value] : [b64u(randomBytes(16)), claimName, value];
  const raw = b64u(JSON.stringify(array));
  return { raw, hash: sha256B64u(raw), value: array };
}

export function serializeSdJwt(jwt: string, disclosures: Disclosure[]): string {
  return [jwt, ...disclosures.map((d) => d.raw)].join("~") + "~";
}

export function parseSdJwt(serialized: unknown): ParsedSdJwt {
  if (typeof serialized !== "string" || !serialized.endsWith("~")) throw new Error("not a serialized SD-JWT (<jwt>~<disclosure>~...~)");
  const [jwt, ...rest] = serialized.slice(0, -1).split("~");
  if (jwt.split(".").length !== 3) throw new Error("SD-JWT does not start with a compact JWS");
  const disclosures = rest.map((raw) => {
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    } catch {
      throw new Error("a disclosure is not base64url JSON");
    }
    if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3)) throw new Error("a disclosure is not a [salt, value] or [salt, name, value] array");
    return { raw, hash: sha256B64u(raw), value };
  });
  return { jwt, disclosures };
}
