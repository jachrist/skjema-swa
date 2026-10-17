/**
 * Nøkkelsjekken som JOBB — uavhengig av hva som startet den.
 *
 * Samme form som de tre andre jobbmodulene: bokføringen bor her, og både
 * HTTP-veien (`POST /api/nokkelkalender/sjekk`) og timeren i dev kaller den
 * samme funksjonen.
 *
 * **DENNE SENDER E-POST.** Ett samlet varsel til `ADMIN_UPNS` om alt som har
 * passert et nytt trinn — ett brev om alle, ikke ett per hemmelighet, fordi
 * en administrator som får seks e-poster leser den første.
 *
 * To ting er derfor viktigere her enn i jobbene som bare leser og skriver
 * tabeller:
 *
 *   **Avkryssingen skjer bare når varselet faktisk gikk ut.** Feiler flyten,
 *   prøver neste kjøring på nytt — og den som leser statusraden skal se at
 *   det ikke ble varslet, ikke at det «gikk fint».
 *
 *   **Tørrkjøring bokføres ikke.** `{ tørrkjør: true }` viser hva som ville
 *   blitt sendt. En statusrad etter den ville vært en påstand om et varsel
 *   ingen fikk.
 *
 * E-postbyggingen (`byggEpost` med hjelperne) lå i `functions/nokkelkalender.js`
 * til 17.10.2026. Den flyttet hit sammen med resten av jobben: en lib kan ikke
 * importere fra `functions/`, og en kopi av den HTML-en ville vært det verste
 * stedet å få to utgaver som svarer ulikt.
 */
const kalender = require('./nokkelkalender-storage');
const { sendEpostViaFlyt } = require('./flyt-kaller');
const hendelser = require('./hendelser-storage');
const pbToken = require('./pb-token-storage');
const pbKalender = require('./pb-kalender');
const skjemaStorage = require('./skjema-storage');

const PK = 'Meta';
const RK = 'Jobb-Nokkelsjekk';

function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fristTekst(rad) {
    if (rad.DagerIgjen === null) return 'ukjent utløp';
    if (rad.DagerIgjen < 0) return `UTLØPT for ${Math.abs(rad.DagerIgjen)} dager siden`;
    if (rad.DagerIgjen === 0) return 'utløper i dag';
    if (rad.DagerIgjen === 1) return 'utløper i morgen';
    return `utløper om ${rad.DagerIgjen} dager`;
}

function byggEpost(rader, miljo, basisUrl) {
    const utlopt = rader.filter(r => r.DagerIgjen !== null && r.DagerIgjen < 0);
    const emne = utlopt.length > 0
        ? `[${miljo}] ${utlopt.length} hemmelighet(er) har UTLØPT`
        : `[${miljo}] ${rader.length} hemmelighet(er) nærmer seg utløp`;

    const rekker = rader.map(r => `
        <tr>
            <td style="padding:6px 10px;border-bottom:1px solid #ddd;"><strong>${esc(r.Navn)}</strong><br>
                <span style="color:#666;font-size:12px;">${esc(r.Type)}${r.Hvor ? ` — ${esc(r.Hvor)}` : ''}</span></td>
            <td style="padding:6px 10px;border-bottom:1px solid #ddd;white-space:nowrap;${r.DagerIgjen !== null && r.DagerIgjen < 0 ? 'color:#b00020;font-weight:bold;' : ''}">
                ${esc(fristTekst(r))}<br>
                <span style="color:#666;font-size:12px;">${r.UtloperFaktisk ? esc(r.UtloperFaktisk.slice(0, 10)) : '—'}</span></td>
            <td style="padding:6px 10px;border-bottom:1px solid #ddd;font-size:13px;">${esc(r.Konsekvens || '')}</td>
        </tr>`).join('');

    const prosedyrer = rader.filter(r => r.Rotasjon).map(r => `
        <p style="margin:12px 0 0;"><strong>${esc(r.Navn)}</strong><br>
        <span style="font-size:13px;">${esc(r.Rotasjon)}</span></p>`).join('');

    const html = `
        <p>Følgende hemmeligheter i <strong>${esc(miljo)}</strong> nærmer seg eller har passert utløp.</p>
        <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
            <tr style="background:#f2f2f2;">
                <th align="left" style="padding:6px 10px;">Hemmelighet</th>
                <th align="left" style="padding:6px 10px;">Frist</th>
                <th align="left" style="padding:6px 10px;">Konsekvens ved utløp</th>
            </tr>
            ${rekker}
        </table>
        <h3 style="margin-top:20px;">Slik fornyes de</h3>
        ${prosedyrer || '<p><em>Ingen rotasjonsprosedyre er fylt inn. Legg den inn i nøkkelkalenderen.</em></p>'}
        ${basisUrl ? `<p style="margin-top:20px;"><a href="${esc(basisUrl)}/admin.html#nokkelkalender">Åpne nøkkelkalenderen</a></p>` : ''}
    `;
    return { emne, html };
}

/**
 * Kjør nøkkelsjekken og bokfør utfallet. Kaster aldri.
 *
 * `utfall` er det handleren oversetter til en HTTP-status, og verdiene er
 * ikke bare «ok» og «feil»: en kjøring der ingenting skulle varsles er et
 * annet utfall enn en der varslingen ikke nådde fram, og de to skal ikke
 * se like ut i panelet heller.
 *
 *   `ingenting`        — ingenting passerte et nytt trinn. Helt normalt.
 *   `ok`               — varselet gikk ut, og radene er merket av.
 *   `tørrkjørt`        — viste hva som ville blitt sendt. Bokføres ikke.
 *   `mangler-mottakere`— ADMIN_UPNS er ikke satt. Det er en konfigurasjonsfeil.
 *   `varsling-feilet`  — flyten svarte ikke ok. Ingenting er merket av.
 *   `feil`             — noe kastet underveis.
 */
async function kjorNokkelsjekk({ kilde, torrkjor = false, request = null, log = () => {} } = {}) {
    const { tabellKlient } = require('./storage');
    const startTid = new Date().toISOString();
    const settStatus = async (felter) => {
        // Tørrkjøring bokføres ikke — se kommentaren øverst.
        if (torrkjor) return;
        try {
            const t = tabellKlient('CacheMetadata');
            await t.upsertEntity({ partitionKey: PK, rowKey: RK, ...felter }, 'Merge');
        } catch (_) { /* statusraden er ikke kritisk */ }
    };

    await settStatus({ Status: 'kjører', Startet: startTid, Kilde: kilde, SistFeil: '' });
    log(`nokkelkalender/sjekk: trigget av ${kilde}`);

    const ferdig = async (utfall, felter, svar) => {
        await settStatus({
            Status: utfall === 'ok' || utfall === 'ingenting' ? 'ok' : 'feil',
            Ferdig: new Date().toISOString(),
            SistOppdatert: new Date().toISOString(),
            Utfall: utfall,
            ...felter
        });
        return { utfall, ...svar };
    };

    try {
        const m = kalender.miljo();
        const na = new Date();
        const rader = await kalender.listAlle({ kunMiljo: m });

        // Power BI-koblingene føres ikke i kalenderen — de opprettes av
        // skjemaeiere når som helst, og utløpet ligger allerede på
        // tokenraden. De formes som kalenderrader her, slik at ÉN
        // eskaleringsregel gjelder for begge slag og alt havner i samme
        // e-post. Se lib/pb-kalender.js.
        //
        // Best-effort: feiler oppslaget, skal de andre hemmelighetene
        // varsles likevel. En Power BI-rapport som viser gamle tall er
        // ikke verdt å tie om et sertifikat som ryker.
        try {
            const tokens = await pbToken.listPbEierTokens();
            if (tokens.length > 0) {
                const navn = new Map();
                for (const id of new Set(tokens.map(t => t.skjematypeId).filter(Boolean))) {
                    try {
                        const st = await skjemaStorage.hentSkjematype(id);
                        if (st?.navn) navn.set(id, st.navn);
                    } catch (_) { /* ID-en står i varselet i stedet */ }
                }
                rader.push(...pbKalender.somKalenderRader(tokens, {
                    na, navnFor: (id) => navn.get(id) || ''
                }));
            }
        } catch (e) {
            log(`nokkelkalender/sjekk: kunne ikke lese Power BI-tokens — ${e.message}`);
        }

        const forfalte = [];
        for (const rad of rader) {
            const trinn = kalender.skalVarsles(rad, na);
            if (trinn !== null) forfalte.push({ rad, trinn });
        }

        if (forfalte.length === 0) {
            return ferdig('ingenting', { AntallVarslet: 0, SistFeil: '' },
                { miljo: m, antallVarslet: 0, melding: 'Ingenting å varsle om', vurdert: rader.length });
        }

        const mottakere = String(process.env.ADMIN_UPNS || '')
            .split(',').map(s => s.trim()).filter(Boolean)
            .map(epost => ({ epost }));

        const detaljer = forfalte.map(f => ({
            Navn: f.rad.Navn, Trinn: f.trinn,
            DagerIgjen: f.rad.DagerIgjen, Utloper: f.rad.UtloperFaktisk
        }));

        if (torrkjor) {
            return { utfall: 'tørrkjørt', miljo: m, antallVarslet: 0,
                villeVarslet: detaljer, mottakere: mottakere.map(x => x.epost) };
        }

        if (mottakere.length === 0) {
            return ferdig('mangler-mottakere',
                { AntallVarslet: 0, SistFeil: 'ADMIN_UPNS er ikke satt' },
                { miljo: m, melding: 'ADMIN_UPNS er ikke satt — ingen å varsle', villeVarslet: detaljer });
        }

        const basisUrl = String(process.env.SWA_URL || '').replace(/\/+$/, '');
        const { emne, html } = byggEpost(forfalte.map(f => f.rad), m, basisUrl);

        const res = await sendEpostViaFlyt(
            { mottakere, emne, html, skjemaNavn: 'Nøkkelkalender', request }, log);

        // Merk bare av når varselet faktisk gikk ut. Feiler flyten, skal
        // neste kjøring prøve på nytt — ikke tro at det er varslet.
        if (res.status !== 'ok') {
            const melding = `Varslingsflyten svarte «${res.status}»: ${res.melding || ''}`.trim();
            log(`nokkelkalender/sjekk: varsling feilet — ${res.melding || res.status}`);
            return ferdig('varsling-feilet',
                { AntallVarslet: 0, SistFeil: melding.slice(0, 500) },
                { miljo: m, melding, villeVarslet: detaljer });
        }

        for (const f of forfalte) {
            // Power BI-radene er syntetiske og har ingen kalenderrad å
            // merke av på. Avkryssingen går til tokenraden selv.
            if (pbKalender.erPbRad(f.rad)) {
                await pbToken.markerVarslet(f.rad._pb.upn, f.rad._pb.guid, f.trinn);
            } else {
                await kalender.markerVarslet(f.rad.Id, f.trinn, m);
            }
        }

        hendelser.logg({
            Type: 'nokkelkalender.varsel', Aktor: kilde,
            ObjektType: 'nokkelkalender', ObjektId: m,
            Melding: `Varslet ${forfalte.length} hemmelighet(er): `
                + forfalte.map(f => f.rad.Navn).join(', ').slice(0, 400)
        });

        return ferdig('ok', { AntallVarslet: forfalte.length, SistFeil: '' }, {
            miljo: m, antallVarslet: forfalte.length,
            mottakere: mottakere.map(x => x.epost), varslet: detaljer
        });
    } catch (e) {
        log(`nokkelkalender/sjekk FEIL: ${e.message}`);
        await settStatus({
            Status: 'feil', Ferdig: new Date().toISOString(),
            Utfall: 'feil', SistFeil: String(e.message || e).slice(0, 500)
        });
        return { utfall: 'feil', melding: String(e.message || e) };
    }
}

module.exports = { kjorNokkelsjekk, byggEpost, PK, RK };
