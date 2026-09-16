/** The inhabited time zone that reaches each new calendar day first. */
export const PUBLICATION_TIME_ZONE = "Pacific/Kiritimati";

export function currentPublicationDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PUBLICATION_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function isPublicationDateVisible(
  publicationDate: string,
  now = new Date(),
): boolean {
  return publicationDate.slice(0, 10) <= currentPublicationDate(now);
}
