/**
 * Tester for arbeidsfanene.
 *
 * To ting er verdt å teste her. Identiteten til en fane: bommer den, får du
 * enten en ny fane for hver navigasjon eller to ulike oppgaver som slår seg
 * sammen til én. Og fortrengningen: en fane med ulagret arbeid skal aldri falle
 * av av seg selv, for da ryker arbeid uten at noen ba om det.
 *
 * Modulen er en ES-modul og lastes med dynamisk import. Den kjører bare
 * nettleserdelen når `document` finnes, så den kan importeres her uten stubber.
 *
 * Kjøres med:  node frontend/test/faner.test.js
 */
const path = require('path');
const { pathToFileURL } = require('url');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const BASE = 'https://swa.example';

async function kjor() {
    const modul = pathToFileURL(path.join(__dirname, '..', 'js', 'faner.js')).href;
    const f = await import(modul);

    // ---------- stiFor ----------
    {
        sjekk('rot blir skjemaoversikten', f.stiFor('/'), '/velgskjematype.html');
        sjekk('tom sti blir skjemaoversikten', f.stiFor(''), '/velgskjematype.html');
        sjekk('sti uten endelse får .html', f.stiFor('/editor'), '/editor.html');
        sjekk('sti med endelse beholdes', f.stiFor('/editor.html'), '/editor.html');
    }

    // ---------- identitet ----------
    {
        const n = (u) => f.faneNokkel(`${BASE}${u}`);
        sjekk('editor identifiseres av skjematype',
            n('/editor.html?skjematype_id=120'), '/editor.html?skjematype_id=120');
        sjekk('to ulike skjematyper er to faner',
            n('/editor.html?skjematype_id=120') === n('/editor.html?skjematype_id=99'), false);

        // Uvedkommende parametere skal ikke lage nye faner — ellers får du en
        // ny fane hver gang du filtrerer eller sorterer.
        sjekk('støyparametere ignoreres',
            n('/editor.html?skjematype_id=120&sok=abc&sort=navn'), '/editor.html?skjematype_id=120');

        // Admin bytter underfane med hash. Det er samme oppgave.
        sjekk('hash gir ikke ny fane',
            n('/admin.html#nokler') === n('/admin.html#hendelser'), true);

        // Behandling av to skjemaer av samme type er to ulike oppgaver.
        sjekk('skjema_id skiller behandlinger',
            n('/evaluering.html?skjematype_id=10&skjema_id=1')
            === n('/evaluering.html?skjematype_id=10&skjema_id=2'), false);

        sjekk('parameterrekkefølge spiller ingen rolle',
            n('/evaluering.html?skjema_id=2&skjematype_id=10'),
            n('/evaluering.html?skjematype_id=10&skjema_id=2'));

        // Registeret har to innganger fra skjemaoversikten: Register er de
        // aktive skjemaene, Arkiv er de avsluttede. To lister, to faner.
        sjekk('register og arkiv er ulike faner',
            n('/register.html?skjematype_id=10')
            === n('/register.html?skjematype_id=10&status=5'), false);
    }

    // ---------- hvilke sider som blir faner ----------
    {
        const e = (u) => f.erArbeidsflate(`${BASE}${u}`);
        sjekk('editoren er en arbeidsflate', e('/editor.html?skjematype_id=1')?.type, 'editor');
        sjekk('admin er en arbeidsflate', e('/admin.html')?.type, 'admin');
        sjekk('registeret er en arbeidsflate', e('/register.html?skjematype_id=1')?.type, 'register');
        // Kvitteringen er en endestasjon etter innsending, ikke en oppgave man
        // vender tilbake til.
        sjekk('kvitteringen er det ikke', e('/kvittering.html'), null);

        // Utfyllingssiden nås også av eksterne via OTP-lenke. Den skal bare
        // telle som arbeid når den er åpnet fra editoren for å teste live.
        sjekk('utfylling alene blir ikke fane', e('/index.html?skjematype_id=1'), null);
        sjekk('utfylling fra editoren blir fane',
            e('/index.html?skjematype_id=1&fra=editor')?.type, 'utfylling');
        sjekk('feil opphav teller ikke', e('/index.html?skjematype_id=1&fra=epost'), null);
    }

    // ---------- leggTil ----------
    {
        const lag = (nokkel, sett, ulagret = false) => ({ nokkel, url: nokkel, navn: nokkel, sett, ulagret });

        // Samme oppgave to ganger er samme fane, ikke to.
        const en = f.leggTil([lag('a', 1)], { nokkel: 'a', url: 'a2', navn: 'Ny tittel', sett: 5 });
        sjekk('samme oppgave dupliseres ikke', en.length, 1);
        sjekk('men oppdateres', [en[0].url, en[0].navn], ['a2', 'Ny tittel']);

        const to = f.leggTil([lag('a', 1)], { nokkel: 'b', url: 'b', navn: 'B', sett: 2 });
        sjekk('ny oppgave legges til', to.map(x => x.nokkel), ['a', 'b']);

        // Taket: eldste uten ulagret arbeid faller av.
        const fulle = [lag('a', 1), lag('b', 2), lag('c', 3)];
        const etter = f.leggTil(fulle, { nokkel: 'd', url: 'd', navn: 'D', sett: 4 }, 3);
        sjekk('taket holdes', etter.length, 3);
        sjekk('eldste falt av', etter.map(x => x.nokkel), ['b', 'c', 'd']);

        // Ulagret arbeid skal aldri fortrenges.
        const medUlagret = [lag('a', 1, true), lag('b', 2), lag('c', 3)];
        const etter2 = f.leggTil(medUlagret, { nokkel: 'd', url: 'd', navn: 'D', sett: 4 }, 3);
        sjekk('fane med ulagret arbeid beholdes',
            etter2.some(x => x.nokkel === 'a'), true);
        sjekk('og den nest eldste falt av i stedet', etter2.map(x => x.nokkel), ['a', 'c', 'd']);

        // Er alt ulagret, beholder vi heller for mange enn å kaste arbeid.
        const alleUlagret = [lag('a', 1, true), lag('b', 2, true)];
        const etter3 = f.leggTil(alleUlagret, { nokkel: 'c', url: 'c', navn: 'C', sett: 3 }, 2);
        sjekk('ingenting kastes når alt er ulagret', etter3.length, 3);

        // Rulleposisjon og ulagret-flagg skal overleve at fanen aktiveres på nytt.
        const medTilstand = [{ nokkel: 'a', url: 'a', navn: 'A', sett: 1, scroll: 420, ulagret: true }];
        const igjen = f.leggTil(medTilstand, { nokkel: 'a', url: 'a', navn: 'A', sett: 9 });
        sjekk('rulleposisjonen overlever', igjen[0].scroll, 420);
        sjekk('ulagret-flagget overlever', igjen[0].ulagret, true);
    }

    // ---------- lesLagret ----------
    {
        sjekk('tom lagring gir tom liste', f.lesLagret(null), []);
        sjekk('ugyldig JSON velter ingenting', f.lesLagret('{ ikke json'), []);
        sjekk('feil struktur gir tom liste', f.lesLagret('{"faner":"nei"}'), []);
        sjekk('halve rader lukes ut',
            f.lesLagret('{"faner":[{"nokkel":"a","url":"a","navn":"A"},{"nokkel":"b"}]}').length, 1);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

kjor().catch(e => { console.error('Testen krasjet:', e); process.exit(1); });
