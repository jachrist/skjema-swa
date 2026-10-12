/**
 * Tabellen bak oppslagslistene — `Oppslagsliste`.
 *
 * PK = listenavnet, RK = Skjema_id-en teksten kom fra. Den nøkkelen gjør
 * oppdateringen idempotent: samme forekomst treffer samme rad hver gang, så en
 * endret vurdering erstatter seg selv i stedet for å legge seg ved siden av.
 *
 * Oppsettet for hvilke lister som finnes ligger IKKE her, men i
 * `SystemInnstillinger` under nøkkelen `Oppslagslister` — det er konfigurasjon
 * admin redigerer, ikke data jobben skriver. Holdes de i samme tabell, kan en
 * full erstatning av en liste ta oppsettet med seg.
 */
const { sikreTabell, odata } = require('./storage');
const innstillinger = require('./innstillinger-storage');

const TABELL = 'Oppslagsliste';
const META_TABELL = 'CacheMetadata';
const OPPSETT_NOKKEL = 'Oppslagslister';

/** Et listenavn skal kunne stå i en PartitionKey og i et DNF-filter. */
function gyldigNavn(navn) {
    return /^[A-Za-zÆØÅæøå0-9 _-]{1,64}$/.test(String(navn || '').trim());
}

/**
 * Oppsettet for alle listene.
 *
 * Returnerer alltid et array, også når nøkkelen mangler eller inneholder
 * ugyldig JSON. Ugyldig JSON logges — en liste som stille forsvinner fordi
 * noen skrev et komma feil, er umulig å skille fra «ingen lister er satt opp».
 */
async function hentOppsett(log = () => {}) {
    const rad = await innstillinger.hent(OPPSETT_NOKKEL);
    if (!rad?.Verdi) return [];
    try {
        const parsed = JSON.parse(rad.Verdi);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        log(`oppslagsliste: oppsettet i SystemInnstillinger/${OPPSETT_NOKKEL} er ugyldig JSON — ${e.message}`);
        return [];
    }
}

async function lagreOppsett(lister, endretAv) {
    const rene = (Array.isArray(lister) ? lister : []).map(l => ({
        Navn: String(l.Navn || '').trim(),
        Skjematype_id: String(l.Skjematype_id || '').trim(),
        Felter: (Array.isArray(l.Felter) ? l.Felter : []).map(f => ({
            Merkelapp: String(f.Merkelapp || '').trim(),
            Prefiks: String(f.Prefiks ?? '')
        }))
    }));
    for (const l of rene) {
        if (!gyldigNavn(l.Navn)) {
            throw new Error(`Ugyldig listenavn "${l.Navn}". Bruk bokstaver, tall, mellomrom, _ eller -.`);
        }
        if (!l.Skjematype_id) throw new Error(`Lista "${l.Navn}" mangler skjematype`);
        if (l.Felter.length === 0) throw new Error(`Lista "${l.Navn}" har ingen felter`);
    }
    const navn = rene.map(l => l.Navn.toLowerCase());
    const duplikat = navn.find((n, i) => navn.indexOf(n) !== i);
    if (duplikat) throw new Error(`Listenavnet "${duplikat}" er brukt to ganger`);

    await innstillinger.sett(OPPSETT_NOKKEL, JSON.stringify(rene), endretAv);
    return rene;
}

/** Radene i én liste, sortert slik de ble skrevet. */
async function hentListe(navn) {
    if (!gyldigNavn(navn)) return [];
    const t = await sikreTabell(TABELL);
    const ut = [];
    const filter = odata`PartitionKey eq ${String(navn).trim()}`;
    for await (const e of t.listEntities({ queryOptions: { filter } })) {
        ut.push({ Tekst: e.Tekst || '', Verdi: e.Verdi || e.Tekst || '', KildeSkjemaId: e.rowKey });
    }
    ut.sort((a, b) => String(a.Tekst).localeCompare(String(b.Tekst), 'nb'));
    return ut;
}

/**
 * Erstatt innholdet i én liste.
 *
 * Rader som ikke er i det nye settet slettes — en vurdering som er trukket
 * tilbake skal forsvinne fra nedtrekket, ikke bli stående fordi den en gang
 * var godkjent.
 */
async function erstattListe(navn, rader, { log = () => {} } = {}) {
    if (!gyldigNavn(navn)) throw new Error(`Ugyldig listenavn "${navn}"`);
    const pk = String(navn).trim();
    const t = await sikreTabell(TABELL);

    const nye = new Map();
    for (const r of (rader || [])) {
        const rk = String(r.KildeSkjemaId || '').trim();
        if (!rk || !r.Tekst) continue;
        nye.set(rk, {
            partitionKey: pk, rowKey: rk,
            Tekst: String(r.Tekst),
            Verdi: String(r.Verdi ?? r.Tekst),
            Oppdatert: new Date().toISOString()
        });
    }

    let slettet = 0;
    const filter = odata`PartitionKey eq ${pk}`;
    for await (const e of t.listEntities({ queryOptions: { filter, select: ['PartitionKey', 'RowKey'] } })) {
        if (nye.has(e.rowKey)) continue;
        try { await t.deleteEntity(e.partitionKey, e.rowKey); slettet++; }
        catch (_) { /* kan alt være borte */ }
    }

    let skrevet = 0;
    for (const entity of nye.values()) {
        await t.upsertEntity(entity, 'Replace');
        skrevet++;
    }
    log(`oppslagsliste "${pk}": skrev ${skrevet}, slettet ${slettet}`);
    return { antallSkrevet: skrevet, antallSlettet: slettet };
}

/** Sist-kjørt-info, samme tabell og form som FS-refreshen bruker. */
async function settStatus(navn, felter) {
    const t = await sikreTabell(META_TABELL);
    await t.upsertEntity({
        partitionKey: 'Meta',
        rowKey: `Oppslagsliste-${String(navn).trim()}`,
        ...felter
    }, 'Merge');
}

async function hentStatus() {
    const t = await sikreTabell(META_TABELL);
    const ut = [];
    const filter = odata`PartitionKey eq ${'Meta'}`;
    for await (const e of t.listEntities({ queryOptions: { filter } })) {
        if (!String(e.rowKey).startsWith('Oppslagsliste-')) continue;
        ut.push({
            Navn: String(e.rowKey).slice('Oppslagsliste-'.length),
            Status: e.Status || '',
            Antall: e.Antall ?? null,
            Hoppet: e.Hoppet ?? null,
            SistKjort: e.SistKjort || null,
            Melding: e.Melding || ''
        });
    }
    return ut;
}

module.exports = {
    TABELL, OPPSETT_NOKKEL, gyldigNavn,
    hentOppsett, lagreOppsett,
    hentListe, erstattListe,
    settStatus, hentStatus
};
