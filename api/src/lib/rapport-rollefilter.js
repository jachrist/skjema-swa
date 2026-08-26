/**
 * Rollebaserte rapportfiltre — «vis bare radene mitt rolleomfang dekker».
 *
 * Et innebygd filter kan bære `fraRolle` i stedet for en fast `verdi`:
 *
 *     { type: 'svar', seksjon: 2, felt: 1, fraRolle: 'Emneansvarlig' }
 *
 * Ved kjøring slås brukerens omfang for den rollen opp, og filteret blir et
 * vanlig `in`-filter mot de verdiene. Emneansvarlig ser sine egne emner,
 * klassesjefen sin egen klasse — uten at rapporten må lages i mange utgaver.
 *
 * Filteret er alltid på og aldri synlig for brukeren; det hører hjemme i
 * `Innebygde_filtre`, ikke i `Brukerfiltre`.
 *
 * To valg som er verdt å kjenne til:
 *
 *   - Admin slipper filteret helt. Det betyr at samme rapport viser flere rader
 *     for en admin enn for andre, så tallene er ikke sammenlignbare på tvers av
 *     hvem som kjørte den.
 *   - Har brukeren ingen omfang for rollen, blir lista tom og rapporten viser
 *     ingen rader. Det er med vilje: å slippe filteret ville vist alt til den
 *     som har minst grunn til å se det.
 */
const rollerStorage = require('./roller-storage');
const { finnOmfangsvarianter } = require('./omfang');

function erRollefilter(filter) {
    return !!String(filter?.fraRolle || '').trim();
}

/**
 * Bytt ut rollefiltrene i lista med konkrete `in`-filtre.
 *
 * @param {object[]} filtre
 * @param {string} upn
 * @param {boolean} erAdministrator — admin ser alt, filteret droppes
 * @param {function} [log]
 * @returns {Promise<object[]>}
 */
async function løsRollefiltre(filtre, upn, erAdministrator, log = () => {}) {
    const ut = [];
    for (const filter of (filtre || [])) {
        if (!erRollefilter(filter)) { ut.push(filter); continue; }

        const rolle = String(filter.fraRolle).trim();
        if (erAdministrator) {
            log(`rapport: admin — rollefilteret på "${rolle}" droppes, alle rader vises`);
            continue;
        }

        let omfang = [];
        try {
            omfang = await rollerStorage.hentOmfangForBruker(rolle, upn);
        } catch (e) {
            // Feiler lukket: et oppslag som ryker skal ikke åpne rapporten.
            log(`rapport: kunne ikke slå opp omfang for rollen "${rolle}" — ${e.message}. Filtrerer bort alt.`);
            ut.push({ ...filter, operator: 'in', verdi: [] });
            continue;
        }

        const varianter = await finnOmfangsvarianter(omfang);
        if (varianter.length === 0) {
            log(`rapport: ${upn} har ingen omfang i rollen "${rolle}" — rapporten blir tom`);
        } else {
            log(`rapport: rollefilter "${rolle}" → ${varianter.length} omfangsverdi(er)`);
        }
        ut.push({ ...filter, operator: 'in', verdi: varianter });
    }
    return ut;
}

module.exports = { løsRollefiltre, erRollefilter };
