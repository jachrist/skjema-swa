/**
 * Svargrense — hvor mange ganger kan én person svare?
 *
 * Bygget for avstemninger, og det er den bruken som setter kravene. «Ett svar
 * per person» er ikke en bekvemmelighet i et valg; det er hele poenget. En
 * feil her gir enten et ugyldig resultat eller en velger som mister stemmen
 * sin, og begge deler oppdages først etterpå.
 *
 * Fire ting er verdt å teste, og tre av dem feiler stille hvis de er gale:
 *
 *   **Anonymisering skal ikke tømme tellingen.** Et anonymisert svar ligger
 *   lagret under et pseudonym. Telles bare den åpne adressen, ser hver ny
 *   innsending ut som personens første — og et anonymt valg blir dermed
 *   ubegrenset uten at noe sier fra.
 *
 *   **Pseudonymet må være samme regel som anonymiseringen bruker.** To
 *   implementasjoner av samme hash gir to ulike svar på «har denne personen
 *   stemt». Derfor testes de mot hverandre, ikke mot en forventet streng.
 *
 *   **Utkast er ikke svar.** Teller mellomlagring, blir en person som begynte
 *   å fylle ut og ombestemte seg utestengt fra sin eneste stemme.
 *
 *   **Oppdatering av et avgitt svar er ikke et nytt svar.** Ellers ville en
 *   behandler ikke kunne registrere en beslutning på et skjema i en
 *   skjematype med grense.
 *
 * Og én regel til, som feiler høylytt og derfor er lettere: et ugyldig tall
 * skal bety «ingen grense», ikke «stengt».
 *
 * Kjøres med:  node api/test/svargrense.test.js
 */
const fs = require('fs');
const path = require('path');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const g = require('../src/lib/svargrense');
const kryptering = require('../src/lib/kryptering');

// ---------- grenseFor ----------
{
    sjekk('ingen innstilling = ubegrenset', g.grenseFor({}), 0);
    sjekk('null-skjematype = ubegrenset', g.grenseFor(null), 0);
    sjekk('0 = ubegrenset', g.grenseFor({ MaksSvarPerBruker: 0 }), 0);
    sjekk('1 er én stemme', g.grenseFor({ MaksSvarPerBruker: 1 }), 1);
    sjekk('streng tolkes som tall', g.grenseFor({ MaksSvarPerBruker: '3' }), 3);

    // Et ugyldig tall skal slippe folk inn, ikke stenge dem ute. Feilen faller
    // mot å la en ekstra stemme passere framfor å utestenge alle.
    sjekk('negativt = ubegrenset', g.grenseFor({ MaksSvarPerBruker: -1 }), 0);
    sjekk('tekst = ubegrenset', g.grenseFor({ MaksSvarPerBruker: 'mange' }), 0);
    sjekk('NaN = ubegrenset', g.grenseFor({ MaksSvarPerBruker: NaN }), 0);
    sjekk('desimal rundes ned', g.grenseFor({ MaksSvarPerBruker: 2.9 }), 2);
    sjekk('absurd tall kappes', g.grenseFor({ MaksSvarPerBruker: 1e9 }), g.MAKS_GRENSE);
}

// ---------- identiteterFor ----------
{
    const salt = 'test-salt';
    const ider = g.identiteterFor('Ola@FHS.no', salt);

    sjekk('to identiteter', ider.length, 2);
    sjekk('den åpne er normalisert', ider[0], 'ola@fhs.no');

    // Nøkkelen i hele funksjonen: pseudonymet må være NØYAKTIG det
    // anonymiseringen skriver til tabellen. Sammenlignes mot den ekte
    // anonymiseringen, ikke mot en streng skrevet av her — en kopi ville
    // bestått selv om de to reglene gled fra hverandre.
    const anonymisert = kryptering.anonymiserInnsender({ Innsender_Epost: 'ola@fhs.no' }, salt);
    sjekk('pseudonymet er det anonymiseringen faktisk lagrer',
        ider[1], anonymisert.Innsender_Epost);

    // Store/små bokstaver og mellomrom skal ikke gi en ny person.
    sjekk('samme person uansett skrivemåte',
        g.identiteterFor('  OLA@FHS.NO ', salt), ider);

    // Ulike personer må ikke kollidere.
    const andre = g.identiteterFor('kari@fhs.no', salt);
    sjekk('ulike personer gir ulike pseudonymer', andre[1] === ider[1], false);

    // Prefikset er en kontrakt mot data som ALT ligger lagret. Endres det,
    // finner tellingen ikke igjen svar avgitt før endringen — og grensen
    // slutter å gjelde for dem, uten at noe feiler.
    sjekk('pseudonymet har prefikset anonym-', /^anonym-[0-9a-f]{12}$/.test(ider[1]), true);

    sjekk('tom identitet gir ingenting', g.identiteterFor('', salt), []);
    sjekk('null gir ingenting', g.identiteterFor(null, salt), []);

    // Uten salt skal det fortsatt virke — HASH_SALT kan mangle i et miljø,
    // og da er alternativet at grensen slutter å gjelde i stillhet.
    sjekk('virker uten salt', g.identiteterFor('ola@fhs.no', '').length, 2);
}

// ---------- erNyInnsending ----------
{
    sjekk('nytt svar teller', g.erNyInnsending({ nyStatus: 2, gammelStatus: 0 }), true);
    sjekk('utkast som sendes inn teller', g.erNyInnsending({ nyStatus: 2, gammelStatus: 1 }), true);
    sjekk('mellomlagring teller ikke', g.erNyInnsending({ nyStatus: 1, gammelStatus: 0 }), false);

    // Alt som skjer ETTER innsending er samme svar. En beslutning, en
    // revidering, en avslutning — ingen av dem er en ny stemme.
    sjekk('beslutning på avgitt svar teller ikke', g.erNyInnsending({ nyStatus: 5, gammelStatus: 2 }), false);
    sjekk('revidering teller ikke', g.erNyInnsending({ nyStatus: 3, gammelStatus: 2 }), false);
    sjekk('retur fra revidering teller ikke', g.erNyInnsending({ nyStatus: 2, gammelStatus: 3 }), false);
    sjekk('manglende gammelStatus regnes som nytt', g.erNyInnsending({ nyStatus: 2 }), true);
}

// ---------- maaSjekkes ----------
{
    // Porten inn til hele sperren. Svarer den nei, gjøres ingen telling og
    // ingen avvisning — så en feil her slår ut grensen i stillhet.
    sjekk('uten grense: nei', g.maaSjekkes({ grense: 0, nyStatus: 2, gammelStatus: 0 }), false);
    sjekk('ny innsending med grense: ja', g.maaSjekkes({ grense: 1, nyStatus: 2, gammelStatus: 0 }), true);
    sjekk('utkast som sendes inn: ja', g.maaSjekkes({ grense: 1, nyStatus: 2, gammelStatus: 1 }), true);
    sjekk('mellomlagring: nei', g.maaSjekkes({ grense: 1, nyStatus: 1, gammelStatus: 0 }), false);
    sjekk('beslutning på avgitt svar: nei', g.maaSjekkes({ grense: 1, nyStatus: 5, gammelStatus: 2 }), false);
    sjekk('manglende grense: nei', g.maaSjekkes({ nyStatus: 2, gammelStatus: 0 }), false);
}

// ---------- radTellerMot ----------
{
    // Dette er den regelen tellingen hviler på, og den eneste som kan gi et
    // galt valgresultat uten at noe feiler.
    sjekk('innsendt teller', g.radTellerMot({ rowKey: '1', Skjemastatus: 2 }), true);
    sjekk('til revidering teller', g.radTellerMot({ rowKey: '1', Skjemastatus: 3 }), true);
    sjekk('avsluttet teller', g.radTellerMot({ rowKey: '1', Skjemastatus: 5 }), true);

    // Et utkast er ikke et svar. Teller det, mister personen sin eneste
    // stemme fordi hen begynte å fylle ut og ombestemte seg.
    sjekk('mellomlagret teller ikke', g.radTellerMot({ rowKey: '1', Skjemastatus: 1 }), false);
    sjekk('status 0 teller ikke', g.radTellerMot({ rowKey: '1', Skjemastatus: 0 }), false);
    sjekk('manglende status teller ikke', g.radTellerMot({ rowKey: '1' }), false);

    // Raden som er i ferd med å lagres skal ikke telle seg selv — ellers ville
    // et utkast som sendes inn alltid vært «ett for mange».
    sjekk('egen rad holdes utenfor', g.radTellerMot({ rowKey: '7', Skjemastatus: 2 }, '7'), false);
    sjekk('en annen rad teller likevel', g.radTellerMot({ rowKey: '8', Skjemastatus: 2 }, '7'), true);
    sjekk('id-er sammenlignes som tekst', g.radTellerMot({ rowKey: '7', Skjemastatus: 2 }, 7), false);

    // Samme regel må gjelde på skjemaformen, ikke bare tabellformen.
    sjekk('skjemaform: innsendt', g.radTellerMot({ Skjema_id: '1', Skjema_status: 2 }), true);
    sjekk('skjemaform: utkast', g.radTellerMot({ Skjema_id: '1', Skjema_status: 1 }), false);

    sjekk('null-rad teller ikke', g.radTellerMot(null), false);
}

// ---------- tellingen, ende til ende ----------
{
    // Tabellen som den ville sett ut for en person med ett avgitt svar og ett
    // utkast hen holder på med.
    const rader = [
        { rowKey: '100', Skjemastatus: 2 },   // avgitt
        { rowKey: '101', Skjemastatus: 1 },   // utkast
        { rowKey: '102', Skjemastatus: 1 }    // utkastet som nå sendes inn
    ];
    const tell = (unntatt) => rader.filter(r => g.radTellerMot(r, unntatt)).length;

    sjekk('ett avgitt svar telles', tell(null), 1);
    sjekk('og utkastet som sendes inn endrer ikke tallet', tell('102'), 1);
    sjekk('med grense 1 er det stopp',
        g.sjekkGrense({ grense: 1, antallSvar: tell('102') }).ok, false);
    sjekk('med grense 2 er det lov',
        g.sjekkGrense({ grense: 2, antallSvar: tell('102') }).ok, true);
}

// ---------- sjekkGrense ----------
{
    sjekk('ubegrenset slipper gjennom', g.sjekkGrense({ grense: 0, antallSvar: 99 }).ok, true);
    sjekk('og oppgir ingen rest', g.sjekkGrense({ grense: 0, antallSvar: 99 }).gjenstaaende, null);

    sjekk('første svar med grense 1', g.sjekkGrense({ grense: 1, antallSvar: 0 }).ok, true);
    sjekk('andre svar med grense 1', g.sjekkGrense({ grense: 1, antallSvar: 1 }).ok, false);
    sjekk('over grensen stopper også', g.sjekkGrense({ grense: 1, antallSvar: 5 }).ok, false);

    sjekk('2 av 3 brukt', g.sjekkGrense({ grense: 3, antallSvar: 2 }).gjenstaaende, 1);
    sjekk('3 av 3 brukt', g.sjekkGrense({ grense: 3, antallSvar: 3 }).ok, false);

    // Meldingen skal si noe brukeren forstår, og noe annet ved 1 enn ved 3.
    const en = g.sjekkGrense({ grense: 1, antallSvar: 1 }).melding;
    const tre = g.sjekkGrense({ grense: 3, antallSvar: 3 }).melding;
    sjekk('melding ved én stemme', /allerede svart/.test(en), true);
    sjekk('melding ved flere', /3/.test(tre), true);
    sjekk('de to meldingene er ikke like', en === tre, false);
    sjekk('ingen melding når det er lov', 'melding' in g.sjekkGrense({ grense: 3, antallSvar: 0 }), false);
}

// ---------- reglene er koblet til der de gjelder ----------
{
    /** Kommentarene strippes: en test skal ikke bestå på sin egen forklaring. */
    const utenKommentarer = (t) => t.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const les = (...p) => utenKommentarer(
        fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8'));

    const lagring = les('functions', 'skjemaer.js');

    // Den ekte sperren MÅ stå ved lagring. Et skjult skjema er ingen
    // tilgangskontroll, og en avstemning er nettopp der noen prøver å gå
    // utenom grensesnittet.
    sjekk('lagreSkjema henter grensen', /svargrense\.grenseFor\(/.test(lagring), true);
    sjekk('lagreSkjema teller svarene', /tellSvarFraBruker\(/.test(lagring), true);
    sjekk('lagreSkjema avviser med 409', /status: 409[\s\S]{0,200}svargrense: true/.test(lagring), true);

    // Og den må bare gjelde nye innsendinger — ellers blokkeres behandlerne.
    //
    // Det holder ikke å sjekke at `maaSjekkes` NEVNES: et vilkår som er byttet
    // ut med `if (false)` lar alle kallene rundt stå, og en slik test gikk
    // grønt mot en sperre som var slått av. Derfor kreves det at `if`-en
    // faktisk spør, og at avvisningen ligger inne i den.
    sjekk('sperren står bak maaSjekkes',
        /if \(svargrense\.maaSjekkes\(\{/.test(lagring), true);
    const port = lagring.indexOf('svargrense.maaSjekkes({');
    const etterPort = port > -1 ? lagring.slice(port, port + 1400) : '';
    sjekk('tellingen skjer inne i den', etterPort.includes('tellSvarFraBruker('), true);
    sjekk('og avvisningen også', /status: 409/.test(etterPort), true);

    // Raden som lagres skal holdes utenfor sin egen telling.
    sjekk('eget skjema holdes utenfor', /unntattSkjemaId: skjemaId/.test(lagring), true);

    // Tellingen må bruke BEGGE identitetene — ellers er en anonymisert
    // avstemning ubegrenset.
    sjekk('teller på begge identitetene', /svargrense\.identiteterFor\(/.test(lagring), true);

    const storage = les('lib', 'skjema-forekomst-storage.js');
    // Statusregelen testes ekte lenger oppe; her skal bare koblingen stå.
    sjekk('tellingen bruker regelen fra svargrense',
        /svargrense\.radTellerMot\(/.test(storage), true);
    sjekk('tellingen filtrerer på innsender', /InnsenderEpost eq/.test(storage), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
