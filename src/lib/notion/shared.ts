import type { UnknownRecord } from "./types";

export function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : null;
}

export function textFromRichText(value: unknown): string {
  if (!Array.isArray(value)) return "";

  return value
    .map((item) => {
      const record = asRecord(item);
      if (!record) return "";
      if (typeof record.plain_text === "string") return record.plain_text;
      const text = asRecord(record.text);
      return typeof text?.content === "string" ? text.content : "";
    })
    .join("");
}
