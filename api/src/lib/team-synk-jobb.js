/**
 * Team-synkroniseringen som JOBB — uavhengig av hva som startet den.
 *
 * Samme form som de andre jobbmodulene, og her betyr den mer enn vanlig:
 * **flyten oppdaterer teamet DESTRUKTIVT.** Reglene for når vi tør å kalle
 * den ligger i `lib/team-synk.js`; denne modulen eier KJØRINGEN av dem og
 * bokføringen av utfallet.
 *
 * Tre innganger kaller nå den samme `synkroniserGruppe`:
 *
 *   `POST /api/team-synk`        — alle grupper (cron i pilot og prod)
 *   `POST /api/team-synk/{rolle}` — én gruppe, med `tillatFall`
 *   timeren i dev
 *
 * **`tillatFall` settes ALDRI fra en automatisk kjøring.** Den overstyrer
 * sperren mot store fall i medlemstall, og en overstyring som gjelder uten at
 * et menneske har sett tallet er nettopp det sperren finnes for å hindre.
 *
 * Lå i `functions/team-synk.js` til 17.10.2026.
 */
const rollerStorage = require('./roller-storage');
const gruppeStorage = require('./rollegruppe-storage');
const teamSynk = require('./team-synk');
const { kallTeamSynkFlyt, miljo } = require('./flyt-kaller');
const hendelser = require('./hendelser-storage');

const PK = 'Meta';
const RK = 'Jobb-Team-Synk';

/**
 * Kjør synkroniseringen for én gruppe.
 *
 * Returnerer alltid et resultatobjekt, aldri et kast: kalleren kjører mange
 * grupper etter hverandre, og én gruppe som feiler skal ikke ta med seg
 * resten.
 */
async function synkroniserGruppe(gruppe, { tillatFall = false, aktor = 'scheduler', log = () => {} }) {
    const { Rolle, Omfang, Team } = gruppe;
    const merkelapp = `${Rolle}${Omfang ? `(${Omfang})` : ''}`;

    const rolleStreng = Omfang ? `${Rolle}(${Omfang})` : Rolle;
    const innehavere = await rollerStorage.hentInnehavere(rolleStreng);
    const upner = teamSynk.upnListe(innehavere);

    // Eierne som skal vernes. Samme omfang som gruppen selv — se
    // `eierRolleFor` for hvorfor omfanget ikke kan velges fritt.
    //
    // Feiler oppslaget, STOPPER vi. Å fortsette uten eierlista ville meldt
    // ut nettopp dem vernet finnes for, og det er en verre utgang enn å la
    // teamet stå urørt et døgn til.
    const eierRolle = teamSynk.eierRolleFor(gruppe);
    let eiere = [];
    if (eierRolle) {
        const eierStreng = Omfang ? `${eierRolle}(${Omfang})` : eierRolle;
        try {
            eiere = teamSynk.upnListe(await rollerStorage.hentInnehavere(eierStreng));
        } catch (e) {
            const melding = `Kunne ikke lese eier-rollen ${eierStreng}: ${e.message}. `
                + 'Synkronisering stoppet — uten eierlista kunne eierne blitt meldt ut.';
            log(`team-synk: ${merkelapp} STOPPET — ${melding}`);
            await gruppeStorage.settResultat(Rolle, Omfang, { status: 'stoppet', melding });
            return { rolle: Rolle, omfang: Omfang, team: Team, status: 'stoppet', grunn: 'eier-oppslag-feilet', antall: upner.length, melding };
        }
    }

    // Sperrene teller MEDLEMMENE alene, ikke det sammenslåtte. Gikk
    // medlemsimporten galt og lista ble tom mens eier-rollen har folk, ville
    // en telling av det sammenslåtte ikke sett noe galt — og teamet ville
    // blitt synkronisert ned til bare eierne, i stillhet.
    const dom = teamSynk.vurderSynk({
        antallNaa: upner.length,
        forrigeAntall: gruppe.SisteAntall,
        tillatFall
    });

    if (!dom.ok) {
        log(`team-synk: ${merkelapp} STOPPET (${dom.grunn}) — ${dom.melding}`);
        await gruppeStorage.settResultat(Rolle, Omfang, { status: 'stoppet', melding: dom.melding });
        try {
            await hendelser.logg({
                Type: 'team.synk.stoppet', Aktor: aktor,
                ObjektType: 'rollegruppe', ObjektId: merkelapp,
                Melding: `${dom.grunn}: ${dom.melding}`
            });
        } catch (_) { /* logging skal ikke velte kjøringen */ }
        return { rolle: Rolle, omfang: Omfang, team: Team, status: 'stoppet', grunn: dom.grunn, antall: upner.length, melding: dom.melding };
    }

    // Eierne slås inn i medlemslista her — etter at sperrene har sagt ja.
    const payload = teamSynk.byggPayload({
        rolle: Rolle, omfang: Omfang, team: Team, upner, eiere, miljo: miljo()
    });
    const res = await kallTeamSynkFlyt(payload, log);

    // `SisteAntall` oppdateres bare ved 'ok' — se rollegruppe-storage.js for
    // hvorfor en stoppet kjøring ikke får flytte grunnlaget for fall-sperren.
    await gruppeStorage.settResultat(Rolle, Omfang, {
        status: res.status === 'ok' ? 'ok' : res.status,
        melding: res.melding || dom.grunn,
        antall: upner.length
    });
    try {
        await hendelser.logg({
            Type: res.status === 'ok' ? 'team.synk.ok' : 'team.synk.feil', Aktor: aktor,
            ObjektType: 'rollegruppe', ObjektId: merkelapp,
            Melding: `${upner.length} medlemmer${eiere.length ? ` + ${eiere.length} eier(e)` : ''} `
                + `→ "${Team}" (${res.status}${dom.grunn === 'stort-fall-overstyrt' ? ', fall overstyrt' : ''})`
        });
    } catch (_) { /* logging skal ikke velte kjøringen */ }

    return {
        rolle: Rolle, omfang: Omfang, team: Team,
        status: res.status, grunn: dom.grunn,
        // `antall` er medlemmene — det tallet sperrene gjelder. `sendt` er
        // hva teamet faktisk får. De to er ulike når eiere er vernet, og et
        // grensesnitt som bare viser ett av dem forklarer ikke differansen.
        antall: upner.length, antallEiere: eiere.length, sendt: payload.Antall,
        melding: res.melding || ''
    };
}

/**
 * Kjør synkroniseringen for ALLE grupper med team-kobling, og bokfør
 * utfallet. Kaster aldri.
 *
 * En gruppe som feiler stopper ikke de andre — det er den samme regelen som
 * i oppslagslistene, og av samme grunn: ett oppsett med en skrivefeil skal
 * ikke ta hele døgnjobben med seg.
 *
 * `stoppet` telles for seg i statusraden. En stoppet gruppe er ikke en feil i
 * koden, men den er heller ikke «ok»: teamet står da urørt fordi medlemstallet
 * falt mer enn sperren tillater, og noen bør se på det.
 */
async function kjorTeamSynk({ kilde, log = () => {} } = {}) {
    const { tabellKlient } = require('./storage');
    const startTid = new Date().toISOString();
    const settStatus = async (felter) => {
        try {
            const t = tabellKlient('CacheMetadata');
            await t.upsertEntity({ partitionKey: PK, rowKey: RK, ...felter }, 'Merge');
        } catch (_) { /* statusraden er ikke kritisk */ }
    };

    await settStatus({ Status: 'kjører', Startet: startTid, Kilde: kilde, SistFeil: '' });
    log(`team-synk: trigget av ${kilde}`);

    let grupper;
    try {
        grupper = (await gruppeStorage.hentAlle()).filter(teamSynk.harTeam);
    } catch (e) {
        const melding = String(e.message || e);
        log(`team-synk FEIL: ${melding}`);
        await settStatus({
            Status: 'feil', Ferdig: new Date().toISOString(),
            SistFeil: melding.slice(0, 500)
        });
        return { utfall: 'feil', kastet: true, melding, resultater: [], kjort: 0, stoppet: 0 };
    }

    const resultater = [];
    for (const g of grupper) {
        try {
            // `tillatFall` sendes IKKE — se kommentaren øverst.
            resultater.push(await synkroniserGruppe(g, { aktor: kilde, log }));
        } catch (e) {
            // Én gruppe som kaster skal ikke stoppe de andre.
            log(`team-synk: ${g.Rolle}(${g.Omfang}) kastet — ${e.message}`);
            resultater.push({ rolle: g.Rolle, omfang: g.Omfang, status: 'feil', melding: e.message });
        }
    }

    const stoppet = resultater.filter(r => r.status === 'stoppet').length;
    const feilet = resultater.filter(r => r.status === 'feil').length;
    const utfall = feilet > 0 ? (resultater.length > feilet ? 'delvis' : 'feil') : 'ok';
    log(`team-synk: ${resultater.length} grupper, ${stoppet} stoppet, ${feilet} feilet`);

    await settStatus({
        Status: utfall === 'ok' ? 'ok' : utfall,
        Ferdig: new Date().toISOString(),
        SistOppdatert: new Date().toISOString(),
        AntallGrupper: resultater.length,
        AntallStoppet: stoppet,
        AntallFeilet: feilet,
        VarighetSekunder: Math.round((Date.now() - Date.parse(startTid)) / 1000),
        SistFeil: resultater.filter(r => r.status === 'feil')
            .map(r => `${r.rolle}: ${r.melding}`).join(' | ').slice(0, 500)
    });

    return { utfall, kastet: false, melding: null, kjort: resultater.length, stoppet, resultater };
}

module.exports = { synkroniserGruppe, kjorTeamSynk, PK, RK };
