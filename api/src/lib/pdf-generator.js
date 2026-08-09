/**
 * PDF-generator for oppsummering av innsendt skjema.
 * Bygger på pdf-lib. Portert fra legacy azure-function-skjema/src/pdf-generator.js
 * med minimale tilpasninger til SWA-pilot (ingen kryptering ennå).
 *
 * Innhold:
 *   - Header + metadata (skjema-navn, id, innsender, datoer)
 *   - Behandlingshistorikk (steg med Beslutning != 0)
 *   - Seksjoner + spørsmål/svar (to-kolonne rad-layout)
 *   - Dialog (ekstern + intern)
 *   - Vedlegg: forside per fil, PNG/JPG embeddes, PDF-vedlegg merges
 *   - Footer: skjema-ID venstre, sidenummer høyre
 */

const { PDFDocument, StandardFonts, rgb, PageSizes } = require('pdf-lib');

const BLAA = rgb(0, 0.47, 0.83);
const TEKST = rgb(0.2, 0.2, 0.2);
const MUTED = rgb(0.5, 0.5, 0.5);
const HVIT = rgb(1, 1, 1);

// Saniter tekst for WinAnsi (StandardFonts). Konverterer smarte anførselstegn,
// diverse streker, ellipsis osv. til Latin-1-ekvivalenter. Kontroll-tegn strippes.
function san(s) {
    if (s === null || s === undefined) return '';
    return String(s)
        .replace(/\r\n?/g, '\n')
        .replace(/[‐-―−]/g, '-')
        .replace(/[‘’‚‛′]/g, "'")
        .replace(/[“”„‟″]/g, '"')
        .replace(/…/g, '...')
        .replace(/[  -​  　﻿]/g, ' ')
        .replace(/[•‣◦⁃]/g, '-')
        .replace(/™/g, '(TM)')
        .replace(/[®©]/g, '')
        .replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, '')
        .replace(/[^\x0A\x20-\x7E\xA1-\xFF]/g, '?');
}

function flatLinje(s) { return san(s).replace(/\n+/g, ' ').trim(); }

function formatDato(iso) {
    if (!iso) return '-';
    try {
        return new Date(iso).toLocaleDateString('no-NO', {
            day: 'numeric', month: 'long', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    } catch { return String(iso); }
}
function formatKortDato(iso) {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleDateString('no-NO', {
            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
        });
    } catch { return String(iso); }
}

/**
 * Utled ferdigbehandlet-dato som nyeste BehandletDato hvis alle steg er ferdig.
 */
function utledFerdigDato(skjema) {
    const b = skjema?.Behandling;
    if (!Array.isArray(b) || b.length === 0) return '';
    let siste = '';
    for (const s of b) {
        if (!Number(s?.Beslutning || 0)) return '';
        const d = s?.BehandletDato || '';
        if (d > siste) siste = d;
    }
    return siste;
}

/**
 * Generer oppsummerings-PDF.
 *
 * @param {Object} skjema - fullt format med Seksjoner/Felter/Svar + Behandling + Dialog
 * @param {Array}  vedleggData - [{ name, data (base64) }]
 * @returns {Promise<Buffer>}
 */
async function genererOppsummeringPdf(skjema, vedleggData = []) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

    const pageW = PageSizes.A4[0];
    const pageH = PageSizes.A4[1];
    const margin = 50;
    const contentW = pageW - 2 * margin;

    let page = doc.addPage(PageSizes.A4);
    let y = pageH - margin;

    function nyLinje(høyde) {
        y -= høyde;
        if (y < margin + 20) {
            page = doc.addPage(PageSizes.A4);
            y = pageH - margin;
        }
    }

    function skrivTekst(tekst, størrelse, skrifttype, farge, x) {
        page.drawText(flatLinje(tekst), {
            x: x || margin, y, size: størrelse, font: skrifttype, color: farge || TEKST
        });
    }

    function wrapTekst(tekst, størrelse, skrifttype, maxBredde) {
        const sanitert = san(tekst);
        const allLinjer = [];
        for (const orgLinje of sanitert.split('\n')) {
            if (orgLinje === '') { allLinjer.push(''); continue; }
            const ord = orgLinje.split(' ');
            let linje = '';
            for (const o of ord) {
                const test = linje ? linje + ' ' + o : o;
                if (skrifttype.widthOfTextAtSize(test, størrelse) > maxBredde && linje) {
                    allLinjer.push(linje);
                    linje = o;
                } else {
                    linje = test;
                }
            }
            if (linje) allLinjer.push(linje);
        }
        return allLinjer;
    }

    // === HEADER ===
    skrivTekst(skjema.Overskrift || skjema.Skjema_navn || 'Oppsummering', 16, fontBold, BLAA);
    nyLinje(20);

    const ferdigDato = utledFerdigDato(skjema);
    const opprettetDato = skjema.Opprettet_dato || skjema.Opprettet || skjema.Innsendt_dato || '';

    const meta = [
        ['Skjema-ID', skjema.Skjema_id || '-'],
        ['Innsender', skjema.Innsender_Navn || skjema.Innsender || '-'],
        ['E-post', skjema.Innsender_Epost || skjema.Innsender_epost || '-'],
        ['Opprettet', formatDato(opprettetDato)],
        ['Ferdigbehandlet', ferdigDato ? formatDato(ferdigDato) : '-']
    ];
    for (const [nøkkel, verdi] of meta) {
        skrivTekst(nøkkel + ': ', 8, fontBold, MUTED);
        page.drawText(flatLinje(verdi), {
            x: margin + fontBold.widthOfTextAtSize(nøkkel + ': ', 8),
            y, size: 8, font, color: TEKST
        });
        nyLinje(12);
    }

    // === BEHANDLINGSHISTORIKK ===
    const behandling = (skjema.Behandling || []).filter(b => b.Beslutning && b.Beslutning !== 0);
    if (behandling.length > 0) {
        nyLinje(8);
        skrivTekst('Behandlingshistorikk', 10, fontBold, BLAA);
        nyLinje(14);
        for (const b of behandling) {
            const valg = (b.Beslutningsvalg || []).find(v => Number(v.Nummer) === Number(b.Beslutning));
            const beslTekst = valg ? valg.Tekst
                : (Number(b.Beslutning) === 5 ? 'Hoppet over' : String(b.Beslutning));
            const dato = formatKortDato(b.BehandletDato || b.Tidspunkt);
            skrivTekst(
                `Steg ${b.Steg}: ${b.Stegnavn || ''} - ${beslTekst} (${b.BehandletAv || b.Epost || ''}, ${dato})`,
                7, font, TEKST
            );
            nyLinje(10);
            if (b.Kommentar) {
                const komLinjer = wrapTekst('Kommentar: ' + b.Kommentar, 7, font, contentW - 10);
                for (const l of komLinjer) {
                    skrivTekst(l, 7, font, MUTED, margin + 10);
                    nyLinje(9);
                }
            }
        }
    }

    // === SEKSJONER ===
    for (const seksjon of (skjema.Seksjoner || [])) {
        const felter = (seksjon.Felter || []).filter(f => f.Type !== 'Informasjon');
        const harSvar = felter.some(f =>
            Array.isArray(f.Svar) && f.Svar.length > 0 && f.Svar.some(s => s !== '')
        );
        if (!harSvar) continue;

        nyLinje(10);
        page.drawRectangle({ x: margin, y: y - 2, width: contentW, height: 14, color: BLAA });
        page.drawText(
            flatLinje(seksjon.Seksjon_overskrift || seksjon.Overskrift || 'Seksjon ' + (seksjon.Seksjon_nummer || seksjon.Nummer)),
            { x: margin + 5, y: y + 1, size: 9, font: fontBold, color: HVIT }
        );
        nyLinje(18);

        let visningsTeller = 0;
        for (const felt of felter) {
            visningsTeller++;
            const svar = Array.isArray(felt.Svar) ? felt.Svar.filter(s => s !== '') : [];
            if (svar.length === 0) continue;

            const spørsmål = felt.Tekst?.Verdi || 'Felt ' + visningsTeller;
            const svarTekst = svar.join(', ');

            const spLinjer = wrapTekst(visningsTeller + '. ' + spørsmål, 7, fontBold, contentW / 2 - 5);
            const svLinjer = wrapTekst(svarTekst, 7, font, contentW / 2 - 5);
            const radHøyde = Math.max(spLinjer.length, svLinjer.length) * 9 + 4;

            nyLinje(radHøyde);
            page.drawRectangle({ x: margin, y: y - 2, width: contentW, height: radHøyde, color: rgb(0.97, 0.97, 0.97) });

            let tempY = y + radHøyde - 10;
            for (const l of spLinjer) {
                page.drawText(flatLinje(l), { x: margin + 3, y: tempY, size: 7, font: fontBold, color: TEKST });
                tempY -= 9;
            }
            tempY = y + radHøyde - 10;
            for (const l of svLinjer) {
                page.drawText(flatLinje(l), { x: margin + contentW / 2, y: tempY, size: 7, font, color: TEKST });
                tempY -= 9;
            }
        }
    }

    // === DIALOG ===
    const dialog = Array.isArray(skjema.Dialog) ? skjema.Dialog : [];
    if (dialog.length > 0) {
        const ekstern = dialog.filter(i => (i.Type || i.DialogType) === 'ekstern');
        const intern = dialog.filter(i => (i.Type || i.DialogType) === 'intern');
        for (const [tittel, innlegg] of [['Ekstern dialog', ekstern], ['Intern dialog', intern]]) {
            if (innlegg.length === 0) continue;
            nyLinje(15);
            skrivTekst(tittel, 10, fontBold, BLAA);
            nyLinje(14);
            for (const i of innlegg) {
                const dato = formatKortDato(i.Dato || i.Tidspunkt);
                skrivTekst(`${i.AvsenderNavn || i.Avsender || '-'} - ${dato}`, 6, font, MUTED);
                nyLinje(9);
                const linjer = wrapTekst(i.Tekst || '', 7, font, contentW - 10);
                for (const l of linjer) {
                    skrivTekst(l, 7, font, TEKST, margin + 5);
                    nyLinje(9);
                }
                nyLinje(3);
            }
        }
    }

    // === VEDLEGG ===
    if (vedleggData && vedleggData.length > 0) {
        for (let vi = 0; vi < vedleggData.length; vi++) {
            const v = vedleggData[vi];
            const ext = (v.name || '').split('.').pop().toLowerCase();
            const buffer = Buffer.from(v.data, 'base64');

            // Forside
            page = doc.addPage(PageSizes.A4);
            y = pageH / 2 + 20;
            const tittelBredde = fontBold.widthOfTextAtSize(`Vedlegg ${vi + 1}`, 28);
            page.drawText(`Vedlegg ${vi + 1}`, {
                x: pageW / 2 - tittelBredde / 2, y, size: 28, font: fontBold, color: BLAA
            });
            y -= 30;
            const filnavnSafe = flatLinje(v.name);
            const navnBredde = font.widthOfTextAtSize(filnavnSafe, 14);
            page.drawText(filnavnSafe, {
                x: pageW / 2 - navnBredde / 2, y, size: 14, font, color: TEKST
            });

            if (['png', 'jpg', 'jpeg'].includes(ext)) {
                try {
                    const img = ext === 'png' ? await doc.embedPng(buffer) : await doc.embedJpg(buffer);
                    const dims = img.scaleToFit(contentW, pageH - 2 * margin - 30);
                    page = doc.addPage(PageSizes.A4);
                    page.drawImage(img, {
                        x: margin, y: pageH - margin - dims.height - 20,
                        width: dims.width, height: dims.height
                    });
                } catch (_) { /* ikke embed-bar */ }
            } else if (ext === 'pdf') {
                try {
                    const vedleggPdf = await PDFDocument.load(buffer);
                    const sider = await doc.copyPages(vedleggPdf, vedleggPdf.getPageIndices());
                    for (const s of sider) doc.addPage(s);
                } catch (e) {
                    page = doc.addPage(PageSizes.A4);
                    page.drawText(flatLinje('Kunne ikke embedde PDF-vedlegg: ' + (e.message || '')), {
                        x: margin, y: pageH - margin - 20, size: 8, font, color: MUTED
                    });
                }
            }
        }
    }

    // === FOOTER ===
    const sider = doc.getPages();
    for (let i = 0; i < sider.length; i++) {
        const s = sider[i];
        s.drawText(flatLinje(`Skjema-ID: ${skjema.Skjema_id || '-'}`), {
            x: margin, y: 20, size: 6, font, color: MUTED
        });
        s.drawText(flatLinje(`Side ${i + 1} av ${sider.length}`), {
            x: pageW - margin - 50, y: 20, size: 6, font, color: MUTED
        });
    }

    return Buffer.from(await doc.save());
}

module.exports = { genererOppsummeringPdf };
