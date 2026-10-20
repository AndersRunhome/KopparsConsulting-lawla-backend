import { describe, expect, it } from "vitest";
import {
  findCommentary,
  forarbeteUri,
  lagrumFromAnchor,
  lawNameForMatch,
  parseAndrar,
  parseLagrumList,
  provisionHistory,
  type Amendment,
} from "./forarbeten";

describe("ändringsuppgifter", () => {
  it("uppräkningar", () => {
    expect(parseLagrumList("4 kap 1, 2 §§, 5 kap 1 §")).toEqual([
      { chapter: "4", paragraph: "1" },
      { chapter: "4", paragraph: "2" },
      { chapter: "5", paragraph: "1" },
    ]);
    expect(parseLagrumList("5 kap. 15 b, 16 a §§")).toEqual([
      { chapter: "5", paragraph: "15 b" },
      { chapter: "5", paragraph: "16 a" },
    ]);
    expect(parseLagrumList("5 a kap. 1–3 §§")).toEqual(["1", "2", "3"].map((p) => ({ chapter: "5 a", paragraph: p })));
    expect(parseLagrumList("3 a kap.")).toEqual([{ chapter: "3 a", paragraph: "*" }]);
    expect(parseLagrumList("36, 38 §§")).toEqual([
      { chapter: null, paragraph: "36" },
      { chapter: null, paragraph: "38" },
    ]);
  });

  it("rpubl:andrar som lagen.nu anger det", () => {
    const ops = parseAndrar(
      "nuvarande 5 kap. 16 a § betecknas 5 kap. 16 b §, rubr. närmast före 5 kap. 16 a § sätts närmast före 5 kap. 16 b §; nya 5 kap. 15 b, 16 a §§",
    );
    expect(ops.renamed).toEqual([{ from: { chapter: "5", paragraph: "16 a" }, to: { chapter: "5", paragraph: "16 b" } }]);
    expect(ops.added.map((l) => l.paragraph)).toEqual(["15 b", "16 a"]);
    const two = parseAndrar("upph. 5 kap. 18 b §, 5 b kap. 15 a §; ändr. 5 kap. 18 §, 6 kap. 4 §");
    expect(two.repealed.length).toBe(2);
    expect(two.changed).toEqual([
      { chapter: "5", paragraph: "18" },
      { chapter: "6", paragraph: "4" },
    ]);
    expect(parseAndrar("ändr. 7 kap. 3 d § i 2026:1221").changed).toEqual([]);
    expect(parseAndrar("ändr. p 3 övergångsbest.").changed).toEqual([]);
  });
});

describe("historik för en bestämmelse", () => {
  const am: Amendment[] = [
    { sfs: "SFS 2005:716", forarbeten: ["Prop. 2004/05:170"], andrar: null, ikraft: "2006-03-31" },
    { sfs: "SFS 2010:533", forarbeten: ["Prop. 2009/10:190", "Bet. 2009/10:SfU11"], andrar: "nuvarande 5 kap. 16 a § betecknas 5 kap. 16 b §; nya 5 kap. 15 b, 16 a §§", ikraft: "2010-07-15" },
    { sfs: "SFS 2012:322", forarbeten: ["Prop. 2011/12:85"], andrar: "nuvarande 5 kap. 16 b § betecknas 5 kap. 16 c §; ändr. 5 kap. 16 a §", ikraft: "2012-07-01" },
    { sfs: "SFS 2021:765", forarbeten: ["Prop. 2020/21:191"], andrar: "ändr. 5 kap. 16 c §, 7 kap. 18 §", ikraft: "2021-07-20" },
  ];
  it("följer ny beteckning bakåt till ursprunget", () => {
    const h = provisionHistory({ chapter: "5", paragraph: "16 c" }, am, "SFS 2005:716");
    expect(h.map((e) => [e.sfs, e.kind, e.label, e.previous, e.prop])).toEqual([
      ["SFS 2021:765", "ändrad", "5 kap. 16 c §", null, "Prop. 2020/21:191"],
      ["SFS 2012:322", "ny beteckning", "5 kap. 16 c §", "5 kap. 16 b §", "Prop. 2011/12:85"],
      ["SFS 2010:533", "ny beteckning", "5 kap. 16 b §", "5 kap. 16 a §", "Prop. 2009/10:190"],
      ["SFS 2005:716", "ursprunglig", "5 kap. 16 a §", null, "Prop. 2004/05:170"],
    ]);
  });
  it("stannar vid införandet", () => {
    const h = provisionHistory({ chapter: "5", paragraph: "16 a" }, am, "SFS 2005:716");
    expect(h.map((e) => [e.sfs, e.kind])).toEqual([
      ["SFS 2012:322", "ändrad"],
      ["SFS 2010:533", "införd"],
    ]);
  });
  it("lagtextens senaste ändring tas med även om metadatan saknar den", () => {
    const h = provisionHistory({ chapter: "12", paragraph: "1" }, am, "SFS 2005:716", "2021:765");
    expect(h.map((e) => e.kind)).toEqual(["ändrad", "ursprunglig"]);
  });
  it("hjälpfunktioner", () => {
    expect(lagrumFromAnchor("K3aP2")).toEqual({ chapter: "3 a", paragraph: "2" });
    expect(lagrumFromAnchor("P36")).toEqual({ chapter: null, paragraph: "36" });
    expect(forarbeteUri("Prop. 2004/05:170")).toBe("https://lagen.nu/prop/2004/05:170");
    expect(forarbeteUri("Bet. 2004/05:SfU17")).toBeNull();
    expect(lawNameForMatch("Utlänningslag (2005:716)")).toBe("utlänningslag");
    expect(lawNameForMatch("Lag (1915:218) om avtal och andra rättshandlingar")).toBe("om avtal och andra rättshandlingar");
  });
});

// Utdrag i lagen.nu:s format (avstämt mot prop. 2025/26:301 och 2004/05:170).
const PROP = `# Prop

## 12 Konsekvenser

Text.

## 13 Författningskommentar

### 13.1 Förslaget till lag om ändring i [utlänningslagen (2005:716)](https://lagen.nu/2005:716)

**5 kap. Uppehållstillstånd**

#### Uppehållstillstånd på grund av anknytning

**3 § Uppehållstillstånd på grund av anknytning till en person**

Paragrafen ändras så att …

Andra stycket är nytt.

**18 §**

Ändringen i 18 § innebär att …

**6 kap.**

#### 2–4 §§

Gemensam kommentar för 6 kap. 2–4 §§.

### 13.2 Förslaget till lag om ändring i [studiestödslagen (1999:1395)](https://lagen.nu/1999:1395)

**5 kap.**

**18 §**

Fel lag.

### 13.3 Förslaget till lag om ändring i lagen (2026:000) om ändring i utlänningslagen (2005:716)

**5 kap. 18 §**

Ändringslagen.

## 14 Bilaga

**5 kap. 18 §** Inte kommentar.`;

describe("specialkommentar", () => {
  const law = { sfs: "2005:716", name: "utlänningslag" };
  it("hittar paragrafen i rätt lagförslag och kapitel", () => {
    const c = findCommentary(PROP, law, { chapter: "5", paragraph: "18" });
    expect(c).toHaveLength(1);
    expect(c[0]!.section).toBe("13.1 Förslaget till lag om ändring i utlänningslagen (2005:716)");
    expect(c[0]!.markdown).toBe("Ändringen i 18 § innebär att …");
  });
  it("rubrik med text och flera stycken, mellanrubrik avslutar", () => {
    const c = findCommentary(PROP, law, { chapter: "5", paragraph: "3" })[0]!;
    expect(c.heading).toBe("3 § Uppehållstillstånd på grund av anknytning till en person");
    expect(c.markdown).toBe("Paragrafen ändras så att …\n\nAndra stycket är nytt.");
  });
  it("gemensam kommentar för ett intervall", () => {
    expect(findCommentary(PROP, law, { chapter: "6", paragraph: "3" })[0]!.markdown).toBe("Gemensam kommentar för 6 kap. 2–4 §§.");
    expect(findCommentary(PROP, law, { chapter: "6", paragraph: "5" })).toEqual([]);
  });
  it("ursprunglig lag: kapitel som rubrik, specialmotivering", () => {
    const old = `## 24 Författningskommentar\n\n### 24.1 Förslaget till utlänningslag\n\n**1 kap. Lagens innehåll**\n\n**1 §**\n\nParagrafen motsvarar 1 kap. 1 § UtlL.\n\n## 12 kap. Verkställighet\n\n**1 §**\n\nOm hinder.\n\n## 13 och 14 §§\n\nGemensamt.\n\n## 25 Bilaga\n\nx`;
    expect(findCommentary(old, law, { chapter: "12", paragraph: "1" })[0]!.markdown).toBe("Om hinder.");
    expect(findCommentary(old, law, { chapter: "12", paragraph: "14" })[0]!.markdown).toBe("Gemensamt.");
    expect(findCommentary(old, law, { chapter: "1", paragraph: "1" })[0]!.markdown).toContain("motsvarar");
  });
  it("paragraf på vanlig rad (äldre propositioner)", () => {
    const p77 = `## 9 Författningskommentar\n\n### 9.1 Förslaget till lag om ändring i utlänningslagen (2005:716)\n\n**5 kap.**\n\n16 a § Paragrafen är ny. Den reglerar …\n\nAndra stycket.\n\n17 § Ändringen …\n\n## 10 Bilaga`;
    const c = findCommentary(p77, law, { chapter: "5", paragraph: "16 a" })[0]!;
    expect(c.heading).toBe("16 a §");
    expect(c.markdown).toBe("Paragrafen är ny. Den reglerar …\n\nAndra stycket.");
  });
});
