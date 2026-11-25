# Endringslogg

[English](CHANGELOG.md)

## 0.10.0 (2026-11-25)

Nytt med `SKOLEMELDING_ALLOW_SEND=1`:
- `prepare_mark_all_read`: merker alle meldinger om et barn som lest, som «Marker alle meldinger som lest for valgt barn» i appen. Det tar to steg, med `send_prepared`, fordi det ikke kan angres. Forhåndsvisningen viser hvor mange meldinger som er uleste.
- `set_favourite` og `set_hidden`: merk en melding som favoritt eller skjul den, eller angre det. Du oppgir tilstanden du vil ha. Skolemelding har bare av/på-brytere, så serveren leser meldingen først, og igjen etter at du har bekreftet, endrer ingenting når den allerede er slik du ba om, og leser den igjen etterpå (`verified`). En endring som ikke vises ennå, stopper nye endringer av den meldingen i 5 minutter. En melding om flere barn trenger `child`.
- Bekreftelsesdialogen viser hver verdi på én kort linje, det avgjørende feltet først og teksten som sendes sist, så et emne med linjeskift ikke kan forfalske en linje. En sending som feiler, logges også.
- Vedlegg er ikke lagt til: i appen og nettportalen kan bare ansatte legge ved filer.

## 0.9.0 (2026-11-25)

- `prepare_absence` sender emnet «Melding om fravær» og de tomme feltene appen sender, og avviser når ingen lærer er koblet til barnet på skolen, slik appen gjør: meldingen ville ikke nådd noen.
- `prepare_message` med `include_other_parents` avviser når ingen annen forelder er registrert, som svar- og fraværsverktøyene.
- Nytt `mark_read` (med `SKOLEMELDING_ALLOW_SEND=1`): merker en melding og ulest svar på den som lest. Skolemelding kan ikke merke den som ulest igjen.
- Når klienten støtter MCP-elicitation, spør `send_prepared` og `mark_read` forelderen direkte i klienten før noe sendes, så tekst i en melding ikke kan få KI-en til både å gjøre klart og godkjenne en sending. `send_prepared` trenger også `summary` fra prepare-steget, så godkjenningsspørsmålet i klienten viser innholdet.
- En sending som aldri får svar, sier at den kan ha blitt sendt, i stedet for å be deg prøve igjen. En mislykket skriving til loggen gjør ikke lenger en fullført sending til en feil. Flere usynlige tegn fjernes (tegn som ser blanke ut, rekker av variantvelgere).

## 0.8.0 (2026-11-25)

- Bare feilmeldinger serveren selv har skrevet, når klienten. Før kunne et uventet svar bli sitert i feilen, for eksempel starten på et svar som ikke var JSON.
- Svar fra Skolemelding og innloggingstjenesten har en grense (2 MB og 100 kB), og en forespørselslinje fra klienten 64 kB, så et for stort svar ikke kan fylle minnet på en liten datamaskin.
- En lås som ble liggende etter at en prosess krasjet under fornying av innloggingen, fjernes etter 40 sekunder i stedet for 90, så neste kall venter på den i stedet for å feile som opptatt.
- Lesetjenestene er merket som skrivebeskyttet (`readOnlyHint`). `package.json` sier Node.js 20 eller nyere.

## 0.7.0 (2026-11-24)

- Sending, av med mindre `SKOLEMELDING_ALLOW_SEND=1`: svar i en tråd, svar på ja/nei-spørsmål, bekreft at du har lest, skriv til ansatte og meld fravær. All sending skjer i to steg: et `prepare_…`-verktøy, så `send_prepared` med en engangskode. Det som sendes, logges i `.data/sent.jsonl`.
- Uten innstillingen er alt som før, og serveren leser bare.

## 0.6.1 (2026-11-24)

- `npm run login:mobile` er fjernet. Bruk `npm run login`.
- Serveren oppgir versjonen fra `package.json`. En test som av og til feilet når testfilene kjørte samtidig, er rettet.

## 0.6.0 (2026-11-22)

- Alle verktøy har `outputSchema` og returnerer `structuredContent` i tillegg til JSON-tekst.
- `list_children` returnerer `{ "children": [...] }` og `list_messages` returnerer `{ "messages": [...] }`, ikke en liste alene.

## 0.5.1 (2026-11-09)

- `npm run login` beholder ikke lenger en nettleserprofil, og `SKOLEMELDING_MOBILE_PROFILE` er fjernet. En gammel `.data/mobile-browser-profile/`-mappe kan slettes.
- Usynlige tegn og skjult tekst fjernes fra meldinger.
- Uvanlige vedleggstyper får `.download` lagt til, og lagrede vedlegg merkes som lastet ned på macOS og Windows.
- Meldinger har ikke lenger `recipients`.
- Ett søk gjennom innboksen om gangen, stoppet etter 90 sekunder. Feilmeldinger viser ikke lenger lokale filstier.
- Innloggingen følger ikke omdirigeringer, én feilformet melding stopper ikke lenger `list_messages` eller `get_message`, og et avvist vedlegg gir en tydeligere feil ([#12](https://github.com/kristoffervp/skolemelding-mcp/issues/12)).
- `unread_only` viser ikke lenger chatter som Skolemelding har merket som lest.

## 0.5.0 (2026-11-09)

- `list_messages` tar imot `search`, `unread_only`, `questions_only` og `absence_only`.
- Meldinger viser skolens ja/nei-spørsmål (`question`) og når skolen ber om lesebekreftelse (`readConfirmationRequested`).

## 0.4.0 (2026-11-09)

- Nytt verktøy, `list_children`, og et `child`-filter i `list_messages`. Hver melding viser hvilke barn den gjelder.

## 0.3.0 (2026-11-09)

- `get_attachment` lagrer filen og gir stien. Selve filen kommer bare med `include_content: true`. Tidligere versjoner ga alltid `base64`.
- `get_message` gir ren tekst. HTML kommer bare med `include_html: true`.
- Flere forespørsler samtidig, og meldinger mellomlagres i fem minutter.
- Appversjon og klient-ID-er kan settes med miljøvariabler. Testene kjøres på GitHub ved hver endring.

## 0.2.0 (2026-10-06)

- Første offentlige versjon: `list_messages`, `get_message` og `get_attachment`.
