/**
 * Tester for sletting av en hel rolle.
 *
 * Det farlige her er ikke at slettingen feiler — det er at den treffer for
 * bredt. Rollenavn går igjen på tvers av omfang («Sjef» finnes for hver
 * avdeling), og en sletting som tar med naboene fjerner tilgang for folk som
 * ikke var involvert. Derfor tester vi mest på avgrensningen.
 *
 * Kjøres med:  node api/test/roller-slett.test.js
 */
const storage = require('../src/lib/roller-storage');

let ok = 0, feil = 0;
function sjekk(navn, faktisk, forventet) {
    const a = JSON.stringify(faktisk), b = JSON.stringify(forventet);
    if (a === b) ok++;
    else { feil++; console.log(`FEIL  ${navn}\n      fikk      ${a}\n      forventet ${b}`); }
}

/**
 * Stubbet tabell. Fanger filteret slettingen bruker, og lar oss se nøyaktig
 * hvilke rader som ville blitt fjernet.
 */
function lagTabell(rader) {
    const sett = { filtre: [], slettet: [] };
    const klient = {
        listEntities({ queryOptions }) {
            sett.filtre.push(queryOptions.filter);
            const f = queryOptions.filter;
            // Etterligner Table Storage: PartitionKey-likhet, og RowKey-område
            // når omfang er oppgitt.
            const pk = /PartitionKey eq '([^']*)'/.exec(f)?.[1];
            const fra = /RowKey ge '([^']*)'/.exec(f)?.[1];
            const til = /RowKey lt '([^']*)'/.exec(f)?.[1];
            const treff = rader.filter(r =>
                r.partitionKey === pk &&
                (fra === undefined || (r.rowKey >= fra && r.rowKey < til)));
            return (async function* () { for (const r of treff) yield r; })();
        },
        async submitTransaction(handlinger) {
            for (const [, e] of handlinger) sett.slettet.push(`${e.partitionKey}|${e.rowKey}`);
        }
    };
    return { klient, sett };
}

const RADER = [
    { partitionKey: 'Sjef', rowKey: 'Fellesadm|a@fhs.no' },
    { partitionKey: 'Sjef', rowKey: 'Fellesadm|b@fhs.no' },
    { partitionKey: 'Sjef', rowKey: 'Cyber|c@fhs.no' },
    { partitionKey: 'Verneombud', rowKey: 'Cyber|d@fhs.no' }
];

async function kjor() {
    // Storage-modulen lager sin egen klient. Vi bytter den ut for testen.
    const opprinnelig = require('../src/lib/storage');
    const gammelSikre = opprinnelig.sikreTabell;
    const gammelOdata = opprinnelig.odata;

    // `odata` laster @azure/data-tables lat, og deploy kjører testene uten
    // node_modules. Vi trenger bare en streng filteret kan gjenkjennes på.
    opprinnelig.odata = (deler, ...verdier) =>
        deler.reduce((ut, d, i) => ut + d + (i < verdier.length ? `'${verdier[i]}'` : ''), '');

    // ---------- ett omfang: naboene skal stå igjen ----------
    {
        const { klient, sett } = lagTabell(RADER);
        opprinnelig.sikreTabell = async () => klient;
        const res = await storage.slettRolle({ Rolle: 'Sjef', Omfang: 'Fellesadm' });
        sjekk('slettet bare det ene omfanget', res.slettet, 2);
        sjekk('riktige rader', sett.slettet.sort(),
            ['Sjef|Fellesadm|a@fhs.no', 'Sjef|Fellesadm|b@fhs.no']);
    }

    // ---------- alle omfang ----------
    {
        const { klient, sett } = lagTabell(RADER);
        opprinnelig.sikreTabell = async () => klient;
        const res = await storage.slettRolle({ Rolle: 'Sjef' });
        sjekk('uten omfang tas hele rollen', res.slettet, 3);
        sjekk('men ikke andre roller',
            sett.slettet.some(s => s.startsWith('Verneombud')), false);
    }

    // ---------- tomt omfang er et gyldig omfang ----------
    {
        // Rollen som gjelder uten avgrensning lagres med tomt omfang. Den må
        // kunne slettes for seg, uten å ta med de avgrensede variantene.
        const rader = [
            { partitionKey: 'Skjemaskaper', rowKey: '|a@fhs.no' },
            { partitionKey: 'Skjemaskaper', rowKey: 'Cyber|b@fhs.no' }
        ];
        const { klient, sett } = lagTabell(rader);
        opprinnelig.sikreTabell = async () => klient;
        const res = await storage.slettRolle({ Rolle: 'Skjemaskaper', Omfang: '' });
        sjekk('tomt omfang treffer bare den uten avgrensning', res.slettet, 1);
        sjekk('den avgrensede står igjen', sett.slettet, ['Skjemaskaper||a@fhs.no']);
    }

    // ---------- ingenting å slette ----------
    {
        const { klient } = lagTabell(RADER);
        opprinnelig.sikreTabell = async () => klient;
        sjekk('ukjent rolle gir 0', (await storage.slettRolle({ Rolle: 'Finnesikke' })).slettet, 0);
    }

    // ---------- rolle må oppgis ----------
    {
        let kastet = false;
        try { await storage.slettRolle({ Rolle: '' }); } catch (_) { kastet = true; }
        sjekk('tom rolle avvises', kastet, true);
        kastet = false;
        try { await storage.slettRolle({}); } catch (_) { kastet = true; }
        sjekk('manglende rolle avvises', kastet, true);
    }

    // ---------- store slettinger går i batcher ----------
    {
        // Table Storage tar maks 100 handlinger per transaksjon, og SWA kutter
        // kallet etter 45 sekunder. En rolle med mange innehavere må derfor
        // deles opp, ellers henger slettingen stille.
        const mange = Array.from({ length: 250 }, (_, i) => ({
            partitionKey: 'Stor', rowKey: `X|bruker${i}@fhs.no`
        }));
        const { klient, sett } = lagTabell(mange);
        let transaksjoner = 0;
        const opprinneligSubmit = klient.submitTransaction;
        klient.submitTransaction = async (h) => {
            transaksjoner++;
            sjekk(`batch ${transaksjoner} er ikke over 100`, h.length <= 100, true);
            return opprinneligSubmit(h);
        };
        opprinnelig.sikreTabell = async () => klient;
        const res = await storage.slettRolle({ Rolle: 'Stor' });
        sjekk('alle slettet', res.slettet, 250);
        sjekk('delt i tre transaksjoner', transaksjoner, 3);
        sjekk('ingen rader mistet', sett.slettet.length, 250);
    }

    opprinnelig.sikreTabell = gammelSikre;
    opprinnelig.odata = gammelOdata;
    console.log(`\n${ok} OK, ${feil} feil`);
    process.exit(feil ? 1 : 0);
}

kjor().catch(e => { console.error('Testen krasjet:', e); process.exit(1); });
