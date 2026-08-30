/**
 * Nøkkelkalenderen — oversikt over hemmeligheter og nøkler som utløper.
 *
 * Hensikten er å fjerne den klassiske panikken: et sertifikat går ut en
 * søndag, all pålogging stopper, og den som satte det opp sluttet i fjor.
 * Kalenderen svarer på fire spørsmål for hver hemmelighet: når utløper den,
 * hvor ligger den, hva skjer når den ryker, og hvordan fornyes den.
 *
 * Lagres sammen med oppgavelista på dev-tenantens konto
 * (TODO_STORAGE_CONNECTION_STRING), slik at oversikten overlever at et miljø
 * bygges opp på nytt. Er varen ikke satt, faller vi tilbake til miljøets eget
 * lager — da er kalenderen lokal, og UI-et sier fra.
 *
 * PK = miljø ('pilot'/'prod'), RK = slug av navnet. Hvert miljø eier sine egne
 * rader: en deployment token i pilot er en annen hemmelighet enn den i prod,
 * selv om den heter det samme. Varslingsjobben behandler bare sitt eget miljø,
 * så to miljøer som kaller den ikke varsler dobbelt om samme rad.
 *
 * Utløpsdatoer vedlikeholdes manuelt — vi kan ikke spørre Key Vault fra koden,
 * siden Managed Identity ikke er tilgjengelig i SWA Managed Functions. Unntaket
 * er SAS-strenger, som bærer utløpet i seg selv (`se=`); de leses direkte fra
 * env-varen og kan derfor aldri komme ut av takt med virkeligheten.
 */
const { sikreTabellFra, glemOpprettelse, kontoNavnFra } = require('./storage');

const TABELL = 'Nokkelkalender';

const DELT_CS = process.env.TODO_STORAGE_CONNECTION_STRING || '';
const CS = DELT_CS || process.env.STORAGE_CONNECTION_STRING || '';

const TYPER = ['sertifikat', 'secret', 'SAS', 'passord', 'kontonøkkel', 'token', 'flyt-URL', 'annet'];
const VARSLE_DAGER_STANDARD = 30;

// Trinnene varslingen eskalerer gjennom. Første varsel går på VarsleDagerFor
// (per rad), deretter på hvert trinn under. Ett varsel per trinn — ikke ett
// hver dag i en måned, for da slutter folk å lese dem.
const TRINN = [14, 7, 3, 1];

function miljo() {
    return String(process.env.MILJO || 'ukjent').toLowerCase();
}

function slug(navn) {
    return String(navn || '')
        .toLowerCase()
        .replace(/[^a-z0-9æøå]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 100) || 'uten-navn';
}

async function tabell() {
    return sikreTabellFra(CS, TABELL, 'TODO_STORAGE_CONNECTION_STRING');
}

function erTabellMangler(e) {
    return e?.statusCode === 404 && /TableNotFound/i.test(`${e.code || ''} ${e.message || ''}`);
}

/** Samme mønster som todo-lista: oversett «TableNotFound» til noe som hjelper. */
async function medTabell(fn) {
    const t = await tabell();
    try {
        return await fn(t);
    } catch (e) {
        if (!erTabellMangler(e)) throw e;
        glemOpprettelse(CS, TABELL);
        try {
            await t.createTable();
        } catch (opprett) {
            if (opprett.statusCode !== 409) {
                const konto = kontoNavnFra(CS) || 'lagringskontoen';
                throw new Error(
                    `Tabellen ${TABELL} finnes ikke på ${konto}, og kunne ikke opprettes: ` +
                    `${opprett.message}. Enten må SAS-en i TODO_STORAGE_CONNECTION_STRING ` +
                    `tillate ressurstypen Container (srt) og rettigheten Create, eller så må ` +
                    `tabellen opprettes én gang manuelt på lagringskontoen.`
                );
            }
        }
        return await fn(t);
    }
}

/** Hvilket lager kalenderen faktisk ligger i — vises i admin-panelet. */
function lagerInfo() {
    const konto = kontoNavnFra(CS);
    const egenKonto = kontoNavnFra(process.env.STORAGE_CONNECTION_STRING || '');
    const sammeSomMiljo = !!(DELT_CS && konto && egenKonto
        && konto.toLowerCase() === egenKonto.toLowerCase());
    return { konto, delt: !!DELT_CS, sammeSomMiljo, miljoKonto: egenKonto, miljo: miljo() };
}


// ==================== UTLØP ====================

/**
 * Utløpsdato lest ut av en SAS-streng. Et account-SAS bærer `se=<ISO>` i
 * signaturen, så for disse trenger ingen å taste inn datoen — og ingen kan
 * glemme å oppdatere den når SAS-en fornyes.
 */
function utlopFraSas(verdi) {
    // Nøkkelen står som regel etter & i signaturen, men kan også komme først
    // rett etter SharedAccessSignature=. Begge må treffe.
    const m = /(?:^|[?&;=])se=([^&;]+)/i.exec(String(verdi || ''));
    if (!m) return null;
    const d = new Date(decodeURIComponent(m[1]));
    return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Faktisk utløp for en rad. Rader med EnvVar leser datoen fra miljøet ved hvert
 * oppslag; resten bruker den lagrede verdien.
 */
function faktiskUtlop(rad) {
    if (rad.EnvVar) {
        const fra = utlopFraSas(process.env[rad.EnvVar] || '');
        if (fra) return { utloper: fra, kilde: 'env' };
        // Varen er ikke satt, eller er ikke en SAS. Da er den lagrede datoen
        // det beste vi har — men UI-et skal kunne vise at automatikken ikke
        // fikk tak i noe.
        return { utloper: rad.Utloper || '', kilde: rad.Utloper ? 'lagret' : 'mangler' };
    }
    return { utloper: rad.Utloper || '', kilde: rad.Utloper ? 'lagret' : 'mangler' };
}

function dagerTil(isoDato, na = new Date()) {
    if (!isoDato) return null;
    const d = new Date(isoDato);
    if (isNaN(d.getTime())) return null;
    return Math.floor((d.getTime() - na.getTime()) / 86400000);
}

/**
 * Hvilket varslingstrinn en rad står på, eller null når det er for tidlig.
 * 0 betyr utløpt. Trinnene er VarsleDagerFor + de faste under den, slik at en
 * rad med 90 dagers varsel eskalerer 90 → 14 → 7 → 3 → 1 → utløpt.
 */
function varslingsTrinn(dagerIgjen, varsleDagerFor) {
    if (dagerIgjen === null) return null;
    if (dagerIgjen < 0) return 0;
    const grense = Number(varsleDagerFor) > 0 ? Number(varsleDagerFor) : VARSLE_DAGER_STANDARD;
    const aktuelle = [grense, ...TRINN.filter(t => t < grense)];
    let valgt = null;
    for (const t of aktuelle) {
        if (dagerIgjen <= t && (valgt === null || t < valgt)) valgt = t;
    }
    return valgt;
}

/**
 * Tilstanden som vises i panelet. «ukjent» er ikke det samme som «ok» — en rad
 * uten dato er en rad ingen har tatt stilling til, og skal skille seg ut.
 */
function tilstand(dagerIgjen, roteres) {
    if (roteres === 'nei') return 'fast';
    if (dagerIgjen === null) return 'ukjent';
    if (dagerIgjen < 0) return 'utløpt';
    if (dagerIgjen <= 7) return 'kritisk';
    if (dagerIgjen <= 30) return 'snart';
    return 'ok';
}

function fraEntitet(e, na = new Date()) {
    const rad = {
        Id: e.rowKey,
        Miljo: e.partitionKey,
        Navn: e.Navn || e.rowKey,
        Type: TYPER.includes(e.Type) ? e.Type : 'annet',
        Hvor: e.Hvor || '',
        EnvVar: e.EnvVar || '',
        Utloper: e.Utloper || '',
        VarsleDagerFor: Number(e.VarsleDagerFor) > 0 ? Number(e.VarsleDagerFor) : VARSLE_DAGER_STANDARD,
        Roteres: e.Roteres === 'nei' ? 'nei' : 'ja',
        Ansvarlig: e.Ansvarlig || '',
        Konsekvens: e.Konsekvens || '',
        Rotasjon: e.Rotasjon || '',
        Notat: e.Notat || '',
        SistVarslet: e.SistVarslet || '',
        SistVarsletTrinn: e.SistVarsletTrinn === '' || e.SistVarsletTrinn === undefined || e.SistVarsletTrinn === null
            ? null : Number(e.SistVarsletTrinn),
        SistFornyet: e.SistFornyet || '',
        Opprettet: e.Opprettet || '',
        OpprettetAv: e.OpprettetAv || '',
        SistEndret: e.SistEndret || '',
        EndretAv: e.EndretAv || ''
    };
    const { utloper, kilde } = faktiskUtlop(rad);
    rad.UtloperFaktisk = utloper;
    rad.UtlopKilde = kilde;
    rad.DagerIgjen = dagerTil(utloper, na);
    rad.Tilstand = tilstand(rad.DagerIgjen, rad.Roteres);
    return rad;
}

const RANG = { utløpt: 0, kritisk: 1, snart: 2, ukjent: 3, ok: 4, fast: 5 };

async function listAlle({ kunMiljo = null } = {}) {
    return medTabell(async (t) => {
        const na = new Date();
        const ut = [];
        const filter = kunMiljo ? `PartitionKey eq '${String(kunMiljo).replace(/'/g, "''")}'` : undefined;
        for await (const e of t.listEntities(filter ? { queryOptions: { filter } } : undefined)) {
            ut.push(fraEntitet(e, na));
        }
        // Det som haster først. Innen samme tilstand: nærmest utløp øverst.
        return ut.sort((a, b) => {
            const r = (RANG[a.Tilstand] ?? 9) - (RANG[b.Tilstand] ?? 9);
            if (r !== 0) return r;
            const da = a.DagerIgjen === null ? Infinity : a.DagerIgjen;
            const db = b.DagerIgjen === null ? Infinity : b.DagerIgjen;
            if (da !== db) return da - db;
            return a.Navn.localeCompare(b.Navn, 'nb');
        });
    });
}

async function hent(id, m = miljo()) {
    return medTabell(async (t) => {
        try {
            return fraEntitet(await t.getEntity(m, id));
        } catch (e) {
            if (erTabellMangler(e)) throw e;
            if (e.statusCode === 404) return null;
            throw e;
        }
    });
}

function normaliserDato(verdi) {
    const s = String(verdi ?? '').trim();
    if (!s) return '';
    // Bare dato → slutten av dagen. En hemmelighet som «utløper 1. mai» virker
    // hele 1. mai, og skal ikke rapporteres som utløpt fra midnatt.
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const d = new Date(`${s}T23:59:59.999Z`);
        if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
        return d.toISOString();
    }
    // Strengt format. new Date('1. september') gir 2001-09-01 i V8 uten å
    // klage, og en utløpsdato 25 år bakover ville meldt alt som utløpt.
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) return null;
    const d = new Date(s.replace(' ', 'T'));
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
}

function byggFelter(body, felter = {}) {
    if (body.Navn !== undefined) felter.Navn = String(body.Navn).trim().slice(0, 200);
    if (body.Type !== undefined) felter.Type = TYPER.includes(body.Type) ? body.Type : 'annet';
    if (body.Hvor !== undefined) felter.Hvor = String(body.Hvor).trim().slice(0, 300);
    if (body.EnvVar !== undefined) felter.EnvVar = String(body.EnvVar).trim().slice(0, 100);
    if (body.Ansvarlig !== undefined) felter.Ansvarlig = String(body.Ansvarlig).trim().slice(0, 200);
    if (body.Konsekvens !== undefined) felter.Konsekvens = String(body.Konsekvens).trim().slice(0, 1000);
    if (body.Rotasjon !== undefined) felter.Rotasjon = String(body.Rotasjon).trim().slice(0, 2000);
    if (body.Notat !== undefined) felter.Notat = String(body.Notat).trim().slice(0, 2000);
    if (body.Roteres !== undefined) felter.Roteres = body.Roteres === 'nei' ? 'nei' : 'ja';
    if (body.VarsleDagerFor !== undefined) {
        const n = Number(body.VarsleDagerFor);
        felter.VarsleDagerFor = Number.isFinite(n) && n > 0 ? Math.trunc(n) : VARSLE_DAGER_STANDARD;
    }
    if (body.Utloper !== undefined) {
        const d = normaliserDato(body.Utloper);
        if (d === null) throw new Error(`Ugyldig dato: «${body.Utloper}». Bruk ÅÅÅÅ-MM-DD.`);
        felter.Utloper = d;
        // Ny utløpsdato = hemmeligheten er fornyet. Nullstill varslingstrinnet,
        // ellers ville eskaleringen stått igjen på 1 dag og aldri varslet igjen.
        felter.SistVarsletTrinn = '';
        felter.SistVarslet = '';
    }
    if (body.SistFornyet !== undefined) {
        const d = normaliserDato(body.SistFornyet);
        if (d === null) throw new Error(`Ugyldig dato for SistFornyet: «${body.SistFornyet}».`);
        felter.SistFornyet = d;
    }
    return felter;
}

async function opprett(body, av) {
    const navn = String(body?.Navn || '').trim();
    if (!navn) throw new Error('Navn mangler');
    const m = String(body?.Miljo || miljo()).toLowerCase();
    const id = slug(navn);
    const na = new Date().toISOString();

    const entitet = {
        partitionKey: m, rowKey: id,
        Navn: navn, Type: 'annet', Hvor: '', EnvVar: '', Utloper: '',
        VarsleDagerFor: VARSLE_DAGER_STANDARD, Roteres: 'ja',
        Ansvarlig: '', Konsekvens: '', Rotasjon: '', Notat: '',
        SistVarslet: '', SistVarsletTrinn: '', SistFornyet: '',
        Opprettet: na, OpprettetAv: String(av || ''),
        SistEndret: na, EndretAv: String(av || '')
    };
    byggFelter(body, entitet);

    return medTabell(async (t) => {
        try {
            await t.createEntity(entitet);
        } catch (e) {
            if (e.statusCode === 409) throw new Error(`«${navn}» finnes allerede i ${m}.`);
            throw e;
        }
        return fraEntitet(entitet);
    });
}

async function oppdater(id, body, av, m = miljo()) {
    const finnes = await hent(id, m);
    if (!finnes) return null;
    const endring = byggFelter(body, {
        partitionKey: m, rowKey: id,
        SistEndret: new Date().toISOString(), EndretAv: String(av || '')
    });
    // Navnet er RowKey-en. Å endre det ville betydd ny rad; her beholder vi
    // id-en og lar visningsnavnet endre seg.
    const t = await tabell();
    await t.updateEntity(endring, 'Merge');
    return hent(id, m);
}

async function slett(id, m = miljo()) {
    return medTabell(async (t) => {
        try { await t.deleteEntity(m, id); return true; }
        catch (e) {
            if (erTabellMangler(e)) throw e;
            if (e.statusCode === 404) return false;
            throw e;
        }
    });
}

/** Registrer at det er varslet, slik at neste kjøring ikke gjentar seg selv. */
async function markerVarslet(id, trinn, m = miljo()) {
    const t = await tabell();
    await t.updateEntity({
        partitionKey: m, rowKey: id,
        SistVarslet: new Date().toISOString(),
        SistVarsletTrinn: String(trinn)
    }, 'Merge');
}

/**
 * Rader som skal varsles nå.
 *
 * En rad varsles når den passerer et nytt trinn — ikke hver dag. Utløpte rader
 * er unntaket: der varsles det daglig, fordi noe er i ferd med å gå galt og
 * meldingen ikke skal drukne.
 */
function skalVarsles(rad, na = new Date()) {
    if (rad.Roteres === 'nei') return null;
    const trinn = varslingsTrinn(rad.DagerIgjen, rad.VarsleDagerFor);
    if (trinn === null) return null;
    if (trinn === 0) {
        const idag = na.toISOString().slice(0, 10);
        if (rad.SistVarslet && rad.SistVarslet.slice(0, 10) === idag) return null;
        return 0;
    }
    if (rad.SistVarsletTrinn !== null && rad.SistVarsletTrinn <= trinn) return null;
    return trinn;
}


// ==================== STANDARDOPPSETT ====================
//
// Inventaret slik det ser ut i koden i dag. Seedes inn i ett miljø av gangen,
// og hopper over rader som allerede finnes, slik at den kan kjøres om igjen
// uten å overskrive datoer noen har fylt inn. Datoene må fylles inn manuelt —
// bortsett fra SAS-radene, som leser sin egen `se=`.

const STANDARD = [
    {
        Navn: 'Entra-klientautentisering (sertifikat/secret)',
        Type: 'sertifikat',
        Hvor: 'Prod: sertifikatet «authapi» i Key Vault fhs-kv-01. Pilot: AAD_CLIENT_SECRET i SWA Configuration.',
        Konsekvens: 'All pålogging stopper umiddelbart, for alle brukere. Ingen kommer inn i løsningen.',
        Rotasjon: 'Forny sertifikatet i Key Vault (prod) eller lag ny client secret under App registrations → Certificates & secrets (pilot). Referansen i staticwebapp.config.*.json peker på sertifikatet, så prod trenger ingen kodeendring. Pilot må ha den nye verdien inn i SWA Configuration.',
        VarsleDagerFor: 60
    },
    {
        Navn: 'TODO_STORAGE_CONNECTION_STRING (SAS)',
        Type: 'SAS',
        EnvVar: 'TODO_STORAGE_CONNECTION_STRING',
        Hvor: 'Key Vault — SAS utstedt på dev-tenantens lagringskonto.',
        Konsekvens: 'Oppgavelista og nøkkelkalenderen blir utilgjengelige i alle miljøer. Vedlegg kan ikke lastes opp eller vises.',
        Rotasjon: 'Utsted nytt account-SAS på riktig konto med Allowed services = Blob + Table, resource types = Service + Container + Object, rettigheter Read/Write/Delete/List/Add/Create/Update. Lagre som ny versjon av hemmeligheten i Key Vault. Utløpsdatoen leses automatisk herfra.',
        VarsleDagerFor: 45
    },
    {
        Navn: 'STORAGE_CONNECTION_STRING',
        Type: 'kontonøkkel',
        EnvVar: 'STORAGE_CONNECTION_STRING',
        Hvor: 'Key Vault — miljøets egen lagringskonto.',
        Konsekvens: 'Hele løsningen slutter å virke: skjemaer, svar, vedlegg og masterdata ligger her.',
        Rotasjon: 'Roter rullerende via key1/key2 på lagringskontoen: bytt til den ubrukte nøkkelen i Key Vault, verifiser at appen svarer, og regenerer så den gamle. Er verdien et SAS, leses utløpet automatisk.',
        VarsleDagerFor: 45
    },
    {
        Navn: 'FS_API_PASSWORD',
        Type: 'passord',
        Hvor: 'Key Vault. Brukes av api/src/lib/fs-client.js (Basic auth mot Felles Studentsystem).',
        Konsekvens: 'FS-oppdateringen stopper stille — emner og terminer blir liggende uendret, uten at noen får feilmelding i grensesnittet.',
        Rotasjon: 'Bestill nytt passord for FS-integrasjonsbrukeren hos FS-forvaltningen, og legg det inn som ny versjon i Key Vault.',
        VarsleDagerFor: 30
    },
    {
        Navn: 'SWA deployment token',
        Type: 'token',
        Hvor: 'GitHub → repo → Settings → Secrets (én per miljø).',
        Konsekvens: 'Deploy feiler. Løsningen kjører videre, men ingen endringer kommer ut.',
        Rotasjon: 'Hent nytt token under SWA-ressursen → Manage deployment token, og oppdater GitHub-hemmeligheten.',
        VarsleDagerFor: 30
    },
    {
        Navn: 'SCHEDULER_KEY',
        Type: 'secret',
        Hvor: 'SWA Configuration + GitHub Secrets. Må være lik begge steder.',
        Konsekvens: 'Cron-jobbene (FS-oppdatering, utsending, purring, nøkkelvarsling) avvises med 401 og stopper stille.',
        Rotasjon: 'Ingen utløpsdato. Sett ny verdi i SWA Configuration og GitHub Secrets i samme operasjon — jobbene feiler i mellomtiden.',
        VarsleDagerFor: 30
    },
    {
        Navn: 'FLOW_CALLBACK_KEY',
        Type: 'secret',
        Hvor: 'SWA Configuration. Sendes som x-flow-key fra Power Automate-flytene inn mot appen.',
        Konsekvens: 'Alle innkommende PA-flyter avvises: teamsynk, utsendingsbestillinger og SharePoint-oppdateringer stopper.',
        Rotasjon: 'Ingen utløpsdato. Krever koordinering: alle flyter som kaller inn må oppdateres samtidig med SWA Configuration.',
        VarsleDagerFor: 30
    },
    {
        Navn: 'OTP_HMAC_KEY',
        Type: 'secret',
        Hvor: 'Key Vault.',
        Konsekvens: 'Engangskoder som er sendt ut, men ikke brukt ennå, slutter å validere. Kortvarig, og brukeren kan be om ny kode.',
        Rotasjon: 'Ingen utløpsdato. Trygg å rotere når som helst — velg et tidspunkt med lite trafikk.',
        VarsleDagerFor: 30
    },
    {
        Navn: 'PA-flytenes signatur-URLer (sig=)',
        Type: 'flyt-URL',
        Hvor: 'Key Vault — sju *_FLOW_URL-varer. Signaturen ligger i query-strengen.',
        Konsekvens: 'Feil eller manglende URL gjør at varsling, utsending, purring, OTP, backup og teamsøk stopper.',
        Rotasjon: 'Ingen utløpsdato — en URL gjelder til noen regenererer nøkkelen i flytens trigger-innstillinger. Regenerering krever at den nye URL-en legges inn i Key Vault samtidig.',
        VarsleDagerFor: 30
    },
    {
        Navn: 'HASH_SALT',
        Type: 'secret',
        Roteres: 'nei',
        Hvor: 'Key Vault.',
        Konsekvens: 'SKAL IKKE ROTERES. Saltet gir deterministisk pseudonymisering av innsendere (api/src/lib/kryptering.js). Et bytte gir nye pseudonymer for alle framtidige innsendinger, mens de historiske beholder de gamle — koblingen kan ikke gjenskapes, fordi e-postadressen den ble beregnet fra er slettet.',
        Rotasjon: 'Ikke aktuelt. Skal saltet likevel byttes, må det gjøres som en bevisst migrering der konsekvensen for eksisterende anonymiserte svar er avklart først.',
        VarsleDagerFor: 30
    }
];

async function seedStandard(av, m = miljo()) {
    const t = await tabell();
    const finnes = new Set((await listAlle({ kunMiljo: m })).map(r => r.Id));
    const na = new Date().toISOString();
    let lagtTil = 0, hoppetOver = 0;

    for (const mal of STANDARD) {
        const id = slug(mal.Navn);
        if (finnes.has(id)) { hoppetOver++; continue; }
        const entitet = {
            partitionKey: m, rowKey: id,
            Navn: mal.Navn, Type: mal.Type, Hvor: mal.Hvor || '',
            EnvVar: mal.EnvVar || '', Utloper: '',
            VarsleDagerFor: mal.VarsleDagerFor || VARSLE_DAGER_STANDARD,
            Roteres: mal.Roteres === 'nei' ? 'nei' : 'ja',
            Ansvarlig: '', Konsekvens: mal.Konsekvens || '',
            Rotasjon: mal.Rotasjon || '', Notat: '',
            SistVarslet: '', SistVarsletTrinn: '', SistFornyet: '',
            Opprettet: na, OpprettetAv: String(av || ''),
            SistEndret: na, EndretAv: String(av || '')
        };
        await t.upsertEntity(entitet, 'Replace');
        lagtTil++;
    }
    return { lagtTil, hoppetOver, totalt: STANDARD.length, miljo: m };
}

module.exports = {
    listAlle, hent, opprett, oppdater, slett,
    markerVarslet, skalVarsles, seedStandard, lagerInfo,
    utlopFraSas, dagerTil, varslingsTrinn, tilstand, normaliserDato, slug,
    miljo, TYPER, TRINN, VARSLE_DAGER_STANDARD, STANDARD
};
