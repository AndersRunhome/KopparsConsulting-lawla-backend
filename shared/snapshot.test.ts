import { describe, expect, it } from "vitest";
import { buildSnapshot, diffSnapshots, snapshotHash } from "./snapshot";

const base = buildSnapshot(
  {
    title: "A",
    caseOverview: "Bakgrund",
    questions: [{ id: 1, text: "Q1", sortOrder: 1 }, { id: 2, text: "Q0", sortOrder: 0 }],
    legalIssues: [{ id: 3, text: "Rättsfråga", analysisCount: 0 }],
  },
  [{ id: 9, displayLabel: "NJA 2018 s. 1036", annotation: null }],
  0,
);

describe("buildSnapshot", () => {
  it("sorterar poster efter sortOrder och fyller i tomma värden", () => {
    expect(base.questions.map((q) => q.text)).toEqual(["Q0", "Q1"]);
    expect(base.description).toBe("");
    expect(base.evidence[0]).toMatchObject({ label: "NJA 2018 s. 1036", documentTitle: null });
  });
  it("ger samma hash för samma innehåll", () => {
    expect(snapshotHash(base)).toBe(snapshotHash(structuredClone(base)));
    expect(snapshotHash(base)).not.toBe(snapshotHash({ ...base, title: "B" }));
  });
});

describe("diffSnapshots", () => {
  it("hittar ändrade fält samt tillagda, borttagna och ändrade poster", () => {
    const after = structuredClone(base);
    after.caseOverview = "Ny bakgrund";
    after.questions = [{ id: 1, text: "Q1 omformulerad" }, { id: 5, text: "Ny fråga" }];
    after.evidence = [{ ...base.evidence[0]!, annotation: "Viktig" }, { id: 10, label: "Prop. 2020/21:1", documentTitle: null, documentId: null, chunkId: null, annotation: null }];
    after.analysisCount = 1;

    const diff = diffSnapshots(base, after);
    expect(diff.fields).toEqual([{ field: "caseOverview", label: "Ärendebeskrivning", before: "Bakgrund", after: "Ny bakgrund" }]);
    const q = diff.lists.find((l) => l.kind === "questions")!;
    expect(q.added).toEqual(["Ny fråga"]);
    expect(q.removed).toEqual(["Q0"]);
    expect(q.changed).toEqual([{ before: "Q1", after: "Q1 omformulerad" }]);
    const e = diff.lists.find((l) => l.kind === "evidence")!;
    expect(e.added).toEqual(["Prop. 2020/21:1"]);
    expect(e.changed[0]?.after).toBe("NJA 2018 s. 1036 — Viktig");
    expect(diff.lists.some((l) => l.kind === "legalIssues")).toBe(false);
    expect(diff.total).toBe(1 + 3 + 2 + 1);
  });
  it("rapporterar noll ändringar för identiska versioner", () => {
    expect(diffSnapshots(base, structuredClone(base)).total).toBe(0);
  });
});
