{{/* Chart name. */}}
{{- define "apilens.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Fully qualified app name (truncated so role suffixes still fit in 63 chars). */}}
{{- define "apilens.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 40 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 40 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 40 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "apilens.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Common labels. */}}
{{- define "apilens.labels" -}}
helm.sh/chart: {{ include "apilens.chart" . }}
{{ include "apilens.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: apilens
{{- end }}

{{- define "apilens.selectorLabels" -}}
app.kubernetes.io/name: {{ include "apilens.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* Selector labels for one component. Call with (dict "root" $ "component" "edge"). */}}
{{- define "apilens.componentSelectorLabels" -}}
{{ include "apilens.selectorLabels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "apilens.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "apilens.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* Image reference: repository@digest when a digest is set, else repository:tag. Call with (dict "image" .Values.image "root" $). */}}
{{- define "apilens.imageRef" -}}
{{- if .image.digest }}
{{- printf "%s@%s" .image.repository .image.digest }}
{{- else }}
{{- printf "%s:%s" .image.repository (default .root.Chart.AppVersion .image.tag) }}
{{- end }}
{{- end }}

{{/* Secret holding credentials. */}}
{{- define "apilens.secretName" -}}
{{- default (printf "%s-secrets" (include "apilens.fullname" .)) .Values.secrets.existingSecret }}
{{- end }}

{{/* Secret the migrate hook reads (must exist before pre-install hooks run). */}}
{{- define "apilens.hookSecretName" -}}
{{- if .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else }}
{{- printf "%s-hook-secrets" (include "apilens.fullname" .) }}
{{- end }}
{{- end }}

{{/* Name of the Service for a role. Call with (dict "root" $ "role" "all"). */}}
{{- define "apilens.roleServiceName" -}}
{{- printf "%s-%s" (include "apilens.fullname" .root) .role }}
{{- end }}

{{/* Backend base URL for the web UI: web.apiUrl, else the identity role Service when enabled, else the ingress.ingestRole Service. */}}
{{- define "apilens.webApiUrl" -}}
{{- if .Values.web.apiUrl }}
{{- .Values.web.apiUrl }}
{{- else if (dig "identity" "enabled" false .Values.roles) }}
{{- printf "http://%s:%v" (include "apilens.roleServiceName" (dict "root" . "role" "identity")) .Values.service.port }}
{{- else }}
{{- printf "http://%s:%v" (include "apilens.roleServiceName" (dict "root" . "role" .Values.ingress.ingestRole)) .Values.service.port }}
{{- end }}
{{- end }}

{{/* Public dashboard origin: web.publicUrl, else derived from ingress.webHost. Empty when neither is set. */}}
{{- define "apilens.webPublicUrl" -}}
{{- if .Values.web.publicUrl }}
{{- .Values.web.publicUrl }}
{{- else if .Values.ingress.webHost }}
{{- printf "%s://%s" (ternary "https" "http" (not (empty .Values.ingress.tls))) .Values.ingress.webHost }}
{{- end }}
{{- end }}

{{/* Role that serves sign-in (identity, else all). Empty when neither is enabled. */}}
{{- define "apilens.identityRole" -}}
{{- if (dig "identity" "enabled" false .Values.roles) }}identity
{{- else if (dig "all" "enabled" false .Values.roles) }}all
{{- end }}
{{- end }}

{{/* Token issuer: identity.issuer, else derived from ingress.ingestHost. Empty = binary default. */}}
{{- define "apilens.identityIssuer" -}}
{{- if .Values.identity.issuer }}
{{- .Values.identity.issuer }}
{{- else if .Values.ingress.ingestHost }}
{{- printf "%s://%s" (ternary "https" "http" (not (empty .Values.ingress.tls))) .Values.ingress.ingestHost }}
{{- end }}
{{- end }}

{{/* Dashboard origin for identity: identity.publicUiUrl, else the web public URL. */}}
{{- define "apilens.identityPublicUiUrl" -}}
{{- default (include "apilens.webPublicUrl" .) .Values.identity.publicUiUrl }}
{{- end }}

{{/* Identity and email settings (APILENS_IDENTITY__*, APILENS_EMAIL__*) as a dict in YAML.
Keys whose value is empty are left out so the binary defaults apply. */}}
{{- define "apilens.identityConfig" -}}
{{- $id := .Values.identity }}
{{- $email := .Values.email }}
{{- if and (eq $email.provider "smtp") (or (not $email.host) (not $email.from)) }}
{{- fail "email.provider=smtp requires email.host and email.from" }}
{{- end }}
{{- if not .Values.secrets.existingSecret }}
{{- if and $id.oauth.google.clientId (not .Values.secrets.oauthGoogleClientSecret) }}
{{- fail "identity.oauth.google.clientId is set: set secrets.oauthGoogleClientSecret (or the oauth-google-client-secret key of secrets.existingSecret)" }}
{{- end }}
{{- if and $id.oauth.github.clientId (not .Values.secrets.oauthGithubClientSecret) }}
{{- fail "identity.oauth.github.clientId is set: set secrets.oauthGithubClientSecret (or the oauth-github-client-secret key of secrets.existingSecret)" }}
{{- end }}
{{- end }}
{{- $ui := include "apilens.identityPublicUiUrl" . }}
{{- $origins := $id.webauthn.origins }}
{{- if and (not $origins) $ui }}
{{- $origins = list $ui }}
{{- end }}
{{- $rpId := $id.webauthn.rpId }}
{{- if and (not $rpId) $ui }}
{{- $rpId = (urlParse $ui).host | splitList ":" | first }}
{{- end }}
{{- $all := dict
  "APILENS_IDENTITY__ISSUER" (include "apilens.identityIssuer" .)
  "APILENS_IDENTITY__PUBLIC_UI_URL" $ui
  "APILENS_IDENTITY__COOKIE_DOMAIN" $id.cookieDomain
  "APILENS_IDENTITY__WEBAUTHN__RP_ID" $rpId
  "APILENS_IDENTITY__WEBAUTHN__RP_NAME" $id.webauthn.rpName
  "APILENS_IDENTITY__WEBAUTHN__ORIGINS" (join "," $origins)
  "APILENS_IDENTITY__CORS_ORIGINS" (join "," $id.corsOrigins)
  "APILENS_IDENTITY__RATE_LIMITS__TRUSTED_PROXIES" (join "," $id.trustedProxies)
  "APILENS_IDENTITY__OAUTH__GOOGLE__CLIENT_ID" $id.oauth.google.clientId
  "APILENS_IDENTITY__OAUTH__GITHUB__CLIENT_ID" $id.oauth.github.clientId
  "APILENS_EMAIL__PROVIDER" $email.provider
  "APILENS_EMAIL__HOST" $email.host
  "APILENS_EMAIL__PORT" (toString $email.port)
  "APILENS_EMAIL__USERNAME" $email.username
  "APILENS_EMAIL__FROM" $email.from
  "APILENS_EMAIL__REPLY_TO" $email.replyTo
  "APILENS_EMAIL__TLS" $email.tls
  "APILENS_EMAIL__TIMEOUT" (toString $email.timeout) }}
{{- $out := dict }}
{{- range $k, $v := $all }}
{{- if $v }}
{{- $_ := set $out $k $v }}
{{- end }}
{{- end }}
{{- toYaml $out }}
{{- end }}

{{/* SpiceDB gRPC address: the in-chart Service when spicedb.enabled, else authz.endpoint (empty = authz disabled). */}}
{{- define "apilens.authzEndpoint" -}}
{{- if and .Values.spicedb.enabled .Values.authz.endpoint }}
{{- fail "set either spicedb.enabled or authz.endpoint, not both" }}
{{- end }}
{{- if .Values.spicedb.enabled }}
{{- printf "%s-spicedb:50051" (include "apilens.fullname" .) }}
{{- else }}
{{- .Values.authz.endpoint }}
{{- end }}
{{- end }}

{{/* Non-secret APILENS_* configuration shared by every role and the migrate job.
Chart-managed keys first; entries in .Values.config override them. */}}
{{- define "apilens.configData" -}}
{{- $base := dict
  "APILENS_SERVER__ADDR" ":8080"
  "APILENS_POSTGRES__MAX_CONNS" (toString .Values.externalPostgres.maxConns)
  "APILENS_CLICKHOUSE__ADDR" (join "," .Values.externalClickHouse.addr)
  "APILENS_CLICKHOUSE__DATABASE" .Values.externalClickHouse.database
  "APILENS_CLICKHOUSE__USERNAME" .Values.externalClickHouse.username
  "APILENS_CLICKHOUSE__SECURE" (toString .Values.externalClickHouse.secure)
  "APILENS_CLICKHOUSE__CLUSTER" .Values.externalClickHouse.cluster
  "APILENS_VALKEY__ADDR" (join "," .Values.externalValkey.addr)
  "APILENS_VALKEY__USERNAME" .Values.externalValkey.username
  "APILENS_AUTHZ__ENDPOINT" (include "apilens.authzEndpoint" .)
  "APILENS_AUTHZ__INSECURE" (toString (or .Values.spicedb.enabled .Values.authz.insecure))
  "APILENS_AUTHZ__CACHE_TTL" (toString .Values.authz.cacheTTL) }}
{{- range $k, $v := (include "apilens.identityConfig" . | fromYaml) }}
{{- $_ := set $base $k (toString $v) }}
{{- end }}
{{- range $k, $v := .Values.config }}
{{- $_ := set $base $k (toString $v) }}
{{- end }}
{{- range $k := keys $base | sortAlpha }}
{{ $k }}: {{ index $base $k | quote }}
{{- end }}
{{- end }}

{{/* Env vars sourced from the credentials Secret. Call with (dict "root" $ "secretName" "..."). */}}
{{- define "apilens.secretEnv" -}}
- name: APILENS_POSTGRES__URL
  valueFrom:
    secretKeyRef:
      name: {{ .secretName }}
      key: postgres-url
- name: APILENS_CLICKHOUSE__PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .secretName }}
      key: clickhouse-password
- name: APILENS_VALKEY__PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .secretName }}
      key: valkey-password
      optional: true
- name: APILENS_IDENTITY__KEY_ENCRYPTION_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .secretName }}
      key: identity-key-encryption-key
      optional: true
- name: APILENS_EMAIL__PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .secretName }}
      key: smtp-password
      optional: true
- name: APILENS_IDENTITY__OAUTH__GOOGLE__CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .secretName }}
      key: oauth-google-client-secret
      optional: true
- name: APILENS_IDENTITY__OAUTH__GITHUB__CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .secretName }}
      key: oauth-github-client-secret
      optional: true
- name: APILENS_AUTHZ__PRESHARED_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .secretName }}
      key: spicedb-preshared-key
      optional: true
{{- end }}

{{/* Topology spread for a component. Call with (dict "root" $ "component" "edge"). */}}
{{- define "apilens.topologySpread" -}}
{{- if .root.Values.topologySpreadConstraints }}
{{- toYaml .root.Values.topologySpreadConstraints }}
{{- else if .root.Values.defaultTopologySpread }}
- maxSkew: 1
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: ScheduleAnyway
  labelSelector:
    matchLabels:
      {{- include "apilens.componentSelectorLabels" . | nindent 6 }}
- maxSkew: 1
  topologyKey: kubernetes.io/hostname
  whenUnsatisfiable: ScheduleAnyway
  labelSelector:
    matchLabels:
      {{- include "apilens.componentSelectorLabels" . | nindent 6 }}
{{- end }}
{{- end }}
