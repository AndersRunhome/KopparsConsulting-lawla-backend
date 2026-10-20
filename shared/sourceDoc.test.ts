import { describe, expect, it } from "vitest";
import {
  buildToc,
  findLagrum,
  lagrumText,
  parseLagrumQuery,
  resolveBareNumber,
  chunksToBlocks,
  lagenUriIn,
  lagrumRange,
  lawAbbreviation,
  parseLagenMarkdown,
  parseSourceKey,
  selectionLabel,
  sourceKey,
} from "./sourceDoc";

// Utdrag i lagen.nu:s format (GET /api/v1/document?format=md), avstämt 2026-10-20.
const UTLL = `# Utlänningslag (2005:716)

## [1 kap.](https://lagen.nu/2005:716#K1) Lagens innehåll

### Lagens innehåll

**1 §** I denna lag finns föreskrifter om

1. lagens innehåll ([1 kap.](https://lagen.nu/2005:716#K1)),

2. villkor för att en utlänning ska få resa in.

**2 §** Andra paragrafen.

## [4 kap.](https://lagen.nu/2005:716#K4) Internationellt skydd

### Undantag från rätten att stanna kvar i Sverige

**1 §** I de situationer som anges i [artikel 9](https://lagen.nu/x) får en utlänning nekas.

**1 a §** Mellanparagraf.

**3 §** Tredje.`;

describe("parseLagenMarkdown", () => {
  const blocks = parseLagenMarkdown(UTLL, "https://lagen.nu/2005:716");

  it("ger paragrafer med lagrum och lagen.nu:s ankare", () => {
    const pars = blocks.filter((b) => b.lagrum);
    expect(pars.map((b) => [b.anchor, b.label])).toEqual([
      ["K1P1", "1 kap. 1 §"],
      ["K1P2", "1 kap. 2 §"],
      ["K4P1", "4 kap. 1 §"],
      ["K4P1a", "4 kap. 1 a §"],
      ["K4P3", "4 kap. 3 §"],
    ]);
    expect(pars[0]!.text).toContain("1 § I denna lag finns föreskrifter om");
    expect(pars[0]!.text).toContain("lagens innehåll (1 kap.)");
    expect(pars[2]!.text).not.toContain("https://");
  });

  it("rubriker får ankare från kapitellänken, titeln hoppas över", () => {
    const heads = blocks.filter((b) => b.kind === "heading");
    expect(heads[0]).toMatchObject({ anchor: "K1", label: "1 kap. Lagens innehåll", level: 2 });
    expect(heads.some((h) => h.label === "Utlänningslag (2005:716)")).toBe(false);
  });

  it("innehållsförteckning med rubriker och paragrafer", () => {
    const toc = buildToc(blocks);
    expect(toc.slice(0, 4).map((t) => [t.label, t.leaf])).toEqual([
      ["1 kap. Lagens innehåll", false],
      ["Lagens innehåll", false],
      ["1 kap. 1 §", true],
      ["1 kap. 2 §", true],
    ]);
  });

  it("dokument utan paragrafer delas efter rubriker och långa stycken", () => {
    const long = Array.from({ length: 30 }, (_, i) => `Stycke ${i} ${"ord ".repeat(60)}`).join("\n\n");
    const b = parseLagenMarkdown(`# Prop\n\n## 5.3 Verkställighet\n\n${long}`, "https://lagen.nu/prop/2004/05:170");
    expect(b[0]!.label).toBe("5.3 Verkställighet");
    expect(b.length).toBeGreaterThan(2);
    expect(b.slice(1).every((x) => x.label === "5.3 Verkställighet" && !x.lagrum)).toBe(true);
    expect(new Set(b.map((x) => x.anchor)).size).toBe(b.length);
  });
});

describe("etiketter", () => {
  const meta = { title: "Utlänningslag (2005:716)", identifier: "SFS 2005:716" };
  const p = (label: string) => ({ anchor: "x", kind: "text" as const, level: 3, label, lagrum: true, text: "" });

  it("lagrummet först, med lagens förkortning", () => {
    expect(selectionLabel(p("4 kap. 1 §"), p("4 kap. 1 §"), meta)).toBe("4 kap. 1 § UtlL");
    expect(selectionLabel(p("4 kap. 1 §"), p("4 kap. 3 §"), meta)).toBe("4 kap. 1–3 §§ UtlL");
    expect(selectionLabel(p("4 kap. 3 §"), p("5 kap. 1 §"), meta)).toBe("4 kap. 3 § – 5 kap. 1 § UtlL");
    expect(selectionLabel(p("36 §"), p("36 §"), { title: "Lag (1915:218) om avtal och andra rättshandlingar på förmögenhetsrättens område", identifier: "SFS 1915:218" })).toBe("36 § AvtL");
    expect(selectionLabel(p("3 §"), p("3 §"), { title: "Lag (2099:1) om något", identifier: "SFS 2099:1" })).toBe("3 § SFS 2099:1");
  });

  it("korpusetikett som redan innehåller lagen lämnas", () => {
    expect(selectionLabel(p("Äktenskapsbalk 12 kap. 3 §"), p("Äktenskapsbalk 12 kap. 3 §"), { title: "Äktenskapsbalk (1987:230)", identifier: null })).toBe(
      "Äktenskapsbalk 12 kap. 3 §",
    );
  });

  it("förarbeten: kommentar till paragraf anges som kommentar, inte som lagrum", () => {
    const b = parseLagenMarkdown("# Prop\n\n## 13 Författningskommentar\n\n**5 kap. Uppehållstillstånd**\n\n**18 §**\n\nParagrafen anger …", "https://lagen.nu/prop/2025/26:301");
    const par = b.find((x) => x.lagrum)!;
    expect(par.label).toBe("5 kap. 18 §");
    expect(selectionLabel(par, par, { title: "Skärpta krav", identifier: "Prop. 2025/26:301", isLaw: false })).toBe("Prop. 2025/26:301, kommentaren till 5 kap. 18 §");
  });

  it("förarbeten: beteckning och avsnitt", () => {
    const h = { anchor: "t", kind: "text" as const, level: 3, label: "5.3 Verkställighet", lagrum: false, text: "" };
    expect(selectionLabel(h, h, { title: "Ny instans- och processordning", identifier: "Prop. 2004/05:170" })).toBe("Prop. 2004/05:170 – 5.3 Verkställighet");
  });

  it("förkortningar", () => {
    expect(lawAbbreviation("Äktenskapsbalk (1987:230)")).toBe("ÄktB");
    expect(lawAbbreviation("Konsumentköplag (2022:260)")).toBe("KKL");
    expect(lawAbbreviation("Förvaltningsprocesslag (1971:291)")).toBe("FPL");
    expect(lagrumRange("36 §", "38 §")).toBe("36–38 §§");
  });
});

describe("nycklar", () => {
  it("flikar och lagen.nu-adresser", () => {
    expect(sourceKey({ kind: "doc", documentId: 12 })).toBe("d12");
    expect(sourceKey({ kind: "lagen", uri: "https://lagen.nu/2005:716#K4P1" })).toBe("l/2005:716");
    expect(parseSourceKey("l/prop/2004/05:170")).toEqual({ kind: "lagen", uri: "https://lagen.nu/prop/2004/05:170" });
    expect(parseSourceKey("x")).toBeNull();
    expect(lagenUriIn("Kommentar.\n\nKälla: lagen.nu https://lagen.nu/2005:716#K4P1 (2026-10-20).")).toBe("https://lagen.nu/2005:716#K4P1");
  });
  it("korpusavsnitt", () => {
    const b = chunksToBlocks([
      { id: 9, chunkIndex: 1, displayLabel: "12 kap. 3 §", content: " text " },
      { id: 8, chunkIndex: 0, displayLabel: "Inledning", content: "a" },
    ]);
    expect(b.map((x) => [x.anchor, x.lagrum, x.text])).toEqual([
      ["chunk-8", false, "a"],
      ["chunk-9", true, "text"],
    ]);
  });
});

describe("gå till lagrum", () => {
  const blocks = parseLagenMarkdown(UTLL, "https://lagen.nu/2005:716");
  it("tolkar skrivsätt", () => {
    const want = { chapter: "7", paragraph: "18" };
    for (const q of ["7 18", "7:18", "7 kap 18", "7 kap. 18 §", "7kap 18§", " 7  18 "]) expect(parseLagrumQuery(q)).toEqual(want);
    expect(parseLagrumQuery("3 a 2")).toEqual({ chapter: "3 a", paragraph: "2" });
    expect(parseLagrumQuery("4 1a")).toEqual({ chapter: "4", paragraph: "1 a" });
    expect(parseLagrumQuery("7 kap")).toEqual({ chapter: "7", paragraph: null });
    expect(parseLagrumQuery("36 §")).toEqual({ chapter: null, paragraph: "36" });
    expect(parseLagrumQuery("36")).toEqual({ chapter: null, paragraph: "36" });
    expect(parseLagrumQuery("barnets bästa")).toBeNull();
    expect(parseLagrumQuery("2005:716")).toBeNull();
  });
  it("hittar paragraf, kapitel och ensamt tal", () => {
    expect(findLagrum(blocks, { chapter: "4", paragraph: "1 a" })?.anchor).toBe("K4P1a");
    expect(findLagrum(blocks, { chapter: "4", paragraph: "9" })).toBeNull();
    expect(findLagrum(blocks, { chapter: "4", paragraph: null })?.anchor).toBe("K4");
    expect(findLagrum(blocks, resolveBareNumber(blocks, { chapter: null, paragraph: "4" }, "4"))?.anchor).toBe("K4");
    expect(findLagrum(blocks, { chapter: null, paragraph: "3" })?.anchor).toBe("K4P3");
    const avtl = parseLagenMarkdown("# Avtalslag\n\n**36 §** Avtalsvillkor får jämkas.", "https://lagen.nu/1915:218");
    expect(findLagrum(avtl, resolveBareNumber(avtl, { chapter: null, paragraph: "36" }, "36"))?.anchor).toBe("P36");
    const corpus = chunksToBlocks([{ id: 1, chunkIndex: 0, displayLabel: "Äktenskapsbalk 12 kap. 3 §", content: "x" }]);
    expect(findLagrum(corpus, { chapter: "12", paragraph: "3" })?.anchor).toBe("chunk-1");
    expect(lagrumText({ chapter: "7", paragraph: "18" })).toBe("7 kap. 18 §");
  });
});
