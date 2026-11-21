export interface MockGooglePayPayload {
  gateway: string;
  gatewayMerchantId: string;
  network: string;
  last4: string;
  authMethod: "PAN_ONLY" | "CRYPTOGRAM_3DS";
  amount: number;
  currency: string;
  messageExpiration: string;
}

export function encodeMockGooglePayToken(payload: MockGooglePayPayload): string {
  return JSON.stringify({
    signature: "MOCK-SIGNATURE-NOT-VERIFIABLE",
    intermediateSigningKey: { signedKey: "mock", signatures: ["mock"] },
    protocolVersion: "ECv2",
    signedMessage: JSON.stringify({
      encryptedMessage: Buffer.from(JSON.stringify(payload)).toString("base64"),
      ephemeralPublicKey: "mock",
      tag: "mock",
    }),
  });
}

export function decodeMockGooglePayToken(token: string): MockGooglePayPayload | undefined {
  try {
    const outer = JSON.parse(token);
    if (outer.protocolVersion !== "ECv2" || !outer.signature || typeof outer.signedMessage !== "string") return undefined;
    const signed = JSON.parse(outer.signedMessage);
    return JSON.parse(Buffer.from(signed.encryptedMessage, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}
