#!/usr/bin/env bash
# Creates or updates a Keycloak realm from a file in deploy/keycloak/realms/,
# one step of the `realm_create` catalogue at a time, and creates the
# credential-free accounts the first-owner bootstrap needs.
#
# Core holds no identity-provider credential (core FIRST_OWNER_BOOTSTRAP.md,
# PC-9), so every Keycloak write of the bootstrap is a step the identity
# operator runs with this tool, from their workstation. Core dispatches the
# catalogue's steps 1-6 one at a time (§5.5); each `step <n>` run does that
# step only, under the run identifier the dispatch names, and prints one
# `run-record` line on stdout for the operator to hand to Core. A run record
# carries no address, no token and no secret. REALMS.md is the runbook.
#
# Usage:
#   realm-apply.sh check   <realm-file>
#   realm-apply.sh step N  --target <staging|production> --run-id ID --file <realm-file> [--realm SLUG] [--synthetic] [--docs] [--visio]
#   realm-apply.sh account --target <staging|production> --run-id ID --realm REALM [--synthetic] < address
#   realm-apply.sh resend  --target <staging|production> --run-id ID --realm REALM [--synthetic] < address
#   realm-apply.sh reset   --target <staging|production> --run-id ID --realm REALM [--synthetic] < address
#   realm-apply.sh holders --target <staging|production> --run-id ID --realm REALM [--synthetic]
#   realm-apply.sh verify  --target <staging|production> --run-id ID --file <realm-file> [--realm SLUG] [--synthetic]
#
# Steps (core JOB_CATALOGUE.md §2, `realm_create`):
#   1 create_realm            the realm's settings, its flows, no client
#   2 create_clients          the console client; on the staff realm also kodera-admin, the
#                             staff administration console; on organisation realms
#                             synapse and the native clients kodera-ios and kodera-android,
#                             with --docs the Docs client, with --visio the organisation's
#                             Visio client: each is made only on request
#   3 create_service_account  organisation realms: the identity worker's
#                             service account, which Core's realm delivery signs in with
#   4 configure_idp           hosted accounts: reads that no broker exists
#   5 configure_smtp          the realm's mail settings
#   6 apply_theme             the theme, then a read-back of the whole realm
#   7 verify                  `verify`: step 6's read-back, writing nothing
#
# `--realm` names the organisation when the file is the template; the staff
# realm file names its own realm. `account` reads the owner's address on its
# standard input, never as an argument, creates the user with no password, no
# second factor and the email not verified, with the required actions VERIFY_EMAIL,
# UPDATE_PASSWORD and CONFIGURE_TOTP (on the staff realm webauthn-register: a security
# key, never OTP), and sends Keycloak's required-actions email. `resend` sends
# that email again with the actions still pending;
# `reset` marks a new password pending, then sends one asking for it, once onboarding is done.
# `holders` writes nothing: it reads who holds a role of realm-management in an
# organisation realm, and refuses anyone but the identity worker's service account,
# and any role outside realm-management that nests one of its roles.
#
# Synthetic realms (synth-*) require --synthetic on every write; the flag refuses
# all other realms. Path K stays outside Core. Static check needs no operational mode.
#
# Before any credential is sent, the server must answer as the target: the
# issuer of realm kodera-probe on it is the target's (needs curl).
#
# Environment:
#   KCADM                 kcadm.sh to run (default: kcadm.sh on PATH)
#   KC_SERVER             admin URL; defaults to the target's admin host. Only
#                         that URL or a local tunnel (http://localhost:<port>).
#   KC_ADMIN_USER         master-realm admin user (asked when unset)
#   KC_ADMIN_PASSWORD     its password (asked without echo when unset)
#   KC_CLIENT_ID          instead of the admin user: a master client that signs in with
#   KC_CLIENT_SECRET_FILE client_credentials, its secret the first line of this file, read
#                         again at every sign-in (Core's worker: kodera-realm-creator)
#   SMTP_USER             the realm's Transactional Email SMTP user, step 5
#   SMTP_PASSWORD         only (each asked when unset; the password without echo)
#   SMTP_PASSWORD_FILE    instead of SMTP_PASSWORD: a file whose first line is the password
#   ACTIONS_LIFESPAN_HOURS  lifetime of the required-actions link, only ever shorter than the
#                         default: 72 h for account and resend (the owner claim's), 24 h for reset
#
# Passwords never reach a command line: kcadm reads the admin password from
# KC_CLI_PASSWORD, a client secret from KC_CLI_CLIENT_SECRET, and the realm body,
# SMTP password included, from stdin.
# A password typed at the prompt is handed only to the one command that needs
# it, never exported to every child.
set -euo pipefail
# A failure inside $( ) stops the substitution too, so a read that failed halfway never reads
# as "nothing found" (I-2b review, round 3 of the same class).
shopt -s inherit_errexit
# fd 4: the run's own standard error, for the few notices a caller's 2>/dev/null must not swallow.
exec 4>&2

PROG="realm-apply"
REQUIRED_ACTIONS='["VERIFY_EMAIL","UPDATE_PASSWORD","CONFIGURE_TOTP"]'
# The staff realm signs in with a password and a security key (WebAuthn), never OTP: its
# accounts register a key, and the credential type that proves it is webauthn.
STAFF_REQUIRED_ACTIONS='["VERIFY_EMAIL","UPDATE_PASSWORD","webauthn-register"]'
# FIRST_OWNER_BOOTSTRAP.md §10.2: never an organisation slug.
RESERVED_SLUGS=(master kodera-staff kodera-probe kodera-dev kodera staff admin)
STAFF_REALM="kodera-staff"
STAFF_FILE="kodera-staff.json"
TEMPLATE_FILE="org-realm-template.json"
SYNAPSE_CLIENT="synapse"
DOCS_CLIENT="docs"
WORKER_CLIENT="kodera-identity-worker"
# The native apps' public clients (REALMS.md, "Native clients"), organisation
# realms only. Both apps share one bundle ID, so one redirect URI.
NATIVE_CLIENTS='["kodera-ios","kodera-android"]'
NATIVE_REDIRECT="io.kodera.app:/oauth2redirect"
# Each native client's mappers, exactly as the template writes them: an extra
# audience (included.client.audience) or claim in a config would otherwise pass.
# userinfo.token.claim is the key Keycloak 26.0.7 adds on create, so the file states it.
NATIVE_MAPPERS='[{"protocolMapper":"oidc-amr-mapper","config":{"access.token.claim":"true","id.token.claim":"true","introspection.token.claim":"true","userinfo.token.claim":"true"}},{"protocolMapper":"oidc-audience-mapper","config":{"included.custom.audience":"kodera-server","access.token.claim":"true","id.token.claim":"false","userinfo.token.claim":"false"}}]'
# The staff administration console: a public client of the staff realm only. Its tokens carry
# amr and audience kodera-server, which the staff lane of the server reads, and audience
# kodera-admin-api, which the console itself requires. Its mappers, exactly, sorted by provider
# then audience: the native clients' two, and a second audience mapper of the same shape.
ADMIN_CLIENT="kodera-admin"
ADMIN_MAPPERS='[{"protocolMapper":"oidc-amr-mapper","config":{"access.token.claim":"true","id.token.claim":"true","introspection.token.claim":"true","userinfo.token.claim":"true"}},{"protocolMapper":"oidc-audience-mapper","config":{"included.custom.audience":"kodera-admin-api","access.token.claim":"true","id.token.claim":"false","userinfo.token.claim":"false"}},{"protocolMapper":"oidc-audience-mapper","config":{"included.custom.audience":"kodera-server","access.token.claim":"true","id.token.claim":"false","userinfo.token.claim":"false"}}]'
CLAIM_HOURS=72
# The set-up link lives three days, as the owner_claim mail says (zôÖma, 2026-11-05): as long as
# the owner claim, and no longer. Core issues the claim only from this tool's record of the
# account's creation (FIRST_OWNER_BOOTSTRAP.md §5.6), so the first link still expires first.
ONBOARDING_HOURS=$CLAIM_HOURS
# A forgotten password after onboarding: nothing promises three days, so the shorter link.
RESET_HOURS=24
# A realm that exists on every instance; its issuer tells which instance answers.
IDENTITY_PROBE_REALM="kodera-probe"
# The clients Keycloak makes in every realm (measured on 26.0.7 and 26.7.3).
# With console, and on organisation realms synapse, the worker's client, the native clients
# and the optional docs and Visio clients, they are the whole client set.
BUILTIN_CLIENTS='["account","account-console","admin-cli","broker","realm-management","security-admin-console"]'
STEP_NAMES=("" create_realm create_clients create_service_account configure_idp configure_smtp apply_theme verify)
# The registered-factor mapper (REALMS.md, "Registered-factor mapper"): Core
# reads the claim from organisation Console access tokens only.
RF_PROVIDER="kodera-registered-factor-v1"
RF_NAME="kodera-mfa-enrolled-v1"
RF_CLAIM="kodera_mfa_enrolled"
# Realm attributes of the withdrawn realm-side switch. Core holds the switch now.
# Kept as a refusal: staging, the only target of this tool, may still carry them.
RF_LEFTOVER_ATTRIBUTES='["kodera.registered-factor-producer","kodera.registered-factor-transition"]'

die() { printf '%s: %s\n' "$PROG" "$*" >&2; exit 1; }
say() { printf '%s: %s\n' "$PROG" "$*" >&2; }

# --- jq reads -----------------------------------------------------------------
# jq-helper: begin
# jq_read <what> [jq options] <filter> [jq args] — the one way this tool reads a value with jq.
# Input on standard input (none with -n). Three outcomes, each handled by the caller:
#   found:  exit 0, jq's output on standard output. It is empty only where the filter may
#           yield nothing, which the caller reads as "none".
#   absent: exit 1, only with -e, when jq's last output was false or null.
#   error:  any other jq exit, or a blank input: the tool refuses, naming <what>, and exits 3;
#           it never returns. During step 1 of an organisation realm (OFFLINE_PHASE=1) the
#           refusal first withholds offline_access from the default role.
# In a command substitution: `x="$(jq_read …)" || exit 1`. As a test: `if jq_read … -e …`.
OFFLINE_PHASE=0
jq_read() {
  local what="$1" input="" out status test=0 null=0 skip=0 a
  shift
  for a in "$@"; do
    if (( skip > 0 )); then skip=$((skip - 1)); continue; fi
    case "$a" in
      --arg|--argjson|--slurpfile|--rawfile) skip=2 ;;
      --exit-status) test=1 ;;
      --null-input) null=1 ;;
      --*) ;;
      -?*) [[ "$a" == *e* ]] && test=1; [[ "$a" == *n* ]] && null=1 ;;
      *) break ;;
    esac
  done
  if (( null )); then
    out="$(jq "$@")" && status=0 || status=$?
  else
    input="$(cat)" || jq_refuse "$what" "input read failed"
    [[ -n "${input//[[:space:]]/}" ]] || jq_refuse "$what" "an empty input"
    out="$(jq "$@" <<<"$input")" && status=0 || status=$?
  fi
  case "$status" in
    0) [[ -z "$out" ]] || printf '%s\n' "$out"; return 0 ;;
    1) (( test )) && return 1 ;;
  esac
  jq_refuse "$what" "jq exit $status"
}
jq_refuse() {  # jq_refuse <what> <cause> — refuses, exit 3
  local msg="refused: $1 could not be read ($2)"
  if [[ "$OFFLINE_PHASE" == 1 && "$WITHHOLDING" != 1 ]]; then
    withhold_offline_role
    msg="$msg; offline_access is withheld from the default role"
  fi
  printf '%s: %s\n' "$PROG" "$msg" >&2
  exit 3
}
# jq-helper: end

# --- targets ----------------------------------------------------------------
# One row per environment: admin URL, public identity host, mail domain and
# the console origin (also Core's KODERA_MAIL_LINK_ORIGINS there). See
# REALMS.md, "Production", for the production host and operator gates.
target_admin_url() {
  case "$1" in
    staging) echo "https://auth-admin.staging.kodera.io" ;;
    production) echo "https://auth-admin.kodera.io" ;;
  esac
}
target_public_host() {
  case "$1" in
    staging) echo "auth.staging.kodera.io" ;;
    production) echo "auth.kodera.io" ;;
  esac
}
target_mail_domain() {
  case "$1" in
    staging) echo "auth.staging.kodera.io" ;;
    production) echo "auth.kodera.io" ;;
  esac
}
target_console_origin() {
  case "$1" in
    staging) echo "https://app.staging.kodera.io" ;;
    production) echo "https://app.kodera.io" ;;
  esac
}
target_synapse_origin() {
  case "$1" in
    staging) echo "https://$2.staging.kodera.io" ;;
    production) echo "https://$2.kodera.io" ;;
  esac
}
target_docs_origin() {
  case "$1" in
    staging) echo "https://docs.$2.staging.kodera.io" ;;
    production) echo "https://docs.$2.kodera.io" ;;
  esac
}
# The staff administration console (client kodera-admin of the staff realm), ${STAFF_ADMIN_ORIGIN}
# in the staff realm file.
target_staff_admin_origin() {
  case "$1" in
    staging) echo "https://admin.staging.kodera.io" ;;
    production) echo "https://admin.kodera.io" ;;
  esac
}
# The Visio client is named after the tenant's Meet host, as the tenant visio
# profile names it (OIDC_RP_CLIENT_ID is hosts.meet).
target_visio_host() {
  case "$1" in
    staging) echo "visio.$2.staging.kodera.io" ;;
    production) echo "visio.$2.kodera.io" ;;
  esac
}

require_target() {
  [[ -n "${1:-}" ]] || die "--target is required (staging or production)"
  [[ "$1" == "staging" || "$1" == "production" ]] ||
    die "refused: target '$1'; expected staging or production (REALMS.md, \"Production\")"
}

# Only the target's own admin URL, or a local tunnel endpoint, is accepted: a
# deny-list of production names would pass an IP address or an alias.
require_target_server() {
  [[ "$1" == "$(target_admin_url "$TARGET")" ]] && return 0
  [[ "$1" =~ ^https?://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?/?$ ]] && return 0
  die "refused: KC_SERVER '$1' is neither $(target_admin_url "$TARGET") nor a local tunnel (http://localhost:<port>)"
}

# --- static checks ----------------------------------------------------------
# check_rep <json-file> <label> <mode> <groups> [console-origin] [mail-domain] [synapse-origin] [docs-origin] [visio-host] [staff-admin-origin]
#   mode "file": a realm file as committed, placeholders unresolved.
#   mode "live": a partial export of a live realm, read back after a step.
#   groups: "all", or a comma list of settings, flows, client, offline, worker,
#   idp, smtp, theme — the part of the realm a step made. offline is who may
#   request offline_access: on organisation realms, the native clients only.
# Prints one line per failed invariant and returns non-zero if any failed.
check_rep() {
  local file="$1" label="$2" mode="$3" groups="$4"
  local origin='${CONSOLE_ORIGIN}' domain='${MAIL_DOMAIN}' synapse_origin='${SYNAPSE_ORIGIN}' docs_origin='${DOCS_ORIGIN}'
  local visio_host='${VISIO_HOST}' admin_origin='${STAFF_ADMIN_ORIGIN}'
  [[ $# -ge 6 ]] && { origin="$5"; domain="$6"; }
  [[ $# -ge 7 ]] && synapse_origin="$7"
  [[ $# -ge 8 ]] && docs_origin="$8"
  [[ $# -ge 9 ]] && visio_host="$9"
  [[ $# -ge 10 ]] && admin_origin="${10}"
  local errors
  jq -e . "$file" >/dev/null 2>&1 || { printf '%s: %s: not valid JSON\n' "$PROG" "$label"; return 1; }
  errors="$(jq_read "realm $label" -r --arg mode "$mode" --arg groups "$groups" --arg origin "$origin" --arg from "no-reply@$domain" \
      --arg staff "$STAFF_FILE" --arg synapse "$SYNAPSE_CLIENT" --arg synapse_origin "$synapse_origin" \
      --arg docs "$DOCS_CLIENT" --arg docs_origin "$docs_origin" --arg visio "$visio_host" \
      --arg worker "$WORKER_CLIENT" --argjson builtins "$BUILTIN_CLIENTS" \
      --argjson natives "$NATIVE_CLIENTS" --arg native_redirect "$NATIVE_REDIRECT" \
      --argjson native_mappers "$NATIVE_MAPPERS" \
      --arg admin "$ADMIN_CLIENT" --arg admin_origin "$admin_origin" --argjson admin_mappers "$ADMIN_MAPPERS" \
      --arg rf_provider "$RF_PROVIDER" --arg rf_name "$RF_NAME" --arg rf_claim "$RF_CLAIM" \
      --argjson rf_leftovers "$RF_LEFTOVER_ATTRIBUTES" '
    . as $r
    | def on($g): $groups == "all" or ($groups | split(",") | index($g)) != null;
      def flow($a): first($r.authenticationFlows[]? | select(.alias == $a)) // null;
      def cfg($a): first($r.authenticatorConfig[]? | select(.alias == $a)) // null;
      # Keycloak reads a claim name as a path (JsonUtils.splitClaimPath): an
      # unescaped dot splits it, and a backslash escapes the next character,
      # which is kept as itself. So "a\mr" emits amr. Every comparison of a
      # claim name runs on what Keycloak emits, never on the raw string.
      def kc_unescape: gsub("\\\\(?<c>.)"; .c);
      # jq 1.6 captures nothing from an empty string, hence the default.
      def claim_head: (capture("^(?<h>(?:[^\\\\.]|\\\\.)*)").h // "") | kc_unescape;
      # A mapper that is the registered-factor mapper, by provider or by name,
      # or that names its claim anywhere in its config (a hard-coded claim, a
      # script): any of them could put a value in the claim Core trusts.
      def factor_mapper: .protocolMapper == $rf_provider or .name == $rf_name
        or any((.config // {}) | to_entries[]?; (.value | type) == "string" and (.value | kc_unescape | contains($rf_claim)));
      # The device and CIBA grants skip PKCE and the redirect pin; Keycloak may
      # write either attribute as "false".
      def grant_drift($who):
        (if (.attributes["oauth2.device.authorization.grant.enabled"]? // "false") != "false"
         then "client \($who) must not allow the device authorization grant (oauth2.device.authorization.grant.enabled absent or \"false\")"
         else empty end),
        (if (.attributes["oidc.ciba.grant.enabled"]? // "false") != "false"
         then "client \($who) must not allow the CIBA grant (oidc.ciba.grant.enabled absent or \"false\")"
         else empty end);
      # offline_access is in the default role of an organisation realm (I-2b,
      # option b), so the scope lists of a client are the only gate.
      def offers_offline: ((.defaultClientScopes // []) + (.optionalClientScopes // [])) | index("offline_access") != null;
      # What a role grants, for a message: its realm roles, then each client with its roles.
      def client_grants: (.composites.client // {}) | to_entries | sort_by(.key) | map("\(.key): \(.value | sort | join(", "))");
      def grants: ((.composites.realm // []) | sort) + client_grants
        | if . == [] then "nothing" else join("; ") end;
      # Every execution a sign-in through flow $a can reach, sub-flows included, each with the
      # alias of the flow that holds it. A flow already on the path is not entered twice.
      def reach($a; $seen):
        if ($seen | index($a)) != null then empty
        else flow($a) as $f
          | ($f.authenticationExecutions[]? | {alias: $a, e: .}),
            ($f.authenticationExecutions[]? | select(.authenticatorFlow == true) | .flowAlias as $x
             | reach($x; $seen + [$a]))
        end;
      ($r.attributes.koderaRealmSource == $staff) as $is_staff
    # The second factor: OTP on organisation realms; on the staff realm a security key
    # (WebAuthn, after the password), which puts hwk in amr. TOTP is never on its sign-in path.
    | (if $is_staff then "webauthn-authenticator" else "auth-otp-form" end) as $factor
    | (if $is_staff then "hwk" else "otp" end) as $factor_ref
    | (if $is_staff then "WebAuthn" else "OTP" end) as $factor_name
    | (flow($r.browserFlow)) as $top
    | ($top.authenticationExecutions // [] | map(select(.authenticatorFlow == true)) | map(.flowAlias)) as $subs
    | ([$subs[] | flow(.) | select(any(.authenticationExecutions[]; .authenticator == $factor))] | first // null) as $forms
    | ($forms.authenticationExecutions // [] | map(select(.authenticator == $factor)) | first // null) as $f2
    | (cfg($f2.authenticatorConfig // "").config["default.reference.value"]) as $f2_ref
    | (cfg($f2.authenticatorConfig // "").config["default.reference.maxAge"]) as $f2_age
    | ($forms.authenticationExecutions // [] | map(select(.authenticator == "auth-username-password-form")) | first // null) as $pwd
    | (cfg($pwd.authenticatorConfig // "").config["default.reference.value"]) as $pwd_ref
    | (cfg($pwd.authenticatorConfig // "").config["default.reference.maxAge"]) as $pwd_age
    | [.clients[]? | select(.clientId == "console")] as $consoles
    | ($consoles[0] // {}) as $c
    | [.clients[]? | select(.clientId == $synapse)] as $synapses
    | ($synapses[0] // {}) as $s
    | [.clients[]? | select(.clientId == $docs)] as $docs_clients
    | ($docs_clients[0] // {}) as $d
    | [.clients[]? | select(.clientId == $visio)] as $visios
    | [.clients[]? | select(.clientId == $worker)] as $workers
    | ($workers[0] // {}) as $w
    | ((.passwordPolicy // "") | [split(" and ")[] | capture("^(?<n>[A-Za-z]+)(\\((?<a>[^)]*)\\))?$")]) as $pp
    | {permanentLockout: false, failureFactor: 5, waitIncrementSeconds: 60, maxFailureWaitSeconds: 900,
       minimumQuickLoginWaitSeconds: 60, quickLoginCheckMilliSeconds: 1000, maxDeltaTimeSeconds: 43200} as $bf
    | [
        (if on("settings") then
          ($rf_leftovers[] | select($r.attributes[.]? != null)
           | "realm attribute \(.) is left over from the withdrawn producer switch; remove it (REALMS.md, \"Registered-factor mapper\")"),
          (if .verifyEmail != true then "verifyEmail must be true" else empty end),
          (if .adminEventsEnabled != true or .adminEventsDetailsEnabled != true
           then "admin events must be on (adminEventsEnabled and adminEventsDetailsEnabled)" else empty end),
          (if .eventsEnabled != true or .eventsExpiration != 7776000
           then "user events must be on and kept 90 days (eventsEnabled, eventsExpiration 7776000)" else empty end),
          (if .registrationAllowed != false then "self-registration must be off (registrationAllowed)" else empty end),
          (if .resetPasswordAllowed != false
           then "password reset must be off (resetPasswordAllowed); a lost password is the tool'"'"'s reset" else empty end),
          (if .rememberMe != false then "remember-me must be off (rememberMe)" else empty end),
          (if .editUsernameAllowed != false
           then "usernames must not be editable (editUsernameAllowed false)" else empty end),
          (if $is_staff and .sslRequired != "all"
           then "the staff realm must require TLS on every request (sslRequired all)"
           elif ([.sslRequired] | inside(["external", "all"])) | not
           then "sslRequired must be external or all" else empty end),
          # The staff WebAuthn policy verifies its holder (PIN or biometric) without restricting
          # attachment to hardware-only, so hardware keys, platform biometrics and passkey vaults work.
          (if $is_staff and .webAuthnPolicyUserVerificationRequirement != "required"
           then "the staff realm'"'"'s WebAuthn policy must require user verification (webAuthnPolicyUserVerificationRequirement \"required\"), is \(.webAuthnPolicyUserVerificationRequirement | tojson)"
           else empty end),
          (if $is_staff and .webAuthnPolicyAuthenticatorAttachment != "not specified"
           then "the staff realm'"'"'s WebAuthn policy must allow any authenticator attachment (webAuthnPolicyAuthenticatorAttachment \"not specified\"), is \(.webAuthnPolicyAuthenticatorAttachment | tojson)"
           else empty end),
          (if .bruteForceProtected != true then "brute-force protection must be on (bruteForceProtected)"
           else ($bf | to_entries[] | select($r[.key] != .value)
                 | "brute-force setting \(.key) must be \(.value | tojson), is \($r[.key] | tojson)") end),
          (if ([$pp[] | select(.n == "length" and ((.a // "0") | tonumber? // 0) >= 12)] | length) == 0
              or ([$pp[] | .n] | index("notUsername")) == null or ([$pp[] | .n] | index("notEmail")) == null
           then "passwordPolicy must hold length(12) or more, notUsername and notEmail; is \(.passwordPolicy | tojson)"
           else empty end),
          (if .revokeRefreshToken != true or .refreshTokenMaxReuse != 0
           then "refresh tokens must rotate (revokeRefreshToken true, refreshTokenMaxReuse 0)" else empty end),
          # Every realm speaks French first, English on request: the login pages and the
          # mails follow the locale of the browser or of the account among the two, French by default.
          (if .internationalizationEnabled != true or .defaultLocale != "fr"
               or ((.supportedLocales // []) | sort) != ["en", "fr"]
           then "locales must be French by default and English on request (internationalizationEnabled true, supportedLocales [\"en\", \"fr\"], defaultLocale \"fr\"); are \({internationalizationEnabled, supportedLocales, defaultLocale} | tojson)"
           else empty end),
          # Offline sessions (I-2b): 14 days idle, 90 days at most, on
          # organisation realms; the staff realm sets none, so the defaults
          # of Keycloak stay, and no client of it offers offline_access.
          (if $is_staff then
             (if $mode == "file" then
                (["offlineSessionIdleTimeout", "offlineSessionMaxLifespanEnabled", "offlineSessionMaxLifespan"][]
                 | select(. as $k | $r | has($k))
                 | "the staff realm must not set \(.): staff get no offline session")
              else empty end)
           else
             ({offlineSessionIdleTimeout: 1209600, offlineSessionMaxLifespanEnabled: true, offlineSessionMaxLifespan: 7776000}
              | to_entries[] | select($r[.key] != .value)
              | "offline session setting \(.key) must be \(.value | tojson), is \($r[.key] | tojson) (14 days idle, 90 days at most)")
           end),
          (if $mode == "live" then
             ((.roles.realm // []) | map(select(.name == $r.defaultRole.name)) | first // null) as $dr
             | ($dr.composites.realm // []) as $granted
             | if $dr == null then "the default role \($r.defaultRole.name | tojson) is not in the read"
               elif $is_staff then
                 (if $granted != []
                  then "the default role must grant no realm role; it grants \($granted | join(", "))" else empty end)
               elif ($granted | sort) != ["offline_access"]
               then "the default role must grant offline_access and no other realm role (the client scope lists are the gate); it grants \(if $granted == [] then "nothing" else $granted | sort | join(", ") end)"
               else empty end,
             # Every member holds the default role, and on organisation realms
             # offline_access through it: anything nested in either reaches
             # everyone. The client roles are Keycloak'"'"'s own, as it makes them.
             (if $dr != null and (($dr.composites.client // {}) | map_values(sort)) != {account: ["manage-account", "view-profile"]}
              then "the default role must grant exactly the client roles Keycloak gives it (account: manage-account, view-profile); it grants \($dr | {composites: {client: .composites.client}} | grants)"
              else empty end)
           else empty end),
          # A file that defines offline_access, and a live read alike: step 1
          # also reads it before it grants the role.
          # Each realm role once: a second definition would otherwise go unread.
          ((.roles.realm // []) | group_by(.name)[] | select(length > 1)
           | "realm role \(.[0].name) is defined \(length) times; each realm role is defined once"),
          (if $is_staff then empty
           else (.roles.realm // [])[] | select(.name == "offline_access")
           | select(.composite == true or (grants) != "nothing")
           | "the realm role offline_access must not be composite: every member holds it; it grants \(grants)"
           end)
        else empty end),
        (if on("flows") then
          # The staff realm: no OTP anywhere a sign-in can reach, and an explicit requiredActions
          # list must register every action `account`/`reset` places on a user (Keycloak ignores an
          # unregistered requiredAction string on a user instead of failing).
          (if $is_staff then
             (reach($r.browserFlow; []) | select(.e.authenticator == "auth-otp-form")
              | "the staff browser flow must not offer OTP (auth-otp-form in \(.alias | tojson)): TOTP never replaces the security key; a lost key is an administrator'"'"'s reset"),
             (if ([.requiredActions[]? | select(.alias == "CONFIGURE_TOTP" or .providerId == "CONFIGURE_TOTP") | .enabled == false and (.defaultAction // false) == false] | length == 1 and all)
              then empty
              else "the staff realm must disable required action CONFIGURE_TOTP (enabled false, defaultAction false)"
              end),
             (["VERIFY_EMAIL", "webauthn-register", "UPDATE_PASSWORD", "UPDATE_PROFILE"][] as $ra
              | if ([.requiredActions[]? | select(.alias == $ra and .providerId == $ra and .enabled == true and (.defaultAction // false) == false)] | length == 1)
                then empty
                else "the staff realm must register and enable required action \($ra) (enabled true, defaultAction false)"
                end),
             ((first(.requiredActions[]? | select(.alias == "webauthn-register") | .priority) // null) as $wp
              | (first(.requiredActions[]? | select(.alias == "UPDATE_PASSWORD") | .priority) // null) as $pp_prio
              | if $wp != null and $pp_prio != null and ($wp < $pp_prio)
                then empty
                else "the staff realm must run webauthn-register before UPDATE_PASSWORD so resend still recovers a half-finished onboarding"
                end)
           elif ($mode == "live" or ($r | has("requiredActions"))) then
             (["VERIFY_EMAIL", "CONFIGURE_TOTP", "UPDATE_PASSWORD"][] as $ra
              | if ([.requiredActions[]? | select(.alias == $ra and .providerId == $ra and .enabled == true and (.defaultAction // false) == false)] | length == 1)
                then empty
                else "an organisation realm must register and enable required action \($ra) (enabled true, defaultAction false)"
                end)
           else empty end),
          (if $top == null then "browserFlow \(.browserFlow | tojson) is not a flow of the realm"
           elif $forms == null then "the browser flow has no sub-flow with \($factor)"
           else
             ($top.authenticationExecutions[]
              | select(.authenticator != "auth-cookie" and .flowAlias != $forms.alias)
              | "the browser flow has a path that skips \($factor_name): \(.authenticator // .flowAlias)"),
             ($top.authenticationExecutions[] | select(.requirement != "ALTERNATIVE")
              | "the browser flow must offer the cookie or the forms, each ALTERNATIVE; \(.authenticator // .flowAlias) is \(.requirement)"),
             ($forms.authenticationExecutions[] | select(.requirement != "REQUIRED")
              | "every step of \($forms.alias | tojson) must be REQUIRED, \(.authenticator) is \(.requirement)"),
             (if ($forms.authenticationExecutions | sort_by(.priority) | map([.authenticator, .requirement]))
                 != [["auth-username-password-form", "REQUIRED"], [$factor, "REQUIRED"]]
              then "\($forms.alias | tojson) must be the password form then the \($factor_name) form, both REQUIRED, and nothing else"
              else empty end),
             (if [$f2_ref, $pwd_ref] | any(. // "" | test("^\\*+$"))
              then "the admin API masks default.reference.value, so amr cannot be read back; check amr in a token (REALMS.md, \"Staging runbook\")"
              else
                (if $f2_ref != $factor_ref then "\($factor) does not put \($factor_ref) in amr" else empty end),
                (if $pwd_ref != "pwd" then "auth-username-password-form does not put pwd in amr" else empty end),
                # A positive maxAge (seconds) on each reference, as the e2e realm check of Core requires.
                (if ($f2_age // "" | tostring | test("^[1-9][0-9]*$")) | not
                 then "\($factor) must give its amr reference a positive default.reference.maxAge, is \($f2_age | tojson)" else empty end),
                (if ($pwd_age // "" | tostring | test("^[1-9][0-9]*$")) | not
                 then "auth-username-password-form must give its amr reference a positive default.reference.maxAge, is \($pwd_age | tojson)" else empty end)
              end)
           end),
          (if (flow($r.directGrantFlow).authenticationExecutions // [] | map([.authenticator, .requirement]))
              != [["deny-access-authenticator", "REQUIRED"]]
           then "the direct grant flow must deny every request (deny-access-authenticator, REQUIRED, alone)" else empty end),
          (.clients[]? | select((.authenticationFlowBindingOverrides // {}) != {})
           | "client \(.clientId) overrides the realm flows (authenticationFlowBindingOverrides)")
        else empty end),
        (if on("client") then
          (["console"] + (if $is_staff then [$admin] else [$synapse, $worker] + $natives end)) as $ours
          # The optional clients of an organisation: step 2 makes docs with --docs and the Visio
          # client with --visio. A live realm may lack them; the template defines both.
          | (if $is_staff then [] else [$docs, $visio] end) as $optional
          | ([.clients[]?.clientId] - $builtins - $ours - $optional - [$admin] | unique[]
             | "client \(.) is not one of the realm'"'"'s clients: \($ours + $optional | join(", ")) and Keycloak'"'"'s built-in ones"),
          # The staff administration console signs staff in, never an organisation member.
          (if ($is_staff | not) and any(.clients[]?; .clientId == $admin)
           then "client \($admin) is for the staff realm only: an organisation realm never has the staff administration console"
           else empty end),
          (if $mode == "live" and $groups == "all" then
             ($builtins + $ours) - [.clients[]?.clientId] | .[] | "client \(.) is missing from the realm"
           else empty end),
          ([(.clientScopes[]? | {w: "client scope \(.name)", m: (.protocolMappers // [])}),
            (.clients[]? | {w: "client \(.clientId)", m: (.protocolMappers // [])})]
           | .[] | .w as $w | .m[]
           | select((.config["claim.name"]? // "") | type == "string" and contains("\\"))
           | "\($w) mapper \(.name): claim.name must not contain a backslash (Keycloak reads \\X as X)"),
          # Core reads amr and audience kodera-server from the tokens of console and, on
          # organisation realms, from the tokens of the native apps; on the staff realm, from
          # the tokens of the staff administration console too.
          (def core_claim: .protocolMapper == "oidc-amr-mapper"
             or ((.config["claim.name"]? // "") | type == "string" and (claim_head == "amr" or claim_head == "aud"))
             or .config["included.custom.audience"] == "kodera-server";
           (["console"] + (if $is_staff then [$admin] else $natives end)) as $core_clients
           | ([.clientScopes[]? | select(any(.protocolMappers[]?; core_claim)) | "client scope \(.name)"]
              + [.clients[]? | select(.clientId as $id | ($core_clients | index($id)) == null)
                 | select(any(.protocolMappers[]?; core_claim)) | "client \(.clientId)"])[]
           | "\(.) maps amr or audience kodera-server; "
             + "only the mappers of clients \($core_clients[:-1] | join(", ")) and \($core_clients[-1]) may"),
          (([.clientScopes[]? | select(any(.protocolMappers[]?; factor_mapper)) | "client scope \(.name)"]
            + [.clients[]? | select(($is_staff or .clientId != "console") and any(.protocolMappers[]?; factor_mapper))
               | "client \(.clientId)"])[]
           | "\(.) carries a registered-factor mapper or the claim \($rf_claim); "
             + (if $is_staff then "the staff realm carries none" else "only client console may" end)),
          (if ($consoles | length) != 1 then "the realm must have exactly one client console"
           else
             (if $c.publicClient != true then "client console must be public" else empty end),
             ($c | grant_drift("console")),
             (if $c.attributes["pkce.code.challenge.method"] != "S256" then "client console must require PKCE S256" else empty end),
             (if $c.directAccessGrantsEnabled != false then "client console must not allow direct access grants" else empty end),
             (if $c.implicitFlowEnabled != false then "client console must not allow the implicit flow" else empty end),
             (if $c.fullScopeAllowed != false
              then "client console must not carry the full scope (fullScopeAllowed false)" else empty end),
             (if ($c.defaultClientScopes == null) or ($c.optionalClientScopes == null)
              then "client console must list its client scopes (defaultClientScopes, optionalClientScopes); left out, Keycloak gives it the default client scopes of the realm"
              elif ($c.defaultClientScopes | sort) != ["acr", "basic", "email", "profile", "web-origins"]
                   or $c.optionalClientScopes != []
              then "client console scopes must be exactly acr, basic (sub), email, profile and web-origins, with no optional scope (so no offline_access); are \($c.defaultClientScopes | sort | join(", ")) + optional [\($c.optionalClientScopes | join(", "))]"
              else empty end),
             (if any($c.protocolMappers[]?; .protocolMapper == "oidc-audience-mapper"
                     and .config["included.custom.audience"] == "kodera-server" and .config["access.token.claim"] == "true") | not
              then "client console must put audience kodera-server in the access token" else empty end),
             (if any($c.protocolMappers[]?; .protocolMapper == "oidc-amr-mapper" and .config["access.token.claim"] == "true") | not
              then "client console must put amr in the access token" else empty end),
             (($c.protocolMappers // [] | map(.protocolMapper) | join(", ")) as $have
              | if $is_staff then
                  (if ($c.protocolMappers // [] | map(.protocolMapper) | sort) != ["oidc-amr-mapper", "oidc-audience-mapper"]
                   then "client console mappers must be exactly one audience mapper and one AMR mapper; are [\($have)]"
                   else empty end)
                elif ($c.protocolMappers // [] | map(.protocolMapper) | sort)
                     != [$rf_provider, "oidc-amr-mapper", "oidc-audience-mapper"]
                then "client console mappers must be exactly one audience mapper, one AMR mapper and one registered-factor mapper; are [\($have)]"
                else
                  # Keycloak may leave the deprecated consentRequired out of a
                  # read; a committed file states it.
                  ($c.protocolMappers[] | select(.protocolMapper == $rf_provider)) as $m
                  | if $m.name != $rf_name or $m.protocol != "openid-connect" or $m.config != {}
                       or (if $mode == "live" then ($m.consentRequired // false) != false else $m.consentRequired != false end)
                    then "the registered-factor mapper of client console must be {name: \($rf_name), protocol: openid-connect, consentRequired: false, config: {}}; is \($m | {name, protocol, consentRequired, config} | tojson)"
                    else empty end
                end),
             # Core waits out this lifetime after the kill switch (REALMS.md):
             # an organisation console token lives 260 s, a staff one as long as the realm says.
             (if $is_staff then
                (if $c.attributes["access.token.lifespan"]? != null
                 then "the staff client console must keep the realm'"'"'s access-token lifetime (no access.token.lifespan)"
                 else empty end)
              elif $c.attributes["access.token.lifespan"]? != "260"
              then "client console access.token.lifespan must be the string \"260\"; is \($c.attributes["access.token.lifespan"]? | tojson)"
              else empty end),
             # Keycloak stores redirect URIs as a set and returns them in any order: they are
             # compared sorted, duplicates kept, so a second copy or a third URI still fails.
             # Organisation realms add the route that completes the protected owner claim, and the
             # home of the console, exactly, where Keycloak returns a person who has just set up
             # their account (the redirect_uri of the execute-actions-email Core sends).
             (([$origin + "/auth/callback"] + (if $is_staff then [] else [$origin + "/auth/claim-callback", $origin + "/"] end)) as $redirects
              | if (if ($c.redirectUris | type) == "array" then $c.redirectUris | sort else $c.redirectUris end) != ($redirects | sort)
                then "client console redirect URIs must be exactly \($redirects | tojson), in any order" else empty end),
             (if $c.attributes["post.logout.redirect.uris"] != $origin + "/"
              then "client console post-logout redirect URI must be exactly \($origin)/" else empty end),
             (if ($c.webOrigins // []) != [$origin]
              then "client console webOrigins must be exactly [\($origin | tojson)]" else empty end)
           end),
          # The staff administration console (staff-admin): a public single-page client with PKCE,
          # the code flow only, exactly its own origin, and RP-initiated logout back to its home.
          (if $is_staff then
             [.clients[]? | select(.clientId == $admin)] as $admins
             | if ($admins | length) != 1 then "the staff realm must have exactly one client \($admin) (the staff administration console)"
               else $admins[0] as $a
               | (if ($a | {enabled, protocol, publicClient, bearerOnly, standardFlowEnabled, implicitFlowEnabled,
                            directAccessGrantsEnabled, serviceAccountsEnabled, fullScopeAllowed})
                     != {enabled: true, protocol: "openid-connect", publicClient: true, bearerOnly: false,
                         standardFlowEnabled: true, implicitFlowEnabled: false, directAccessGrantsEnabled: false,
                         serviceAccountsEnabled: false, fullScopeAllowed: false}
                  then "client \($admin) must be a public OIDC client with the code flow only: no implicit flow, direct access grant, service account or full scope"
                  else empty end),
                 ($a | grant_drift($admin)),
                 (if $a.attributes["pkce.code.challenge.method"] != "S256" then "client \($admin) must require PKCE S256" else empty end),
                 (if (if ($a.redirectUris | type) == "array" then $a.redirectUris | sort else $a.redirectUris end) != [$admin_origin + "/auth/callback"]
                  then "client \($admin) redirect URIs must be exactly [\($admin_origin + "/auth/callback" | tojson)]" else empty end),
                 (if $a.attributes["post.logout.redirect.uris"] != $admin_origin + "/"
                  then "client \($admin) post-logout redirect URI must be exactly \($admin_origin)/" else empty end),
                 (if ($a.webOrigins // []) != [$admin_origin]
                  then "client \($admin) webOrigins must be exactly [\($admin_origin | tojson)]" else empty end),
                 (if ($a.defaultClientScopes == null) or ($a.optionalClientScopes == null)
                  then "client \($admin) must list its client scopes (defaultClientScopes, optionalClientScopes); left out, Keycloak gives it the default client scopes of the realm"
                  elif ($a.defaultClientScopes | sort) != ["acr", "basic", "email", "profile", "web-origins"]
                       or $a.optionalClientScopes != []
                  then "client \($admin) scopes must be exactly acr, basic (sub), email, profile and web-origins, with no optional scope (so no offline_access); are \($a.defaultClientScopes | sort | join(", ")) + optional [\($a.optionalClientScopes | join(", "))]"
                  else empty end),
                 (($a.protocolMappers // [] | map({protocolMapper, config: (.config // {})})
                   | sort_by(.protocolMapper, (.config["included.custom.audience"] // ""))) as $pinned
                  | if $pinned != $admin_mappers
                    then "client \($admin) mappers must be exactly one AMR mapper and the audience mappers kodera-admin-api and kodera-server, config included; are \($pinned | tojson)"
                    else empty end),
                 (if $a.attributes["access.token.lifespan"]? != null
                  then "client \($admin) must keep the realm'"'"'s access-token lifetime (no access.token.lifespan)" else empty end)
               end
           else empty end),
          (if $is_staff then
             (if ($synapses | length) != 0
              then "the staff realm has no client \($synapse) (Espace is for organisation realms)" else empty end)
           elif ($synapses | length) != 1 then "the realm must have exactly one client \($synapse)"
           else
             (if $s.enabled != true then "client \($synapse) must be enabled" else empty end),
             (if $s.publicClient != false or $s.clientAuthenticatorType != "client-secret" or $s.bearerOnly != false
              then "client \($synapse) must be a confidential client (publicClient false, clientAuthenticatorType client-secret, bearerOnly false)" else empty end),
             (if $s.standardFlowEnabled != true then "client \($synapse) must enable the authorization-code flow (standardFlowEnabled true)" else empty end),
             (if $s.directAccessGrantsEnabled != false then "client \($synapse) must not allow direct access grants" else empty end),
             (if $s.implicitFlowEnabled != false then "client \($synapse) must not allow the implicit flow" else empty end),
             (if $s.serviceAccountsEnabled != false then "client \($synapse) must not have a service account" else empty end),
             (if $s.consentRequired != false then "client \($synapse) must not require consent (consentRequired false)" else empty end),
             (if $s.frontchannelLogout != false then "client \($synapse) must use back-channel logout, not front-channel (frontchannelLogout false)" else empty end),
             (if $s.attributes["pkce.code.challenge.method"] != "S256" then "client \($synapse) must require PKCE S256" else empty end),
             (if $s.attributes["backchannel.logout.url"] != $synapse_origin + "/_synapse/client/oidc/backchannel_logout"
              then "client \($synapse) backchannel.logout.url must be exactly \($synapse_origin)/_synapse/client/oidc/backchannel_logout" else empty end),
             (if $s.attributes["backchannel.logout.session.required"] != "true"
              then "client \($synapse) backchannel.logout.session.required must be \"true\"" else empty end),
             (if $s.fullScopeAllowed != false
              then "client \($synapse) must not carry the full scope (fullScopeAllowed false)" else empty end),
             (if ($s.defaultClientScopes == null) or ($s.optionalClientScopes == null)
              then "client \($synapse) must list its client scopes (defaultClientScopes, optionalClientScopes); left out, Keycloak gives it the default client scopes of the realm"
              elif ($s.defaultClientScopes | sort) != ["basic", "email", "profile"]
                   or $s.optionalClientScopes != []
              then "client \($synapse) scopes must be exactly basic (sub), email and profile, with no optional scope (so no offline_access); are \($s.defaultClientScopes | sort | join(", ")) + optional [\($s.optionalClientScopes | join(", "))]"
              else empty end),
             (if ($s.protocolMappers // []) != []
              then "client \($synapse) must have no protocol mappers; has [\($s.protocolMappers | map(.protocolMapper // .name) | join(", "))]" else empty end),
             (if $s.redirectUris != [$synapse_origin + "/_synapse/client/oidc/callback"]
              then "client \($synapse) redirect URIs must be exactly [\($synapse_origin + "/_synapse/client/oidc/callback" | tojson)]" else empty end),
             (if ($s.webOrigins // []) != []
              then "client \($synapse) webOrigins must be empty ([])" else empty end)
           end),
          (if $is_staff then
             (if ($docs_clients | length) != 0
              then "the staff realm has no client \($docs) (Docs is for organisation realms)" else empty end)
           elif ($docs_clients | length) > 1 then "the realm must have at most one client \($docs)"
           elif ($docs_clients | length) == 0 then
             (if $mode == "file" then "the template must define client \($docs) (step 2 makes it with --docs)" else empty end)
           else
             ($d | grant_drift($docs)),
             (if $d.authenticationFlowBindingOverrides != null and $d.authenticationFlowBindingOverrides != {}
              then "client \($docs) must not override the realm authentication flows" else empty end),
             (if ($d | {enabled, protocol, publicClient, clientAuthenticatorType, bearerOnly,
                         standardFlowEnabled, implicitFlowEnabled, directAccessGrantsEnabled,
                         serviceAccountsEnabled, consentRequired, frontchannelLogout, fullScopeAllowed})
                  != {enabled: true, protocol: "openid-connect", publicClient: false,
                      clientAuthenticatorType: "client-secret", bearerOnly: false,
                      standardFlowEnabled: true, implicitFlowEnabled: false, directAccessGrantsEnabled: false,
                      serviceAccountsEnabled: false, consentRequired: false, frontchannelLogout: false, fullScopeAllowed: false}
              then "client \($docs) must be confidential OIDC with code flow only, no service account, consent, front-channel logout or full scope" else empty end),
             (if $d.attributes["pkce.code.challenge.method"] != "S256"
              then "client \($docs) must require PKCE S256" else empty end),
             # Keycloak 26.0.7 stores backchannel.logout.session.required "true" on every new
             # client; without a URL it sends nothing, so only the URL is refused.
             (if ($d.attributes["backchannel.logout.url"]? // "") != ""
              then "client \($docs) must not configure back-channel logout (Docs cache sessions do not support it)" else empty end),
             (if $d.attributes["post.logout.redirect.uris"] != $docs_origin + "/api/v1.0/logout-callback/"
              then "client \($docs) post-logout redirect URI must be exactly \($docs_origin)/api/v1.0/logout-callback/" else empty end),
             (if $d.redirectUris != [$docs_origin + "/api/v1.0/callback/"]
              then "client \($docs) redirect URIs must be exactly [\($docs_origin + "/api/v1.0/callback/" | tojson)]" else empty end),
             (if $d.webOrigins != [] then "client \($docs) webOrigins must be empty ([])" else empty end),
             (if $d.defaultClientScopes == null or $d.optionalClientScopes == null
                  or ($d.defaultClientScopes // [] | sort) != ["basic", "email", "profile"] or $d.optionalClientScopes != []
              then "client \($docs) scopes must be exactly basic (sub), email and profile, with no optional scope (so no offline_access)" else empty end),
             (if ($d.protocolMappers // []) != [] then "client \($docs) must have no protocol mappers" else empty end)
           end),
          # The Visio client of the organisation (La Suite Meet): optional on a live realm, defined once
          # in the template. Confidential, code flow with PKCE S256, ID tokens signed RS256 (the realm
          # signs ES256 and Meet verifies RS256), and back-channel logout so that a member removed
          # from Keycloak is signed out of Meet too.
          (if $is_staff then empty
           elif ($visios | length) > 1 then "the realm must have at most one client \($visio)"
           elif ($visios | length) == 0 then
             (if $mode == "file" then "the template must define client \($visio) (step 2 makes it with --visio)" else empty end)
           else $visios[0] as $v
             | ("https://" + $visio) as $vo
             | ($v | grant_drift($visio)),
               (if ($v | {enabled, protocol, publicClient, clientAuthenticatorType, bearerOnly,
                          standardFlowEnabled, implicitFlowEnabled, directAccessGrantsEnabled,
                          serviceAccountsEnabled, consentRequired, frontchannelLogout, fullScopeAllowed})
                   != {enabled: true, protocol: "openid-connect", publicClient: false,
                       clientAuthenticatorType: "client-secret", bearerOnly: false,
                       standardFlowEnabled: true, implicitFlowEnabled: false, directAccessGrantsEnabled: false,
                       serviceAccountsEnabled: false, consentRequired: false, frontchannelLogout: false, fullScopeAllowed: false}
                then "client \($visio) must be confidential OIDC with code flow only, no service account, consent, front-channel logout or full scope" else empty end),
               (if $v.attributes["pkce.code.challenge.method"] != "S256" then "client \($visio) must require PKCE S256" else empty end),
               (if $v.attributes["id.token.signed.response.alg"] != "RS256"
                then "client \($visio) must sign its ID tokens RS256 (id.token.signed.response.alg)" else empty end),
               (if $v.redirectUris != [$vo + "/api/v1.0/callback/"]
                then "client \($visio) redirect URIs must be exactly [\($vo + "/api/v1.0/callback/" | tojson)]" else empty end),
               (if $v.attributes["post.logout.redirect.uris"] != $vo + "/api/v1.0/logout-callback/"
                then "client \($visio) post-logout redirect URI must be exactly \($vo)/api/v1.0/logout-callback/" else empty end),
               (if $v.attributes["backchannel.logout.url"] != $vo + "/api/v1.0/backchannel-logout/"
                then "client \($visio) backchannel.logout.url must be exactly \($vo)/api/v1.0/backchannel-logout/" else empty end),
               (if $v.attributes["backchannel.logout.session.required"] != "true"
                then "client \($visio) backchannel.logout.session.required must be \"true\"" else empty end),
               (if ($v.webOrigins // []) != [] then "client \($visio) webOrigins must be empty ([])" else empty end),
               (if $v.defaultClientScopes == null or $v.optionalClientScopes == null
                    or ($v.defaultClientScopes // [] | sort) != ["basic", "email", "profile"] or $v.optionalClientScopes != []
                then "client \($visio) scopes must be exactly basic (sub), email and profile, with no optional scope (so no offline_access)" else empty end),
               (if ($v.protocolMappers // []) != [] then "client \($visio) must have no protocol mappers" else empty end)
           end),
          # The native apps: public, code flow with PKCE, the redirect of the
          # app only, the default scopes of console and offline_access as their
          # only optional scope (I-2b), the audience and AMR mappers of console, never
          # the registered-factor mapper (the rule above names it), and the token
          # and session lifetimes of the realm.
          (if $is_staff then
             ($natives[] as $n | select(any($r.clients[]?; .clientId == $n))
              | "the staff realm has no client \($n) (the native apps sign organisation members in)")
           else
             ($natives[] as $n | [$r.clients[]? | select(.clientId == $n)] as $ks
              | if ($ks | length) != 1 then "the realm must have exactly one client \($n)"
                else $ks[0] as $k
                | (if $k.enabled != true then "client \($n) must be enabled" else empty end),
                  (if $k.publicClient != true then "client \($n) must be public (an app holds no secret)" else empty end),
                  ($k | grant_drift($n)),
                  (($k.protocolMappers // [] | map({protocolMapper, config: (.config // {})}) | sort_by(.protocolMapper)) as $pinned
                   | if $pinned != $native_mappers
                     then "client \($n) mappers must be exactly the template'"'"'s audience and AMR mappers, config included; are \($pinned | tojson)"
                     else empty end),
                  (if $k.standardFlowEnabled != true
                   then "client \($n) must enable the authorization-code flow (standardFlowEnabled true)" else empty end),
                  (if $k.implicitFlowEnabled != false then "client \($n) must not allow the implicit flow" else empty end),
                  (if $k.directAccessGrantsEnabled != false then "client \($n) must not allow direct access grants" else empty end),
                  (if $k.serviceAccountsEnabled != false then "client \($n) must not have a service account" else empty end),
                  (if $k.consentRequired != false then "client \($n) must not require consent (consentRequired false)" else empty end),
                  (if $k.fullScopeAllowed != false
                   then "client \($n) must not carry the full scope (fullScopeAllowed false)" else empty end),
                  (if $k.attributes["pkce.code.challenge.method"] != "S256" then "client \($n) must require PKCE S256" else empty end),
                  (if $k.redirectUris != [$native_redirect]
                   then "client \($n) redirect URIs must be exactly [\($native_redirect | tojson)]" else empty end),
                  (if $k.attributes["post.logout.redirect.uris"] != $native_redirect
                   then "client \($n) post-logout redirect URI must be exactly \($native_redirect)" else empty end),
                  (if ($k.webOrigins // []) != [] then "client \($n) webOrigins must be empty ([])" else empty end),
                  (if ($k.defaultClientScopes == null) or ($k.optionalClientScopes == null)
                   then "client \($n) must list its client scopes (defaultClientScopes, optionalClientScopes); left out, Keycloak gives it the default client scopes of the realm"
                   elif ($k.defaultClientScopes | sort) != ["acr", "basic", "email", "profile", "web-origins"]
                        or $k.optionalClientScopes != ["offline_access"]
                   then "client \($n) scopes must be exactly acr, basic (sub), email, profile and web-origins, with offline_access as the only optional scope; are \($k.defaultClientScopes | sort | join(", ")) + optional [\($k.optionalClientScopes | join(", "))]"
                   else empty end),
                  (if any($k.protocolMappers[]?; .protocolMapper == "oidc-audience-mapper"
                          and .config["included.custom.audience"] == "kodera-server" and .config["access.token.claim"] == "true") | not
                   then "client \($n) must put audience kodera-server in the access token" else empty end),
                  (if any($k.protocolMappers[]?; .protocolMapper == "oidc-amr-mapper" and .config["access.token.claim"] == "true") | not
                   then "client \($n) must put amr in the access token" else empty end),
                  (($k.protocolMappers // [] | map(.protocolMapper)) as $have
                   | if ($have | sort) != ["oidc-amr-mapper", "oidc-audience-mapper"]
                     then "client \($n) mappers must be exactly one audience mapper and one AMR mapper; are [\($have | join(", "))]"
                     else empty end),
                  (if $k.attributes["access.token.lifespan"]? != null
                   then "client \($n) must keep the realm'"'"'s access-token lifetime (no access.token.lifespan)" else empty end),
                  # The SSO and offline session times of the realm apply (I-2b): no
                  # client may set its own.
                  (($k.attributes // {} | keys | map(select(startswith("client.session.") or startswith("client.offline.session.")))) as $sk
                   | if $sk != []
                     then "client \($n) must keep the realm'"'"'s session times (no client.session.* or client.offline.session.* attribute); has \($sk | join(", "))"
                     else empty end)
                end)
           end)
        else empty end),
        # Who may request offline_access. On an organisation realm, only the
        # native clients, as an optional scope (their rule above); on the staff
        # realm, no client of the file. Keycloak offers it to its own built-in
        # clients and to every new client through the default scopes of the realm:
        # step 1 takes it off both on organisation realms, and a live read
        # checks them; the staff realm keeps them as Keycloak made them, since
        # nobody there holds the role.
        (if on("offline") then
          (.clients[]? | .clientId as $id
           | select(($is_staff or ($natives | index($id)) == null)
                    and (($is_staff and $mode == "live" and ($builtins | index($id)) != null) | not)
                    and offers_offline)
           | "client \($id) must not offer offline_access, as a default or an optional scope; "
             + (if $is_staff then "the staff realm gives no offline session"
                else "only \($natives | join(" and ")) may, as an optional scope" end)),
          (if $mode == "live" and ($is_staff | not) then
             (["defaultDefaultClientScopes", "defaultOptionalClientScopes"][] | . as $k | select($r | has($k) | not)
              | "the read lacks \(.): which scopes new clients get, offline_access among them, is unknown")
           else empty end),
          (if ($is_staff | not)
              and (((.defaultDefaultClientScopes // []) + (.defaultOptionalClientScopes // [])) | index("offline_access")) != null
           then "the realm must not give offline_access to new clients (defaultDefaultClientScopes, defaultOptionalClientScopes)"
           else empty end),
          # The role reaches the token of a native client through the role
          # mapping of the client scope itself, since fullScopeAllowed is false.
          (if $mode == "live" and ($is_staff | not) then
             (if any(.clientScopes[]?; .name == "offline_access") | not
              then "the realm has no client scope offline_access; the native clients request it"
              elif any(.scopeMappings[]?; .clientScope == "offline_access" and ((.roles // []) | index("offline_access")) != null) | not
              then "client scope offline_access must map the realm role offline_access (scopeMappings); without it Keycloak refuses a native client'"'"'s offline request (not_allowed)"
              else empty end)
           else empty end)
        else empty end),
        (if on("worker") then
          (if $is_staff then
             (if ($workers | length) != 0
              then "the staff realm has no service account (catalogue step 3 is for organisation realms)" else empty end)
           elif ($workers | length) != 1 then "the realm must have exactly one client \($worker) (catalogue step 3)"
           else
             (if $w.enabled != true then "client \($worker) must be enabled: the realm delivery of Core signs in with it" else empty end),
             (if $w.serviceAccountsEnabled != true then "client \($worker) must be a service account" else empty end),
             (if [$w.publicClient, $w.standardFlowEnabled, $w.implicitFlowEnabled, $w.directAccessGrantsEnabled] | any
              then "client \($worker) must allow the service-account grant only" else empty end),
             ($w | grant_drift($worker)),
             # No browser ever reaches the worker: no redirect, origin or post-logout URI.
             (if ($w.redirectUris // []) != [] then "client \($worker) redirect URIs must be empty ([])" else empty end),
             (if ($w.webOrigins // []) != [] then "client \($worker) webOrigins must be empty ([])" else empty end),
             (if ($w.attributes["post.logout.redirect.uris"]? // "") != ""
              then "client \($worker) must have no post-logout redirect URI" else empty end),
             # It signs in with its secret, and its token carries what Keycloak gives a service
             # account and nothing a mapper adds. Keycloak gives a client its three session-note
             # mappers when it turns service accounts on (measured on 26.0.7: Client ID, Client Host,
             # Client IP Address); any other mapper, or one of those three changed, is refused.
             (if ($w.clientAuthenticatorType // "client-secret") != "client-secret"
              then "client \($worker) must sign in with its secret (clientAuthenticatorType client-secret), is \($w.clientAuthenticatorType | tojson)" else empty end),
             ([$w.protocolMappers[]?
               | select({protocolMapper, note: .config["user.session.note"], claim: .config["claim.name"]} as $k
                        | any(("client_id", "clientHost", "clientAddress");
                              $k == {protocolMapper: "oidc-usersessionmodel-note-mapper", note: ., claim: .}) | not)
               | .name] as $extra
              | if $extra != []
                then "client \($worker) must have no protocol mapper but the service-account ones Keycloak adds (Client ID, Client Host, Client IP Address); has \($extra | join(", "))"
                else empty end)
           end)
        else empty end),
        (if on("idp") then
          (if ((.identityProviders // []) + (.identityProviderMappers // [])) != []
           then "the realm must have no identity provider (hosted accounts; a broker would skip OTP): \([.identityProviders[]?.alias] | join(", "))"
           else empty end)
        else empty end),
        (if on("smtp") then
          ({host: "smtp.tem.scaleway.com", port: "587", ssl: "false", starttls: "true", auth: "true",
            from: $from, fromDisplayName: "Kodera", replyTo: "support@kodera.io"}
           | to_entries[] | select($r.smtpServer[.key] != .value)
           | "smtpServer.\(.key) must be \(.value | tojson), is \($r.smtpServer[.key] | tojson)"),
          (if (.smtpServer.envelopeFrom // "") != "" then "smtpServer.envelopeFrom must be empty (the sender is from)" else empty end),
          (if $mode == "file" then
             (if .smtpServer.user != "${SMTP_USER}" then "smtpServer.user must be ${SMTP_USER}, typed at step 5" else empty end)
           else
             (if (.smtpServer.user // "") == "" or (.smtpServer.user | contains("${"))
              then "smtpServer.user is not set (step 5)" else empty end),
             (if (.smtpServer.password // "") == "" then "smtpServer.password is not set (step 5)" else empty end)
           end)
        else empty end),
        (if on("theme") then
          (if [.loginTheme, .accountTheme, .emailTheme] != ["kodera", "kodera", "kodera"]
           then "loginTheme, accountTheme and emailTheme must be kodera" else empty end)
        else empty end),
        (if $mode == "file" then
           ([paths | select(.[-1] | type == "string" and test("^(password|secret|clientSecret|credentials)$"; "i"))]
            | map(map(tostring) | join(".")) | .[]
            | "the file holds \(.); secrets are typed at apply time, never committed"),
           (if has("users") then "the file holds users; accounts are created with \"account\", without credentials" else empty end)
         else empty end)
      ] | .[]' < "$file")" || { printf '%s: %s: could not be read\n' "$PROG" "$label"; return 1; }
  [[ -z "$errors" ]] && return 0
  while IFS= read -r line; do printf '%s: %s: %s\n' "$PROG" "$label" "$line"; done <<<"$errors"
  return 1
}

cmd_check() {
  local file="${1:-}"
  [[ -n "$file" && -f "$file" ]] || die "usage: realm-apply.sh check <realm-file>"
  # The marker first: the checks read the realm's kind from it.
  local source
  source="$(jq -r '.attributes.koderaRealmSource // ""' "$file" 2>/dev/null)" || source=""
  [[ "$source" == "$(basename "$file")" ]] ||
    die "$(basename "$file"): attributes.koderaRealmSource must be the file name, is '$source'"
  check_rep "$file" "$(basename "$file")" file all >&2 || exit 1
  say "$(basename "$file"): ok"
}

# --- arguments --------------------------------------------------------------
TARGET="" RUN_ID="" FILE="" REALM="" EMAIL="" ORIGIN="" KC_URL=""
SYNTHETIC_MODE=0 DOCS=0 VISIO=0
parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --synthetic) SYNTHETIC_MODE=1; shift; continue ;;
      --docs) DOCS=1; shift; continue ;;
      --visio) VISIO=1; shift; continue ;;
      --email) die "refused: --email; the address is read on standard input, never as an argument (FIRST_OWNER_BOOTSTRAP.md §5.6)" ;;
      --console-origin) die "refused: --console-origin; the origin is the target's ($(target_console_origin staging) on staging)" ;;
      --synapse-origin) die "refused: --synapse-origin; the origin is the target's ($(target_synapse_origin staging '<realm>') on staging)" ;;
    esac
    [[ $# -ge 2 ]] || die "$1 needs a value"
    case "$1" in
      --target) TARGET="$2" ;;
      --run-id) RUN_ID="$2" ;;
      --file) FILE="$2" ;;
      --realm) REALM="$2" ;;
      *) die "unknown option $1" ;;
    esac
    shift 2
  done
  require_target "$TARGET"
  [[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ ]] ||
    die "--run-id is required: the run identifier the dispatch names (letters, digits, . _ : -)"
  ORIGIN="$(target_console_origin "$TARGET")"
}

validate_slug() {
  local s
  for s in "${RESERVED_SLUGS[@]}"; do
    [[ "$1" == "$s" ]] && die "refused: '$1' is a reserved slug (FIRST_OWNER_BOOTSTRAP.md §10.2)"
  done
  [[ "$1" =~ ^[a-z0-9][a-z0-9-]{3,18}[a-z0-9]$ ]] ||
    die "refused: '$1' is not an organisation slug (5-20 lower-case ASCII, first and last alphanumeric)"
}

# The file a realm must have been made from: the staff realm by name, every
# other realm an organisation realm under a valid slug. master and the
# reserved names are refused before anything is read.
source_for_realm() {
  [[ "$1" == "$STAFF_REALM" ]] && { echo "$STAFF_FILE"; return 0; }
  validate_slug "$1"
  echo "$TEMPLATE_FILE"
}

# Both step and account-family callers resolve their source and realm first. No mode is
# inferred from an environment variable, a run id or the caller's choice of admin server.
require_realm_mode() {
  if [[ "$SYNTHETIC_MODE" == 1 && "$TARGET" != "staging" ]]; then
    die "refused: --synthetic is for staging only, never $TARGET"
  fi
  if [[ "$REALM" == synth-* ]]; then
    validate_slug "$REALM"
    [[ "$TARGET" == "staging" ]] ||
      die "refused: '$REALM' is reserved for synthetic realms on staging, never $TARGET"
    [[ "$SYNTHETIC_MODE" == 1 ]] ||
      die "refused: '$REALM' is reserved for synthetic realms; pass --synthetic explicitly (Path K)"
    [[ "$SOURCE" == "$TEMPLATE_FILE" ]] ||
      die "refused: --synthetic requires a synth-* organisation realm from $TEMPLATE_FILE"
  elif [[ "$SYNTHETIC_MODE" == 1 ]]; then
    die "refused: --synthetic requires a synth-* organisation realm; '$REALM' is not one"
  fi
  return 0
}

# --- secrets and kcadm ------------------------------------------------------
# ask <variable> <prompt> <secret:0|1> — the environment wins; otherwise the
# terminal, never a file. The value is set in this shell only, not exported.
ask() {
  local var="$1" prompt="$2" secret="$3" value
  [[ -n "${!var:-}" ]] && return 0
  { exec 3</dev/tty; } 2>/dev/null || die "$var is unset and there is no terminal to ask on"
  printf '%s: ' "$prompt" >/dev/tty
  if [[ "$secret" == 1 ]]; then IFS= read -rs value <&3; printf '\n' >/dev/tty
  else IFS= read -r value <&3; fi
  exec 3<&-
  [[ -n "$value" ]] || die "$var is empty"
  printf -v "$var" '%s' "$value"
}

# read_secret_file <variable> <file> — sets the variable, in this shell only, to the file's first
# line. Says why and returns 1 when the file is not a readable regular file or that line is empty.
read_secret_file() {
  local value=""
  [[ -f "$2" && -r "$2" ]] || { say "'$2' is not a readable file"; return 1; }
  IFS= read -r value < "$2" || true
  value="${value%$'\r'}"
  [[ -n "$value" ]] || { say "'$2' starts with an empty line"; return 1; }
  printf -v "$1" '%s' "$value"
}

# Every temporary file goes through this list, removed on exit or interrupt.
TMP_FILES=()
cleanup() {
  # Step 3 between the enable and its record: whatever ends the run (a refused read, a failed
  # re-sign-in, a signal, an enable Keycloak applied but reported as failed) disables the worker
  # again, or says plainly that it could not.
  if [[ "${DISABLE_WORKER_ON_EXIT:-0}" == 1 ]]; then
    DISABLE_WORKER_ON_EXIT=0
    if (create_or_update_client "$WORKER_CLIENT" '.enabled = false') >/dev/null 2>&1; then
      say "step 3 did not finish; client $WORKER_CLIENT is disabled again"
    else
      say "step 3 did not finish, and client $WORKER_CLIENT could not be disabled: it may be left enabled; disable it by hand"
    fi
  fi
  [[ ${#TMP_FILES[@]} -eq 0 ]] || rm -f "${TMP_FILES[@]}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

KC_CONFIG=""
# kcadm reads its standard input (a JVM may; the lab wrapper's `docker exec -i` did): a call
# inside a `while read` loop would drain the loop's input and end it after one turn. So kc gives
# kcadm /dev/null unless the call sends a body on stdin (-f -), and every loop below that runs kc
# reads its own lines from fd 3.
#
# An expired admin token. kcadm 26.0.7 refreshes its token only when its own expiresAt is under
# 5 s away, and that expiresAt overshoots the token's real exp by up to 9.7 s (measured on the
# I-2b lab, Run 3), so on a slow host a call can carry an expired token. The admin API then
# answers `HTTP 401` and does nothing, so kc signs in again and retries that one call once, a
# write too, its -f - body buffered and sent again. A second 401, or any other error, fails the
# call as before. A sign-in itself is never retried.
KC_ERR=""
# kc_expired <stderr file> — kcadm's own diagnostic for an answer it got is its last line,
# ending in "[HTTP <status> <reason>]" (`null [HTTP 401 Unauthorized]` for an expired token). Only
# that status counts: "HTTP 401" quoted in a body, in a JSON error field, or on an earlier line
# of a different failure (a 500, for which a write may have been applied) is not a 401.
# A client's token is renewed by kcadm itself, with the secret it keeps from the sign-in; once that
# secret is rotated, the renewal fails before any request is sent and kcadm says so last, so the
# call is signed in again (the file read anew) and retried the same way.
kc_expired() {
  local last
  last="$(awk 'NF { line = $0 } END { print line }' "$1")"
  [[ -n "$KC_CLIENT" && "$last" == "Failed to refresh access token - "* ]] && return 0
  [[ "$last" == *" [HTTP 401 Unauthorized]" ]] && [[ "${last%" [HTTP 401 Unauthorized]"}" != *"[HTTP "* ]]
}
# kc_not_found <stderr file> — kcadm's last line for a 404.
kc_not_found() {
  local last
  last="$(awk 'NF { line = $0 } END { print line }' "$1")"
  [[ "$last" == "Resource not found for url: "* || "$last" == *" [HTTP 404 Not Found]" ]]
}
kc() {
  local a prev="" body_on_stdin=0 body="" err status
  for a in "$@"; do
    [[ "$prev" == -f && "$a" == - ]] && body_on_stdin=1
    prev="$a"
  done
  if [[ "$body_on_stdin" == 1 ]]; then body="$(cat; printf x)"; body="${body%x}"; fi
  err="${KC_ERR:-$(mktemp)}"
  kc_once() {
    if [[ "$body_on_stdin" == 1 ]]; then
      printf '%s' "$body" | "${KCADM:-kcadm.sh}" "$@" --config "$KC_CONFIG" 2>"$err"
    elif [[ "${1:-} ${2:-}" == "config credentials" && -n "$KC_CLIENT" ]]; then
      KC_CLI_CLIENT_SECRET="$SIGN_IN_SECRET" "${KCADM:-kcadm.sh}" "$@" --config "$KC_CONFIG" </dev/null 2>"$err"
    elif [[ "${1:-} ${2:-}" == "config credentials" ]]; then
      KC_CLI_PASSWORD="$KC_ADMIN_PASSWORD" "${KCADM:-kcadm.sh}" "$@" --config "$KC_CONFIG" </dev/null 2>"$err"
    else
      "${KCADM:-kcadm.sh}" "$@" --config "$KC_CONFIG" </dev/null 2>"$err"
    fi
  }
  if kc_once "$@"; then status=0; else status=$?; fi
  if (( status != 0 )) && [[ "${1:-}" != config ]] && kc_expired "$err"; then
    cat "$err" >&2
    say "kcadm answered HTTP 401 (an expired admin token); signing in again and retrying once" 2>&4
    kc_sign_in
    if kc_once "$@"; then status=0; else status=$?; fi
  fi
  cat "$err" >&2
  [[ -n "$KC_ERR" ]] || rm -f "$err"
  return "$status"
}

# A value the server supplies (an id, a clientId) goes into a kcadm path only as
# one plain path segment: Keycloak does not restrict a clientId's characters (a
# SAML client's is a URL), and a '/..' in it would, once the path is normalised,
# aim a write with the master admin's token somewhere else, another realm
# included. seg_ok tells whether a value is plain; seg prints it URL-encoded
# (':' becomes %3A) or dies naming it. Callers add `|| exit 1` to seg.
SEG_RE='^[A-Za-z0-9][A-Za-z0-9._:-]*$'
SEG_RULE="[A-Za-z0-9][A-Za-z0-9._:-]*, no '..'"
seg_ok() { [[ "$1" =~ $SEG_RE && "$1" != *..* ]]; }
seg() {  # seg <what> <value>
  seg_ok "$2" || die "refused: $1 '$2' is not a plain identifier ($SEG_RULE); it is not put in a path"
  jq_read "the identifier '$2'" -rn --arg v "$2" '$v | @uri'
}

# kc_read <object|array> <what> <kcadm get args...> — prints the answer of a
# read once it is exactly one JSON value of that type; dies naming the cause
# otherwise. jq reads an empty or whitespace-only answer as no input at all:
# it prints nothing and exits 0, so every filter run on it would pass.
# Callers add `|| exit 1`: the read runs in a command substitution.
kc_read() {
  local type="$1" what="$2" out shape
  shift 2
  out="$(kc get "$@")" || die "could not read $what on $KC_URL"
  if [[ -z "$out" ]]; then
    shape="an empty response"
  elif [[ -z "${out//[[:space:]]/}" ]]; then
    shape="a whitespace-only response"
  else
    shape="$(jq -rs --arg t "$type" 'if length != 1 then "\(length) JSON values"
        elif (.[0] | type) != $t then "a JSON \(.[0] | type)" else "ok" end' <<<"$out" 2>/dev/null)" ||
      shape="invalid JSON"
  fi
  [[ "$shape" == ok ]] || die "refused: $KC_URL answered $what with $shape, not a JSON $type"
  printf '%s\n' "$out"
}

# A tunnel endpoint says nothing about where it leads, so before any
# credential is sent the server must answer as the target: the issuer of
# IDENTITY_PROBE_REALM comes from the instance's own KC_HOSTNAME.
require_target_identity() {
  local want got
  want="https://$(target_public_host "$TARGET")/realms/$IDENTITY_PROBE_REALM"
  got="$(curl -fsS --max-time 15 "${KC_URL%/}/realms/$IDENTITY_PROBE_REALM/.well-known/openid-configuration" 2>/dev/null |
    jq -r '.issuer // ""' 2>/dev/null)" || got=""
  [[ "$got" == "$want" ]] ||
    die "refused: $KC_URL answers as '${got:-nothing}', not as $want; no credential was sent"
}

# KC_CLIENT: the client this run signs in as (KC_CLIENT_ID), or empty for the admin user.
# SIGN_IN_SECRET: its secret, read from the file just before the one sign-in call that sends it
# (kc_once hands it to kcadm as KC_CLI_CLIENT_SECRET) and cleared right after. Never exported.
# kcadm keeps that secret in its session file (KC_CONFIG: mode 0600, this run's own, removed on
# exit) to renew the 60 s token itself; that file is no more readable than KC_CLIENT_SECRET_FILE.
KC_CLIENT=""
SIGN_IN_SECRET=""
require_sign_in_mode() {
  [[ -n "${KC_CLIENT_ID:-}" ]] || return 0
  [[ -z "${KC_ADMIN_USER:-}" && -z "${KC_ADMIN_PASSWORD:-}" ]] ||
    die "refused: KC_CLIENT_ID is set and so is KC_ADMIN_USER or KC_ADMIN_PASSWORD; sign in one way only"
  [[ -z "${KC_CLI_CLIENT_SECRET+x}" && -z "${KC_CLIENT_SECRET+x}" ]] ||
    die "refused: a client secret is in the environment; it is read from KC_CLIENT_SECRET_FILE only"
  seg_ok "$KC_CLIENT_ID" || die "refused: KC_CLIENT_ID '$KC_CLIENT_ID' is not a plain client id ($SEG_RULE)"
  [[ -n "${KC_CLIENT_SECRET_FILE:-}" ]] || die "KC_CLIENT_ID is set without KC_CLIENT_SECRET_FILE"
  KC_CLIENT="$KC_CLIENT_ID"
}

kc_login() {
  KC_URL="${KC_SERVER:-$(target_admin_url "$TARGET")}"
  require_target_server "$KC_URL"
  require_sign_in_mode
  require_target_identity
  if [[ -z "$KC_CLIENT" ]]; then
    ask KC_ADMIN_USER "Keycloak admin user ($KC_URL)" 0
    ask KC_ADMIN_PASSWORD "Keycloak admin password" 1
  fi
  KC_CONFIG="$(mktemp)"
  KC_ERR="$(mktemp)"
  TMP_FILES+=("$KC_CONFIG" "$KC_ERR")
  kc_sign_in
}

# A token issued before a realm existed holds none of that realm's admin roles; step 1 signs in
# again once it has created one (the first live run got `null [HTTP 401 Unauthorized]` there).
# The password reaches the kcadm sign-in call alone (kc_once sets KC_CLI_PASSWORD on it), never
# the other commands kc runs. A sign-in that fails while step 1 has granted offline_access and
# not yet read the realm back takes the role out first, as every refusal of step 1 does; a
# sign-in failing during that withholding itself just stops.
# A client signs in with the secret read from KC_CLIENT_SECRET_FILE at that moment, so a secret
# rotated meanwhile is taken at the next sign-in, the 401 retry's included.
WITHHOLDING=0
kc_sign_in() {
  local who="the admin user" ok=0
  if [[ -n "$KC_CLIENT" ]]; then
    who="client $KC_CLIENT"
    if read_secret_file SIGN_IN_SECRET "$KC_CLIENT_SECRET_FILE" &&
      kc config credentials --server "$KC_URL" --realm master --client "$KC_CLIENT" >/dev/null; then ok=1; fi
    SIGN_IN_SECRET=""
  elif kc config credentials --server "$KC_URL" --realm master --user "$KC_ADMIN_USER" >/dev/null; then
    ok=1
  fi
  [[ "$ok" == 1 ]] && return 0
  if [[ "$WITHHOLD_ON_FAILED_READ" == 1 && "$WITHHOLDING" != 1 ]]; then
    refuse_withheld "could not sign in to $KC_URL as $who"
  fi
  die "could not sign in to $KC_URL as $who"
}

# --- run records ------------------------------------------------------------
issuer() { echo "https://$(target_public_host "$TARGET")/realms/$1"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# One line per catalogue step, as §5.5's decision on that step reads it:
# compute_terminated is this run's own record that it has ended, target_read
# the read of the realm object the step made. `admin_url` is the endpoint
# this run reached (a tunnel shows here); `provider` is the identity service
# by its public host.
step_record() {  # step_record <n> <target-resource-id> <read-at> <note>
  jq -cn --arg run "$RUN_ID" --argjson n "$1" --arg name "${STEP_NAMES[$1]}" --arg res "$2" \
    --arg read_at "$3" --arg note "$4" --arg iss "$(issuer "$REALM")" --arg admin "$KC_URL" \
    --arg provider "keycloak:$(target_public_host "$TARGET")" --arg at "$(now)" '
    {run_id: $run, step: $n, name: $name, outcome: "completed", issuer: $iss, admin_url: $admin,
     compute_terminated: {provider: $provider, resource_id: $run, request_id: "\($run)/\($n)", observed_at: $at},
     target_read: {provider: $provider, resource_id: $res, request_id: "\($run)/\($n)/read", observed_at: $read_at},
     note: $note}' |
    sed 's/^/run-record /'
}

# Account records are not catalogue steps: `bind_intended_owner` (§5.6) reads
# the account's (iss, sub) from them.
account_record() {  # account_record <step> <outcome> <user-id> <note>
  jq -cn --arg run "$RUN_ID" --arg step "$1" --arg outcome "$2" --arg res "$3" --arg note "$4" \
    --arg iss "$(issuer "$REALM")" --arg admin "$KC_URL" \
    --arg provider "keycloak:$(target_public_host "$TARGET")" --arg at "$(now)" '
    {run_id: $run, step: $step, outcome: $outcome, issuer: $iss, provider: $provider, admin_url: $admin,
     resource_id: $res, request_id: "\($run)/\($step)", observed_at: $at, note: $note}' |
    sed 's/^/run-record /'
}

# --- realm reads ------------------------------------------------------------
# Read by name, never from the realm list: a client holding create-realm only is refused the list
# (403) until it has made a realm, and any admin reads any realm's name (DEPLOY.md, "Core's
# realm-creation client"). A 404 is "no such realm"; any other failure stops.
realm_exists() {
  local r
  r="$(seg "the realm" "$1")" || exit 1
  [[ -n "$KC_ERR" ]] || die "realm_exists before kc_login"
  kc get "realms/$r" --fields realm >/dev/null 2>&1 && return 0
  kc_not_found "$KC_ERR" && return 1
  cat "$KC_ERR" >&2
  die "could not read realm '$1' on $KC_URL"
}

# Refuses unless the realm exists and carries the marker of its source file.
require_marked_realm() {  # require_marked_realm <realm> <source>
  realm_exists "$1" || die "realm '$1' does not exist (step 1 creates it)"
  local marker
  marker="$(kc get "realms/$1")" || die "could not read realm '$1'"
  marker="$(jq_read "realm '$1'" -r '.attributes.koderaRealmSource // ""' <<<"$marker")" || exit 1
  [[ "$marker" == "$2" ]] ||
    die "refused: realm '$1' is not marked koderaRealmSource=$2; this tool changes only the realms it created"
}

# read_live <realm> <groups> <what> — a partial export of the live realm,
# checked for the given groups; dies on drift. Sets READ_AT to the read's time.
READ_AT=""
# DISABLE_WORKER_ON_EXIT=1 (set by step 3 just before it enables the worker, cleared once the
# step is recorded): a refused read-back disables the worker again and says so, and any other exit
# in between does it in cleanup, so a failed step 3 never leaves it enabled.
DISABLE_WORKER_ON_EXIT=0
# WITHHOLD_ON_FAILED_READ=1 (set by step 1 on an organisation realm, once it has granted
# offline_access): a read-back that fails or does not match takes the role back out before the
# step exits, as every other refusal of step 1 does.
WITHHOLD_ON_FAILED_READ=0
read_refused() {  # read_refused <message>
  if [[ "$WITHHOLD_ON_FAILED_READ" == 1 ]]; then refuse_withheld "$1"; fi
  if [[ "$DISABLE_WORKER_ON_EXIT" == 1 ]]; then
    create_or_update_client "$WORKER_CLIENT" '.enabled = false' >/dev/null
    DISABLE_WORKER_ON_EXIT=0
    die "$1; client $WORKER_CLIENT is disabled again"
  fi
  die "$1"
}
read_live() {
  local exported synapse_origin="" docs_origin="" visio_host="" admin_origin=""
  exported="$(mktemp)"
  TMP_FILES+=("$exported")
  kc create "realms/$1/partial-export" -q exportClients=true -q exportGroupsAndRoles=true -o > "$exported" ||
    read_refused "could not read realm '$1' back"
  READ_AT="$(now)"
  if [[ "$1" != "$STAFF_REALM" ]]; then
    synapse_origin="$(target_synapse_origin "$TARGET" "$1")"
    docs_origin="$(target_docs_origin "$TARGET" "$1")"
    visio_host="$(target_visio_host "$TARGET" "$1")"
  else
    admin_origin="$(target_staff_admin_origin "$TARGET")"
  fi
  check_rep "$exported" "live realm $1" live "$2" "$ORIGIN" "$(target_mail_domain "$TARGET")" "$synapse_origin" "$docs_origin" "$visio_host" "$admin_origin" >&2 ||
    read_refused "realm '$1' does not match $3 (REALMS.md, \"Drift\")"
  if [[ "$2" == all || ",$2," == *,theme,* ]]; then
    local themes
    themes="$(jq_read "the themes of realm '$1'" -c '{loginTheme, accountTheme, emailTheme}' < "$exported")" || exit 1
    require_themes_installed "$themes"
  fi
}

# require_themes_installed <themes-json> — each theme the realm names is
# installed on the server. Keycloak falls back to its default theme, silently,
# when a realm names one it does not have (staging, 2026-10-07).
require_themes_installed() {
  local info missing
  info="$(kc_read object serverinfo serverinfo)" || exit 1
  jq_read "serverinfo" -e '.themes | type == "object"' <<<"$info" >/dev/null ||
    die "refused: $KC_URL answered serverinfo without a themes section; the installed themes are unknown"
  missing="$(jq_read "the themes installed on $KC_URL (serverinfo)" -r --argjson r "$1" '
      .themes as $t
      | {login: $r.loginTheme, account: $r.accountTheme, email: $r.emailTheme} | to_entries[]
      | select(.value as $n | ($t[.key] // []) | map(.name) | index($n) | not)
      | "\(.key) theme \(.value // "" | tojson)"' <<<"$info")" ||
    die "could not read the themes installed on $KC_URL (serverinfo)"
  [[ -z "$missing" ]] ||
    die "refused: not installed on $KC_URL (serverinfo): $(paste -sd, - <<<"$missing" | sed 's/,/, /g'); Keycloak would fall back to its default theme"
}

# The worker's service account holds manage-users and view-users of
# realm-management, and no other role than the realm's default one.
check_worker_roles() {
  local uid mappings
  uid="$(kc get users -r "$REALM" -q username="service-account-$WORKER_CLIENT" -q exact=true)" ||
    die "could not read the service account of $WORKER_CLIENT"
  uid="$(jq_read "the service account of $WORKER_CLIENT" -r '.[0].id // ""' <<<"$uid")" || exit 1
  [[ -n "$uid" ]] || die "client $WORKER_CLIENT has no service-account user in realm '$REALM'"
  uid="$(seg "the id of the service account of $WORKER_CLIENT" "$uid")" || exit 1
  mappings="$(kc get "users/$uid/role-mappings" -r "$REALM")" || die "could not read the roles of $WORKER_CLIENT's service account"
  jq_read "the roles of $WORKER_CLIENT's service account" -e --arg dr "default-roles-$REALM" '
      ((.clientMappings // {}) | keys) == ["realm-management"]
      and ([.clientMappings["realm-management"].mappings[].name] | sort) == ["manage-users", "view-users"]
      and all((.realmMappings // [])[]; .name == $dr)' <<<"$mappings" >/dev/null ||
    die "the service account of $WORKER_CLIENT must hold exactly manage-users and view-users of realm-management"
}

# Who holds a role of realm-management, directly or through a group: the worker's service
# account with manage-users and view-users, and nobody else. A worker token can create a user and
# give it manage-users (measured on 26.0.7, reported on #72: 201, then 204), and a rotation of the worker's secret
# does not take that holder away (REALMS.md, §5b). A role outside realm-management that nests one
# of its roles hands it to everyone holding that role, directly, through a group or through
# another composite, so no such role may exist. Any chain to a realm-management role ends in a
# role outside it that nests one directly: reading the direct composites of every composite realm
# and client role is enough. About 60 kcadm runs: it is its own command, `holders`, not part of
# step 6, which runs it would make minutes longer.
check_admin_holders() {
  local rm roles role users groups want bad="" names got clients client composite id label nested
  rm="$(kc_read array "client realm-management" clients -r "$REALM" -q clientId=realm-management)" || exit 1
  rm="$(jq_read "client realm-management" -r '[.[] | select(.clientId == "realm-management")][0].id // ""' <<<"$rm")" || exit 1
  [[ -n "$rm" ]] || die "realm '$REALM' has no client realm-management"
  rm="$(seg "the id of client realm-management" "$rm")" || exit 1
  roles="$(kc_read array "the roles of realm-management" "clients/$rm/roles" -r "$REALM")" || exit 1
  names="$(jq_read "the roles of realm-management" -r '.[].name' <<<"$roles")" || exit 1
  # An empty or partial list would pass vacuously: the two roles the worker holds must be in it.
  got="$(jq_read "the roles of realm-management" -c '[.[].name]' <<<"$roles")" || exit 1
  jq_read "the roles of realm-management" -e 'index("manage-users") and index("view-users")' <<<"$got" >/dev/null ||
    die "refused: realm '$REALM': the roles of realm-management were read without manage-users and view-users ($got); its holders cannot be checked"
  for role in $names; do
    role="$(seg "role $role of realm-management" "$role")" || exit 1
    users="$(kc_read array "the holders of $role" "clients/$rm/roles/$role/users" -r "$REALM")" || exit 1
    users="$(jq_read "the holders of $role" -r '[.[].username] | sort | join(",")' <<<"$users")" || exit 1
    groups="$(kc_read array "the groups holding $role" "clients/$rm/roles/$role/groups" -r "$REALM")" || exit 1
    groups="$(jq_read "the groups holding $role" -r '[.[].name] | sort | join(",")' <<<"$groups")" || exit 1
    case "$role" in manage-users | view-users) want="service-account-$WORKER_CLIENT" ;; *) want="" ;; esac
    [[ "$users" == "$want" && -z "$groups" ]] || bad="${bad:+$bad; }$role: users [$users], groups [$groups]"
  done
  composite="$(kc_read array "the realm roles" roles -r "$REALM")" || exit 1
  composite="$(jq_read "the realm roles" -r '.[] | select(.composite == true) | "\(.id) realm role \(.name)"' <<<"$composite")" || exit 1
  clients="$(kc_read array "the clients" clients -r "$REALM")" || exit 1
  clients="$(jq_read "the clients" -r --arg rm "$rm" '.[] | select(.id != $rm) | "\(.id) \(.clientId)"' <<<"$clients")" || exit 1
  while read -r id client; do
    [[ -n "$id" ]] || continue
    id="$(seg "the id of client $client" "$id")" || exit 1
    roles="$(kc_read array "the roles of client $client" "clients/$id/roles" -r "$REALM")" || exit 1
    roles="$(jq_read "the roles of client $client" -r --arg c "$client" '.[] | select(.composite == true) | "\(.id) role \($c)/\(.name)"' <<<"$roles")" || exit 1
    composite="$composite${roles:+$'\n'$roles}"
  done <<<"$clients"
  while read -r id label; do
    [[ -n "$id" ]] || continue
    id="$(seg "the id of $label" "$id")" || exit 1
    nested="$(kc_read array "the roles nested in $label" "roles-by-id/$id/composites" -r "$REALM")" || exit 1
    nested="$(jq_read "the roles nested in $label" -r --arg rm "$rm" \
      '[.[] | select(.clientRole == true and .containerId == $rm) | .name] | sort | join(",")' <<<"$nested")" || exit 1
    [[ -z "$nested" ]] || bad="${bad:+$bad; }$label nests realm-management [$nested]"
  done <<<"$composite"
  [[ -z "$bad" ]] ||
    die "realm '$REALM': only service-account-$WORKER_CLIENT may hold a realm-management role (manage-users, view-users), and no other role may nest one; $bad"
}

# --- steps ------------------------------------------------------------------
BODY=""
SOURCE=""
render_body() {
  local synapse_origin="" docs_origin="" visio_host="" admin_origin=""
  if [[ "$SOURCE" == "$TEMPLATE_FILE" ]]; then
    synapse_origin="$(target_synapse_origin "$TARGET" "$REALM")"
    docs_origin="$(target_docs_origin "$TARGET" "$REALM")"
    visio_host="$(target_visio_host "$TARGET" "$REALM")"
  else
    admin_origin="$(target_staff_admin_origin "$TARGET")"
  fi
  BODY="$(REALM_V="$REALM" ORIGIN_V="$ORIGIN" DOMAIN_V="$(target_mail_domain "$TARGET")" SYNAPSE_V="$synapse_origin" DOCS_V="$docs_origin" VISIO_V="$visio_host" ADMIN_V="$admin_origin" jq_read "$SOURCE" '
    walk(if type == "string" then
           gsub("\\$\\{REALM\\}"; env.REALM_V) | gsub("\\$\\{CONSOLE_ORIGIN\\}"; env.ORIGIN_V)
           | gsub("\\$\\{MAIL_DOMAIN\\}"; env.DOMAIN_V) | gsub("\\$\\{SYNAPSE_ORIGIN\\}"; env.SYNAPSE_V)
           | gsub("\\$\\{DOCS_ORIGIN\\}"; env.DOCS_V) | gsub("\\$\\{VISIO_HOST\\}"; env.VISIO_V)
           | gsub("\\$\\{STAFF_ADMIN_ORIGIN\\}"; env.ADMIN_V)
         else . end)' < "$FILE")" || exit 1
  local unresolved
  unresolved="$(jq_read "$SOURCE, rendered" 'del(.smtpServer.user)' <<<"$BODY")" || exit 1
  if grep -q '\${' <<<"$unresolved"; then
    die "$SOURCE: a placeholder is left unresolved"
  fi
}

step_args() {
  parse_args "$@"
  [[ -n "$FILE" && -f "$FILE" ]] || die "--file is required: a file from deploy/keycloak/realms/"
  cmd_check "$FILE"
  SOURCE="$(basename "$FILE")"
  local file_realm
  file_realm="$(jq_read "$SOURCE" -r .realm < "$FILE")" || exit 1
  if [[ "$file_realm" == '${REALM}' ]]; then
    [[ -n "$REALM" ]] || die "--realm is required with the template: the organisation slug"
    validate_slug "$REALM"
  else
    [[ -z "$REALM" || "$REALM" == "$file_realm" ]] || die "$SOURCE names realm '$file_realm'; drop --realm"
    REALM="$file_realm"
  fi
  require_realm_mode
  render_body
}

# offline_scope_id — the id of the realm's client scope offline_access, which
# Keycloak makes in every realm and maps to the realm role of that name.
# Callers add `|| exit 1`: the read runs in a command substitution.
offline_scope_id() {
  local scopes sid
  scopes="$(kc_read array "the client scopes of realm '$REALM'" client-scopes -r "$REALM")" || exit 1
  sid="$(jq_read "the client scopes of realm '$REALM'" -r '[.[] | select(.name == "offline_access")][0].id // ""' <<<"$scopes")" ||
    exit 1
  [[ -n "$sid" ]] || die "realm '$REALM' has no client scope offline_access; the native clients request it"
  seg "the id of client scope offline_access" "$sid"
}

# offline_offerers — who, besides the native clients, offers offline_access:
# "realm <keys>" for the realm's default client scope lists, "clients <ids>"
# for the clients, joined by ", "; nothing when nobody does.
# Callers add `|| exit 1`: the reads run in a command substitution.
offline_offerers() {
  local kind list clients realm_keys="" parts=()
  for kind in default-default-client-scopes default-optional-client-scopes; do
    list="$(kc_read array "the realm's $kind" "$kind" -r "$REALM")" || exit 1
    jq_read "the realm's $kind" -e 'any(.[]; .name == "offline_access")' <<<"$list" >/dev/null || continue
    case "$kind" in
      default-default-*) realm_keys="${realm_keys:+$realm_keys, }defaultDefaultClientScopes" ;;
      *) realm_keys="${realm_keys:+$realm_keys, }defaultOptionalClientScopes" ;;
    esac
  done
  [[ -z "$realm_keys" ]] || parts+=("realm $realm_keys")
  clients="$(kc_read array "the clients of realm '$REALM'" clients -r "$REALM")" || exit 1
  clients="$(jq_read "the clients of realm '$REALM'" -r --argjson natives "$NATIVE_CLIENTS" '
      [.[] | select(.clientId as $c | $natives | index($c) | not)
       | select(((.defaultClientScopes // []) + (.optionalClientScopes // [])) | index("offline_access") != null)
       | .clientId] | sort | join(", ")' <<<"$clients")" || exit 1
  [[ -z "$clients" ]] || parts+=("clients $clients")
  local part joined=""
  for part in ${parts[@]+"${parts[@]}"}; do joined="${joined:+$joined, }$part"; done
  [[ -z "$joined" ]] || echo "$joined"
}

# require_offline_rule_applied — refuses, before anything is written, a realm where a client or a
# realm default other than the native clients still offers offline_access: a realm made before
# I-2b, which step 1 has not converged yet. Steps 2 and 3 would otherwise write their clients and
# only then fail their read-back (REALMS.md, §5b).
require_offline_rule_applied() {
  local offerers
  offerers="$(offline_offerers)" || exit 1
  [[ -z "$offerers" ]] ||
    die "refused before writing: in realm '$REALM', $offerers still offer offline_access, which step 1 takes off; run step 1 first (REALMS.md, \"Realms made before offline sessions (I-2b)\")"
}

# Organisation realms (I-2b, option b): offline_access is in the default role,
# so the client scope lists are the only gate. Keycloak offers the scope to its
# built-in clients and, through the realm's default scopes, to every client made
# without scope lists; it is taken off both, and off any client but the native
# ones. While anyone else offers it, the role is withheld from the default role:
# it is removed first (a fresh realm has it from Keycloak), the scope is taken
# off, the clients and realm defaults are read again, and the step refuses if
# anyone still offers it, leaving the role withheld. Only then does
# ensure_offline_role grant it. Run again, nothing is withheld or taken off.
# Prints the note fragment.
take_offline_access_off_others() {
  local sid kind list clients id key before after taken_realm="" taken_clients=""
  before="$(offline_offerers)" || exit 1
  if [[ -z "$before" ]]; then echo "no other client and no realm default offers offline_access"; return 0; fi
  kc remove-roles -r "$REALM" --rname "default-roles-$REALM" --rolename offline_access >/dev/null ||
    die "could not withhold offline_access from the default role of realm '$REALM'"
  sid="$(offline_scope_id)" || exit 1
  for kind in default-default-client-scopes default-optional-client-scopes; do
    list="$(kc_read array "the realm's $kind" "$kind" -r "$REALM")" || exit 1
    jq_read "the realm's $kind" -e 'any(.[]; .name == "offline_access")' <<<"$list" >/dev/null || continue
    kc delete "$kind/$sid" -r "$REALM" >/dev/null ||
      die "could not take offline_access off the realm's $kind"
    case "$kind" in
      default-default-*) key=defaultDefaultClientScopes ;;
      *) key=defaultOptionalClientScopes ;;
    esac
    taken_realm="${taken_realm:+$taken_realm, }$key"
  done
  clients="$(kc_read array "the clients of realm '$REALM'" clients -r "$REALM")" || exit 1
  clients="$(jq_read "the clients of realm '$REALM'" -c --argjson natives "$NATIVE_CLIENTS" '
      [.[] | select(.clientId as $c | $natives | index($c) | not)
       | {id, clientId, default: ((.defaultClientScopes // []) | index("offline_access") != null),
          optional: ((.optionalClientScopes // []) | index("offline_access") != null)}
       | select(.default or .optional)] | sort_by(.clientId)' <<<"$clients")" || exit 1
  local strips
  strips="$(jq_read "the clients of realm '$REALM' to strip" -r \
    '.[] | (select(.default) | [.id, "default"]), (select(.optional) | [.id, "optional"]) | @tsv' <<<"$clients")" || exit 1
  while IFS=$'\t' read -r id key <&3; do
    [[ -n "$id" ]] || continue
    id="$(seg "a client id" "$id")" || exit 1
    kc delete "clients/$id/$key-client-scopes/$sid" -r "$REALM" >/dev/null ||
      die "could not take offline_access off the $key client scopes of client id $id"
  done 3<<<"$strips"
  taken_clients="$(jq_read "the clients of realm '$REALM' to strip" -r 'map(.clientId) | join(", ")' <<<"$clients")" || exit 1
  after="$(offline_offerers)" || exit 1
  [[ -z "$after" ]] ||
    die "refused: offline_access is still offered after step 1 took it off: $after; offline_access was not added to the default role"
  if [[ -z "$taken_clients" ]]; then
    echo "offline_access withheld from the default role, then taken off the realm's default scopes ($taken_realm)"
  elif [[ -z "$taken_realm" ]]; then
    echo "offline_access withheld from the default role, then taken off clients $taken_clients"
  else
    echo "offline_access withheld from the default role, then taken off the realm's default scopes ($taken_realm) and off clients $taken_clients"
  fi
}

# Before any grant (I-2b): every member will hold offline_access through the
# default role, so nothing may be nested in either, and no client but the
# native ones may hold an offline session. Any doubt refuses with the role
# withheld from the default role; nothing here ever adds it.
withhold_offline_role() {
  WITHHOLDING=1
  kc remove-roles -r "$REALM" --rname "default-roles-$REALM" --rolename offline_access >/dev/null ||
    die "could not withhold offline_access from the default role of realm '$REALM'"
}
refuse_withheld() { withhold_offline_role; die "$1; offline_access is withheld from the default role"; }

# read_or_withhold <object|array> <what> <kcadm get args...> — kc_read's shape
# check, refusing with the role withheld. Callers add `|| exit 1`.
read_or_withhold() {
  local type="$1" what="$2" out shape
  shift 2
  out="$(kc get "$@" 2>/dev/null)" || refuse_withheld "refused: $what could not be read: the request failed"
  shape="$(jq -rs --arg t "$type" 'if length != 1 then "\(length) JSON values"
      elif (.[0] | type) != $t then "a JSON \(.[0] | type)" else "ok" end' <<<"$out" 2>/dev/null)" || shape="invalid JSON"
  [[ "$shape" == ok ]] || refuse_withheld "refused: $what could not be read: $shape, not a JSON $type"
  printf '%s\n' "$out"
}

# role_grants <clients-json> — a role's composites list (GET roles/<r>/composites)
# as "realm roles; client: roles", or "nothing".
role_grants() {
  jq_read "the roles a role grants" -r --argjson clients "$1" '
      ($clients | map({(.id): .clientId}) | add // {}) as $ids
      | ([.[] | select(.clientRole != true) | .name] | sort)
        + ([.[] | select(.clientRole == true) | {c: ($ids[.containerId] // .containerId), n: .name}]
           | group_by(.c) | map("\(.[0].c): \(map(.n) | sort | join(", "))"))
      | if . == [] then "nothing" else join("; ") end'
}

# The role itself is not composite, and the default role grants nothing but
# offline_access and the account roles Keycloak gives it. A role nested in
# either would reach every member with the grant.
require_offline_role_safe() {
  local role comps clients granted
  clients="$(read_or_withhold array "the clients of realm '$REALM'" clients -r "$REALM")" || exit 1
  role="$(read_or_withhold object "the realm role offline_access" roles/offline_access -r "$REALM")" || exit 1
  comps="$(read_or_withhold array "the composites of the realm role offline_access" roles/offline_access/composites -r "$REALM")" ||
    exit 1
  granted="$(role_grants "$clients" <<<"$comps")" || exit 1
  if jq_read "the realm role offline_access" -e '.composite == true' <<<"$role" >/dev/null || [[ "$granted" != nothing ]]; then
    refuse_withheld "refused: the realm role offline_access is composite (it grants $granted): every member would inherit it"
  fi
  comps="$(read_or_withhold array "the composites of default-roles-$REALM" "roles/default-roles-$REALM/composites" -r "$REALM")" ||
    exit 1
  granted="$(role_grants "$clients" <<<"$comps")" || exit 1
  jq_read "the composites of default-roles-$REALM" -e --argjson clients "$clients" '
      ($clients | map({(.id): .clientId}) | add // {}) as $ids
      | ([.[] | select(.clientRole != true) | .name] - ["offline_access"]) == []
        and ([.[] | select(.clientRole == true) | "\($ids[.containerId] // .containerId)/\(.name)"] | sort)
            == ["account/manage-account", "account/view-profile"]' <<<"$comps" >/dev/null ||
    refuse_withheld "refused: the default role grants $granted; it may grant only offline_access and account: manage-account, view-profile"
  require_stock_expansion "$clients" "$comps"
}

# Keycloak 26.0.7 nests one role in the account roles it gives the default role
# (RealmManager.setupAccountManagement, read from the image's bytecode):
# account/manage-account nests account/manage-account-links, and
# account/view-profile nests nothing. Every role nested below the default
# role's composites is read (GET roles-by-id/<id>/composites, depth-first, at
# most STOCK_WALK_MAX roles), and anything beyond that expansion refuses.
STOCK_EXPANSION='["account/manage-account","account/manage-account-links","account/view-profile"]'
STOCK_WALK_MAX=50
require_stock_expansion() {  # <clients-json> <the default role's composites>
  local queue seen="" id nested extra count=0
  queue="$(jq_read "the composites of default-roles-$REALM" -r '.[].id // empty' <<<"$2")" || exit 1
  local all="$2" more
  while [[ -n "$queue" ]]; do
    # Shell splitting cannot fail empty like an external head/tail read.
    id="${queue%%$'\n'*}"
    if [[ "$queue" == *$'\n'* ]]; then queue="${queue#*$'\n'}"; else queue=""; fi
    # Plain before anything else is done with it, the bookkeeping included.
    seg_ok "$id" || refuse_withheld "refused: the role id '$id' is not a plain identifier ($SEG_RULE); it is not put in a path"
    [[ " $seen " == *" $id "* ]] && continue
    seen="$seen $id"
    count=$((count + 1))
    (( count <= STOCK_WALK_MAX )) ||
      refuse_withheld "refused: the default role nests more than $STOCK_WALK_MAX roles; Keycloak's own nest three"
    nested="$(read_or_withhold array "the roles nested in role $id" "roles-by-id/$(seg "role id" "$id")/composites" -r "$REALM")" ||
      exit 1
    all="$(jq_read "the roles nested below the default role" -c --argjson n "$nested" '. + $n' <<<"$all")" || exit 1
    # The ids of the roles nested in this one, read on their own: a failure here would otherwise
    # leave its descendants unread, and a forbidden role below them unseen.
    more="$(jq_read "the roles nested in role $id" -r '.[].id // empty' <<<"$nested")" || exit 1
    if [[ -n "$more" ]]; then queue="${queue:+$queue$'\n'}$more"; fi
  done
  extra="$(jq_read "the roles nested below the default role" -r --argjson clients "$1" --argjson stock "$STOCK_EXPANSION" '
      ($clients | map({(.id): .clientId}) | add // {}) as $ids
      | [.[] | select(.clientRole == true) | {c: ($ids[.containerId] // .containerId), n: .name}
         | select(("\(.c)/\(.n)") as $k | $stock | index($k) | not)]
        + [.[] | select(.clientRole != true and .name != "offline_access") | {c: "", n: .name}]
      | unique | group_by(.c)
      | map(if .[0].c == "" then (map(.n) | join(", ")) else "\(.[0].c): \(map(.n) | join(", "))" end)
      | join("; ")' <<<"$all")" || exit 1
  [[ -z "$extra" ]] ||
    refuse_withheld "refused: the default role grants, through the roles it nests, $extra; beyond Keycloak's own (account: manage-account, manage-account-links, view-profile)"
}

# offline_sessions_elsewhere <clients-json> — "clientId<TAB>userId" for every
# offline session of a client other than the native ones, every page read
# (GET clients/<id>/offline-sessions, 100 a page).
# At most OFFLINE_PAGES_MAX pages a client: past that, the step refuses rather
# than revoke an unbounded number one by one.
OFFLINE_PAGES_MAX=100
offline_sessions_elsewhere() {
  local id cid first page pages lines kind uid list
  # The client list in a variable first: jq failing on it is a refusal, never "no client", which
  # would list no session and let the role be granted.
  list="$(jq_read "the clients of realm '$REALM', listed for their offline sessions" -r --argjson natives "$NATIVE_CLIENTS" \
      'sort_by(.clientId)[] | select(.clientId as $c | $natives | index($c) | not) | [.id, .clientId] | @tsv' <<<"$1")" ||
    exit 1
  while IFS=$'\t' read -r id cid <&3; do
    [[ -n "$id" ]] || continue
    seg_ok "$id" ||
      refuse_withheld "refused: the id '$id' of client $cid is not a plain identifier ($SEG_RULE); it is not put in a path"
    first=0 pages=0
    while :; do
      page="$(read_or_withhold array "the offline sessions of client $cid (page from $first)" \
        "clients/$(seg "client id" "$id")/offline-sessions" -r "$REALM" -q first="$first" -q max=100)" || exit 1
      pages=$((pages + 1))
      # Each session's userId, checked here, before any delete: a string, and plain. jq failing
      # (a page whose entries are not sessions) is a refusal, never an empty page; with errexit
      # off inside $( ), its silence would otherwise read as "no session".
      # A control character (a newline, a tab) would split or shift the line: it is refused whole.
      lines="$(jq_read "the offline sessions of client $cid (page from $first)" -r '.[] | .userId
          | if type != "string" then "type\t\(tojson)"
            elif (explode | any(. < 32 or . == 127)) then "ctl\t\(tojson)"
            else "ok\t\(.)" end' <<<"$page")" || exit 1
      while IFS=$'\t' read -r kind uid; do
        [[ -n "$kind" ]] || continue
        [[ "$kind" != ctl ]] ||
          refuse_withheld "refused: an offline session of client $cid has a userId with a control character: $uid"
        [[ "$kind" == ok ]] ||
          refuse_withheld "refused: an offline session of client $cid has a userId that is not a string: $uid"
        seg_ok "$cid" ||
          refuse_withheld "refused: the clientId '$cid' of an offline session is not a plain identifier ($SEG_RULE); it is not put in a path"
        seg_ok "$uid" ||
          refuse_withheld "refused: the userId '$uid' of an offline session is not a plain identifier ($SEG_RULE); it is not put in a path"
        printf '%s\t%s\n' "$cid" "$uid"
      done <<<"$lines"
      local size
      size="$(jq_read "the offline sessions of client $cid (page from $first)" length <<<"$page")" || exit 1
      (( size < 100 )) && break
      (( pages < OFFLINE_PAGES_MAX )) ||
        refuse_withheld "refused: client $cid has more than $((OFFLINE_PAGES_MAX * 100)) offline sessions ($pages pages read); they are not revoked one by one"
      first=$((first + 100))
    done
  done 3<<<"$list"
}

# Stripping the scope does not end offline sessions a client already holds, and
# a refresh is decided on the old token's scope: once the role is back, such a
# token would refresh again. Each one is revoked by deleting the user's grant
# to that client (DELETE users/<id>/consents/<clientId>, which on Keycloak 26
# removes the consent and the client's offline sessions; measured on 26.0.7 in
# the realm-revocation lab proof), with the role withheld; then none may remain.
# Prints the note fragment.
revoke_other_offline_sessions() {
  local clients found remain uid cid
  clients="$(read_or_withhold array "the clients of realm '$REALM'" clients -r "$REALM")" || exit 1
  found="$(offline_sessions_elsewhere "$clients")" || exit 1
  if [[ -z "$found" ]]; then echo "no offline session on another client"; return 0; fi
  # offline_sessions_elsewhere checked every identifier while it listed them, before any delete.
  withhold_offline_role
  while IFS=$'\t' read -r cid uid <&3; do
    kc delete "users/$(seg userId "$uid")/consents/$(seg clientId "$cid")" -r "$REALM" >/dev/null ||
      refuse_withheld "could not revoke the offline sessions of user $uid on client $cid"
  done 3< <(sort -u <<<"$found")
  remain="$(offline_sessions_elsewhere "$clients")" || exit 1
  [[ -z "$remain" ]] ||
    refuse_withheld "refused: offline sessions remain on clients other than the native ones after their revocation: $(cut -f1 <<<"$remain" | sort | uniq -c | awk '{print $2 " " $1}' | paste -sd, - | sed 's/,/, /g')"
  echo "offline sessions of other clients revoked: $(cut -f1 <<<"$found" | sort | uniq -c | awk '{print $2 " " $1}' | paste -sd, - | sed 's/,/, /g')"
}

# Organisation realms: offline_access in the default role, added when missing
# (a realm made by #60, whose step 1 removed it). Prints the note fragment.
ensure_offline_role() {
  local granted
  granted="$(kc_read array "the realm roles of default-roles-$REALM" "roles/default-roles-$REALM/composites/realm" -r "$REALM")" ||
    exit 1
  if jq_read "the realm roles of default-roles-$REALM" -e 'any(.[]; .name == "offline_access")' <<<"$granted" >/dev/null; then
    echo "offline_access in the default role: present"; return 0
  fi
  kc add-roles -r "$REALM" --rname "default-roles-$REALM" --rolename offline_access >/dev/null ||
    die "could not add offline_access to the default role of realm '$REALM'"
  echo "offline_access in the default role: added"
}

# 1: the realm's settings and flows. Flows are part of the realm from its
# creation, so it never exists with Keycloak's default browser flow; an
# update never touches flows, clients, mail or theme. Keycloak always adds
# offline_access and uma_authorization to the default role. uma_authorization
# is removed. On the staff realm offline_access is removed too; on an
# organisation realm it stays, or is added back to a realm made before I-2b,
# once no client but the native ones offers it (the scope lists are the gate).
step_1() {
  local note
  if realm_exists "$REALM"; then
    require_marked_realm "$REALM" "$SOURCE"
    local settings
    settings="$(jq_read "$SOURCE, rendered" 'del(.clients, .authenticationFlows, .authenticatorConfig, .requiredActions, .users, .browserFlow,
            .directGrantFlow, .smtpServer, .loginTheme, .accountTheme, .emailTheme)' <<<"$BODY")" || exit 1
    kc update "realms/$REALM" -f - <<<"$settings" >/dev/null || die "could not update realm '$REALM'"
    note="realm existed with marker $SOURCE: settings updated"
  else
    local created
    created="$(jq_read "$SOURCE, rendered" 'del(.clients, .smtpServer, .loginTheme, .accountTheme, .emailTheme)' <<<"$BODY")" ||
      exit 1
    kc create realms -f - <<<"$created" >/dev/null || die "could not create realm '$REALM'"
    kc_sign_in
    note="realm created from $SOURCE, with no client"
  fi
  if [[ "$SOURCE" == "$TEMPLATE_FILE" ]]; then
    OFFLINE_PHASE=1
    kc remove-roles -r "$REALM" --rname "default-roles-$REALM" --rolename uma_authorization >/dev/null ||
      die "could not remove uma_authorization from the default role of realm '$REALM'"
    # Withheld, taken off every other client, read again, and only then
    # granted: the role never meets a client that may request it.
    note="$note; $(take_offline_access_off_others)" || exit 1
    note="$note; $(revoke_other_offline_sessions)" || exit 1
    require_offline_role_safe
    note="$note; $(ensure_offline_role)" || exit 1
    note="$note; $(ensure_email_admin_only)" || exit 1
    WITHHOLD_ON_FAILED_READ=1
  else
    kc remove-roles -r "$REALM" --rname "default-roles-$REALM" \
      --rolename offline_access --rolename uma_authorization >/dev/null ||
      die "could not remove offline_access from the default role of realm '$REALM'"
    ensure_staff_required_actions
  fi
  read_live "$REALM" settings,flows,offline "$SOURCE after step 1"
  if [[ "$SOURCE" == "$TEMPLATE_FILE" ]]; then check_email_admin_only; fi
  step_record 1 "$(issuer "$REALM")" "$READ_AT" "$note"
}

# Staff realm: an explicit `requiredActions` array in a realm file replaces Keycloak's default
# registrations on create, and a realm update ignores `.requiredActions`. Register any action from
# kodera-staff.json that a pre-existing realm lacks, then write each action's enabled/priority
# state through authentication/required-actions.
ensure_staff_required_actions() {
  local live entry alias provider name safe_alias
  live="$(kc_read array "the required actions of realm '$REALM'" authentication/required-actions -r "$REALM")" || exit 1
  while IFS= read -r entry <&3; do
    [[ -n "$entry" ]] || continue
    alias="$(jq_read "staff requiredAction" -r '.alias' <<<"$entry")" || exit 1
    provider="$(jq_read "staff requiredAction" -r '.providerId' <<<"$entry")" || exit 1
    name="$(jq_read "staff requiredAction" -r '.name' <<<"$entry")" || exit 1
    safe_alias="$(seg "required action alias" "$alias")" || exit 1
    seg "required action providerId" "$provider" >/dev/null || exit 1
    if ! jq_read "the required actions of realm '$REALM'" -e --arg a "$alias" 'any(.[]; .alias == $a)' <<<"$live" >/dev/null; then
      kc create authentication/register-required-action -r "$REALM" -f - \
        <<<"$(jq_read "staff requiredAction registration" -cn --arg p "$provider" --arg n "$name" '{providerId: $p, name: $n}')" >/dev/null ||
        die "could not register required action '$alias' in realm '$REALM'"
    fi
    kc update "authentication/required-actions/$safe_alias" -r "$REALM" -f - <<<"$entry" >/dev/null ||
      die "could not configure required action '$alias' in realm '$REALM'"
  done 3< <(jq_read "$SOURCE, rendered" -c '.requiredActions[]' <<<"$BODY")
}

# Organisation realms: a member cannot change their own email. Docs grants an invitation, and
# Core binds a membership, by the email the account holds, so only the admin context (the Admin
# API: Core, this tool) may change it. The rest of the user profile stays Keycloak's own; a realm
# update does not carry it, so step 1 sets it through users/profile and steps 1 and 6 read it.
EMAIL_PERMISSIONS='{"view":["admin","user"],"edit":["admin"]}'
ensure_email_admin_only() {  # prints a note fragment
  local up want
  up="$(kc_read object "the user profile of realm '$REALM'" users/profile -r "$REALM")" || exit 1
  if jq_read "the user profile of realm '$REALM'" -e --argjson p "$EMAIL_PERMISSIONS" \
      'all(.attributes[]? | select(.name == "email"); .permissions == $p)' <<<"$up" >/dev/null; then
    echo "email editable by administrators only: in place"
    return 0
  fi
  want="$(jq_read "the user profile of realm '$REALM'" -c --argjson p "$EMAIL_PERMISSIONS" \
    '(.attributes[]? | select(.name == "email") | .permissions) = $p' <<<"$up")" || exit 1
  kc update users/profile -r "$REALM" -f - <<<"$want" >/dev/null ||
    die "could not set the user profile of realm '$REALM'"
  echo "email editable by administrators only: set"
}
check_email_admin_only() {
  local up got
  up="$(kc_read object "the user profile of realm '$REALM'" users/profile -r "$REALM")" || exit 1
  got="$(jq_read "the user profile of realm '$REALM'" -c '[.attributes[]? | select(.name == "email") | .permissions]' <<<"$up")" || exit 1
  jq_read "the user profile of realm '$REALM'" -e --argjson p "$EMAIL_PERMISSIONS" '
      length == 1 and ((.[0].view // []) | sort) == $p.view and (.[0].edit // []) == $p.edit' <<<"$got" >/dev/null ||
    die "realm '$REALM': the email must be viewable by admin and user and editable by admin only (user profile); is $got"
}

# create_or_update_client <clientId> — from the rendered file; prints its id.
create_or_update_client() {  # create_or_update_client <clientId> [filter applied to the rendered body]
  local cid body
  body="$(jq_read "$SOURCE, rendered" --arg c "$1" ".clients[] | select(.clientId == \$c) | ${2:-.}" <<<"$BODY")" || exit 1
  cid="$(kc get clients -r "$REALM" -q clientId="$1")" || die "could not read client $1"
  cid="$(jq_read "client $1" -r --arg c "$1" '[.[] | select(.clientId == $c)][0].id // ""' <<<"$cid")" || exit 1
  if [[ -n "$cid" ]]; then
    cid="$(seg "the id of client $1" "$cid")" || exit 1
    local update
    update="$(jq_read "client $1, rendered" 'del(.protocolMappers)' <<<"$body")" || exit 1
    kc update "clients/$cid" -r "$REALM" -f - <<<"$update" >/dev/null || die "could not update client $1"
  else
    cid="$(kc create clients -r "$REALM" -f - -i <<<"$body")" || die "could not create client $1"
    [[ -n "$cid" ]] || die "Keycloak returned no id for client $1"
    cid="$(seg "the id of client $1" "$cid")" || exit 1
  fi
  echo "$cid"
}

# The server must have the mapper's provider before step 2 writes the mapper:
# a mapper whose provider the server lacks is skipped at token time (the sort in
# ProtocolMapperUtils drops it),
# so every Console token would lack the claim and Core would refuse them all.
require_registered_factor_installed() {
  local info
  info="$(kc_read object serverinfo serverinfo)" || exit 1
  jq_read "serverinfo" -e --arg p "$RF_PROVIDER" '(.providers["protocol-mapper"].providers? // null) | type == "object" and has($p)' \
      <<<"$info" >/dev/null ||
    die "refused: $KC_URL does not list protocol mapper $RF_PROVIDER (serverinfo); deploy the Keycloak image that carries it before step 2 (REALMS.md, \"Registered-factor mapper\")"
}

# registered_factor_state <console client id> — "missing" when the console
# client has no registered-factor mapper, "ok" when it has exactly the
# template's one and nothing else that touches the claim. Anything else is
# refused: Core trusts the claim, so a wrong mapper is never repaired around.
# Callers add `|| exit 1`: the read runs in a command substitution.
registered_factor_state() {
  local mappers found
  mappers="$(kc_read array "the protocol mappers of client console" "clients/$1/protocol-mappers/models" -r "$REALM")" ||
    exit 1
  found="$(jq_read "the protocol mappers of client console" -c --arg p "$RF_PROVIDER" --arg n "$RF_NAME" --arg c "$RF_CLAIM" '
      [.[] | select(.protocolMapper == $p or .name == $n
                    or any((.config // {}) | to_entries[]?; (.value | type) == "string" and (.value | contains($c))))]' <<<"$mappers")" || exit 1
  if [[ "$found" == "[]" ]]; then echo missing; return 0; fi
  if jq_read "the registered-factor mappers of client console" -e --arg p "$RF_PROVIDER" --arg n "$RF_NAME" '
      length == 1 and (.[0] | .protocolMapper == $p and .name == $n and .protocol == "openid-connect"
                       and (.config // {}) == {} and (.consentRequired // false) == false)' <<<"$found" >/dev/null; then
    echo ok; return 0
  fi
  die "refused: client console carries a registered-factor mapper that is not the template's: $(jq -c 'map({name, protocolMapper, config})' <<<"$found" || echo "$found"); delete it by hand (REALMS.md, \"Registered-factor mapper\") and run step 2 again"
}

# The organisation console's registered-factor mapper: created when missing (a
# realm made before it, so step 2 run again is the migration), left untouched
# when it is the template's. create_or_update_client never writes mappers on an
# update. Prints the note fragment for the record.
ensure_registered_factor_mapper() {  # <console client id>
  local state
  state="$(registered_factor_state "$1")" || exit 1
  if [[ "$state" == ok ]]; then echo "registered-factor mapper in place"; return 0; fi
  local mapper
  mapper="$(jq_read "$SOURCE, rendered" --arg n "$RF_NAME" \
    '.clients[] | select(.clientId == "console") | .protocolMappers[] | select(.name == $n)' <<<"$BODY")" || exit 1
  kc create "clients/$1/protocol-mappers/models" -r "$REALM" -f - <<<"$mapper" >/dev/null ||
    die "could not add the registered-factor mapper to client console"
  state="$(registered_factor_state "$1")" || exit 1
  [[ "$state" == ok ]] || die "client console has no registered-factor mapper after adding it"
  echo "registered-factor mapper added"
}

# The native apps' clients, from the rendered file. A realm made before them
# gets them from step 2 run again: that is the migration. An existing one is
# updated like console, its mappers never written. Each offers offline_access
# as an optional scope (I-2b): a client made before it gets the scope through
# the client's own scope endpoint, since an update is not relied on to change
# scope lists. Prints the note fragment.
ensure_native_clients() {
  local n cid found state scope_state sid optional note="" scope_note=""
  sid="$(offline_scope_id)" || exit 1
  local natives
  natives="$(jq_read "the native clients" -r '.[]' <<<"$NATIVE_CLIENTS")" || exit 1
  for n in $natives; do
    found="$(kc get clients -r "$REALM" -q clientId="$n")" || die "could not read client $n"
    found="$(jq_read "client $n" -c --arg c "$n" '[.[] | select(.clientId == $c)][0] // {}' <<<"$found")" || exit 1
    if jq_read "client $n" -e '.id // false' <<<"$found" >/dev/null; then state=present; else state=added; fi
    if jq_read "client $n" -e '(.optionalClientScopes // []) | index("offline_access") != null' <<<"$found" >/dev/null; then
      scope_state=present
    else
      scope_state=added
    fi
    cid="$(create_or_update_client "$n")" || exit 1
    optional="$(kc_read array "the optional client scopes of client $n" "clients/$cid/optional-client-scopes" -r "$REALM")" || exit 1
    if ! jq_read "the optional client scopes of client $n" -e 'any(.[]; .name == "offline_access")' <<<"$optional" >/dev/null; then
      kc update "clients/$cid/optional-client-scopes/$sid" -r "$REALM" >/dev/null ||
        die "could not offer offline_access to client $n"
    fi
    note="${note:+$note, }$n $state"
    scope_note="${scope_note:+$scope_note, }$n $scope_state"
  done
  echo "native clients: $note; offline_access optional scope: $scope_note"
}

step_2() {
  require_marked_realm "$REALM" "$SOURCE"
  local cid note
  if [[ "$SOURCE" == "$TEMPLATE_FILE" ]]; then
    require_offline_rule_applied
    require_registered_factor_installed
    # A wrong mapper is refused before anything is written.
    cid="$(kc get clients -r "$REALM" -q clientId=console)" || die "could not read client console"
    cid="$(jq_read "client console" -r '[.[] | select(.clientId == "console")][0].id // ""' <<<"$cid")" || exit 1
    if [[ -n "$cid" ]]; then
      cid="$(seg "the id of client console" "$cid")" || exit 1
      registered_factor_state "$cid" >/dev/null || exit 1
    fi
  fi
  cid="$(create_or_update_client console)"
  note="client console, origin $ORIGIN"
  if [[ "$SOURCE" == "$STAFF_FILE" ]]; then
    create_or_update_client "$ADMIN_CLIENT" >/dev/null
    note="clients console ($ORIGIN) and $ADMIN_CLIENT ($(target_staff_admin_origin "$TARGET"))"
  fi
  if [[ "$SOURCE" == "$TEMPLATE_FILE" ]]; then
    create_or_update_client "$SYNAPSE_CLIENT" >/dev/null
    note="clients console ($ORIGIN) and $SYNAPSE_CLIENT ($(target_synapse_origin "$TARGET" "$REALM"))"
    # Docs is prepared, not deployed: its client is made only on request, as the Visio
    # client is. A run without the option leaves an existing one in place, updated by
    # neither.
    if [[ "$DOCS" == 1 ]]; then
      create_or_update_client "$DOCS_CLIENT" >/dev/null
      note="$note; Docs client $DOCS_CLIENT ($(target_docs_origin "$TARGET" "$REALM"))"
    fi
    if [[ "$VISIO" == 1 ]]; then
      create_or_update_client "$(target_visio_host "$TARGET" "$REALM")" >/dev/null
      note="$note; Visio client $(target_visio_host "$TARGET" "$REALM")"
    fi
    note="$note; $(ensure_native_clients)" || exit 1
    note="$note; $(ensure_registered_factor_mapper "$cid")" || exit 1
  fi
  read_live "$REALM" client,offline "$SOURCE after step 2"
  step_record 2 "$cid" "$READ_AT" "$note"
}

step_3() {
  require_marked_realm "$REALM" "$SOURCE"
  [[ "$SOURCE" == "$TEMPLATE_FILE" ]] ||
    die "refused: step 3 is for organisation realms; the staff realm has no service account"
  require_offline_rule_applied
  local cid
  # The client is written disabled and enabled only once its service account holds exactly
  # its two roles, so a failed run leaves no enabled client with a missing or extra role. On a
  # realm where it was enabled, a re-run disables it for the length of the run. It is enabled
  # with its whole body: on Keycloak 26.0.7, after an update carrying only "enabled", step 6
  # found no service-account user for the client (CI, run 41810473367). The roles are read
  # again after it.
  cid="$(create_or_update_client "$WORKER_CLIENT" '.enabled = false')"
  kc add-roles -r "$REALM" --uusername "service-account-$WORKER_CLIENT" --cclientid realm-management \
    --rolename manage-users --rolename view-users >/dev/null ||
    die "could not give the service account of $WORKER_CLIENT its roles; the client is left disabled"
  check_worker_roles
  DISABLE_WORKER_ON_EXIT=1
  create_or_update_client "$WORKER_CLIENT" >/dev/null
  if ! (check_worker_roles); then
    create_or_update_client "$WORKER_CLIENT" '.enabled = false' >/dev/null
    DISABLE_WORKER_ON_EXIT=0
    die "the roles of $WORKER_CLIENT changed when it was enabled; the client is disabled again"
  fi
  read_live "$REALM" worker,offline "$SOURCE after step 3"
  step_record 3 "$cid" "$READ_AT" "client $WORKER_CLIENT: service account, manage-users and view-users, enabled; its secret is never read"
  DISABLE_WORKER_ON_EXIT=0
}

# 4: hosted accounts, no broker. Nothing to write in the pilot: the step reads
# that no identity provider exists and that the browser flow is bound.
step_4() {
  require_marked_realm "$REALM" "$SOURCE"
  read_live "$REALM" flows,idp "$SOURCE at step 4"
  local factor=OTP
  [[ "$SOURCE" == "$STAFF_FILE" ]] && factor="security-key (WebAuthn)"
  step_record 4 "$(issuer "$REALM")" "$READ_AT" "hosted accounts: no identity provider; the password-then-$factor browser flow was made with the realm at step 1"
}

# Before an operator step 5 writes smtpServer to a real realm (or when KC_SMTP_VERIFY_SERVER points
# at a local lab relay), prove TCP, STARTTLS certificate verification for smtpServer.host and SMTP
# AUTH with the supplied credentials, without sending a message. Core's job worker signs in with
# KC_CLIENT_ID inside br-kc-worker, whose egress firewall drops every SMTP port on purpose, so a
# client run probes SMTP only when KC_SMTP_VERIFY_SERVER is explicitly set.
verify_smtp_auth() {
  local smtp_host smtp_port connect_host connect_port
  if [[ ( "$SYNTHETIC_MODE" == 1 || -n "$KC_CLIENT" ) && -z "${KC_SMTP_VERIFY_SERVER:-}" ]]; then
    return 0
  fi
  smtp_host="$(jq_read "$SOURCE, rendered" -r '.smtpServer.host' <<<"$BODY")" || exit 1
  smtp_port="$(jq_read "$SOURCE, rendered" -r '.smtpServer.port' <<<"$BODY")" || exit 1
  connect_host="$smtp_host"
  connect_port="$smtp_port"
  if [[ -n "${KC_SMTP_VERIFY_SERVER:-}" ]]; then
    [[ "$KC_SMTP_VERIFY_SERVER" =~ ^(localhost|127\.0\.0\.1):([0-9]{1,5})$ ]] ||
      die "refused: KC_SMTP_VERIFY_SERVER '$KC_SMTP_VERIFY_SERVER' must be a local tunnel (127.0.0.1:<port> or localhost:<port>)"
    connect_host="${KC_SMTP_VERIFY_SERVER%:*}"
    connect_port="${KC_SMTP_VERIFY_SERVER##*:}"
  fi
  KC_SMTP_HOST="$smtp_host" KC_SMTP_PORT="$smtp_port" \
  KC_SMTP_CONNECT_HOST="$connect_host" KC_SMTP_CONNECT_PORT="$connect_port" \
  KC_SMTP_USER="$SMTP_USER" KC_SMTP_PASSWORD="$SMTP_PASSWORD" \
  python3 -c '
import os, smtplib, ssl, sys

smtp_host = os.environ["KC_SMTP_HOST"]
smtp_port = int(os.environ["KC_SMTP_PORT"])
connect_host = os.environ["KC_SMTP_CONNECT_HOST"]
connect_port = int(os.environ["KC_SMTP_CONNECT_PORT"])
user = os.environ["KC_SMTP_USER"]
password = os.environ["KC_SMTP_PASSWORD"]

ctx = ssl.create_default_context()
if (
    not os.environ.get("SSL_CERT_FILE")
    and not os.environ.get("SSL_CERT_DIR")
    and not ctx.get_ca_certs()
    and os.path.isfile("/etc/ssl/cert.pem")
):
    ctx.load_verify_locations(cafile="/etc/ssl/cert.pem")

try:
    with smtplib.SMTP(connect_host, connect_port, timeout=15) as client:
        code, _ = client.ehlo()
        if not (200 <= code < 300):
            raise RuntimeError(f"EHLO before STARTTLS returned {code}")
        client._host = smtp_host
        code, _ = client.starttls(context=ctx)
        if code != 220:
            raise RuntimeError(f"STARTTLS returned {code}, expected 220")
        code, _ = client.ehlo()
        if not (200 <= code < 300):
            raise RuntimeError(f"EHLO after STARTTLS returned {code}")
        client.login(user, password)
except smtplib.SMTPAuthenticationError as exc:
    sys.stderr.write(f"SMTP AUTH rejected by {smtp_host}:{smtp_port} (SMTP {exc.smtp_code})\n")
    sys.exit(1)
except Exception as exc:
    sys.stderr.write(f"SMTP STARTTLS/AUTH check against {smtp_host}:{smtp_port} failed: {type(exc).__name__}: {exc}\n")
    sys.exit(1)
' || die "refused: SMTP STARTTLS/AUTH verification failed for $smtp_host:$smtp_port; mail settings were not written to realm '$REALM'"
}

step_5() {
  require_marked_realm "$REALM" "$SOURCE"
  ask SMTP_USER "Transactional Email SMTP user for $(target_mail_domain "$TARGET")" 0
  if [[ -n "${SMTP_PASSWORD_FILE:-}" ]]; then
    [[ -z "${SMTP_PASSWORD:-}" ]] || die "refused: SMTP_PASSWORD and SMTP_PASSWORD_FILE are both set; give one"
    read_secret_file SMTP_PASSWORD "$SMTP_PASSWORD_FILE" || die "SMTP_PASSWORD_FILE: no password read"
  else
    ask SMTP_PASSWORD "Transactional Email SMTP password" 1
  fi
  verify_smtp_auth
  local mail
  mail="$(SMTP_USER_V="$SMTP_USER" SMTP_PASSWORD_V="$SMTP_PASSWORD" jq_read "$SOURCE, rendered" '
      {smtpServer: (.smtpServer | .user = env.SMTP_USER_V | .password = env.SMTP_PASSWORD_V)}' <<<"$BODY")" || exit 1
  kc update "realms/$REALM" -f - <<<"$mail" >/dev/null || die "could not set the mail settings of realm '$REALM'"
  read_live "$REALM" smtp "$SOURCE after step 5"
  step_record 5 "$(issuer "$REALM")" "$READ_AT" "sender no-reply@$(target_mail_domain "$TARGET")"
}

# 6: the theme, once the server has it, then the read-back of every
# invariant of the file.
step_6() {
  require_marked_realm "$REALM" "$SOURCE"
  local themes
  themes="$(jq_read "$SOURCE, rendered" -c '{loginTheme, accountTheme, emailTheme}' <<<"$BODY")" || exit 1
  require_themes_installed "$themes"
  kc update "realms/$REALM" -f - <<<"$themes" >/dev/null || die "could not set the theme of realm '$REALM'"
  read_live "$REALM" all "$SOURCE after step 6"
  if [[ "$SOURCE" == "$TEMPLATE_FILE" ]]; then check_worker_roles; check_email_admin_only; fi
  step_record 6 "$(issuer "$REALM")" "$READ_AT" "theme kodera; the whole realm read back against $SOURCE"
}

# 7, `verify`: step 6's read-back, writing nothing (a partial export is a POST that changes
# nothing). Core's catalogue runs it after step 6.
step_7() {
  require_marked_realm "$REALM" "$SOURCE"
  read_live "$REALM" all "$SOURCE at verify"
  if [[ "$SOURCE" == "$TEMPLATE_FILE" ]]; then check_worker_roles; check_email_admin_only; fi
  step_record 7 "$(issuer "$REALM")" "$READ_AT" "nothing written; the whole realm read back against $SOURCE"
}
cmd_verify() {
  step_args "$@"
  [[ "$VISIO" == 0 && "$DOCS" == 0 ]] || die "refused: --visio and --docs are options of step 2"
  kc_login
  step_7
}

cmd_step() {
  local n="${1:-}"
  [[ "$n" =~ ^[1-6]$ ]] || die "usage: realm-apply.sh step <1-6> ... (see the header of this file)"
  shift
  step_args "$@"
  [[ "$VISIO" == 0 || "$n" == 2 ]] || die "refused: --visio is an option of step 2, which makes the Visio client"
  [[ "$VISIO" == 0 || "$SOURCE" == "$TEMPLATE_FILE" ]] || die "refused: --visio is for organisation realms; the staff realm has no Visio client"
  [[ "$DOCS" == 0 || "$n" == 2 ]] || die "refused: --docs is an option of step 2, which makes the Docs client"
  [[ "$DOCS" == 0 || "$SOURCE" == "$TEMPLATE_FILE" ]] || die "refused: --docs is for organisation realms; the staff realm has no Docs client"
  kc_login
  "step_$n"
}

# --- accounts ---------------------------------------------------------------
# lifespan_seconds <hours>: the default is also the ceiling, so the variable can only shorten a
# link. A variable left from an earlier account run never lengthens a reset link.
lifespan_seconds() {
  local h="${ACTIONS_LIFESPAN_HOURS:-$1}"
  [[ "$h" =~ ^[1-9][0-9]?$ ]] || die "ACTIONS_LIFESPAN_HOURS must be a whole number of hours, 1 to $1"
  if (( $1 == CLAIM_HOURS )); then
    (( h <= CLAIM_HOURS )) || die "ACTIONS_LIFESPAN_HOURS=$h: the link must not outlive the ${CLAIM_HOURS} h owner claim"
  else
    (( h <= $1 )) || die "ACTIONS_LIFESPAN_HOURS=$h: this link lives at most $1 h; the variable may only shorten it"
  fi
  echo $((h * 3600))
}

# The address comes on standard input, one line, so it stays out of the
# shell history and of every process's arguments (kcadm's and jq's too).
read_address() {
  [[ -t 0 ]] && printf 'Account address: ' >&2
  IFS= read -r EMAIL || true
  EMAIL="${EMAIL#"${EMAIL%%[![:space:]]*}"}"
  EMAIL="${EMAIL%"${EMAIL##*[![:space:]]}"}"
  [[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+$ ]] ||
    die "the address is read on standard input: one address on one line"
}

# Prints the id of the user with this email, or nothing. Users are listed by
# page and matched here: a search would put the address on kcadm's arguments.
find_user() {
  local first=0 page found
  while :; do
    page="$(kc_read array "the users of realm '$REALM'" users -r "$REALM" -q first="$first" -q max=100 \
      -q briefRepresentation=true)" || exit 1
    found="$(EMAIL_V="$EMAIL" jq_read "the users of realm '$REALM'" -r \
      '[.[] | select((.email // "" | ascii_downcase) == (env.EMAIL_V | ascii_downcase))] | .[0].id // ""' <<<"$page")" || exit 1
    [[ -n "$found" ]] && { seg "the id of the account" "$found"; return; }
    local size
    size="$(jq_read "the users of realm '$REALM'" length <<<"$page")" || exit 1
    (( size < 100 )) && return 0
    first=$((first + 100))
  done
}

# account_state <user-id> — prints "credential <types>", "actions" when the
# email is verified or the three required actions are not all there, or
# "clean".
account_state() {
  local user creds
  user="$(kc get "users/$1" -r "$REALM")" || die "could not read account $1"
  creds="$(kc get "users/$1/credentials" -r "$REALM")" || die "could not read the credentials of account $1"
  if ! jq_read "the credentials of account $1" -e '. == []' <<<"$creds" >/dev/null; then
    local types
    types="$(jq_read "the credentials of account $1" -r '[.[].type] | join(",")' <<<"$creds")" || exit 1
    echo "credential $types"
  elif ! jq_read "account $1" -e --argjson actions "$ACCOUNT_ACTIONS" \
      '.emailVerified == false and ((.requiredActions // []) | sort) == ($actions | sort)' <<<"$user" >/dev/null; then
    echo actions
  else
    echo clean
  fi
}

send_actions() {  # send_actions <user-id> <actions-json> <hours: default and ceiling>
  local seconds
  seconds="$(lifespan_seconds "$3")"
  # Logging the account out moves its notBefore, and Keycloak then refuses every link issued
  # before it (REALMS.md, "Set-up links"): the link sent now is the only one that works. It also
  # ends the account's sessions, which a reset means to do anyway.
  kc create "users/$1/logout" -r "$REALM" >/dev/null ||
    die "could not log account $1 out, so its older links would still work; nothing was sent"
  kc update "users/$1/execute-actions-email" -r "$REALM" -q lifespan="$seconds" -b "$2" >/dev/null ||
    die "Keycloak could not send the required-actions email (check the realm's SMTP settings)"
  account_record send_actions_email completed "$1" "link expires in $((seconds / 3600)) h"
}

# The required actions of a new account and the credential type of its second factor: OTP on
# organisation realms, a security key (WebAuthn) on the staff realm. account_args sets them.
ACCOUNT_ACTIONS="$REQUIRED_ACTIONS" SECOND_FACTOR=otp SECOND_FACTOR_NAME=OTP
# Before any account is read or written: a known realm, made by this tool,
# holding every invariant of its file.
account_args() {  # account_args <link hours> <args>
  local hours="$1"
  shift
  parse_args "$@"
  [[ "$VISIO" == 0 ]] || die "refused: --visio is an option of step 2, which makes the Visio client"
  [[ "$DOCS" == 0 ]] || die "refused: --docs is an option of step 2, which makes the Docs client"
  [[ -n "$REALM" ]] || die "--realm is required"
  SOURCE="$(source_for_realm "$REALM")" || exit 1
  if [[ "$SOURCE" == "$STAFF_FILE" ]]; then
    ACCOUNT_ACTIONS="$STAFF_REQUIRED_ACTIONS" SECOND_FACTOR=webauthn SECOND_FACTOR_NAME="security key"
  fi
  require_realm_mode
  # Fail on the lifespan and the address before anything is read or written.
  lifespan_seconds "$hours" >/dev/null
  read_address
  kc_login
  require_marked_realm "$REALM" "$SOURCE"
  read_live "$REALM" all "$SOURCE; no account is touched in a realm that drifted"
}

cmd_account() {
  account_args "$ONBOARDING_HOURS" "$@"
  local id state
  id="$(find_user)" || exit 1
  if [[ -n "$id" ]]; then
    state="$(account_state "$id")"
    case "$state" in
      credential*) die "refused: account $id exists and has a credential (${state#credential }); it must not be bound (FIRST_OWNER_BOOTSTRAP.md §5.6)" ;;
      actions) die "refused: account $id exists without an unverified email and the three required actions; it must not be bound" ;;
    esac
    account_record create_account no_effect "$id" "account exists without credential; not created by this run"
    say "the account exists: use resend to send its required-actions email again"
    return 0
  fi
  local account
  account="$(EMAIL_V="$EMAIL" jq_read "the new account" -n --argjson actions "$ACCOUNT_ACTIONS" '
      {username: env.EMAIL_V, email: env.EMAIL_V, emailVerified: false, enabled: true,
       requiredActions: $actions}')" || exit 1
  id="$(kc create users -r "$REALM" -f - -i <<<"$account")" || die "could not create the account in realm '$REALM'"
  [[ -n "$id" ]] || die "Keycloak returned no id for the new account"
  id="$(seg "the id of the new account" "$id")" || exit 1

  # The record says "created without credential" only after Keycloak says so.
  state="$(account_state "$id")"
  case "$state" in
    credential*) die "account $id has a credential; it must not be bound (FIRST_OWNER_BOOTSTRAP.md §5.6)" ;;
    actions) die "account $id does not carry an unverified email and the three required actions" ;;
  esac
  account_record create_account completed "$id" "created without credential"
  send_actions "$id" "$ACCOUNT_ACTIONS" "$ONBOARDING_HOURS"
}

# read_credentials <id>: prints the account's credentials, a list. Anything else is refused as a
# failed read, never taken for an account without a password.
read_credentials() {
  local creds
  creds="$(kc get "users/$1/credentials" -r "$REALM")" || die "could not read the credentials of account $1"
  jq_read "the credentials of account $1" -e 'type == "array"' <<<"$creds" >/dev/null ||
    die "could not read the credentials of account $1: the answer is not a list; nothing was sent"
  printf '%s\n' "$creds"
}

# no_second_factor <id> <credentials JSON> — refuses an account with a password and no second
# factor (OTP; on the staff realm a security key, credential type webauthn). resend
# sends no 72 h link to an account with a password, and reset needs both factors, so the two
# would point at each other; the runbook wipes both credentials and starts the account again.
no_second_factor() {
  if jq_read "the credentials of account $1" -e --arg f "$SECOND_FACTOR" '[.[].type] | index("password") != null and index($f) == null' <<<"$2" >/dev/null; then
    die "refused: account $1 has a password but no second factor; neither resend nor reset fits: follow REALMS.md, \"Resetting a second factor\""
  fi
}

cmd_resend() {
  account_args "$ONBOARDING_HOURS" "$@"
  local id user actions
  id="$(find_user)" || exit 1
  [[ -n "$id" ]] || die "no account with that email in realm '$REALM'"
  user="$(kc_read object "account $id" "users/$id" -r "$REALM")" || exit 1
  actions="$(jq_read "account $id" -c '.requiredActions // []' <<<"$user")" || exit 1
  [[ "$actions" != "[]" ]] || die "account $id has no pending required action; nothing to send"
  # An account with a password has been set up: a link for it is a reset, which lives 24 h, not a
  # 72 h set-up link. That covers a reset marked but never mailed, which reset itself finishes.
  # An owner who stopped after the second factor has no password yet, and gets a set-up link.
  local creds
  creds="$(read_credentials "$id")" || exit 1
  if ! jq_read "the credentials of account $id" -e '[.[].type] | index("password") == null' <<<"$creds" >/dev/null; then
    no_second_factor "$id" "$creds"
    die "refused: account $id already has a password, so its link is a reset (24 h); use reset"
  fi
  send_actions "$id" "$actions" "$ONBOARDING_HOURS"
}

# A forgotten password after onboarding: resend refuses an account with a password,
# and reset asks for a new one through the same email, for 24 h.
cmd_holders() {
  parse_args "$@"
  [[ "$VISIO" == 0 && "$DOCS" == 0 ]] || die "refused: --visio and --docs are options of step 2"
  [[ -n "$REALM" ]] || die "--realm is required"
  SOURCE="$(source_for_realm "$REALM")" || exit 1
  [[ "$SOURCE" == "$TEMPLATE_FILE" ]] || die "refused: realm '$REALM' is not an organisation realm; holders reads organisation realms only"
  require_realm_mode
  kc_login
  require_marked_realm "$REALM" "$SOURCE"
  check_worker_roles
  check_admin_holders
  say "realm '$REALM': only service-account-$WORKER_CLIENT holds a realm-management role (manage-users, view-users)"
}

cmd_reset() {
  account_args "$RESET_HOURS" "$@"
  local id
  id="$(find_user)" || exit 1
  [[ -n "$id" ]] || die "no account with that email in realm '$REALM'"
  local user creds
  user="$(kc get "users/$id" -r "$REALM")" || die "could not read account $id"
  creds="$(read_credentials "$id")" || exit 1
  # A reset already marked but never mailed (the send failed) is finished by running reset again.
  no_second_factor "$id" "$creds"
  jq_read "account $id" -e '.emailVerified == true and ((.requiredActions // []) | . == [] or . == ["UPDATE_PASSWORD"])' <<<"$user" >/dev/null &&
    jq_read "the credentials of account $id" -e --arg f "$SECOND_FACTOR" '([.[].type] | index("password") != null and index($f) != null)' <<<"$creds" >/dev/null ||
    die "refused: account $id has not finished onboarding (verified email, password and $SECOND_FACTOR_NAME, nothing pending); use resend"
  # Log out before anything is marked: a link issued earlier (an admin-console send, say) would
  # otherwise be accepted from the moment the password is pending, and stay so if a later step fails.
  kc create "users/$id/logout" -r "$REALM" >/dev/null ||
    die "could not log account $id out before marking a new password; nothing was changed or sent"
  # Keycloak refuses a link to an account with nothing left to do (the current-setup-link handler,
  # REALMS.md), so the new password is marked pending first. The account's next sign-in asks for it too.
  kc update "users/$id" -r "$REALM" -f - <<<'{"requiredActions":["UPDATE_PASSWORD"]}' >/dev/null ||
    die "could not mark a new password as pending on account $id"
  user="$(kc get "users/$id" -r "$REALM")" || die "could not read account $id back"
  jq_read "account $id" -e '(.requiredActions // []) == ["UPDATE_PASSWORD"]' <<<"$user" >/dev/null ||
    die "account $id does not read back with exactly UPDATE_PASSWORD pending; nothing was sent"
  send_actions "$id" '["UPDATE_PASSWORD"]' "$RESET_HOURS"
}

case "${1:-}" in
  check) shift; cmd_check "$@" ;;
  step) shift; cmd_step "$@" ;;
  account) shift; cmd_account "$@" ;;
  resend) shift; cmd_resend "$@" ;;
  reset) shift; cmd_reset "$@" ;;
  holders) shift; cmd_holders "$@" ;;
  verify) shift; cmd_verify "$@" ;;
  apply) die "apply is replaced by one run per catalogue step: realm-apply.sh step <1-6> (REALMS.md)" ;;
  *) die "usage: realm-apply.sh check|step|account|resend|reset|holders|verify ... (see the header of this file)" ;;
esac
