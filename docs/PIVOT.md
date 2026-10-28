# Humanframe – pivot til norsk AI-resepsjonist

28. okt. 2026 · Casper Nag

Status: anbefaling. Erstatter retningen i [`VISION.md`](VISION.md) («Chief of
Staff for alle») der de to er uenige. Byggelisten under er det som nå styrer
prioriteringen i [`GAPS.md`](GAPS.md).

## Anbefaling

Pivoter Humanframe fra «Chief of Staff for alle» til en norsk AI-resepsjonist
som også utfører oppgavene etter samtalen. Den globale Maya-ideen er for trang,
og videoen er for dyr. Du har allerede de dyre delene: norsk tale, minne,
godkjenningskø, Stripe, bruksmåling og flerbrukerstruktur.

Snakk.ai svarer i telefonen for 990 kr/mnd. Humanframe kan i tillegg handle med
eierens godkjenning:

- booke tid i kalenderen
- sende SMS med lenke for bilder eller mer info
- skrive utkast til tilbud eller svar som eieren godkjenner med ett trykk
- huske kunden neste gang vedkommende ringer

Forskjellen er «noen tok telefonen» mot «jobben er i boks».

## Oppdatering 29. okt. 2026: web først, eget hoveddomene

Telefonen settes på vent. Vi bygger på nettsiden, og vi lar Snakk.ai eie
kundeservice.

**Snakk.ai sitt domene er å svare.** Én agent på telefon, chat og e-post,
gratis FAQ-chatbot, BankID, CRM-sammendrag, pris per minutt, og salg mot
bank, kommune, hotell og eiendom. Det de leverer etter en samtale, er et
sammendrag.

**Humanframes domene er fra henvendelse til oppdrag.** Vi lover ikke at noen
svarer. Vi lover at forespørselen blir en jobb.

| | Snakk.ai | Humanframe |
|---|---|---|
| Spørsmålet | «Hva kan jeg hjelpe deg med?» | «Hva skal gjøres, og når kan dere komme?» |
| Resultat | Sammendrag i CRM | Tilbudsutkast og forslag til tid, godkjent med ett trykk |
| Kunde | Kundeservice-team, finans, kommune | Eier-drevne småbedrifter: håndverk, verksted, klinikk |
| Kanal | Telefon og volum | Nettsiden og bilder |
| Målepunkt | Besvarte samtaler | Henvendelser som ble jobb, i kroner |
| Pris | Per minutt | Fast per måned |

**Det vi bygger nå:**

1. **Widget på nettsiden** (én linje kode). Den stiller fagspørsmålene en
   fagperson ville stilt, tar imot bilder midt i samtalen, og sender en
   komplett forespørsel – ikke en FAQ-bot.
2. **Tilbudsutkast** regnet ut fra eierens egen prisliste, som et nytt
   forslag i godkjenningskøen. Eieren justerer og sender med ett trykk.
   Proanbud er det naturlige neste steget for større tilbud.
3. **Kundeside** per henvendelse: kunden ser status og tilbud, godtar, velger
   tid og legger til bilder. Vi følger saken til den er avtalt.
4. **Rapport i kroner:** forespørsler, tilbud sendt, tilbud godtatt og verdi.
5. **Ny merkevare og nytt grensesnitt** med premium følelse: rolig, varmt og
   presist – et verktøy en håndverker er stolt av å vise kunden.

Status 29. okt.: punkt 1–5 er bygget (se [`WEB.md`](WEB.md)). Gjenstår før
første kunde: kjøre migrasjonene, sette opp e-post (Resend) og legge inn
prislisten i Oppsett.

**Det vi ikke konkurrerer på:** telefonvolum, BankID, bank og kommune, og
gratis FAQ-felt. Telefonen kommer senere som en kanal inn i samme løp; koden
for den ligger klar (docs/RECEPTIONIST.md).

## Kunde og marked

Målgruppen er bedrifter med 1–19 ansatte: ca. 174 000 i Norge (103 298 med 1–4,
40 367 med 5–9 og 30 803 med 10–19 ansatte, per januar 2026, SSB). Velg kunder
etter egenskaper, ikke bransje:

1. En henvendelse er verdt flere tusen kroner.
2. Eieren kan ikke ta telefonen (på stige, i bil, med pasient i stolen).
3. Samtalene er enkle: pris, tid, adresse, «kan dere komme».
4. Eieren bestemmer selv, så salget går raskt.

Test klinikker, verksteder og installatører parallelt, og velg etter pilotdata.

| Konkurrent | Pris / posisjon | Merknad |
|---|---|---|
| Snakk.ai | 990 kr/mnd, live på 7 dager, chatbot inkludert | Hovedkonkurrent, SEO-sider per by og bransje |
| AIChatbot | 999 kr/mnd eks. mva, uten binding | Kun nettsidechatbot |
| Telavox | AI-resepsjonist lansert i Norge | Rettet mot større kunder |
| Waboom / Zeeg | Internasjonalt, ca. 50–300 USD/mnd | Norsk tale (Zeeg fra september 2026) |

Prisene og kundetallene er konkurrentenes egne opplysninger, ikke verifisert.

## Prising og enhetsøkonomi

Snittpris på ca. 1 600 kr/mnd gir 53 kunder = 1 mill. kr i årlig omsetning, og
520 kunder = 10 mill. kr (ca. 0,3 % av målgruppen).

| Plan | Pris/mnd eks. mva | Inkludert | Estimert margin |
|---|---|---|---|
| Liten | 990 kr | 150 min | ca. 80 % |
| Standard | 1 990 kr | 500 min | ca. 70 % |
| Pro | 3 990 kr | 1 500 min, flere integrasjoner | ca. 60 % |

- Oppsett: 2 990 kr engangs. Overforbruk: 3 kr/min.
- Kostnad per minutt: ca. 0,70 kr for tale (regnet fra kostnadene i
  `lib/plans.ts`) pluss ca. 0,3–0,5 kr for telefoni (anslag, ikke verifisert).
- Videoavatar tas ut av hovedplanene. Den står for halvparten av kostnaden og
  er mest usikker. Selges senere som tillegg: et ansikt i widget på kundens
  nettside.
- Med 4 % frafall per måned er en kunde verdt ca. 28 000 kr
  (1 600 × 70 % margin ÷ 4 %). Du kan bruke opptil ca. 5 000 kr på å skaffe en
  kunde.

Frafall (4 %) og konvertering (3 av 100 kontaktede blir betalende) er
antakelser som pilotene skal teste.

## Kanaler og salg

Start med et demonummer folk kan ringe, og selg til dem som ringer. Det viser
norsk talekvalitet bedre enn noen landingsside.

1. Demonummer og egne .no-sider per bransje. Snakk dekker allerede by, så
   bransje er mer åpent.
2. Kald e-post og sosiale medier mot de tre første bransjene.
3. Din egen kundeliste fra Nag Software og Proanbud.
4. Fase 2: videresalg via regnskapsførere, IT-leverandører og webbyråer.

Salgsløftet er «vi setter det opp, og du betaler full pris først hvis det
virker». Be hver pilotkunde vise anropsloggen fra forrige måned og tell
ubesvarte samtaler. Det er det beste salgsargumentet, og det gir ekte norske
tall. Utenlandske tall om tapte henvendelser skal ikke brukes overfor norske
kunder.

## Det som må bygges

Seks ting skiller dagens Humanframe fra et produkt du kan selge. Kalender er
allerede kalt blokkerende i [`GAPS.md`](GAPS.md) (2.6, 4.3).

- [x] Fiks innloggingen: feilmelding for alle feiltilfeller, ingen
      omdirigeringsløkke uten workspace, engangskode fra e-posten som reserve
      for magiske lenker, og bootstrap som faller tilbake til servicerollen.
      E-postmalen må limes inn i Supabase (docs/RECEPTIONIST.md §3.5).
- [x] Telefoni via viderekobling av ubesvarte anrop fra kundens eget nummer,
      uten nummerportering (Twilio + OpenAI Realtime SIP, telefonsvarer som
      reserve)
- [x] Kalender og booking (ledige tider fra åpningstider, egne bookinger og
      Google Kalender; booking med ett trykk; kalenderabonnement for alle
      andre kalendere)
- [x] SMS med lenke for bilder og mer info (opplastingsside uten innlogging)
- [x] Onboarding fra nettside-URL, så agenten lærer bedriften selv
- [x] Ukesrapport med antall henvendelser som ellers ville gått tapt

Alt er bygget og testet uten ekte telefonsamtaler. Før første kunde må
kontoene settes opp og leverandørdetaljene verifiseres med en testsamtale:
se [`RECEPTIONIST.md`](RECEPTIONIST.md) §3–5.

## 90 dager

Fase 1 bygger og skaffer piloter, fase 2 måler betaling, fase 3 åpner kanalene.

Be hver pilotkunde om anropsloggen og mål ubesvarte anrop før og etter. Hvis
minst 1 av 3 piloter betaler full pris etter 60 dager, har du et produkt.

## Risiko og antakelser

Den største risikoen er at telefon-AI blir en standardfunksjon i telefon- og
bookingsystemer. Behandle derfor pivoten som kontantstrøm og kundekanal, med
Proanbud og nettsider fra Nag Software som oppsalg.

- Snakk har 990 kr som prisanker og live på 7 dager. Ikke gå under prisen.
- Telavox og teleselskapene kan lansere det samme. Jeg fant ikke at Telenor
  eller Telia har et slikt produkt for småbedrifter.
- Norsk tale må høres bra ut på dialekt. Ring demoen selv på bergensk før du
  selger noe.
- Samtaleopptak krever informasjon til innringer og databehandleravtale (GDPR).
- Telefonikostnad, frafall (4 %) og konvertering (3 av 100) er antakelser som
  ikke er målt.
