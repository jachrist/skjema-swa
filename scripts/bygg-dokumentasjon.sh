#!/usr/bin/env bash
#
# Bygger dokumentasjonen fra docs/*.md — én kilde, to utganger.
#
#   docs/*.md ──┬──► MkDocs Material ──► frontend/dokumentasjon/   (SWA, bak Entra)
#               └──► pandoc + Chromium ──► .../pdf/*.pdf           (overleveres)
#
# PDF-en vedlikeholdes ALDRI for seg. To kopier av samme innhold svarer ulikt
# innen et kvartal; det har skjedd i dette repoet flere ganger. Derfor leser
# begge utgangene de samme filene, i samme kjøring.
#
# Kjøres av CI (ci.yml, med --strict) og av deploy-jobbene (uten). Lokalt:
#
#   scripts/bygg-dokumentasjon.sh            # bygg
#   scripts/bygg-dokumentasjon.sh --strict   # som CI: advarsler blir feil
#   scripts/bygg-dokumentasjon.sh --uten-pdf # bare nettsidene
#
# VERSJONENE ER PINNET. Material for MkDocs varsler selv at MkDocs 2.0 fjerner
# plugin-systemet uten migreringsvei. En flytende versjon ville tatt ned
# deployen den dagen 2.0 slippes, uten at noe i dette repoet var endret.
set -euo pipefail

MKDOCS_VERSJON="mkdocs==1.6.1"
MATERIAL_VERSJON="mkdocs-material==9.7.7"
PYMDOWN_VERSJON="pymdown-extensions==12.3"

# Dokumentene som skal bli PDF. Overleveringsdokumentet, og API-oversikten —
# en evaluator spør «hva er eksponert, og hvem slipper til», og det svaret må
# være komplett, ikke representativt.
PDF_DOKUMENTER=(SIKKERHET-OG-ARKITEKTUR API-OVERSIKT)

STRICT=""
MED_PDF=1
for arg in "$@"; do
    case "$arg" in
        --strict) STRICT="--strict" ;;
        --uten-pdf) MED_PDF=0 ;;
        *) echo "Ukjent flagg: $arg" >&2; exit 2 ;;
    esac
done

ROT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROT"
UT="frontend/dokumentasjon"

# ---------------------------------------------------------------- MkDocs
if ! command -v mkdocs >/dev/null 2>&1; then
    echo "── Installerer MkDocs (pinnet)"
    python3 -m pip install --quiet --disable-pip-version-check \
        "$MKDOCS_VERSJON" "$MATERIAL_VERSJON" "$PYMDOWN_VERSJON"
fi

echo "── Bygger nettsidene${STRICT:+ (strict)}"
# Material skriver et varsel om MkDocs 2.0 på stderr ved hver kjøring. Det er
# verdt å lese én gang, ikke i hver logg — men det filtreres IKKE bort her,
# for en skjult advarsel er en advarsel ingen ser.
mkdocs build $STRICT

# ------------------------------------------------------------------- PDF
if [ "$MED_PDF" -eq 1 ]; then
    if ! command -v pandoc >/dev/null 2>&1; then
        echo "::warning::pandoc mangler — hopper over PDF-ene" >&2
        exit 0
    fi

    # Nettleseren finnes under ulike navn på ulike verter: GitHub-runnerne har
    # google-chrome, dette bildet har Playwright sin Chromium. Første treff
    # vinner, og hvis ingen finnes sies det — en PDF som stille ikke ble laget
    # er en PDF noen tror finnes.
    NETTLESER=""
    for kandidat in \
        /opt/pw-browsers/chromium-*/chrome-linux/chrome \
        "$(command -v google-chrome || true)" \
        "$(command -v chromium || true)" \
        "$(command -v chromium-browser || true)"
    do
        if [ -n "$kandidat" ] && [ -x "$kandidat" ]; then NETTLESER="$kandidat"; break; fi
    done
    if [ -z "$NETTLESER" ]; then
        echo "::warning::fant ingen Chromium/Chrome — hopper over PDF-ene" >&2
        exit 0
    fi

    SHA="$(git rev-parse --short HEAD 2>/dev/null || echo 'ukjent')"
    DATO="$(date -u +%d.%m.%Y)"
    mkdir -p "$UT/pdf"

    for navn in "${PDF_DOKUMENTER[@]}"; do
        kilde="docs/$navn.md"
        if [ ! -f "$kilde" ]; then
            echo "::warning::$kilde finnes ikke — hopper over" >&2
            continue
        fi
        echo "── PDF: $navn"
        tmp="$(mktemp -d)"
        # Undertittelen bærer dato og commit. Et overlevert dokument uten dem
        # kan ikke etterprøves: «hvilken versjon så evaluatoren?» har ingen
        # annen kilde enn fila selv.
        pandoc --from=gfm --to=html5 --standalone \
            --metadata title="$navn" \
            --metadata subtitle="FHS Skjema | bygget $DATO | commit $SHA" \
            --css "$ROT/scripts/dokumentasjon-pdf.css" \
            --embed-resources \
            "$kilde" -o "$tmp/ut.html"
        "$NETTLESER" --headless --no-sandbox --disable-gpu \
            --print-to-pdf="$UT/pdf/$navn.pdf" --no-pdf-header-footer \
            "file://$tmp/ut.html" 2>/dev/null
        rm -rf "$tmp"
    done
fi

echo "── Ferdig: $UT ($(find "$UT" -type f | wc -l) filer, $(du -sh "$UT" | cut -f1))"
