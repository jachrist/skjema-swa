#!/usr/bin/env python3
"""
Fire arkitekturillustrasjoner for gjennomgangen 12.11.2026, som SVG (16:9).

  1  v2: komponentene og samhandlingen
  2  v2: sikkerhetsutfordringene, nummerert på samme tegning
  3  v3: komponentene og samhandlingen
  4  v3: hvordan utfordringene er løst — samme numre som i 2

Tegningene for 2 og 4 GJENBRUKER 1 og 3 (dempet), slik at nummer N står på
samme sted i begge versjoner. Hver påstand er hentet fra
docs/SIKKERHET-OG-ARKITEKTUR.md (kapittel 7–9) eller
docs/BESLUTNING-EGEN-FUNCTION-APP.md — ikke formulert her.

Kjøres med:  python3 scripts/arkitektur-illustrasjoner.py [utmappe]
Standard utmappe: docs/illustrasjoner
"""
import os
import sys
from xml.sax.saxutils import escape

B, H = 1920, 1080
FONT = "Segoe UI, Liberation Sans, Arial, Helvetica, sans-serif"

# Farger: blå = Azure-ressurser vi eier, grå = tjenester utenfor, rødt =
# problem, grønt = løst, gult = gjenstår.
F = {
    'tekst': '#1F2933', 'dempet': '#52606D', 'linje': '#7B8794',
    'azure': '#E6F0FA', 'azureKant': '#2B6CB0', 'indre': '#FFFFFF',
    'ute': '#F2F4F7', 'uteKant': '#9AA5B1',
    'rod': '#C53030', 'rodLys': '#FDECEC',
    'gronn': '#2F855A', 'gronnLys': '#E7F6EC',
    'gul': '#B7791F', 'gulLys': '#FDF5E1',
    'bakgrunn': '#FFFFFF',
}


def t(x, y, s, size=16, vekt='normal', farge=None, anker='start', stil=''):
    return (f'<text x="{x}" y="{y}" font-family="{FONT}" font-size="{size}" '
            f'font-weight="{vekt}" fill="{farge or F["tekst"]}" text-anchor="{anker}"'
            f'{(" font-style=" + chr(34) + stil + chr(34)) if stil else ""}>{escape(s)}</text>')


def boks(x, y, w, h, tittel, linjer=(), fyll=None, kant=None, tittelStr=19,
         tekstStr=15, kantBredde=1.5, strek=None, tittelFarge=None):
    d = (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fyll or F["indre"]}" '
         f'stroke="{kant or F["linje"]}" stroke-width="{kantBredde}"'
         f'{(" stroke-dasharray=" + chr(34) + strek + chr(34)) if strek else ""}/>')
    d += t(x + 14, y + 28, tittel, tittelStr, 'bold', tittelFarge)
    for i, l in enumerate(linjer):
        farge = F['dempet']
        if isinstance(l, tuple):
            l, farge = l
        d += t(x + 14, y + 52 + i * (tekstStr + 6), l, tekstStr, farge=farge)
    return d


def pil(punkter, etikett=None, ePos=None, farge=None, strek=None, bredde=2,
        eAnker='middle', eStr=14, toVeis=False):
    farge = farge or F['linje']
    p = ' '.join(f'{x},{y}' for x, y in punkter)
    mid = 'url(#pil-' + farge.strip('#') + ')'
    d = (f'<polyline points="{p}" fill="none" stroke="{farge}" stroke-width="{bredde}" '
         f'marker-end="{mid}"' + (f' marker-start="{mid}"' if toVeis else '')
         + (f' stroke-dasharray="{strek}"' if strek else '') + '/>')
    if etikett:
        ex, ey = ePos
        for i, linje in enumerate(etikett.split('\n')):
            d += t(ex, ey + i * (eStr + 3), linje, eStr, farge=farge if farge != F['linje'] else F['dempet'],
                   anker=eAnker, vekt='600')
    return d


def defs():
    d = '<defs>'
    for farge in {F['linje'], F['rod'], F['gronn'], F['gul'], F['azureKant']}:
        n = farge.strip('#')
        d += (f'<marker id="pil-{n}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" '
              f'markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{farge}"/></marker>')
    d += '</defs>'
    return d


def tittel(hoved, under):
    return (t(50, 72, hoved, 38, 'bold') + t(50, 110, under, 20, farge=F['dempet']))


def fot(tekst):
    return t(B - 50, H - 22, tekst, 13, farge=F['linje'], anker='end')


# ---------------------------------------------------------------------------
# Felles venstre- og høyrekolonne
# ---------------------------------------------------------------------------

# Høyrekolonnen starter ved X: gapet mellom SWA og kolonnen bærer etikettene
# på pilene, og må være bredt nok til dem.
X, W = 1320, 560
CX0, CX1 = 400, 1090            # containerne (SWA, Function App)
IX0, IX1 = 430, 1060            # boksene inni dem


def brukere():
    return (boks(40, 170, 300, 260, 'Brukere', (), fyll=F['ute'], kant=F['uteKant'])
            + boks(58, 215, 264, 92, 'Intern bruker', ('Entra ID-pålogging', '(ansatte, studenter)'))
            + boks(58, 320, 264, 92, 'Ekstern innsender', ('engangskode (OTP) på e-post', 'eller signert lenke')))


def eksterne(v3):
    fs = 'passord via Key Vault-referanse' if v3 else 'brukernavn + passord'
    graph = 'sertifikat i Key Vault' if v3 else 'klienthemmelighet'
    ant = 'nøkkel via Key Vault-referanse' if v3 else 'API-nøkkel'
    return boks(X, 605, W, 200, 'Tjenester utenfor løsningen', (
        f'FS API (studentdata) — {fs}',
        f'Graph/SharePoint (backup) — {graph}',
        'Bring (postnumre) — åpent API',
        f'Anthropic (skjematolk) — {ant}',
    ), fyll=F['ute'], kant=F['uteKant'], tekstStr=15)


def lagring(v3):
    linjer = ['Table Storage (20 tabeller)', 'Blob Storage (vedlegg,', 'backup, arkiv)']
    return boks(40, 760, 300, 200, 'Datalagring', linjer + (
        [('nås med identitet + roller', F['gronn'])] if v3 else [('nås med kontonøkkel', F['rod'])]),
        fyll=F['azure'], kant=F['azureKant'])


def keyvault(v3):
    linjer = (['Kilden for alle hemmeligheter', 'Auth- og backup-sertifikat']
              if v3 else ['Arkiv/kopi av hemmelighetene', 'Auth-sertifikatet (innlogging)'])
    return boks(X, 150, W, 120, 'Azure Key Vault (fhs-kv-01)', linjer, fyll=F['azure'], kant=F['azureKant'])


def flyter(v3):
    linjer = ['6 flyter: e-post, Teams, Planner,', 'SharePoint-liste, team-oppslag,', 'backup-kvittering']
    linjer.append(('Utløses bare av tillatte identiteter (Entra)', F['gronn']) if v3
                  else ('Utløses av alle som har URL-en (sig=)', F['rod']))
    return boks(X, 300, W, 280, 'Power Automate', linjer, fyll=F['ute'], kant=F['uteKant'])


def innsikt(v3):
    return boks(X, 830, W, 130, 'Application Insights',
                ['Logging og feilsøking',
                 ('+ Log stream på Function App-en', F['gronn']) if v3 else ('Ingen Log stream (SWA Managed Functions)', F['dempet'])],
                fyll=F['ute'], kant=F['uteKant'])


# ---------------------------------------------------------------------------
# Versjon 2
# ---------------------------------------------------------------------------

def tegning_v2():
    d = brukere()
    d += boks(40, 470, 300, 220, 'GitHub Actions', (
        'Deploy av frontend og API', '8 jobber på klokke kaller', 'API-et over Internett',
        ('med delt nøkkel i header', F['rod'])), fyll=F['ute'], kant=F['uteKant'])
    d += lagring(False)

    d += boks(CX0, 150, CX1 - CX0, 640, 'Azure Static Web Apps (SWA) — én ressurs', (), fyll=F['azure'],
              kant=F['azureKant'], kantBredde=2.5, tittelStr=21)
    d += boks(IX0, 195, 305, 105, 'Statiske sider', ('13 HTML-sider via CDN', 'intet byggsteg'))
    d += boks(755, 195, IX1 - 755, 105, 'Innlogging (/.auth)', ('Entra ID, låst til FHS', 'sertifikat fra Key Vault'))
    d += boks(IX0, 325, IX1 - IX0, 72, 'Ruteregler for /api/*', ('hvem slipper fram: anonym, innlogget eller admin',))
    d += boks(IX0, 420, IX1 - IX0, 180, 'API — SWA Managed Functions', (
        'Azure Functions v4, Node 22, bare HTTP-triggere',
        'Vakt i hver handler: rolle, eier, innsender, token',
        ('Koden får ingen managed identity', F['rod']),
        ('Plattformen løser ikke Key Vault-referanser', F['rod'])))
    d += boks(IX0, 625, IX1 - IX0, 145, 'App settings (Configuration)', (
        ('Alle hemmeligheter i klartekst:', F['rod']),
        'STORAGE_CONNECTION_STRING · flyt-URL-er med sig=',
        'OTP_HMAC_KEY · HASH_SALT · BACKUP_PASSPHRASE · FS_API_PASSWORD',
        'SCHEDULER_KEY · FLOW_CALLBACK_KEY · Graph · ANTHROPIC_API_KEY'), tekstStr=14, kant=F['rod'])

    d += keyvault(False) + flyter(False) + eksterne(False) + innsikt(False)

    d += pil([(340, 300), (428, 300)], 'HTTPS', (370, 290), eStr=13)
    d += pil([(340, 520), (375, 520), (375, 361), (428, 361)], None, None, farge=F['rod'])
    d += pil([(430, 560), (392, 560), (392, 850), (342, 850)], 'kontonøkkel', (392, 875), farge=F['rod'])
    d += pil([(X, 240), (IX1 + 2, 240)], 'auth-sertifikat', (1190, 230), eStr=13)
    d += pil([(X, 262), (1300, 262), (1300, 740), (IX1 + 2, 740)], 'kopieres inn\nfor hånd', (1180, 762),
             strek='6 5', eStr=13)
    d += pil([(IX1, 460), (X - 2, 460)], 'kall: URL med sig=', (1180, 450), farge=F['rod'], eStr=13)
    d += pil([(X - 2, 530), (IX1 + 2, 530)], 'tilbakekall: x-flow-key', (1180, 555), farge=F['rod'], eStr=13)
    d += pil([(IX1, 590), (1150, 590), (1150, 700), (X - 2, 700)], 'utgående HTTPS', (1225, 690), eStr=13)
    d += pil([(CX1, 790), (X - 2, 880)], None, None, strek='4 4')
    return d


# ---------------------------------------------------------------------------
# Versjon 3
# ---------------------------------------------------------------------------

def tegning_v3():
    d = brukere()
    d += boks(40, 470, 300, 220, 'GitHub Actions', (
        'Bare deploy:', 'frontend til SWA,', 'API til Function App',
        ('godkjenning kreves for prod', F['gronn'])), fyll=F['ute'], kant=F['uteKant'])
    d += lagring(True)

    d += boks(CX0, 150, CX1 - CX0, 260, 'Azure Static Web Apps (SWA) — frontend', (), fyll=F['azure'],
              kant=F['azureKant'], kantBredde=2.5, tittelStr=21)
    d += boks(IX0, 195, 305, 95, 'Statiske sider', ('13 HTML-sider via CDN',))
    d += boks(755, 195, IX1 - 755, 95, 'Innlogging (/.auth)', ('Entra ID, sertifikat fra KV',))
    d += boks(IX0, 305, IX1 - IX0, 88, 'Ruteregler for /api/*', ('samme regler som før — videresendes til', 'lenket backend (Function App)'))

    d += boks(CX0, 455, CX1 - CX0, 335, 'Azure Function App (API)', (), fyll=F['azure'],
              kant=F['azureKant'], kantBredde=2.5, tittelStr=21)
    d += boks(IX0, 497, IX1 - IX0, 103, 'API — samme kode som v2', (
        'Azure Functions v4, Node 22, HTTP-triggere',
        ('+ 9 jobber på timer i appen selv', F['gronn'])))
    d += boks(IX0, 612, IX1 - IX0, 70, 'Managed identity (user-assigned)', (
        ('lagring, Key Vault og flyter — uten nøkkel', F['gronn']),), kant=F['gronn'])
    d += boks(IX0, 694, IX1 - IX0, 80, 'App settings', (
        ('Bare Key Vault-referanser: @Microsoft.KeyVault(…)', F['gronn']),
        'og ikke-hemmelige verdier (MILJO, FLYT_AUTH=entra …)'), kant=F['gronn'], tekstStr=14)

    d += keyvault(True) + flyter(True) + eksterne(True) + innsikt(True)

    d += pil([(340, 300), (428, 300)], 'HTTPS', (370, 290), eStr=13)
    d += pil([(745, 393), (745, 453)], 'lenket backend', (757, 437), eAnker='start', eStr=13)
    d += pil([(340, 580), (398, 580)], 'deploy', (369, 570), eStr=13)
    d += pil([(430, 647), (392, 647), (392, 850), (342, 850)], 'identitet +\nRBAC-roller', (392, 875), farge=F['gronn'])
    d += pil([(X, 240), (IX1 + 2, 240)], 'auth-sertifikat', (1190, 230), eStr=13)
    d += pil([(X, 262), (1300, 262), (1300, 734), (IX1 + 2, 734)], 'referanser løses\nav plattformen', (1180, 756),
             farge=F['gronn'], eStr=13)
    d += pil([(IX1, 515), (X - 2, 515)], 'kall: Entra-token', (1180, 505), farge=F['gronn'], eStr=13)
    d += pil([(X - 2, 565), (IX1 + 2, 565)], 'tilbakekall: x-flow-key', (1180, 590), farge=F['gul'], eStr=13)
    d += pil([(IX1, 595), (1150, 595), (1150, 700), (X - 2, 700)], 'utgående HTTPS', (1225, 690), eStr=13)
    d += pil([(CX1, 790), (X - 2, 880)], None, None, strek='4 4')
    return d


# ---------------------------------------------------------------------------
# Markører og forklaringer
# ---------------------------------------------------------------------------

# (x, y) i tegningens koordinater. Samme NUMMER betyr samme sak i begge
# versjoner, men markøren står der saken er i hver tegning: problemet i v2,
# løsningen i v3.
MARKORER_V2 = {
    1: (IX1, 625), 2: (392, 720), 3: (IX1, 420), 4: (CX1, 460),
    5: (375, 440), 6: (CX1, 530), 7: (X + W, 840), 8: (1300, 330),
}
MARKORER_V3 = {
    1: (IX1, 700), 2: (392, 750), 3: (IX1, 615), 4: (CX1, 515),
    5: (790, 557), 6: (CX1, 565), 7: (X + W, 840), 8: (1300, 330),
}

PROBLEMER = [
    (1, 'Hemmeligheter i klartekst', 'Alle hemmeligheter står i SWA-ens app settings. Plattformen løser ikke Key Vault-referanser.'),
    (2, 'Lagring med kontonøkkel', 'Tilkoblingsstrengen gir alt — også krypteringsnøklene. Den mest verdifulle enkeltverdien.'),
    (3, 'Ingen identitet for koden', 'SWA Managed Functions gir ikke koden en managed identity.'),
    (4, 'Flyt-URL-er er hemmeligheter', 'sig= i adressen er hele adgangen. Den som har URL-en, kan utløse flyten.'),
    (5, 'Jobber utløses utenfra', '8 jobber i GitHub Actions kaller anonyme endepunkter med delt nøkkel.'),
    (6, 'Én nøkkel, fem inngangspunkter', 'FLOW_CALLBACK_KEY deles med skjemaeiere og åpner også utsending og teamcache.'),
    (7, 'Begrenset feilsøking', 'Ingen Log stream — bare Application Insights i etterkant.'),
    (8, 'To kopier av hver hemmelighet', 'Key Vault er bare arkiv. Rotasjon = lim inn for hånd, og kopiene kan drive.'),
]

LOSNINGER = [
    (1, 'gronn', 'Hemmelighetene bor i Key Vault', 'App settings har bare referanser, og plattformen løser dem ved oppstart.'),
    (2, 'gronn', 'Lagring uten nøkkel', 'Identitet + tre RBAC-roller. Backup-lenker signeres med delegeringsnøkkel.'),
    (3, 'gronn', 'Egen managed identity', 'User-assigned: overlever at Function App-en bygges på nytt.'),
    (4, 'gronn', 'Flyter krever Entra', 'Kall med token fra identiteten, ingen sig=. Tilgang trekkes ved å fjerne én oid.'),
    (5, 'gronn', 'Jobbene kjører i appen', '9 timere i Function App-en. GitHub kaller ikke prod; den delte nøkkelen brukes ikke av noen jobb.'),
    (6, 'gul', 'Gjenstår: tilbakekall fra flyter', 'FLOW_CALLBACK_KEY er nå i Key Vault, men fortsatt én delt nøkkel. Egen beslutning.'),
    (7, 'gronn', 'Log stream og vanlig drift', 'Ordinær Function App: Log stream, metrikker, egen plan.'),
    (8, 'gronn', 'Én kilde', 'Key Vault er kilden. Rotasjon = ny versjon i vaulten, ingen innliming.'),
]


def markor(n, x, y, farge, symbol=None):
    return (f'<circle cx="{x}" cy="{y}" r="22" fill="{farge}" stroke="#FFFFFF" stroke-width="3"/>'
            + t(x, y + 9, symbol or str(n), 24, 'bold', '#FFFFFF', 'middle'))


def forklaring(x, y, w, n, farge, lys, overskrift, tekst):
    # Enkel ombrekking på ord, for 17 px-tekst i boksbredden.
    maks = int((w - 80) / 8.6)
    linjer, linje = [], ''
    for ord_ in tekst.split():
        if len(linje) + len(ord_) + 1 > maks:
            linjer.append(linje)
            linje = ord_
        else:
            linje = (linje + ' ' + ord_).strip()
    linjer.append(linje)
    hoyde = 40 + len(linjer) * 22
    d = f'<rect x="{x}" y="{y}" width="{w}" height="{hoyde}" rx="8" fill="{lys}"/>'
    d += f'<circle cx="{x + 26}" cy="{y + 26}" r="16" fill="{farge}"/>' + t(x + 26, y + 33, str(n), 18, 'bold', '#FFFFFF', 'middle')
    d += t(x + 54, y + 32, overskrift, 19, 'bold', farge)
    for i, l in enumerate(linjer):
        d += t(x + 54, y + 56 + i * 22, l, 16, farge=F['tekst'])
    return d, hoyde


def svg(innhold):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{B}" height="{H}" viewBox="0 0 {B} {H}">'
            f'{defs()}<rect width="{B}" height="{H}" fill="{F["bakgrunn"]}"/>{innhold}</svg>\n')


SKALA = 0.64


def dempet(tegning):
    """Tegningen nedskalert og dempet, med plass til forklaringene til høyre."""
    ty = 135 - 150 * SKALA
    return (f'<g transform="translate(10,{ty:.1f}) scale({SKALA})"><g opacity="0.45">{tegning}</g>'), ty


def lag_1():
    return svg(tittel('Versjon 2 — komponenter og samhandling',
                      'Ett Azure-produkt bærer alt: Static Web Apps med innebygd API (SWA Managed Functions)')
               + tegning_v2() + fot('Kilde: docs/SIKKERHET-OG-ARKITEKTUR.md, kap. 2–4 og 7'))


def lag_3():
    return svg(tittel('Versjon 3 — komponenter og samhandling',
                      'Frontend og innlogging blir på SWA; API-et flyttes til en egen Function App med egen identitet')
               + tegning_v3() + fot('Kilde: docs/BESLUTNING-EGEN-FUNCTION-APP.md og docs/KOKEBOK-PROD-V3.md'))


def lag_med_markorer(tegning, markorer, poster, hoved, under, kilde, nederst):
    g, _ = dempet(tegning)
    for n, (x, y) in markorer.items():
        farge = F['rod']
        symbol = None
        for post in poster:
            if post[0] == n and len(post) == 4:
                farge = F[post[1]]
        g += markor(n, x, y, farge, symbol)
    g += '</g>'
    d = tittel(hoved, under) + g
    # Forklaringene i høyre kolonne
    x, y, w = 1260, 140, 620
    for post in poster:
        if len(post) == 4:
            n, fn, o, tx = post
            farge, lys = F[fn], F[fn + 'Lys']
        else:
            n, o, tx = post
            farge, lys = F['rod'], F['rodLys']
        bit, h = forklaring(x, y, w, n, farge, lys, o, tx)
        d += bit
        y += h + 8
    # Nederst til venstre, under tegningen
    d += nederst
    d += fot(kilde)
    return svg(d)


def lag_2():
    nederst = (f'<rect x="40" y="720" width="1180" height="300" rx="10" fill="{F["rodLys"]}"/>'
               + t(64, 760, 'Rotårsaken er plattformvalget, ikke koden', 24, 'bold', F['rod'])
               + t(64, 796, 'SWA Managed Functions verken gir koden en managed identity eller løser Key Vault-referanser.', 18)
               + t(64, 822, 'Det er fastslått ved forsøk i pilot 12.10.2026, ikke antatt. Alle punktene unntatt 6 følger av det.', 18)
               + t(64, 862, 'Det som demper risikoen i v2:', 18, 'bold')
               + t(84, 890, '• Å lese app settings er en privilegert operasjon — en ren Reader får dem ikke', 17)
               + t(84, 916, '• Appen viser aldri verdiene selv: /api/system/info oppgir bare lengde og vertsnavn', 17)
               + t(84, 942, '• Branch protection, signerte commits og godkjenning før prod-deploy', 17)
               + t(84, 968, '• Svarene kan krypteres per skjematype, og backup krypteres før opplasting', 17))
    return lag_med_markorer(tegning_v2(), MARKORER_V2, PROBLEMER,
                            'Versjon 2 — sikkerhetsutfordringene',
                            'Nummerert på tegningen fra forrige bilde',
                            'Kilde: docs/SIKKERHET-OG-ARKITEKTUR.md, kap. 7.1–7.3, 8 og 9', nederst)


def lag_4():
    nederst = (f'<rect x="40" y="720" width="1180" height="300" rx="10" fill="{F["gulLys"]}"/>'
               + t(64, 760, 'Det v3 ikke løser — og som står på lista', 24, 'bold', F['gul'])
               + t(84, 796, '• Tilbakekall fra flyter (6): én delt nøkkel. Forslag: egen nøkkel per steg, eller signert engangstoken', 17)
               + t(84, 824, '• «Lenker som er hemmeligheter»: Power BI-feed og utsendingslenker gir tilgang til den som har dem', 17)
               + t(84, 852, '• Arkiv-JSON er klartekst med vilje — tilgangen til arkivet er hele vernet', 17)
               + t(84, 880, '• Datakontoen deles med v2 til den er revet; kontonøkkelen kan slås av først da', 17)
               + t(84, 908, '• Funn 09.11.2026: anonym skjemaside kan vise persondata fra nedtrekk (FORSLAG-MASTERDATA, steg 0)', 17)
               + t(64, 950, 'Samme kode i begge versjoner: koden velger vei etter konfigurasjon.', 18, 'bold')
               + t(64, 976, 'Forbedringene er i vertsmodellen og i oppsettet — de er målt i dev før de ble tatt i bruk i prod.', 17))
    return lag_med_markorer(tegning_v3(), MARKORER_V3, LOSNINGER,
                            'Versjon 3 — slik er utfordringene løst',
                            'Samme numre som forrige bilde — grønt er løst, gult gjenstår',
                            'Kilde: docs/BESLUTNING-EGEN-FUNCTION-APP.md (8e–8m) og docs/SIKKERHET-OG-ARKITEKTUR.md kap. 9', nederst)


def main():
    ut = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'docs', 'illustrasjoner')
    os.makedirs(ut, exist_ok=True)
    for navn, lag in [('1-v2-komponenter', lag_1), ('2-v2-sikkerhet', lag_2),
                      ('3-v3-komponenter', lag_3), ('4-v3-losninger', lag_4)]:
        with open(os.path.join(ut, navn + '.svg'), 'w', encoding='utf-8') as f:
            f.write(lag())
        print('skrev', os.path.join(ut, navn + '.svg'))


if __name__ == '__main__':
    main()
