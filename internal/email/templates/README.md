# Email templates

Each email is `<name>.txt.tmpl` (text/template: the plain-text body, plus a
`{{define "subject"}}` block) and an optional `<name>.html.tmpl`
(html/template: the HTML alternative). `layout.txt.tmpl` and
`layout.html.tmpl`, when present, are parsed into every template of the same
kind. Templates run with `missingkey=error`.

The `email.send` job (`internal/email`) renders a template by name with the
job's `data` map and sends it with the configured provider.
