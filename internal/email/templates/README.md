# Email templates

Each email is `<name>.txt.tmpl` (text/template: the plain-text body, plus a
`{{define "subject"}}` block) and an optional `<name>.html.tmpl`
(html/template: the HTML alternative). `layout.txt.tmpl` and
`layout.html.tmpl`, when present, are parsed into every template of the same
kind. Templates run with `missingkey=error`.

The `email.send` job (`internal/email`) renders a template by name with the
job's `data` map and sends it with the configured provider.

Template functions: `link` builds an absolute URL on `identity.public_ui_url`
(jobs pass tokens, never URLs), `seg` escapes a path segment, `datetime` and
`date` format a time (UTC), and `security` returns the copy for a
`security_change` value. The built-in templates and their data keys are listed
in `catalog.go`.

Copy rules: subjects in sentence case, no exclamation marks, no "Oops". HTML
uses no images and declares both light and dark colour schemes.

Golden files live in `internal/email/testdata/golden`. After changing a
template, run `go test ./internal/email -update` and review the diff.
