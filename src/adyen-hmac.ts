import { createHmac, timingSafeEqual } from "node:crypto";

export interface NotificationRequestItem {
  additionalData?: Record<string, string>;
  amount: { value: number; currency: string };
  eventCode: string;
  eventDate?: string;
  merchantAccountCode: string;
  merchantReference: string;
  originalReference?: string;
  pspReference: string;
  reason?: string;
  success: "true" | "false";
}

function signingString(item: NotificationRequestItem): string {
  return [
    item.pspReference,
    item.originalReference ?? "",
    item.merchantAccountCode,
    item.merchantReference,
    item.amount.value,
    item.amount.currency,
    item.eventCode,
    item.success,
  ].join(":");
}

export function signNotification(item: NotificationRequestItem, hexKey: string): string {
  return createHmac("sha256", Buffer.from(hexKey, "hex")).update(signingString(item), "utf8").digest("base64");
}

export function isValidNotification(item: NotificationRequestItem, hexKey: string): boolean {
  const given = Buffer.from(item.additionalData?.hmacSignature ?? "", "base64");
  const expected = Buffer.from(signNotification(item, hexKey), "base64");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
