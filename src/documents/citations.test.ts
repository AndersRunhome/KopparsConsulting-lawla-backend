import { describe, expect, it } from "vitest";
import { extractReferences, parseReference } from "./citations.js";

describe("extractReferences", () => {
  it("lagrum med kapitel, förkortning och SFS-nummer", () => {
    const refs = extractReferences("Enligt 5 kap. 16 c § UtlL och 36 § avtalslagen samt 12 kap. 3 § äktenskapsbalken (1987:230).");
    expect(refs.map((r) => r.canonical)).toEqual(["sfs:2005:716#K5P16c", "sfs:1915:218#P36", "sfs:1987:230#K12P3"]);
    expect(refs[0]!.lagrum).toMatchObject({ chapter: "5", paragraph: "16 c", law: "UtlL" });
  });

  it("lagrum utan lag i dokument med känd SFS (intern hänvisning)", () => {
    const refs = extractReferences("se 4 kap. 1 § och 3 §", "2005:716", "4");
    expect(refs.map((r) => r.canonical)).toEqual(["sfs:2005:716#K4P1", "sfs:2005:716#K4P3"]);
  });

  it("rättsfall och förarbeten", () => {
    const refs = extractReferences("Jfr NJA 2015 s. 899, MIG 2017:3, HFD 2016 ref. 21, prop. 2005/06:77, SOU 2020:54 och Ds 2019:7.");
    expect(refs.map((r) => r.canonical)).toEqual(["nja:2015:899", "mig:2017:3", "hfd:2016:21", "prop:2005/06:77", "sou:2020:54", "ds:2019:7"]);
  });

  it("parseReference tolkar en fristående hänvisning", () => {
    expect(parseReference("7 kap. 18 § utlänningslagen")?.canonical).toBe("sfs:2005:716#K7P18");
    expect(parseReference("Prop. 2016/17:180")?.canonical).toBe("prop:2016/17:180");
    expect(parseReference("hej")).toBeNull();
  });
});

describe("listor och interna hänvisningar", () => {
  it("delar paragraflistor och tolkar lösa paragrafer i egen lag med kapitel", () => {
    const refs = extractReferences("enligt 1 § eller med stöd av 21 kap. 2, 3 eller 4 §. Se 17–17 b §§.", "2005:716", "5");
    expect(refs.map((r) => r.canonical)).toEqual([
      "sfs:2005:716#K5P1",
      "sfs:2005:716#K21P2",
      "sfs:2005:716#K21P3",
      "sfs:2005:716#K21P4",
      "sfs:2005:716#K5P17",
      "sfs:2005:716#K5P17b",
    ]);
    expect(refs[0]!.lagrum?.internal).toBe(true);
  });
  it("lösa paragrafer utan känd lag ignoreras", () => {
    expect(extractReferences("enligt 1 § gäller")).toEqual([]);
  });
});
