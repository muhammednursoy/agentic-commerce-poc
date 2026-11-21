import type http from "node:http";
import { config, tracing } from "../config.ts";
import { Router, randomId } from "../http.ts";
import type { Req, Res } from "../http.ts";
import { ENROLMENT_PATH, IntentVerificationError, JWKS_PATH, REGISTRATIONS_PATH, generateSigningKey, issueL1, jwksOf, verifyImmediateL2, verifyL1 } from "../vi/credentials.ts";
import type { PaymentMandate, SigningKey } from "../vi/credentials.ts";

export interface IntentRegistration {
  intent_id: string;
  status: "registered";
  transaction_id: string;
  payment_amount: PaymentMandate["payment_amount"];
  payee: PaymentMandate["payee"];
  payment_instrument: PaymentMandate["payment_instrument"];
  nonce: string;
  sub: string;
  expires_at: number;
  registered_at: number;
}

export class MockMastercard {
  readonly issuerId: string;
  readonly registrations = new Map<string, IntentRegistration>();
  private readonly key: SigningKey = generateSigningKey("mock-mc-issuer");
  private readonly nonces = new Set<string>();

  constructor(issuerId: string = config.vi.mastercardUrl) {
    this.issuerId = issuerId;
  }

  router(): Router {
    return new Router()
      .on("GET", JWKS_PATH, () => ({ status: 200, body: jwksOf(this.key) }))
      .on("POST", ENROLMENT_PATH, (r) => this.enrol(r))
      .on("POST", REGISTRATIONS_PATH, (r) => this.register(r))
      .on("GET", `${REGISTRATIONS_PATH}/:id`, (r) => {
        const found = this.registrations.get(r.params.id);
        return found ? { status: 200, body: found } : { status: 404, body: { type: "invalid_request", code: "not_found", message: "no such intent" } };
      });
  }

  async listen(port: number): Promise<http.Server> {
    const server = await this.router().listen(port, "mock-mastercard");
    if (tracing()) console.log(`[mock-mastercard] SIMULATED Mastercard (not Mastercard): Verifiable Intent issuer (L1) and registration service, issuer ${this.issuerId}`);
    return server;
  }

  private async enrol(req: Req): Promise<Res> {
    const b = req.body ?? {};
    const jwk = b.cnf_jwk;
    if (jwk?.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || "d" in jwk || !/^\d{4}$/.test(b.pan_last_four ?? "") || typeof b.scheme !== "string") {
      return { status: 422, body: { type: "invalid_request", code: "invalid_request", message: "cnf_jwk (EC P-256 public key), pan_last_four and scheme are required" } };
    }
    const sub = randomId("user-", 6);
    const credential = await issueL1(this.key, { iss: this.issuerId, sub, cnfJwk: jwk, panLastFour: b.pan_last_four, scheme: b.scheme, email: b.email });
    return { status: 201, body: { sub, credential } };
  }

  private async register(req: Req): Promise<Res> {
    const { l1, l2 } = req.body ?? {};
    let registration: IntentRegistration;
    try {
      const holder = await verifyL1(l1, async (iss) => (iss === this.issuerId ? jwksOf(this.key) : undefined));
      const intent = await verifyImmediateL2(l2, l1, holder, { audiences: [config.vi.agentPlatformId], require: ["payment"] });
      const payment = intent.payment!;
      registration = {
        intent_id: randomId("vi_", 10),
        status: "registered",
        transaction_id: payment.transaction_id,
        payment_amount: payment.payment_amount,
        payee: payment.payee,
        payment_instrument: payment.payment_instrument,
        nonce: intent.nonce,
        sub: holder.sub,
        expires_at: intent.exp,
        registered_at: Math.floor(Date.now() / 1000),
      };
    } catch (err) {
      if (!(err instanceof IntentVerificationError)) throw err;
      return { status: 422, body: { type: "invalid_request", code: "intent_verification_failed", message: err.message } };
    }
    if (this.nonces.has(registration.nonce)) {
      return { status: 409, body: { type: "invalid_request", code: "nonce_replayed", message: "this L2 nonce was already registered" } };
    }
    this.nonces.add(registration.nonce);
    this.registrations.set(registration.intent_id, registration);
    return { status: 201, body: registration };
  }
}
