import { describe, expect, it } from "vitest";
import { decodeEntities, htmlToLines, linesToMarkdown, parseBeteckning, riksdagenIdFromUrl } from "./riksdagen";
import { findCommentary } from "./forarbeten";

describe("riksdagen.se", () => {
  it("beteckningar och adresser", () => {
    expect(parseBeteckning("2004/05:170")).toEqual({ rm: "2004/05", bet: "170" });
    expect(parseBeteckning("prop. 2004/05:170")).toEqual({ rm: "2004/05", bet: "170" });
    expect(parseBeteckning("2004/05:SfU17")).toEqual({ rm: "2004/05", bet: "SfU17" });
    expect(parseBeteckning("SOU 2004:74")).toEqual({ rm: "2004", bet: "74" });
    expect(parseBeteckning("hej")).toBeNull();
    expect(riksdagenIdFromUrl("https://www.riksdagen.se/sv/dokument-och-lagar/dokument/proposition/ny-instans--och-processordning_gs03170/")).toBe("GS03170");
    expect(riksdagenIdFromUrl("https://data.riksdagen.se/dokument/HD03301.html")).toBe("HD03301");
    expect(riksdagenIdFromUrl("https://evil.example/x_gs03170")).toBeNull();
    expect(decodeEntities("a&amp;b &#167; &#x2013; &auml;")).toBe("a&b § – &auml;");
  });

  it("PDF-konverterad HTML blir markdown som kommentarsökningen förstår", () => {
    const html = `<html><head><style>.p{}</style></head><body>
      <div id="page_120"><P class="p1">Prop. 2025/26:301</P><P class="p2"><SPAN>13</SPAN> <SPAN>Författningskommentar</SPAN></P>
      <P>13.1 Förslaget till lag om ändring i utlänningslagen (2005:716)</P>
      <P>5 kap. Uppehållstillstånd</P>
      <P>18 §</P>
      <P>Paragrafen ändras så att kravet på uppehålls-</P><P>tillstånd före inresan</P><P>gäller i fler fall.</P>
      <P>120</P></div>
      <div id="page_121"><P>Prop. 2025/26:301</P><P>19 § Uppehållstillstånd för studier</P><P>Ändringen är redaktionell.</P>
      <P>14 Bilaga</P></div></body></html>`;
    const lines = htmlToLines(html, "Prop. 2025/26:301");
    expect(lines).not.toContain("120");
    expect(lines).not.toContain("Prop. 2025/26:301");
    const md = linesToMarkdown(lines, "Ny proposition");
    expect(md).toContain("## 13 Författningskommentar");
    expect(md).toContain("### 13.1 Förslaget till lag om ändring i utlänningslagen (2005:716)");
    expect(md).toContain("**5 kap. Uppehållstillstånd**");
    expect(md).toContain("Paragrafen ändras så att kravet på uppehållstillstånd före inresan gäller i fler fall.");
    const c = findCommentary(md, { sfs: "2005:716", name: "utlänningslag" }, { chapter: "5", paragraph: "18" });
    expect(c[0]?.markdown).toBe("Paragrafen ändras så att kravet på uppehållstillstånd före inresan gäller i fler fall.");
    expect(findCommentary(md, { sfs: "2005:716", name: null }, { chapter: "5", paragraph: "19" })[0]?.markdown).toBe("Ändringen är redaktionell.");
  });
});
