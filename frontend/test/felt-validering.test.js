/**
 * Tredje lag i `valider()`: vilkår som kan vise til ANDRE felter.
 *
 * Brukerønske 22.10.2026: «sluttdato etter startdato», «minst 14 dager
 * fram», «etter dagens dato». Tallgrenser fantes alt (`Min_verdi`/
 * `Max_verdi`), e-post, fødselsnummer og kontonummer likeså — men ingen
 * regel kunne sammenligne to felter.
 *
 * Fire ting holdes fast:
 *
 *   **Rekkefølgen mellom lagene.** Obligatorisk, så felttypen, så
 *   vilkårene. Et felt som ikke er et gyldig tall skal si nettopp det —
 *   ikke «må være minst 14 dager etter startdato», som sender den som
 *   fyller ut på jakt i feil ende av skjemaet.
 *
 *   **Uten `ctx` er `valider` den samme funksjonen som før.** Kallsteder
 *   som ikke har hele skjemaet for hånden skal virke uendret, og det er
 *   nettopp det som gjør at lag 3 kunne legges til uten å røre dem.
 *
 *   **En regel hopper over seg selv** til alle feltene den viser til er
 *   utfylt. Uten det møter brukeren «ugyldig» på et felt hen ikke har
 *   rørt, i samme øyeblikk skjemaet åpnes.
 *
 *   **Kallstedet sender med skjemaet.** `index.html` må gi `valider` den
 *   tredje parameteren. Glemmes den, hopper lag 3 over seg selv i
 *   stillhet — reglene er satt opp i editoren og gjør ingenting.
 *
 * Kjøres med:  node frontend/test/felt-validering.test.js
 */
const fs = require('fs');
const path = require('path');
const { hentEksport, utenKommentarer } = require('../../scripts/test-kilde.js');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const rot = path.join(__dirname, '..', '..');
const les = (...p) => fs.readFileSync(path.join(rot, ...p), 'utf8');

// `valider` hentes ut av kilden sammen med hjelperne den bruker.
// `forsteBrudd` kommer fra vilkar.js og sendes inn — den er testet for seg
// i api/test/vilkar-tvilling.test.js, på BEGGE kopiene.
const kilde = les('frontend', 'js', 'felt-render.js');
const vilkar = require(path.join(rot, 'api', 'src', 'lib', 'vilkar.js'));

const validerKilde = hentEksport(kilde, 'valider',
    ['_erGyldigEpost', '_erGyldigFodselsnummer', '_erGyldigKontonummer']);
// hentEksport bygger funksjonen i sitt eget scope; `forsteBrudd` må bindes.
const valider = (felt, svar, ctx) => {
    global.forsteBrudd = vilkar.forsteBrudd;
    try { return validerKilde(felt, svar, ctx); }
    finally { delete global.forsteBrudd; }
};

const SEKSJONER = [{
    Seksjon_nummer: '1',
    Felter: [
        { Nummer: 1, Svar: ['2026-03-01'] },   // startdato
        { Nummer: 2, Svar: ['2026-03-05'] },   // sluttdato, for tidlig
        { Nummer: 3, Svar: [] }                // tomt
    ]
}];

const regel = (felt, op, verdi, melding) => ([{
    Vilkar: { EllerAv: [{ OgAv: [{ Felt: felt, Operator: op, Verdi: verdi }] }] },
    Melding: melding
}]);

// ---------- 1. lag 3 slår til, og bare med ctx ----------
{
    const felt = {
        Type: 'Dato',
        Validering: regel('1-02', '>=', { Felt: '1-01', PlussDager: 14 },
            'Sluttdato må være minst 14 dager etter startdato')
    };

    sjekk('uten ctx hoppes lag 3 over',
        valider(felt, ['2026-03-05']), { ok: true });

    sjekk('med ctx slår regelen til',
        valider(felt, ['2026-03-05'], { seksjoner: SEKSJONER }),
        { ok: false, feilmelding: 'Sluttdato må være minst 14 dager etter startdato' });

    const nok = JSON.parse(JSON.stringify(SEKSJONER));
    nok[0].Felter[1].Svar = ['2026-03-20'];
    sjekk('og slipper gjennom når regelen holder',
        valider(felt, ['2026-03-20'], { seksjoner: nok }), { ok: true });
}

// ---------- 2. en regel med tomt felt hopper over seg selv ----------
{
    // Feltet som valideres MÅ være utfylt her. Er det tomt, returnerer
    // lag 1 før lag 3 i det hele tatt, og tilfellet beviser ingenting —
    // det var nettopp slik første utgave var grønn uten å måle noe.
    const felt = {
        Type: 'Dato',
        Validering: regel('1-02', '>', { Felt: '1-03' }, 'Må være etter sluttfrist')
    };
    sjekk('utfylt felt, men regelen viser til et TOMT felt',
        valider(felt, ['2026-03-05'], { seksjoner: SEKSJONER }), { ok: true });

    // Og motprøven: samme felt, samme form, men høyresiden er utfylt —
    // da SKAL regelen slå til. Uten denne kunne «hopp over» vært «hopp
    // over alt».
    const fylt = JSON.parse(JSON.stringify(SEKSJONER));
    fylt[0].Felter[2].Svar = ['2026-06-01'];
    sjekk('samme regel slår til når feltet er fylt ut',
        valider(felt, ['2026-03-05'], { seksjoner: fylt }),
        { ok: false, feilmelding: 'Må være etter sluttfrist' });
}

// ---------- 3. rekkefølgen mellom lagene ----------
{
    // Obligatorisk vinner over alt.
    const obl = {
        Type: 'Tall', Obligatorisk: true,
        Validering: regel('1-02', '>', 999, 'aldri')
    };
    sjekk('obligatorisk melder først',
        valider(obl, [], { seksjoner: SEKSJONER }),
        { ok: false, feilmelding: 'Dette feltet er obligatorisk' });

    // Felttypen vinner over vilkåret: «må være et tall» er det brukeren
    // kan gjøre noe med.
    const tall = {
        Type: 'Tall',
        Validering: regel('1-02', '>', 999, 'skal ikke vises')
    };
    sjekk('felttypen melder før vilkåret',
        valider(tall, ['ikke et tall'], { seksjoner: SEKSJONER }),
        { ok: false, feilmelding: 'Må være et tall' });

    // Og Min_verdi, som fortsatt finnes ved siden av DNF.
    const grense = {
        Type: 'Tall', Min_verdi: 10,
        Validering: regel('1-02', '>', 999, 'skal ikke vises')
    };
    sjekk('Min_verdi melder før vilkåret',
        valider(grense, ['5'], { seksjoner: SEKSJONER }),
        { ok: false, feilmelding: 'Må være minst 10' });
}

// ---------- 4. en regel uten melding får en ----------
{
    const felt = {
        Type: 'Dato',
        Validering: [{ Vilkar: { EllerAv: [{ OgAv: [
            { Felt: '1-02', Operator: '>', Verdi: { Felt: '1-01', PlussDager: 99 } }
        ] }] } }]
    };
    const res = valider(felt, ['2026-03-05'], { seksjoner: SEKSJONER });
    sjekk('brudd uten Melding gir en melding likevel', res.ok, false);
    sjekk('og den er ikke tom', !!res.feilmelding, true);
}

// ---------- 5. kallstedet sender med skjemaet ----------
//
// Dette er sjekken som fanger den stille varianten: reglene settes opp i
// editoren, `valider` kalles med to argumenter, og ingenting skjer.
{
    const side = utenKommentarer(les('frontend', 'index.html'));

    // Funksjonen må importeres der.
    sjekk('index.html importerer valider', /\bvalider\b/.test(side), true);

    // Og kalles med en tredje parameter som bærer seksjonene.
    const kall = /valider\(\s*effektivFelt\s*,\s*verdi\s*,([\s\S]{0,120}?)\)\s*;/.exec(side);
    sjekk('valider kalles med en tredje parameter', !!kall, true);
    if (kall) {
        sjekk('og den bærer seksjonene', /seksjoner\s*:/.test(kall[1]), true);
        sjekk('med svarene fra DOM-en, ikke definisjonen',
            /seksjonerMedSvar/.test(kall[1]), true);
    }

    // felt-render må faktisk importere forsteBrudd — uten den er lag 3
    // en gren som aldri kan kjøre.
    sjekk('felt-render importerer forsteBrudd',
        /import \{[^}]*\bforsteBrudd\b[^}]*\} from '\.\/vilkar\.js'/.test(kilde), true);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
