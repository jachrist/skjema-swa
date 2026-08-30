/**
 * Nøkkelkalender — hemmeligheter og nøkler med utløpsdato.
 *
 *   GET    /api/nokkelkalender          — hele kalenderen + lagerinfo (admin)
 *   POST   /api/nokkelkalender          — ny rad (admin)
 *   PUT    /api/nokkelkalender/{id}     — endre rad (admin)
 *   DELETE /api/nokkelkalender/{id}     — slett rad (admin)
 *   POST   /api/nokkelkalender/seed     — legg inn standardinventaret (admin)
 *   POST   /api/nokkelkalender/sjekk    — varsle om det som nærmer seg utløp
 *                                          (x-scheduler-key eller admin)
 *
 * Sjekken kjøres daglig av .github/workflows/sjekk-nokler.yml, siden SWA
 * Managed Functions ikke støtter timer-triggere. Den behandler bare rader i
 * sitt eget miljø, så pilot og prod varsler ikke dobbelt om samme rad.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const kalender = require('../lib/nokkelkalender-storage');
const { sendEpostViaFlyt } = require('../lib/flyt-kaller');
const hendelser = require('../lib/hendelser-storage');

function admin(request) {
    const upn = hentInnloggetUpn(request);
    if (!upn) return { ok: false, status: 401, melding: 'Ikke innlogget' };
    if (!erAdmin(upn)) return { ok: false, status: 403, melding: 'Krever admin' };
    return { ok: true, upn };
}

/** Samme mønster som utsending/purre: cron eller admin slipper inn. */
function schedulerEllerAdmin(request) {
    const gitt = request.headers.get('x-scheduler-key');
    const konfigurert = String(process.env.SCHEDULER_KEY || '').trim();
    if (konfigurert && gitt && gitt === konfigurert) return { ok: true, upn: 'scheduler' };
    const upn = hentInnloggetUpn(request);
    if (upn && erAdmin(upn)) return { ok: true, upn };
    return { ok: false, status: 401, melding: 'Krever x-scheduler-key eller admin' };
}

function oppsummering(rader) {
    const tell = (t) => rader.filter(r => r.Tilstand === t).length;
    return {
        totalt: rader.length,
        utløpt: tell('utløpt'),
        kritisk: tell('kritisk'),
        snart: tell('snart'),
        ukjent: tell('ukjent'),
        ok: tell('ok'),
        fast: tell('fast')
    };
}

app.http('nokkelkalenderList', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'nokkelkalender',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const rader = await kalender.listAlle();
            return {
                jsonBody: {
                    rader,
                    lager: kalender.lagerInfo(),
                    miljo: kalender.miljo(),
                    typer: kalender.TYPER,
                    oppsummering: oppsummering(rader)
                }
            };
        } catch (e) {
            context.log('nokkelkalender GET FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('nokkelkalenderOpprett', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'nokkelkalender',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const body = await request.json();
            const rad = await kalender.opprett(body, a.upn);
            hendelser.logg({
                Type: 'nokkelkalender.opprett', Aktor: a.upn,
                ObjektType: 'nokkelkalender', ObjektId: rad.Id,
                Melding: `La til «${rad.Navn}» i ${rad.Miljo}`
            });
            return { status: 201, jsonBody: rad };
        } catch (e) {
            context.log('nokkelkalender POST FEIL:', e.message);
            return { status: 400, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('nokkelkalenderOppdater', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'nokkelkalender/{id}',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const body = await request.json();
            const m = String(body?.Miljo || kalender.miljo()).toLowerCase();
            const rad = await kalender.oppdater(request.params.id, body, a.upn, m);
            if (!rad) return { status: 404, jsonBody: { status: 'feil', melding: 'Raden finnes ikke' } };
            hendelser.logg({
                Type: 'nokkelkalender.endre', Aktor: a.upn,
                ObjektType: 'nokkelkalender', ObjektId: rad.Id,
                Melding: `Endret «${rad.Navn}»${rad.UtloperFaktisk ? ` — utløper ${rad.UtloperFaktisk.slice(0, 10)}` : ''}`
            });
            return { jsonBody: rad };
        } catch (e) {
            context.log('nokkelkalender PUT FEIL:', e.message);
            return { status: 400, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('nokkelkalenderSlett', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'nokkelkalender/{id}',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const m = String(request.query.get('miljo') || kalender.miljo()).toLowerCase();
            const slettet = await kalender.slett(request.params.id, m);
            if (!slettet) return { status: 404, jsonBody: { status: 'feil', melding: 'Raden finnes ikke' } };
            hendelser.logg({
                Type: 'nokkelkalender.slett', Aktor: a.upn,
                ObjektType: 'nokkelkalender', ObjektId: request.params.id,
                Melding: `Slettet «${request.params.id}» fra ${m}`
            });
            return { jsonBody: { status: 'ok' } };
        } catch (e) {
            context.log('nokkelkalender DELETE FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('nokkelkalenderSeed', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'nokkelkalender/seed',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const res = await kalender.seedStandard(a.upn);
            hendelser.logg({
                Type: 'nokkelkalender.seed', Aktor: a.upn,
                ObjektType: 'nokkelkalender', ObjektId: res.miljo,
                Melding: `Standardinventar: ${res.lagtTil} lagt til, ${res.hoppetOver} fantes fra før`
            });
            return { jsonBody: { status: 'ok', ...res } };
        } catch (e) {
            context.log('nokkelkalender seed FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});


// ==================== VARSLING ====================

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
 * POST /api/nokkelkalender/sjekk — daglig kontroll.
 *
 * Sender ett samlet varsel til ADMIN_UPNS med alt som har passert et nytt
 * trinn. Ett brev om alle, ikke ett per hemmelighet: en administrator som får
 * seks e-poster leser den første.
 *
 * Body: { tørrkjør?: true } for å se hva som ville blitt sendt uten å sende.
 */
app.http('nokkelkalenderSjekk', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'nokkelkalender/sjekk',
    handler: async (request, context) => {
        const a = schedulerEllerAdmin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };

        try {
            const body = await request.json().catch(() => ({}));
            const torrkjor = body?.tørrkjør === true || body?.torrkjor === true;
            const m = kalender.miljo();
            const na = new Date();

            const rader = await kalender.listAlle({ kunMiljo: m });
            const forfalte = [];
            for (const rad of rader) {
                const trinn = kalender.skalVarsles(rad, na);
                if (trinn !== null) forfalte.push({ rad, trinn });
            }

            if (forfalte.length === 0) {
                return {
                    jsonBody: {
                        status: 'ok', miljo: m, antallVarslet: 0,
                        melding: 'Ingenting å varsle om', vurdert: rader.length
                    }
                };
            }

            const mottakere = String(process.env.ADMIN_UPNS || '')
                .split(',').map(s => s.trim()).filter(Boolean)
                .map(epost => ({ epost }));

            const detaljer = forfalte.map(f => ({
                Navn: f.rad.Navn, Trinn: f.trinn,
                DagerIgjen: f.rad.DagerIgjen, Utloper: f.rad.UtloperFaktisk
            }));

            if (torrkjor) {
                return {
                    jsonBody: {
                        status: 'ok', tørrkjør: true, miljo: m,
                        antallVarslet: 0, villeVarslet: detaljer,
                        mottakere: mottakere.map(x => x.epost)
                    }
                };
            }

            if (mottakere.length === 0) {
                return {
                    status: 500,
                    jsonBody: {
                        status: 'feil', miljo: m,
                        melding: 'ADMIN_UPNS er ikke satt — ingen å varsle',
                        villeVarslet: detaljer
                    }
                };
            }

            const basisUrl = String(process.env.SWA_URL || '').replace(/\/+$/, '');
            const { emne, html } = byggEpost(forfalte.map(f => f.rad), m, basisUrl);

            const res = await sendEpostViaFlyt(
                { mottakere, emne, html, skjemaNavn: 'Nøkkelkalender', request },
                (s) => context.log(s)
            );

            // Merk bare av når varselet faktisk gikk ut. Feiler flyten, skal
            // neste kjøring prøve på nytt — ikke tro at det er varslet.
            if (res.status !== 'ok') {
                context.log(`nokkelkalender/sjekk: varsling feilet — ${res.melding || res.status}`);
                return {
                    status: 502,
                    jsonBody: {
                        status: 'feil', miljo: m,
                        melding: `Varslingsflyten svarte «${res.status}»: ${res.melding || ''}`.trim(),
                        villeVarslet: detaljer
                    }
                };
            }

            for (const f of forfalte) {
                await kalender.markerVarslet(f.rad.Id, f.trinn, m);
            }
            hendelser.logg({
                Type: 'nokkelkalender.varsel', Aktor: a.upn,
                ObjektType: 'nokkelkalender', ObjektId: m,
                Melding: `Varslet ${forfalte.length} hemmelighet(er): ${forfalte.map(f => f.rad.Navn).join(', ').slice(0, 400)}`
            });

            return {
                jsonBody: {
                    status: 'ok', miljo: m,
                    antallVarslet: forfalte.length,
                    mottakere: mottakere.map(x => x.epost),
                    varslet: detaljer
                }
            };
        } catch (e) {
            context.log('nokkelkalender/sjekk FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
