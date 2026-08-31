#!/usr/bin/env bash
#
# Oppretter app-registreringene som trengs for å erstatte Power Automate-flytene
# med direkte Graph-kall, og gir dem rettighetene de skal ha — ikke mer.
#
# Tre apper, delt etter skadeomfang. Grunnen til å ikke slå dem sammen er
# Mail.Send: evnen til å sende e-post skal ikke ligge i samme hemmelighet som
# noe annet. Grunnen til å ikke splitte mer er at hver app er en hemmelighet
# som skal roteres, overvåkes og inn i nøkkelkalenderen.
#
#   fhs-skjema-lagring    Sites.Selected                       (backup — finnes trolig alt)
#   fhs-skjema-utgaende   Mail.Send [, Tasks.ReadWrite.All]    (e-post, evt. Planner)
#   fhs-skjema-oppslag    Group.Read.All, User.Read.All,
#                         TeamMember.Read.All                  (rene lesekall)
#
# Rolle-ID-ene slås opp fra Graph ved kjøring i stedet for å hardkodes. Da
# feiler skriptet tydelig hvis en tillatelse ikke finnes som APPLIKASJONSrolle
# — som er nøyaktig spørsmålet rundt Teams og Planner.
#
# Bruk:
#   ./opprett-graph-apper.sh --sjekk                  # bare: finnes tillatelsene?
#   ./opprett-graph-apper.sh --torrkjor --site <url>  # vis hva som ville skjedd
#   ./opprett-graph-apper.sh --site <url>             # opprett og gi rettigheter
#   ./opprett-graph-apper.sh --site <url> --ny-hemmelighet
#
# Kjøres i Azure Cloud Shell (az er ferdig innlogget) eller lokalt med az CLI.
# Krever en bruker som kan opprette app-registreringer OG gi administrator-
# samtykke — i praksis Global Administrator eller Privileged Role Administrator.
#
# Skriptet er idempotent: kjør det om igjen uten å lage duplikater. Unntaket er
# --ny-hemmelighet, som alltid lager en ny (gamle blir stående til de utløper).
#
# DET SKRIPTET IKKE GJØR:
#   Låser Mail.Send til én postkasse. Uten det kan appen sende som hvem som
#   helst i tenanten. Det gjøres i Exchange Online PowerShell, se utskriften
#   til slutt.

set -euo pipefail

GRAPH_APP_ID="00000003-0000-0000-c000-000000000000"
PREFIKS="fhs-skjema"
SITE=""
TORRKJOR=0
NY_HEMMELIGHET=0
KUN_SJEKK=0
MED_PLANNER=0
HEMMELIGHET_AAR=1

while [ $# -gt 0 ]; do
    case "$1" in
        --site)            SITE="${2:-}"; shift 2 ;;
        --prefiks)         PREFIKS="${2:-}"; shift 2 ;;
        --hemmelighet-aar) HEMMELIGHET_AAR="${2:-}"; shift 2 ;;
        --torrkjor)        TORRKJOR=1; shift ;;
        --ny-hemmelighet)  NY_HEMMELIGHET=1; shift ;;
        --sjekk)           KUN_SJEKK=1; shift ;;
        --med-planner)     MED_PLANNER=1; shift ;;
        -h|--help)         sed -n '2,40p' "$0"; exit 0 ;;
        *) echo "Ukjent flagg: $1" >&2; exit 1 ;;
    esac
done

# ---------- utskrift ----------
gronn()  { printf '\033[32m%s\033[0m\n' "$*"; }
gul()    { printf '\033[33m%s\033[0m\n' "$*"; }
rod()    { printf '\033[31m%s\033[0m\n' "$*"; }
tittel() {
    local strek="" i
    for ((i = ${#1}; i < 58; i++)); do strek="$strek─"; done
    printf '\n\033[1m── %s %s\033[0m\n' "$1" "$strek"
}

gjor() {
    # Alt som endrer noe går gjennom denne, slik at --torrkjor faktisk dekker alt.
    if [ "$TORRKJOR" = "1" ]; then
        gul "  [tørrkjøring] $*"
        return 0
    fi
    "$@"
}

# ---------- forutsetninger ----------
command -v az >/dev/null 2>&1 || { rod "az CLI mangler. Kjør i Azure Cloud Shell, eller installer az."; exit 1; }
KONTO=$(az account show --query "{bruker:user.name, tenant:tenantId}" -o tsv 2>/dev/null) || {
    rod "Ikke innlogget. Kjør: az login --allow-no-subscriptions"; exit 1;
}
BRUKER=$(echo "$KONTO" | cut -f1)
TENANT=$(echo "$KONTO" | cut -f2)
tittel "Tenant"
echo "  Innlogget som : $BRUKER"
echo "  Tenant        : $TENANT"
[ "$TORRKJOR" = "1" ] && gul "  TØRRKJØRING — ingenting endres"

# Graph sin egen tjenestehovedstol. Rollene ligger på den.
GRAPH_SP_ID=$(az ad sp show --id "$GRAPH_APP_ID" --query id -o tsv)

# ---------- tillatelser ----------
# Slår opp app-rollen på navn. Finnes den ikke som applikasjonsrolle, sier vi
# fra med én gang — det er svaret på om Teams/Planner i det hele tatt lar seg
# gjøre app-only, og det er billigere å oppdage her enn i kode.
rolle_id() {
    local navn="$1"
    az ad sp show --id "$GRAPH_APP_ID" \
        --query "appRoles[?value=='$navn' && contains(allowedMemberTypes, 'Application')].id | [0]" -o tsv 2>/dev/null
}

sjekk_tillatelser() {
    tittel "Tillatelser som applikasjonsroller"
    local navn id
    # De tre siste er ikke i bruk ennå — de står her fordi det er dem du skal
    # verifisere før Teams- og Planner-varsling kan flyttes ut av PA.
    for navn in Mail.Send Sites.Selected Group.Read.All User.Read.All \
                TeamMember.Read.All Tasks.ReadWrite.All \
                ChannelMessage.Send ChatMessage.Send Teamwork.Migrate.All; do
        id=$(rolle_id "$navn" || true)
        if [ -n "$id" ] && [ "$id" != "null" ]; then
            printf '  %-24s ' "$navn"; gronn "finnes  ($id)"
        else
            printf '  %-24s ' "$navn"; rod "IKKE tilgjengelig app-only"
        fi
    done
    echo
    echo "  «IKKE tilgjengelig app-only» betyr at funksjonen må bli i Power Automate,"
    echo "  eller løses med delegert tilgang. Det gjelder typisk Teams-meldinger."
}

if [ "$KUN_SJEKK" = "1" ]; then
    sjekk_tillatelser
    exit 0
fi

[ -n "$SITE" ] || { rod "--site mangler. Oppgi SharePoint-området, f.eks. https://fhs.sharepoint.com/sites/Skjemasystem"; exit 1; }

# ---------- app-registrering ----------
finn_app() {
    az ad app list --display-name "$1" --query "[?displayName=='$1'].appId | [0]" -o tsv 2>/dev/null
}

sikre_app() {
    local navn="$1" appid
    appid=$(finn_app "$navn" || true)
    if [ -n "$appid" ] && [ "$appid" != "null" ]; then
        echo "  Finnes fra før: $navn ($appid)" >&2
        echo "$appid"
        return
    fi
    if [ "$TORRKJOR" = "1" ]; then
        gul "  [tørrkjøring] ville opprettet app-registreringen $navn" >&2
        echo "00000000-0000-0000-0000-000000000000"
        return
    fi
    appid=$(az ad app create --display-name "$navn" --sign-in-audience AzureADMyOrg --query appId -o tsv)
    echo "  Opprettet: $navn ($appid)" >&2
    echo "$appid"
}

sikre_sp() {
    local appid="$1" spid
    spid=$(az ad sp list --filter "appId eq '$appid'" --query "[0].id" -o tsv 2>/dev/null || true)
    if [ -z "$spid" ] || [ "$spid" = "null" ]; then
        if [ "$TORRKJOR" = "1" ]; then
            gul "  [tørrkjøring] ville opprettet tjenestehovedstol for $appid" >&2
            echo "00000000-0000-0000-0000-000000000000"; return
        fi
        spid=$(az ad sp create --id "$appid" --query id -o tsv)
    fi
    echo "$spid"
}

# Selve samtykket. En appRoleAssignment ER administratorsamtykke for en
# applikasjonstillatelse — det finnes ingen ekstra knapp å trykke på etterpå.
sikre_rolle() {
    local spid="$1" rollenavn="$2" rolleid finnes
    rolleid=$(rolle_id "$rollenavn" || true)
    if [ -z "$rolleid" ] || [ "$rolleid" = "null" ]; then
        rod "  $rollenavn finnes ikke som applikasjonsrolle — hoppes over"
        return 0
    fi
    if [ "$TORRKJOR" = "0" ]; then
        finnes=$(az rest --method GET \
            --url "https://graph.microsoft.com/v1.0/servicePrincipals/$spid/appRoleAssignments" \
            --query "value[?appRoleId=='$rolleid'] | [0].id" -o tsv 2>/dev/null || true)
        if [ -n "$finnes" ] && [ "$finnes" != "null" ]; then
            echo "  $rollenavn — allerede gitt"
            return 0
        fi
    fi
    gjor az rest --method POST \
        --url "https://graph.microsoft.com/v1.0/servicePrincipals/$spid/appRoleAssignments" \
        --headers "Content-Type=application/json" \
        --body "{\"principalId\":\"$spid\",\"resourceId\":\"$GRAPH_SP_ID\",\"appRoleId\":\"$rolleid\"}" \
        >/dev/null
    gronn "  $rollenavn — gitt"
}

# Deklarasjonen på selve app-objektet. Gir ingen tilgang i seg selv, men er det
# som vises under «API permissions» i portalen. Uten den ser appen tom ut for
# den som reviderer den senere.
deklarer_tillatelser() {
    local appid="$1"; shift
    local roller=() navn id
    for navn in "$@"; do
        id=$(rolle_id "$navn" || true)
        [ -n "$id" ] && [ "$id" != "null" ] && roller+=("{\"id\":\"$id\",\"type\":\"Role\"}")
    done
    [ ${#roller[@]} -eq 0 ] && return 0
    local liste
    liste=$(IFS=,; echo "${roller[*]}")
    gjor az ad app update --id "$appid" \
        --required-resource-accesses "[{\"resourceAppId\":\"$GRAPH_APP_ID\",\"resourceAccess\":[$liste]}]" \
        >/dev/null
}

# Sites.Selected gir ingen tilgang før appen får skriverett på et bestemt
# område. Det er dette steget folk hopper over og lurer på hvorfor de får 403.
sikre_site_tilgang() {
    local appid="$1" navn="$2" ref siteid finnes
    ref=$(echo "$SITE" | sed -E 's#^https?://##; s#/$##; s#/#:/#')
    siteid=$(az rest --method GET --url "https://graph.microsoft.com/v1.0/sites/$ref" --query id -o tsv 2>/dev/null || true)
    if [ -z "$siteid" ] || [ "$siteid" = "null" ]; then
        rod "  Fant ikke SharePoint-området «$SITE» — sjekk adressen"
        return 1
    fi
    echo "  Område: $siteid"
    if [ "$TORRKJOR" = "0" ]; then
        finnes=$(az rest --method GET --url "https://graph.microsoft.com/v1.0/sites/$siteid/permissions" \
            --query "value[?contains(to_string(grantedToIdentitiesV2), '$appid')] | [0].id" -o tsv 2>/dev/null || true)
        if [ -n "$finnes" ] && [ "$finnes" != "null" ]; then
            echo "  Skriverett på området — allerede gitt"
            return 0
        fi
    fi
    gjor az rest --method POST \
        --url "https://graph.microsoft.com/v1.0/sites/$siteid/permissions" \
        --headers "Content-Type=application/json" \
        --body "{\"roles\":[\"write\"],\"grantedToIdentities\":[{\"application\":{\"id\":\"$appid\",\"displayName\":\"$navn\"}}]}" \
        >/dev/null
    gronn "  Skriverett på området — gitt"
}

lag_hemmelighet() {
    local appid="$1" navn="$2"
    [ "$NY_HEMMELIGHET" = "1" ] || return 0
    if [ "$TORRKJOR" = "1" ]; then
        gul "  [tørrkjøring] ville laget en hemmelighet med ${HEMMELIGHET_AAR} års levetid"
        return 0
    fi
    local ut
    ut=$(az ad app credential reset --id "$appid" --append \
        --display-name "swa-$(date +%Y%m%d)" --years "$HEMMELIGHET_AAR" \
        --query password -o tsv)
    HEMMELIGHETER+=("$navn|$ut|$(date -u -d "+${HEMMELIGHET_AAR} years" +%Y-%m-%d 2>/dev/null || echo 'se portalen')")
}

# ---------- kjøring ----------
sjekk_tillatelser

APP_LAGRING="$PREFIKS-lagring"
APP_UTGAENDE="$PREFIKS-utgaende"
APP_OPPSLAG="$PREFIKS-oppslag"
HEMMELIGHETER=()

tittel "$APP_LAGRING"
ID_LAGRING=$(sikre_app "$APP_LAGRING")
SP_LAGRING=$(sikre_sp "$ID_LAGRING")
deklarer_tillatelser "$ID_LAGRING" Sites.Selected
sikre_rolle "$SP_LAGRING" Sites.Selected
sikre_site_tilgang "$ID_LAGRING" "$APP_LAGRING"
lag_hemmelighet "$ID_LAGRING" "$APP_LAGRING"

tittel "$APP_UTGAENDE"
ID_UTGAENDE=$(sikre_app "$APP_UTGAENDE")
SP_UTGAENDE=$(sikre_sp "$ID_UTGAENDE")
UTG_TILLATELSER=(Mail.Send)
[ "$MED_PLANNER" = "1" ] && UTG_TILLATELSER+=(Tasks.ReadWrite.All)
deklarer_tillatelser "$ID_UTGAENDE" "${UTG_TILLATELSER[@]}"
for r in "${UTG_TILLATELSER[@]}"; do sikre_rolle "$SP_UTGAENDE" "$r"; done
lag_hemmelighet "$ID_UTGAENDE" "$APP_UTGAENDE"

tittel "$APP_OPPSLAG"
ID_OPPSLAG=$(sikre_app "$APP_OPPSLAG")
SP_OPPSLAG=$(sikre_sp "$ID_OPPSLAG")
OPPSLAG_TILLATELSER=(Group.Read.All User.Read.All TeamMember.Read.All)
deklarer_tillatelser "$ID_OPPSLAG" "${OPPSLAG_TILLATELSER[@]}"
for r in "${OPPSLAG_TILLATELSER[@]}"; do sikre_rolle "$SP_OPPSLAG" "$r"; done
lag_hemmelighet "$ID_OPPSLAG" "$APP_OPPSLAG"

# ---------- oppsummering ----------
tittel "Env-vars"
cat <<OPPSUMMERING
  Settes i SWA Configuration i hvert miljø. Hemmelighetene som
  Key Vault-referanser, aldri som klartekst.

  GRAPH_TENANT_ID                 $TENANT

  # Backup til SharePoint (i bruk i dag)
  GRAPH_CLIENT_ID                 $ID_LAGRING
  GRAPH_CLIENT_SECRET             <Key Vault-referanse>
  BACKUP_SHAREPOINT_SITE          $SITE

  # Utgående e-post (når flytene legges om)
  GRAPH_UTGAENDE_CLIENT_ID        $ID_UTGAENDE
  GRAPH_UTGAENDE_CLIENT_SECRET    <Key Vault-referanse>
  GRAPH_AVSENDER                  <postkassen det sendes fra>

  # Oppslag mot katalog og team
  GRAPH_OPPSLAG_CLIENT_ID         $ID_OPPSLAG
  GRAPH_OPPSLAG_CLIENT_SECRET     <Key Vault-referanse>
OPPSUMMERING

if [ ${#HEMMELIGHETER[@]} -gt 0 ]; then
    tittel "Hemmeligheter — vises ÉN gang"
    for h in "${HEMMELIGHETER[@]}"; do
        printf '  %-24s %s\n' "$(echo "$h" | cut -d'|' -f1)" "$(echo "$h" | cut -d'|' -f2)"
        printf '  %-24s utløper %s\n\n' "" "$(echo "$h" | cut -d'|' -f3)"
    done
    rod "  Legg dem i Key Vault nå, og inn i nøkkelkalenderen med utløpsdato."
    echo "  Admin → 🗓 Nøkkelkalender → + Ny hemmelighet."
fi

tittel "Gjenstår manuelt"
cat <<GJENSTAR
  1. LÅS Mail.Send TIL ÉN POSTKASSE. Uten dette kan $APP_UTGAENDE sende
     e-post som hvem som helst i tenanten. Kjøres i Exchange Online PowerShell:

       Connect-ExchangeOnline
       New-DistributionGroup -Name "FHS-Skjema-Avsendere" -Type Security \\
         -Members skjema@fhs.no
       New-ApplicationAccessPolicy -AppId $ID_UTGAENDE \\
         -PolicyScopeGroupId "FHS-Skjema-Avsendere" -AccessRight RestrictAccess \\
         -Description "Skjemaløsningen sender bare fra skjema@fhs.no"
       Test-ApplicationAccessPolicy -Identity annen.bruker@fhs.no -AppId $ID_UTGAENDE

     Siste linje skal svare Denied. Gjør den ikke det, er policyen ikke aktiv.

  2. Vurder sertifikat framfor client secret. Samme begrunnelse som at prod
     bruker sertifikat mot Entra i dag.

  3. Sjekk lista over tillatelser øverst. Står ChannelMessage.Send som ikke
     tilgjengelig, må Teams-varsling bli i Power Automate.
GJENSTAR

echo
gronn "Ferdig."
