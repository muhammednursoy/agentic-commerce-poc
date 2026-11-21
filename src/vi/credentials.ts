import { generateKeyPairSync } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { SignJWT, createLocalJWKSet, decodeJwt, decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import type { JSONWebKeySet, JWK, JWTPayload } from "jose";
import { randomId } from "../http.ts";
import type { Address } from "../domain.ts";
import { createDisclosure, parseSdJwt, serializeSdJwt, sha256B64u } from "./sd-jwt.ts";
import type { Disclosure } from "./sd-jwt.ts";

export const L1_VCT = "https://credentials.mastercard.com/card";
export const CHECKOUT_VCT = "mandate.checkout.1";
export const PAYMENT_VCT = "mandate.payment.1";
const OPEN_VCTS = new Set(["mandate.checkout.open.1", "mandate.payment.open.1"]);
export const CLOCK_SKEW_SECONDS = 300;
export const L2_IMMEDIATE_TTL_SECONDS = 15 * 60;
export const CHECKOUT_JWT_TTL_SECONDS = 3600;
const L1_TTL_SECONDS = 365 * 24 * 3600;
export const JWKS_PATH = "/.well-known/jwks.json";
export const ENROLMENT_PATH = "/issuer/credentials";
export const REGISTRATIONS_PATH = "/verifiable-intent/registrations";

export class IntentVerificationError extends Error {}

function fail(message: string): never {
  throw new IntentVerificationError(message);
}

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicJwk: JWK;
}

export function generateSigningKey(kidPrefix: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const kid = randomId(`${kidPrefix}-`, 6);
  return { kid, privateKey, publicJwk: { ...(publicKey.export({ format: "jwk" }) as JWK), kid, alg: "ES256", use: "sig" } };
}

export function jwksOf(...keys: SigningKey[]): JSONWebKeySet {
  return { keys: keys.map((k) => k.publicJwk) };
}

export function checkoutHash(checkoutJwt: string): string {
  return sha256B64u(checkoutJwt);
}

export interface Payee {
  id: string;
  name: string;
  website: string;
}

export interface CheckoutClaims extends JWTPayload {
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  merchant: Payee;
  checkout_session_id: string;
  currency: string;
  line_items: { sku: string; title: string; quantity: number; unit_price: number; subtotal: number; tax: number; total: number }[];
  fulfillment: { option_id: string; title: string; amount: number; address?: Address } | null;
  subtotal: number;
  tax: number;
  total: number;
}

export interface CheckoutMandate {
  vct: typeof CHECKOUT_VCT;
  checkout_jwt: string;
  checkout_hash: string;
}

export interface PaymentMandate {
  vct: typeof PAYMENT_VCT;
  payment_instrument: { type: string; id: string; description?: string };
  payment_amount: { currency: string; amount: number };
  payee: Payee;
  transaction_id: string;
}

export interface VerifiablePresentation {
  l1: string;
  l2: string;
  intent_id: string;
}

export async function signCheckoutJwt(key: SigningKey, claims: Omit<CheckoutClaims, "iat" | "exp" | "jti">, ttlSeconds = CHECKOUT_JWT_TTL_SECONDS): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...claims, jti: randomId("chk_", 8) })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: key.kid })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key.privateKey);
}

export async function verifyCheckoutJwt(checkoutJwt: string, jwks: JSONWebKeySet, issuer: string): Promise<CheckoutClaims> {
  try {
    const { payload } = await jwtVerify(checkoutJwt, createLocalJWKSet(jwks), { algorithms: ["ES256"], typ: "JWT", issuer, clockTolerance: CLOCK_SKEW_SECONDS, requiredClaims: ["sub", "iat", "exp"] });
    return payload as CheckoutClaims;
  } catch (err) {
    return fail(`checkout_jwt does not verify against the merchant JWKS: ${err instanceof Error ? err.message : err}`);
  }
}

export interface L1Input {
  iss: string;
  sub: string;
  cnfJwk: JWK;
  panLastFour: string;
  scheme: string;
  email?: string;
}

export async function issueL1(issuerKey: SigningKey, input: L1Input): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const disclosures = input.email ? [createDisclosure(input.email, "email")] : [];
  const { kid: _kid, alg: _alg, use: _use, ...cnfJwk } = input.cnfJwk;
  const jwt = await new SignJWT({
    iss: input.iss,
    sub: input.sub,
    iat: now,
    exp: now + L1_TTL_SECONDS,
    vct: L1_VCT,
    cnf: { jwk: cnfJwk },
    pan_last_four: input.panLastFour,
    scheme: input.scheme,
    _sd_alg: "sha-256",
    _sd: disclosures.map((d) => d.hash),
  }).setProtectedHeader({ alg: "ES256", typ: "sd+jwt", kid: issuerKey.kid }).sign(issuerKey.privateKey);
  return serializeSdJwt(jwt, disclosures);
}

export interface ImmediateL2Input {
  l1: string;
  userKey: SigningKey;
  aud: string;
  checkoutJwt: string;
  payment: Pick<PaymentMandate, "payment_instrument" | "payment_amount" | "payee">;
  nonce?: string;
  iat?: number;
  ttlSeconds?: number;
}

export interface ImmediateL2 {
  serialized: string;
  nonce: string;
  checkoutHash: string;
  jwt: string;
  checkout: Disclosure;
  payment: Disclosure;
}

export async function createImmediateL2(input: ImmediateL2Input): Promise<ImmediateL2> {
  const iat = input.iat ?? Math.floor(Date.now() / 1000);
  const nonce = input.nonce ?? randomId("", 16);
  const hash = checkoutHash(input.checkoutJwt);
  const checkout = createDisclosure({ vct: CHECKOUT_VCT, checkout_jwt: input.checkoutJwt, checkout_hash: hash } satisfies CheckoutMandate);
  const payment = createDisclosure({ vct: PAYMENT_VCT, ...input.payment, transaction_id: hash } satisfies PaymentMandate);
  const jwt = await new SignJWT({
    nonce,
    aud: input.aud,
    iat,
    exp: iat + (input.ttlSeconds ?? L2_IMMEDIATE_TTL_SECONDS),
    sd_hash: sha256B64u(input.l1),
    delegate_payload: [{ "...": checkout.hash }, { "...": payment.hash }],
    _sd_alg: "sha-256",
    _sd: [checkout.hash, payment.hash],
  }).setProtectedHeader({ alg: "ES256", typ: "kb-sd-jwt", kid: input.userKey.kid }).sign(input.userKey.privateKey);
  return { serialized: serializeSdJwt(jwt, [checkout, payment]), nonce, checkoutHash: hash, jwt, checkout, payment };
}

export function presentL2(l2: ImmediateL2, disclose: ("checkout" | "payment")[]): string {
  return serializeSdJwt(l2.jwt, disclose.map((which) => l2[which]));
}

export type IssuerJwksResolver = (iss: string) => Promise<JSONWebKeySet | undefined>;

export interface VerifiedL1 {
  iss: string;
  sub: string;
  cnfJwk: JWK;
  panLastFour: string;
  scheme: string;
}

export async function verifyL1(serialized: unknown, resolveIssuer: IssuerJwksResolver): Promise<VerifiedL1> {
  const { jwt, disclosures } = parse(serialized, "L1");
  const header = decodeProtectedHeader(jwt);
  if (header.alg !== "ES256" || header.typ !== "sd+jwt" || typeof header.kid !== "string") fail("L1 header must be alg ES256, typ sd+jwt, with a kid");
  const iss = decodeJwt(jwt).iss;
  const jwks = typeof iss === "string" ? await resolveIssuer(iss) : undefined;
  if (!jwks) return fail(`L1 issuer ${iss} is not a trusted issuer`);
  const payload = await verifyJwt("L1", () => jwtVerify(jwt, createLocalJWKSet(jwks), { algorithms: ["ES256"], typ: "sd+jwt", clockTolerance: CLOCK_SKEW_SECONDS, requiredClaims: ["iss", "sub", "iat", "exp"] }));
  if (payload.vct !== L1_VCT) fail(`L1 vct must be ${L1_VCT}`);
  if ("sd_hash" in payload) fail("L1 must not contain sd_hash");
  if (payload._sd_alg !== "sha-256" || !Array.isArray(payload._sd)) fail("L1 needs _sd_alg sha-256 and an _sd array");
  if (disclosures.some((d) => !(payload._sd as string[]).includes(d.hash))) fail("L1 carries a disclosure that its _sd does not commit to");
  const cnfJwk = (payload.cnf as { jwk?: JWK } | undefined)?.jwk;
  if (cnfJwk?.kty !== "EC" || cnfJwk.crv !== "P-256" || typeof cnfJwk.x !== "string" || typeof cnfJwk.y !== "string") fail("L1 cnf.jwk must be an EC P-256 public key");
  if (typeof payload.pan_last_four !== "string" || typeof payload.scheme !== "string") fail("L1 needs pan_last_four and scheme");
  return { iss: payload.iss!, sub: payload.sub!, cnfJwk: cnfJwk!, panLastFour: payload.pan_last_four as string, scheme: payload.scheme as string };
}

export interface VerifiedL2 {
  nonce: string;
  aud: string;
  iat: number;
  exp: number;
  checkout?: CheckoutMandate;
  payment?: PaymentMandate;
}

export async function verifyImmediateL2(
  serialized: unknown,
  l1Serialized: string,
  l1: VerifiedL1,
  options: { audiences: string[]; require: ("checkout" | "payment")[] },
): Promise<VerifiedL2> {
  const { jwt, disclosures } = parse(serialized, "L2");
  const header = decodeProtectedHeader(jwt);
  if (header.alg !== "ES256" || header.typ !== "kb-sd-jwt") fail("L2 header must be alg ES256, typ kb-sd-jwt (Immediate mode)");
  const userKey = await importJWK(l1.cnfJwk, "ES256");
  const payload = await verifyJwt("L2", () => jwtVerify(jwt, userKey, { algorithms: ["ES256"], typ: "kb-sd-jwt", audience: options.audiences, clockTolerance: CLOCK_SKEW_SECONDS, requiredClaims: ["nonce", "aud", "iat", "exp", "sd_hash"] }));
  const now = Math.floor(Date.now() / 1000);
  const iat = payload.iat!;
  const exp = payload.exp!;
  if (iat > now + CLOCK_SKEW_SECONDS) fail("L2 iat is in the future");
  if (exp - iat > L2_IMMEDIATE_TTL_SECONDS) fail("L2 Immediate lifetime exceeds 15 minutes");
  if (payload.sd_hash !== sha256B64u(l1Serialized)) fail("L2 sd_hash does not match the presented L1");
  if (typeof payload.nonce !== "string" || !payload.nonce) fail("L2 nonce missing");
  if (payload._sd_alg !== "sha-256" || !Array.isArray(payload._sd) || !Array.isArray(payload.delegate_payload)) fail("L2 needs _sd_alg sha-256, _sd and delegate_payload");
  const committed = new Set((payload.delegate_payload as { "..."?: unknown }[]).map((ref) => ref?.["..."]));
  const out: VerifiedL2 = { nonce: payload.nonce as string, aud: payload.aud as string, iat, exp };
  for (const d of disclosures) {
    if (d.value.length !== 2 || !committed.has(d.hash) || !(payload._sd as string[]).includes(d.hash)) fail("L2 carries a disclosure that delegate_payload does not commit to");
    const mandate = d.value[1] as Record<string, unknown>;
    if (typeof mandate !== "object" || mandate === null) return fail("L2 mandate disclosure is not an object");
    if (typeof mandate.vct === "string" && OPEN_VCTS.has(mandate.vct)) fail("Autonomous mandates are not accepted; Immediate mode only");
    if ("cnf" in mandate || "constraints" in mandate) fail("Immediate mandates must not contain cnf or constraints");
    if (mandate.vct === CHECKOUT_VCT) {
      if (out.checkout) fail("L2 discloses more than one checkout mandate");
      out.checkout = checkoutMandate(mandate);
    } else if (mandate.vct === PAYMENT_VCT) {
      if (out.payment) fail("L2 discloses more than one payment mandate");
      out.payment = paymentMandate(mandate);
    } else {
      fail(`unrecognized mandate vct ${String(mandate.vct)}`);
    }
  }
  for (const which of options.require) if (!out[which]) fail(`L2 does not disclose the ${which} mandate`);
  if (out.checkout && out.payment && out.checkout.checkout_hash !== out.payment.transaction_id) fail("payment mandate transaction_id does not equal checkout_hash");
  return out;
}

function checkoutMandate(m: Record<string, unknown>): CheckoutMandate {
  if (typeof m.checkout_jwt !== "string" || typeof m.checkout_hash !== "string") fail("checkout mandate needs checkout_jwt and checkout_hash");
  if (checkoutHash(m.checkout_jwt as string) !== m.checkout_hash) fail("checkout_hash does not match checkout_jwt");
  return m as unknown as CheckoutMandate;
}

function paymentMandate(m: Record<string, unknown>): PaymentMandate {
  const p = m as unknown as PaymentMandate;
  if (typeof p.payment_instrument?.type !== "string" || typeof p.payment_instrument?.id !== "string") fail("payment mandate needs payment_instrument type and id");
  if (typeof p.payment_amount?.currency !== "string" || !Number.isInteger(p.payment_amount?.amount) || p.payment_amount.amount < 0) fail("payment_amount needs currency and an integer amount in minor units");
  if (typeof p.payee?.name !== "string" || typeof p.payee?.website !== "string") fail("payee needs name and website");
  if (typeof p.transaction_id !== "string") fail("payment mandate needs transaction_id");
  return p;
}

function parse(serialized: unknown, layer: string) {
  try {
    return parseSdJwt(serialized);
  } catch (err) {
    return fail(`${layer}: ${err instanceof Error ? err.message : err}`);
  }
}

async function verifyJwt(layer: string, run: () => Promise<{ payload: JWTPayload }>): Promise<JWTPayload> {
  try {
    return (await run()).payload;
  } catch (err) {
    return fail(`${layer} rejected: ${err instanceof Error ? err.message : err}`);
  }
}
