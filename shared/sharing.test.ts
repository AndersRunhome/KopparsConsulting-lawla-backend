import { describe, expect, it } from "vitest";
import { shareStatus, shareUrl } from "./sharing";
import { buildSnapshot, diffSnapshots } from "./snapshot";

describe("shareStatus", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  it("aktiv utan utgångsdatum och före utgång", () => {
    expect(shareStatus({ expiresAt: null, revokedAt: null }, now)).toBe("active");
    expect(shareStatus({ expiresAt: "2026-10-20T12:00:00Z", revokedAt: null }, now)).toBe("active");
  });
  it("utgången och återkallad", () => {
    expect(shareStatus({ expiresAt: "2026-10-19T12:00:00Z", revokedAt: null }, now)).toBe("expired");
    expect(shareStatus({ expiresAt: "2027-01-01T00:00:00Z", revokedAt: "2026-10-18T00:00:00Z" }, now)).toBe("revoked");
  });
});

describe("shareUrl", () => {
  it("bygger adressen till den delade vyn", () => {
    expect(shareUrl("https://lawla.kopparsconsulting.com/", "abc_DEF-123")).toBe("https://lawla.kopparsconsulting.com/delad/abc_DEF-123");
  });
});

describe("huvudprompt i versioner", () => {
  const project = { title: "A", questions: [], circumstances: [], legalIssues: [] };
  it("följer med i ögonblicksbilden och jämförs", () => {
    const before = buildSnapshot(project, [], 0, "Skriv kort.");
    const after = buildSnapshot(project, [], 0, "Skriv utförligt.");
    expect(before.mainPrompt).toBe("Skriv kort.");
    const diff = diffSnapshots(before, after);
    expect(diff.fields).toEqual([{ field: "mainPrompt", label: "Instruktion till Lawla", before: "Skriv kort.", after: "Skriv utförligt." }]);
  });
  it("gamla versioner utan fältet räknas som tom instruktion", () => {
    const old = { ...buildSnapshot(project, [], 0), mainPrompt: undefined };
    expect(diffSnapshots(old, buildSnapshot(project, [], 0)).total).toBe(0);
    expect(diffSnapshots(old, buildSnapshot(project, [], 0, "Ny")).fields[0]?.before).toBe("");
  });
});
