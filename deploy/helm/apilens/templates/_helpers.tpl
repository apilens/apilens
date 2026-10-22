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
  "APILENS_VALKEY__USERNAME" .Values.externalValkey.username }}
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
