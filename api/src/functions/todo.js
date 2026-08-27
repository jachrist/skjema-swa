/**
 * Todo — utestående punkter, vedlikeholdt fra admin-panelet.
 *
 *   GET    /api/todo             — hele lista + hvilket lager den ligger i (admin)
 *   POST   /api/todo             — nytt punkt bakerst { Tekst, Kategori?, Notat? } (admin)
 *   PUT    /api/todo/{nummer}    — endre { Tekst?, Status?, Kategori?, Notat? } (admin)
 *   DELETE /api/todo/{nummer}    — slett punkt (admin)
 *   POST   /api/todo/importer    — engangsimport fra Markdown { markdown } (admin)
 *   GET    /api/todo/markdown    — lista som Markdown, til deling (admin)
 *
 *   GET    /api/todo/{nummer}/vedlegg            — list vedlegg (admin)
 *   POST   /api/todo/{nummer}/vedlegg            — last opp (multipart «fil», admin)
 *   GET    /api/todo/{nummer}/vedlegg/{filnavn}  — hent fila inline (admin)
 *   DELETE /api/todo/{nummer}/vedlegg/{filnavn}  — fjern vedlegget (admin)
 *
 * Vedleggene ligger i blob-containeren todo-vedlegg på samme konto som lista,
 * så de følger den delte versjonen på tvers av miljøene.
 *
 * Lista deles på tvers av tenanter, så alle skrivende kall logges med UPN.
 */
const { app } = require('@azure/functions');
const { hentInnloggetUpn, erAdmin } = require('../lib/auth');
const todo = require('../lib/todo-storage');
const hendelser = require('../lib/hendelser-storage');

function admin(request) {
    const upn = hentInnloggetUpn(request);
    if (!upn) return { ok: false, status: 401, melding: 'Ikke innlogget' };
    if (!erAdmin(upn)) return { ok: false, status: 403, melding: 'Krever admin' };
    return { ok: true, upn };
}

function nummerFra(request) {
    const n = Number(request.params.nummer);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

app.http('todoList', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'todo',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const punkter = await todo.listAlle();
            // Ett kall over hele containeren, ikke ett per punkt — lista
            // trenger bare tallet for å vise bindersen.
            const vedleggAntall = await todo.antallVedleggPerPunkt();
            for (const p of punkter) {
                p.AntallVedlegg = vedleggAntall[String(p.Nummer).padStart(4, '0')] || 0;
            }
            return {
                jsonBody: {
                    punkter,
                    lager: todo.lagerInfo(),
                    antall: {
                        totalt: punkter.length,
                        apne: punkter.filter(p => p.Status === 'åpen').length,
                        ferdige: punkter.filter(p => p.Status === 'ferdig').length
                    }
                }
            };
        } catch (e) {
            context.log('todo GET FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('todoOpprett', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'todo',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const body = await request.json();
            const tekst = String(body?.Tekst || '').trim();
            if (!tekst) return { status: 400, jsonBody: { status: 'feil', melding: 'Tekst mangler' } };

            const punkt = await todo.opprett({ tekst, kategori: body.Kategori, notat: body.Notat }, a.upn);
            hendelser.logg({
                Type: 'todo.opprett', Aktor: a.upn,
                ObjektType: 'todo', ObjektId: String(punkt.Nummer),
                Melding: `La til punkt ${punkt.Nummer}: ${punkt.Tekst.slice(0, 120)}`
            });
            return { status: 201, jsonBody: punkt };
        } catch (e) {
            context.log('todo POST FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('todoOppdater', {
    methods: ['PUT'],
    authLevel: 'anonymous',
    route: 'todo/{nummer}',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        const nummer = nummerFra(request);
        if (nummer === null) return { status: 400, jsonBody: { status: 'feil', melding: 'Ugyldig nummer' } };
        try {
            const body = await request.json();
            const felter = {};
            for (const f of ['Tekst', 'Status', 'Kategori', 'Notat']) {
                if (body?.[f] !== undefined) felter[f] = body[f];
            }
            if (Object.keys(felter).length === 0) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Ingen felter å endre' } };
            }

            const punkt = await todo.oppdater(nummer, felter, a.upn);
            if (!punkt) return { status: 404, jsonBody: { status: 'feil', melding: 'Punktet finnes ikke' } };

            hendelser.logg({
                Type: 'todo.oppdater', Aktor: a.upn,
                ObjektType: 'todo', ObjektId: String(nummer),
                Melding: felter.Status
                    ? `Satte punkt ${nummer} til ${punkt.Status}`
                    : `Endret punkt ${nummer}`,
                Detaljer: { felter: Object.keys(felter) }
            });
            return { jsonBody: punkt };
        } catch (e) {
            context.log('todo PUT FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('todoSlett', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'todo/{nummer}',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        const nummer = nummerFra(request);
        if (nummer === null) return { status: 400, jsonBody: { status: 'feil', melding: 'Ugyldig nummer' } };
        try {
            const slettet = await todo.slett(nummer);
            if (!slettet) return { status: 404, jsonBody: { status: 'feil', melding: 'Punktet finnes ikke' } };
            // Vedleggene har ingen mening uten punktet, og nummeret gjenbrukes
            // ikke — blir de liggende, dukker de opp på ingenting.
            const vedlegg = await todo.slettAlleVedlegg(nummer);
            hendelser.logg({
                Type: 'todo.slett', Aktor: a.upn,
                ObjektType: 'todo', ObjektId: String(nummer),
                Melding: `Slettet punkt ${nummer}${vedlegg ? ` og ${vedlegg} vedlegg` : ''}`
            });
            return { jsonBody: { status: 'ok' } };
        } catch (e) {
            context.log('todo DELETE FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('todoImporter', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'todo/importer',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const body = await request.json();
            const markdown = String(body?.markdown || '');
            if (!markdown.trim()) return { status: 400, jsonBody: { status: 'feil', melding: 'markdown mangler' } };

            const res = await todo.importerMarkdown(markdown, a.upn);
            if (res.lest === 0) {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Fant ingen punkter på formen «12. [ ] tekst».' } };
            }
            hendelser.logg({
                Type: 'todo.importer', Aktor: a.upn,
                ObjektType: 'todo', ObjektId: 'import',
                Melding: `Importerte ${res.lagtTil} punkt (${res.hoppetOver} fantes fra før)`,
                Detaljer: res
            });
            return { jsonBody: { status: 'ok', ...res } };
        } catch (e) {
            context.log('todo importer FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

app.http('todoMarkdown', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'todo/markdown',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const md = todo.tilMarkdown(await todo.listAlle());
            return {
                status: 200,
                headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
                body: md
            };
        } catch (e) {
            context.log('todo markdown FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

/**
 * GET /api/todo/{nummer}/vedlegg — list vedlegg for punktet (admin).
 */
app.http('todoVedleggList', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'todo/{nummer}/vedlegg',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            return { jsonBody: { status: 'ok', vedlegg: await todo.listVedlegg(request.params.nummer) } };
        } catch (e) {
            context.log('todo vedlegg GET FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

/**
 * POST /api/todo/{nummer}/vedlegg — last opp én fil (multipart, felt "fil").
 * Admin. Bilder, PDF og tekstfiler, maks 4 MB.
 */
app.http('todoVedleggOpplast', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'todo/{nummer}/vedlegg',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const nummer = request.params.nummer;
            const punkt = await todo.hent(nummer);
            if (!punkt) return { status: 404, jsonBody: { status: 'feil', melding: `Fant ikke punkt ${nummer}` } };

            const formData = await request.formData();
            const fil = formData.get('fil');
            if (!fil || typeof fil === 'string') {
                return { status: 400, jsonBody: { status: 'feil', melding: 'Ingen fil sendt (må hete "fil")' } };
            }
            const buffer = Buffer.from(await fil.arrayBuffer());
            if (buffer.length > todo.VEDLEGG_MAKS) {
                return { status: 413, jsonBody: { status: 'feil', melding: `Filen er for stor (maks ${todo.VEDLEGG_MAKS / 1024 / 1024} MB)` } };
            }

            const res = await todo.lagreVedlegg(nummer, {
                filnavn: fil.name, buffer, contentType: fil.type
            });
            context.log(`todo vedlegg: ${a.upn} lastet opp ${res.Filnavn} (${res.Storrelse} bytes) til punkt ${nummer}`);
            hendelser.logg({
                Type: 'todo.vedlegg-opplast', Aktor: a.upn,
                ObjektType: 'todo', ObjektId: String(nummer),
                Melding: `La ved ${res.Filnavn} på punkt ${nummer}`,
                Detaljer: { filnavn: res.Filnavn, storrelse: res.Storrelse }
            });
            return { jsonBody: { status: 'ok', ...res } };
        } catch (e) {
            context.log('todo vedlegg POST FEIL:', e.message);
            // Filtype- og størrelsesfeil er brukerfeil, ikke serverfeil.
            const brukerfeil = /ikke tillatt|for stor|er tom/i.test(e.message);
            return { status: brukerfeil ? 400 : 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

/**
 * GET /api/todo/{nummer}/vedlegg/{filnavn} — hent selve fila (admin).
 * Vises inline, så et skjermbilde kan åpnes rett i fana.
 */
app.http('todoVedleggHent', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'todo/{nummer}/vedlegg/{filnavn}',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const filnavn = todo.trygtFilnavn(request.params.filnavn);
            const fil = await todo.hentVedlegg(request.params.nummer, filnavn);
            if (!fil) return { status: 404, jsonBody: { status: 'feil', melding: 'Fant ikke vedlegget' } };
            return {
                status: 200,
                headers: {
                    'Content-Type': fil.contentType,
                    'Content-Disposition': `inline; filename="${filnavn}"`,
                    'Cache-Control': 'private, max-age=300'
                },
                body: fil.buffer
            };
        } catch (e) {
            context.log('todo vedlegg hent FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});

/**
 * DELETE /api/todo/{nummer}/vedlegg/{filnavn} — fjern vedlegget (admin).
 */
app.http('todoVedleggSlett', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'todo/{nummer}/vedlegg/{filnavn}',
    handler: async (request, context) => {
        const a = admin(request);
        if (!a.ok) return { status: a.status, jsonBody: { status: 'feil', melding: a.melding } };
        try {
            const filnavn = todo.trygtFilnavn(request.params.filnavn);
            const slettet = await todo.slettVedlegg(request.params.nummer, filnavn);
            if (!slettet) return { status: 404, jsonBody: { status: 'feil', melding: 'Fant ikke vedlegget' } };
            hendelser.logg({
                Type: 'todo.vedlegg-slett', Aktor: a.upn,
                ObjektType: 'todo', ObjektId: String(request.params.nummer),
                Melding: `Fjernet vedlegget ${filnavn} fra punkt ${request.params.nummer}`,
                Detaljer: { filnavn }
            });
            return { jsonBody: { status: 'ok' } };
        } catch (e) {
            context.log('todo vedlegg slett FEIL:', e.message);
            return { status: 500, jsonBody: { status: 'feil', melding: e.message } };
        }
    }
});
