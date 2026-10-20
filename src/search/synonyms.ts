/**
 * Vardagsord ↔ juridiska termer. Används vid fulltextsök så att "kasta ut hyresgästen" även
 * träffar "förverkande" och "uppsägning". Listan är en början – fyll på från utvärderingen
 * (eval/questions.jsonl) när frågor missar.
 */
export const SYNONYMS: Record<string, string[]> = {
  // Utlänningsrätt
  uppehållstillstånd: ["ut", "tillstånd", "anknytning"],
  anhöriginvandring: ["anknytning", "uppehållstillstånd", "familjeåterförening"],
  anknytning: ["anhörig", "make", "sambo", "familjeåterförening"],
  utvisning: ["avvisning", "avlägsnande", "återreseförbud"],
  utvisas: ["utvisning", "avvisning"],
  asyl: ["flykting", "skyddsbehov", "alternativt", "skyddsbehövande"],
  flykting: ["asyl", "skyddsbehövande", "förföljelse"],
  arbetstillstånd: ["arbete", "anställning", "uppehållstillstånd"],
  medborgarskap: ["naturalisation", "hemvist"],
  försörjningskrav: ["försörjning", "bostad", "anknytning"],
  // Avtal, hyra, familj
  kontrakt: ["avtal", "rättshandling"],
  avtal: ["kontrakt", "rättshandling", "överenskommelse"],
  oskäligt: ["jämkning", "oskälig", "36"],
  hyresgäst: ["hyresrätt", "hyresavtal", "bostadshyra"],
  vräka: ["förverkande", "uppsägning", "avhysning"],
  vräkning: ["förverkande", "uppsägning", "avhysning"],
  uppsägning: ["förverkande", "uppsägningstid", "upphör"],
  skilsmässa: ["äktenskapsskillnad", "bodelning"],
  vårdnad: ["umgänge", "boende", "barnets bästa"],
  arv: ["kvarlåtenskap", "arvinge", "testamente", "laglott"],
  testamente: ["arv", "laglott", "kvarlåtenskap"],
  // Arbetsrätt
  uppsagd: ["uppsägning", "saklig grund", "anställningsskydd"],
  sparkad: ["avskedande", "uppsägning", "anställningsskydd"],
  avsked: ["avskedande", "grovt åsidosatt"],
  // Allmänt
  ersättning: ["skadestånd", "vederlag"],
  skadestånd: ["ersättning", "skada", "vållande"],
  böter: ["påföljd", "straff"],
  straff: ["påföljd", "fängelse", "böter"],
  överklaga: ["överklagande", "besvär", "prövningstillstånd"],
  myndighet: ["förvaltningsmyndighet", "beslut"],
  tidsfrist: ["frist", "inom", "senast"],
  preskription: ["preskriberad", "frist"],
};
