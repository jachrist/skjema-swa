/**
 * Tester for «sett inn før/etter» på felt og seksjoner i editoren.
 *
 * Det som må holde er ikke at innsettingen virker — det er at den advarer på
 * riktig sted. Feltnummer tildeles etter posisjon, så et felt satt inn midt i
 * en seksjon forskyver alle under, og skjemaer uten stabil felt-id kan da vise
 * svarene sine under feil spørsmål.
 *
 * Innsetting NEDERST forskyver derimot ingenting. Advarer vi der også, lærer
 * folk seg å klikke den vekk — og da beskytter den ingen når det gjelder.
 * Derfor er «advarer ikke nederst» like viktig å teste som «advarer i midten».
 *
 * Kjøres med:  node frontend/test/editor-innsetting.test.js
 */
const fs = require('fs');
const path = require('path');

const kilde = fs.readFileSync(path.join(__dirname, '..', 'editor.html'), 'utf8');
function klipp(navn) {
    const start = kilde.indexOf(`function ${navn}(`);
    if (start === -1) throw new Error(`Fant ikke ${navn} i editor.html`);
    // Funksjonene er indentert med 8 mellomrom, så «\n        }» avslutter dem.
    const slutt = kilde.indexOf('\n        }', start) + '\n        }'.length;
    return kilde.slice(start, slutt);
}

/** Bygger et isolert editor-miljø med stubbede omgivelser. */
function lagEditor(seksjoner, { svarPåAdvarsel = true } = {}) {
    const logg = { advarsler: 0 };
    let idTeller = 0;
    const src = [
        klipp('nyttFelt'), klipp('renummererFelter'), klipp('renummererSeksjoner'),
        klipp('settInnFelt'), klipp('settInnSeksjon')
    ].join('\n');

    const fabrikk = new Function('data', 'stub', `
        const { nyId, bekreftStrukturendring, fangKollapsKart,
                oppdaterKollapsEtterFlytting, rendrerSeksjoner,
                fokuserFelt, fokuserSeksjon } = stub;
        ${src}
        return { settInnFelt, settInnSeksjon, nyttFelt };
    `);

    const data = { Seksjoner: seksjoner };
    const api = fabrikk(data, {
        nyId: () => `ny-${++idTeller}`,
        bekreftStrukturendring: () => { logg.advarsler++; return svarPåAdvarsel; },
        fangKollapsKart: () => new Map(),
        oppdaterKollapsEtterFlytting: () => { },
        rendrerSeksjoner: () => { },
        fokuserFelt: () => { },
        fokuserSeksjon: () => { }
    });
    return { ...api, data, logg };
}

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const seksjon = (felter) => ({ Seksjon_nummer: 1, Seksjon_overskrift: 'S', Felter: felter });
const felt = (nr, id) => ({ Id: id, Nummer: nr, Type: 'Tekst' });
const numre = (e) => e.data.Seksjoner[0].Felter.map(f => f.Nummer);
const ider = (e) => e.data.Seksjoner[0].Felter.map(f => f.Id);

// ---------- felt: nederst advarer ikke ----------
{
    const e = lagEditor([seksjon([felt('01', 'a'), felt('02', 'b')])]);
    e.settInnFelt(0, 2);
    sjekk('nederst: ingen advarsel', e.logg.advarsler, 0);
    sjekk('nederst: numre i rekkefølge', numre(e), ['01', '02', '03']);
    sjekk('nederst: eksisterende felt urørt', ider(e).slice(0, 2), ['a', 'b']);
}

// ---------- felt: midt i advarer ----------
{
    const e = lagEditor([seksjon([felt('01', 'a'), felt('02', 'b')])]);
    e.settInnFelt(0, 1);
    sjekk('midt i: advarte', e.logg.advarsler, 1);
    sjekk('midt i: renummerert', numre(e), ['01', '02', '03']);
    sjekk('midt i: nytt felt på plass 2', ider(e), ['a', 'ny-1', 'b']);
}

// ---------- felt: først advarer ----------
{
    const e = lagEditor([seksjon([felt('01', 'a')])]);
    e.settInnFelt(0, 0);
    sjekk('først: advarte', e.logg.advarsler, 1);
    sjekk('først: nytt felt øverst', ider(e), ['ny-1', 'a']);
}

// ---------- avbrutt advarsel endrer ingenting ----------
{
    const e = lagEditor([seksjon([felt('01', 'a'), felt('02', 'b')])], { svarPåAdvarsel: false });
    e.settInnFelt(0, 1);
    sjekk('avbrutt: ingen felt lagt til', ider(e), ['a', 'b']);
    sjekk('avbrutt: numre urørt', numre(e), ['01', '02']);
}

// ---------- tom seksjon ----------
{
    const e = lagEditor([seksjon([])]);
    e.settInnFelt(0, 0);
    sjekk('tom seksjon: ingen advarsel', e.logg.advarsler, 0);
    sjekk('tom seksjon: ett felt', numre(e), ['01']);
}

// ---------- hvert nytt felt får egen Id ----------
{
    const e = lagEditor([seksjon([])]);
    e.settInnFelt(0, 0);
    e.settInnFelt(0, 1);
    const [a, b] = ider(e);
    sjekk('Id-er er unike', a !== b && !!a && !!b, true);
}

// ---------- seksjoner ----------
{
    const e = lagEditor([
        { Seksjon_nummer: 1, Felter: [] },
        { Seksjon_nummer: 2, Felter: [] }
    ]);
    e.settInnSeksjon(2);
    sjekk('seksjon nederst: ingen advarsel', e.logg.advarsler, 0);
    sjekk('seksjon nederst: numre', e.data.Seksjoner.map(s => s.Seksjon_nummer), [1, 2, 3]);
}

{
    const e = lagEditor([
        { Seksjon_nummer: 1, Seksjon_overskrift: 'A', Felter: [] },
        { Seksjon_nummer: 2, Seksjon_overskrift: 'B', Felter: [] }
    ]);
    e.settInnSeksjon(1);
    sjekk('seksjon midt i: advarte', e.logg.advarsler, 1);
    sjekk('seksjon midt i: numre', e.data.Seksjoner.map(s => s.Seksjon_nummer), [1, 2, 3]);
    sjekk('seksjon midt i: rekkefølge',
        e.data.Seksjoner.map(s => s.Seksjon_overskrift), ['A', '', 'B']);
}

{
    const e = lagEditor([{ Seksjon_nummer: 1, Seksjon_overskrift: 'A', Felter: [] }],
        { svarPåAdvarsel: false });
    e.settInnSeksjon(0);
    sjekk('seksjon avbrutt: uendret', e.data.Seksjoner.length, 1);
}

// ---------- felt i én seksjon rører ikke en annen ----------
{
    const e = lagEditor([
        seksjon([felt('01', 'a')]),
        { Seksjon_nummer: 2, Felter: [felt('01', 'x'), felt('02', 'y')] }
    ]);
    e.settInnFelt(0, 0);
    sjekk('annen seksjon urørt',
        e.data.Seksjoner[1].Felter.map(f => `${f.Id}:${f.Nummer}`), ['x:01', 'y:02']);
}

console.log(`\n${ok} OK, ${feil} feil`);
process.exit(feil ? 1 : 0);
