/**
 * Omdøping av en rolle — kjøringen i lib/rolle-omdoping-kjoring.js.
 *
 * Reglene for hva som skrives om er prøvd i rolle-omdoping.test.js. Her
 * prøves det som bare kjøringen kan gjøre galt:
 *
 *   - en forhåndsvisning som skriver noe
 *   - en rekkefølge der noen står uten tilgang underveis
 *   - saker som ikke følger med fordi definisjonen ikke ENDRES, bare NEVNER
 *     rollen (`Klassesjef({2-01})`)
 *   - krypterte saker (Krypteres=Alt), og en kryptert sak uten nøkkel som
 *     forsvinner i stillhet
 *   - saker som skrives med lagreSkjema, som flytter «sist endret»
 *
 * Lagringen er stubbet; krypteringen er den ekte.
 *
 * Kjøres med:  node api/test/rolle-omdoping-kjoring.test.js
 */
const { kjorOmdoping } = require('../src/lib/rolle-omdoping-kjoring');
const kryptering = require('../src/lib/kryptering');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

const NOKKEL = kryptering.genererNokkel();

/** Stubbet lagring. `logg` får hvert skrivekall i rekkefølge. */
function lagDeps({ nokkelFor = { 13: NOKKEL } } = {}) {
    const logg = [];
    const sakerForType = {
        // Type 12 nevner rollen bare dynamisk; sakene har den konkret.
        12: [
            { Skjema_id: '12-1', Skjematype_id: '12', Skjema_status: 2,
              Behandling: [{ Steg: 1, Roller: ['Klassesjef(MILM23-1)'], RollerMal: ['Klassesjef({2-01})'] }] },
            { Skjema_id: '12-2', Skjematype_id: '12', Skjema_status: 5,
              Behandling: [{ Steg: 1, Roller: ['Klassesjef(MILM23-1)'] }] },
            { Skjema_id: '12-3', Skjematype_id: '12', Skjema_status: 2,
              Behandling: [{ Steg: 1, Roller: ['Klassesjef(MILM23-2)'] }] }
        ],
        // Type 13 krypterer hele saken.
        13: [kryptering.krypterSkjema({
            Skjema_id: '13-1', Skjematype_id: '13', Skjema_status: 2,
            Behandling: [{ Steg: 1, Roller: ['Klassesjef(MILM23-1)'] }]
        }, NOKKEL, 'Alt')],
        // Type 14 nevner ikke rollen — sakene skal ikke leses.
        14: [{ Skjema_id: '14-1', Skjematype_id: '14', Behandling: [{ Roller: ['Klassesjef(MILM23-1)'] }] }]
    };
    const lest = [];
    return {
        logg, lest, sakerForType,
        deps: {
            roller: {
                hentAlle: async () => [
                    { Rolle: 'Klassesjef', Omfang: 'MILM23-1', UPN: 'a@mil.no', Kilde: 'manuell' },
                    { Rolle: 'Klassesjef', Omfang: 'MILM23-2', UPN: 'b@mil.no', Kilde: 'manuell' }
                ],
                utforBatch: async ({ skriv, slett }) => {
                    if (skriv.length) logg.push(['medlemskap-skriv', skriv.map(r => `${r.Rolle}(${r.Omfang})|${r.UPN}`)]);
                    if (slett.length) logg.push(['medlemskap-slett', slett.map(r => `${r.Rolle}(${r.Omfang})|${r.UPN}`)]);
                    return {};
                }
            },
            grupper: {
                hentAlle: async () => [{ Rolle: 'Klassesjef', Omfang: 'MILM23-1', Team: 'Klasse 1', EierRolle: '' }],
                skrivGruppe: async (g) => logg.push(['gruppe-skriv', `${g.Rolle}(${g.Omfang})`]),
                slettGruppe: async (r, o) => logg.push(['gruppe-slett', `${r}(${o})`])
            },
            skjematyper: {
                hentAlleSkjematyper: async () => [
                    { id: '12', navn: 'Permisjon', JSON: { Skjematype_id: '12', Behandling: [{ Roller: ['Klassesjef({2-01})'] }] } },
                    { id: '13', navn: 'Klage', JSON: { Skjematype_id: '13', Krypteres: 'Alt', Eiere: { Roller: ['Klassesjef(MILM23-1)'] } } },
                    { id: '14', navn: 'Annet', JSON: { Skjematype_id: '14', Behandling: [{ Roller: ['Sjef'] }] } }
                ],
                lagreSkjematype: async (d) => logg.push(['skjematype', d.Skjematype_id])
            },
            rapporter: {
                hentAlleRapporttyper: async () => [
                    { id: 'r1', navn: 'Klasser', JSON: { Rapporttype_id: 'r1', Publikum: { Roller: ['Klassesjef(MILM23-1)'] } } }
                ],
                lagreRapporttype: async (d) => logg.push(['rapport', d.Rapporttype_id])
            },
            saker: {
                hentAlleSkjemaerForType: async (id, opt) => {
                    lest.push([id, opt]);
                    return JSON.parse(JSON.stringify(sakerForType[id] || []));
                },
                erstattJson: async (t, s, data) => logg.push(['sak', `${t}/${s}`, data]),
                lagreSkjema: async () => { throw new Error('lagreSkjema skal ikke brukes — den flytter Sist_endret'); }
            },
            nokler: { hentNokkel: async (id) => nokkelFor[id] || null },
            kryptering
        }
    };
}

const OP = { type: 'omfang', rolle: 'Klassesjef', fra: 'MILM23-1', til: 'MILM23-1A' };

(async () => {
    // ---------- 1. forhåndsvisning skriver ingenting ----------
    {
        const { logg, lest, deps } = lagDeps();
        const plan = await kjorOmdoping(OP, { deps });
        sjekk('status er forhåndsvisning', plan.status, 'forhandsvisning');
        sjekk('ingenting skrevet', logg, []);
        sjekk('medlemskap som flyttes', plan.medlemskap.flyttes, 1);
        sjekk('grupper som flyttes', plan.grupper.flyttes, 1);
        sjekk('skjematyper som endres (bare den konkrete)', plan.skjematyper.map(t => t.id), ['13']);
        sjekk('rapporter som endres', plan.rapporter.map(r => r.id), ['r1']);
        // Type 12 endres ikke selv, men NEVNER rollen — sakene må med.
        sjekk('saker under behandling (12-1 og den krypterte 13-1)', plan.saker.underBehandling, 2);
        sjekk('avsluttede saker følger også med', plan.saker.avsluttet, 1);
        sjekk('én av dem var kryptert', plan.saker.kryptert, 1);
        sjekk('saker leses i lagret form, ikke ekspandert', lest.every(([, o]) => o && o.fulltFormat === false), true);
        sjekk('typen som ikke nevner rollen, leses ikke', lest.map(([id]) => id).sort(), ['12', '13']);
        sjekk('planen inneholder ikke de omskrevne trærne',
            JSON.stringify(plan).includes('"tre"'), false);
    }

    // ---------- 2. utførelse: rekkefølgen ----------
    {
        const { logg, deps } = lagDeps();
        const plan = await kjorOmdoping(OP, { deps, utfor: true });
        sjekk('status er utført', plan.status, 'utfort');
        const typer = logg.map(l => l[0]);
        sjekk('nye medlemskap først', typer[0], 'medlemskap-skriv');
        sjekk('gamle medlemskap sist', typer[typer.length - 1], 'medlemskap-slett');
        sjekk('nytt medlemskap', logg[0][1], ['Klassesjef(MILM23-1A)|a@mil.no']);
        sjekk('gammelt slettet', logg[logg.length - 1][1], ['Klassesjef(MILM23-1)|a@mil.no']);
        sjekk('naboomfanget røres ikke', JSON.stringify(logg).includes('b@mil.no'), false);

        const saker = logg.filter(l => l[0] === 'sak');
        sjekk('tre saker skrevet med erstattJson', saker.map(s => s[1]).sort(), ['12/12-1', '12/12-2', '13/13-1']);
        const s121 = saker.find(s => s[1] === '12/12-1')[2];
        sjekk('saken følger med til nytt omfang', s121.Behandling[0].Roller, ['Klassesjef(MILM23-1A)']);
        sjekk('dynamisk mal står', s121.Behandling[0].RollerMal, ['Klassesjef({2-01})']);

        // Den krypterte skrives kryptert, og dekrypterer til det nye.
        const s131 = saker.find(s => s[1] === '13/13-1')[2];
        sjekk('kryptert sak skrives kryptert', typeof s131.Kryptert, 'string');
        sjekk('og ingen klartekst ved siden av', 'Behandling' in s131, false);
        sjekk('den dekrypterer til nytt omfang',
            kryptering.dekrypterSkjema(s131, NOKKEL).Behandling[0].Roller, ['Klassesjef(MILM23-1A)']);

        sjekk('gruppa flyttes', logg.filter(l => l[0].startsWith('gruppe')).map(l => l.join(' ')),
            ['gruppe-skriv Klassesjef(MILM23-1A)', 'gruppe-slett Klassesjef(MILM23-1)']);
    }

    // ---------- 3. kryptert sak uten nøkkel ----------
    {
        const { logg, deps } = lagDeps({ nokkelFor: {} });
        const plan = await kjorOmdoping(OP, { deps });
        sjekk('saken uten nøkkel meldes', plan.saker.ikkeLest.map(s => [s.sakId, s.grunn]), [['13-1', 'nøkkel mangler']]);
        sjekk('og telles ikke som endret', plan.saker.kryptert, 0);
        sjekk('og ingenting skrevet', logg, []);
    }

    // ---------- 4. ugyldig operasjon ----------
    {
        const { logg, deps } = lagDeps();
        const plan = await kjorOmdoping({ type: 'navn', fra: 'Skjemaskaper', til: 'X' }, { deps, utfor: true });
        sjekk('reservert rolle avvises', plan.status, 'ugyldig');
        sjekk('og ingenting skrevet', logg, []);
    }

    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
})().catch(e => {
    console.log('FEIL  testen kastet:', e.message);
    console.log(e.stack);
    process.exit(1);
});
