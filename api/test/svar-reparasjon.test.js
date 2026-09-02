/**
 * Tester for opprettingsjobben som flytter lagrede svar når feltnumrene endrer
 * seg.
 *
 * Det farligste denne koden kan gjøre er ikke å la være å reparere — det er å
 * reparere feil. Et svar skrevet til feil posisjon ser riktig ut og oppdages
 * ikke. Derfor tester vi like grundig på hva den lar være å røre:
 *
 *   - fullformat-skjemaer (bærer Id, trenger ingenting)
 *   - rader som allerede har id
 *   - svar på felt som er fjernet fra definisjonen
 *   - rader på posisjoner som ikke har flyttet seg
 *
 * Kjøres med:  node api/test/svar-reparasjon.test.js
 */
const r = require('../src/lib/svar-reparasjon');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const A = 'id-a', B = 'id-b', C = 'id-c';
const def = (felter) => ({ Seksjoner: [{ Seksjon_nummer: 1, Felter: felter }] });
const f = (id, nr, type = 'Tekst') => ({ Id: id, Nummer: nr, Type: type });

// ---------- flyttekart ----------
{
    // A slettet, B og C rykker opp.
    const gammel = def([f(A, '01'), f(B, '02'), f(C, '03')]);
    const ny = def([f(B, '01'), f(C, '02')]);
    const k = r.byggFlyttekart(gammel, ny);
    sjekk('flyttinger', k.flyttinger, [
        { id: B, fra: '1-02', til: '1-01' },
        { id: C, fra: '1-03', til: '1-02' }
    ]);
    sjekk('fjernet felt registrert', k.fjernet, [A]);
}

{
    // Tillegg nederst flytter ingenting.
    const k = r.byggFlyttekart(def([f(A, '01')]), def([f(A, '01'), f(B, '02')]));
    sjekk('tillegg nederst gir ingen flytting', k.flyttinger, []);
    sjekk('og fjerner ingenting', k.fjernet, []);
}

{
    // Innsetting øverst flytter alt under.
    const k = r.byggFlyttekart(def([f(A, '01'), f(B, '02')]), def([f(C, '01'), f(A, '02'), f(B, '03')]));
    sjekk('innsetting øverst', k.flyttinger, [
        { id: A, fra: '1-01', til: '1-02' },
        { id: B, fra: '1-02', til: '1-03' }
    ]);
}

{
    // Informasjon-felt er ikke med i kompaktformatet og skal ikke telles.
    const k = r.byggFlyttekart(
        def([f(A, '01', 'Informasjon'), f(B, '02')]),
        def([f(A, '01', 'Informasjon'), f(B, '02')])
    );
    sjekk('Informasjon ignoreres', k.flyttinger, []);
}

{
    // Felt uten Id kan ikke spores. De skal ikke gi falske flyttinger.
    const k = r.byggFlyttekart(def([{ Nummer: '01', Type: 'Tekst' }]), def([{ Nummer: '02', Type: 'Tekst' }]));
    sjekk('felt uten Id gir ingen flytting', k.flyttinger, []);
}

// ---------- selve omskrivingen ----------
const flyttinger = [
    { id: B, fra: '1-02', til: '1-01' },
    { id: C, fra: '1-03', til: '1-02' }
];

{
    const skjema = { Skjema_id: '5', Svar: [
        { sek: 1, spm: '02', sva: ['svar B'] },
        { sek: 1, spm: '03', sva: ['svar C'] }
    ] };
    const res = r.reparerKompakt(skjema, flyttinger);
    sjekk('endret', res.endret, true);
    sjekk('posisjoner flyttet', res.skjema.Svar.map(s => `${s.sek}-${s.spm}`), ['1-01', '1-02']);
    sjekk('id stemplet inn', res.skjema.Svar.map(s => s.id), [B, C]);
    sjekk('svarene selv urørt', res.skjema.Svar.map(s => s.sva), [['svar B'], ['svar C']]);
    sjekk('originalen ikke mutert', skjema.Svar.map(s => s.spm), ['02', '03']);
}

{
    // Svar på et fjernet felt står igjen på sin gamle posisjon. Å flytte det
    // ville gitt et annet spørsmål feil svar.
    const skjema = { Svar: [{ sek: 1, spm: '01', sva: ['svar A'] }, { sek: 1, spm: '02', sva: ['svar B'] }] };
    const res = r.reparerKompakt(skjema, flyttinger);
    sjekk('fjernet felt urørt', res.skjema.Svar[0], { sek: 1, spm: '01', sva: ['svar A'] });
    sjekk('det andre flyttet', `${res.skjema.Svar[1].sek}-${res.skjema.Svar[1].spm}`, '1-01');
}

{
    // Visningstekst må følge svaret.
    const skjema = { Svar: [{ sek: 1, spm: '02', sva: ['ING2308'], svt: ['Kull 23'] }] };
    const res = r.reparerKompakt(skjema, flyttinger);
    sjekk('svt følger med', res.skjema.Svar[0].svt, ['Kull 23']);
}

// ---------- hva som IKKE skal røres ----------
{
    const fullformat = { Seksjoner: [{ Seksjon_nummer: 1, Felter: [f(B, '02')] }] };
    sjekk('fullformat trenger ingenting', r.trengerReparasjon(fullformat, flyttinger), false);
}

{
    const medId = { Svar: [{ sek: 1, spm: '02', sva: ['x'], id: B }] };
    sjekk('rad med id trenger ingenting', r.trengerReparasjon(medId, flyttinger), false);
}

{
    const uberørt = { Svar: [{ sek: 2, spm: '01', sva: ['x'] }] };
    sjekk('uberørt posisjon', r.trengerReparasjon(uberørt, flyttinger), false);
}

{
    const berørt = { Svar: [{ sek: 1, spm: '02', sva: ['x'] }] };
    sjekk('berørt posisjon uten id', r.trengerReparasjon(berørt, flyttinger), true);
}

{
    sjekk('tomt skjema', r.trengerReparasjon(null, flyttinger), false);
    sjekk('skjema uten svar', r.trengerReparasjon({ Svar: [] }, flyttinger), false);
}

// ---------- kjøring over mange ----------
async function kjorAlle() {
    const rader = [
        { Skjema_id: '1', Svar: [{ sek: 1, spm: '02', sva: ['a'] }] },              // repareres
        { Skjema_id: '2', Svar: [{ sek: 1, spm: '02', sva: ['b'], id: B }] },       // har id
        { Skjema_id: '3', Seksjoner: [{ Seksjon_nummer: 1, Felter: [f(B, '02')] }] }, // fullformat
        { Skjema_id: '4', Svar: [{ sek: 9, spm: '01', sva: ['d'] }] }               // uberørt
    ];

    {
        const lagret = [];
        const res = await r.reparerAlle(
            { skjematypeId: '7', flyttinger, torrkjor: true },
            { hentAlle: async () => rader, lagre: async (s) => lagret.push(s) }
        );
        sjekk('tørrkjøring teller', { vurdert: res.vurdert, berørte: res.berørte, reparert: res.reparert },
            { vurdert: 4, berørte: 1, reparert: 0 });
        sjekk('tørrkjøring skriver ingenting', lagret.length, 0);
    }

    {
        const lagret = [];
        const res = await r.reparerAlle(
            { skjematypeId: '7', flyttinger },
            { hentAlle: async () => rader, lagre: async (s) => lagret.push(s) }
        );
        sjekk('reparerte én', { berørte: res.berørte, reparert: res.reparert, feilet: res.feilet },
            { berørte: 1, reparert: 1, feilet: 0 });
        sjekk('bare den ene ble skrevet', lagret.map(s => s.Skjema_id), ['1']);
        sjekk('og fikk ny posisjon', `${lagret[0].Svar[0].sek}-${lagret[0].Svar[0].spm}`, '1-01');
    }

    {
        // En rad som feiler skal ikke stoppe resten.
        const mange = [
            { Skjema_id: 'x', Svar: [{ sek: 1, spm: '02', sva: ['a'] }] },
            { Skjema_id: 'y', Svar: [{ sek: 1, spm: '03', sva: ['b'] }] }
        ];
        const res = await r.reparerAlle(
            { skjematypeId: '7', flyttinger },
            {
                hentAlle: async () => mange,
                lagre: async (s) => { if (s.Skjema_id === 'x') throw new Error('nettverk'); }
            }
        );
        sjekk('feil stopper ikke resten', { reparert: res.reparert, feilet: res.feilet }, { reparert: 1, feilet: 1 });
    }

    {
        const res = await r.reparerAlle({ skjematypeId: '7', flyttinger: [] }, { hentAlle: async () => rader });
        sjekk('tomt kart gjør ingenting', res.berørte, 0);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

kjorAlle().catch(e => { console.error('Testen krasjet:', e); process.exit(1); });
