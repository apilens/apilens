package email

import (
	"bytes"
	"embed"
	"errors"
	"fmt"
	htmltemplate "html/template"
	"io/fs"
	"net/url"
	"slices"
	"strings"
	texttemplate "text/template"
	"time"
)

// Template files live in templates/ (or any fs.FS given to NewRenderer):
//
//   - <name>.txt.tmpl  (required) text/template; the plain-text body. It must
//     also {{define "subject"}}.
//   - <name>.html.tmpl (optional) html/template; the HTML alternative.
//   - layout.txt.tmpl / layout.html.tmpl (optional) are parsed into every
//     template of the same kind, for a shared layout. They are not templates
//     themselves.
//
// Templates run with missingkey=error, so a job missing data fails instead of
// sending a half-filled email.
//
// Every template can call these functions:
//
//   - link PATH [KEY VALUE]...  an absolute URL on identity.public_ui_url
//     (WithPublicUIURL) with the query pairs encoded. Emails never carry a
//     URL from job data, so a job cannot point a user anywhere else.
//   - seg S       S escaped as one URL path segment, for link paths.
//   - datetime T  T (a time.Time or an RFC 3339 string, as JSON job data
//     carries it) as "Wed, 4 Nov 2026 09:30 UTC".
//   - date T      T as "4 November 2026".
//   - security CHANGE  the copy (.Subject, .Summary) for a security_change
//     value; unknown values fail the render.

//go:embed templates
var embedded embed.FS

const (
	txtExt  = ".txt.tmpl"
	htmlExt = ".html.tmpl"
	layout  = "layout"
)

// ErrUnknownTemplate is returned by Render for a name with no template.
var ErrUnknownTemplate = errors.New("email: unknown template")

type compiled struct {
	text *texttemplate.Template
	html *htmltemplate.Template // nil when there is no HTML part
}

// Renderer renders named templates into Messages.
type Renderer struct {
	templates map[string]compiled
	uiURL     *url.URL // nil: link fails
}

// Option configures a Renderer.
type Option func(*Renderer) error

// WithPublicUIURL sets the origin (identity.public_ui_url) that the link
// template function builds URLs on.
func WithPublicUIURL(raw string) Option {
	return func(r *Renderer) error {
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return fmt.Errorf("email: public UI URL %q: want an absolute http(s) URL", raw)
		}
		u.Path = strings.TrimSuffix(u.Path, "/")
		u.RawPath, u.RawQuery, u.Fragment = "", "", ""
		r.uiURL = u
		return nil
	}
}

// DefaultRenderer returns a Renderer over the built-in templates.
func DefaultRenderer(opts ...Option) (*Renderer, error) {
	sub, err := fs.Sub(embedded, "templates")
	if err != nil {
		return nil, err
	}
	return NewRenderer(sub, opts...)
}

// NewRenderer parses every template in fsys (top level only) up front, so a
// broken template fails at startup rather than in a job.
func NewRenderer(fsys fs.FS, opts ...Option) (*Renderer, error) {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return nil, fmt.Errorf("email: read templates: %w", err)
	}
	has := func(name string) bool {
		return slices.ContainsFunc(entries, func(e fs.DirEntry) bool { return e.Name() == name })
	}
	r := &Renderer{templates: map[string]compiled{}}
	for _, opt := range opts {
		if err := opt(r); err != nil {
			return nil, err
		}
	}
	funcs := r.funcs()
	for _, e := range entries {
		name, ok := strings.CutSuffix(e.Name(), txtExt)
		if e.IsDir() || !ok || name == layout {
			continue
		}
		var c compiled
		files := []string{e.Name()}
		if has(layout + txtExt) {
			files = append([]string{layout + txtExt}, files...)
		}
		c.text, err = texttemplate.New(e.Name()).Option("missingkey=error").Funcs(texttemplate.FuncMap(funcs)).ParseFS(fsys, files...)
		if err != nil {
			return nil, fmt.Errorf("email: template %s: %w", name, err)
		}
		if c.text.Lookup("subject") == nil {
			return nil, fmt.Errorf("email: template %s: %s must {{define \"subject\"}}", name, e.Name())
		}
		if has(name + htmlExt) {
			files := []string{name + htmlExt}
			if has(layout + htmlExt) {
				files = append([]string{layout + htmlExt}, files...)
			}
			c.html, err = htmltemplate.New(name+htmlExt).Option("missingkey=error").Funcs(htmltemplate.FuncMap(funcs)).ParseFS(fsys, files...)
			if err != nil {
				return nil, fmt.Errorf("email: template %s: %w", name, err)
			}
		}
		r.templates[name] = c
	}
	for _, e := range entries {
		if name, ok := strings.CutSuffix(e.Name(), htmlExt); ok && name != layout {
			if _, found := r.templates[name]; !found {
				return nil, fmt.Errorf("email: template %s: %s has no %s", name, e.Name(), name+txtExt)
			}
		}
	}
	return r, nil
}

// Has reports whether a template called name exists.
func (r *Renderer) Has(name string) bool {
	_, ok := r.templates[name]
	return ok
}

// Names returns the template names, sorted.
func (r *Renderer) Names() []string {
	names := make([]string, 0, len(r.templates))
	for n := range r.templates {
		names = append(names, n)
	}
	slices.Sort(names)
	return names
}

// Render executes template name with data and returns the message for to.
func (r *Renderer) Render(name, to string, data map[string]any) (*Message, error) {
	c, ok := r.templates[name]
	if !ok {
		return nil, fmt.Errorf("%w %q", ErrUnknownTemplate, name)
	}
	if data == nil {
		data = map[string]any{}
	}
	var subject, text, html bytes.Buffer
	if err := c.text.ExecuteTemplate(&subject, "subject", data); err != nil {
		return nil, fmt.Errorf("email: render %s subject: %w", name, err)
	}
	if err := c.text.ExecuteTemplate(&text, name+txtExt, data); err != nil {
		return nil, fmt.Errorf("email: render %s text: %w", name, err)
	}
	if c.html != nil {
		if err := c.html.ExecuteTemplate(&html, name+htmlExt, data); err != nil {
			return nil, fmt.Errorf("email: render %s html: %w", name, err)
		}
	}
	// A subject is one header line.
	subj := strings.Join(strings.Fields(subject.String()), " ")
	if subj == "" {
		return nil, fmt.Errorf("email: render %s: empty subject", name)
	}
	return &Message{
		To: to, Subject: subj, Template: name,
		Text: strings.TrimSpace(text.String()) + "\n",
		HTML: strings.TrimSpace(html.String()),
	}, nil
}

// funcs returns the template functions (see the file comment).
func (r *Renderer) funcs() map[string]any {
	return map[string]any{
		"link":     r.link,
		"seg":      url.PathEscape,
		"datetime": func(v any) (string, error) { return formatTime(v, "Mon, 2 Jan 2006 15:04 MST") },
		"date":     func(v any) (string, error) { return formatTime(v, "2 January 2006") },
		"security": securityChangeCopy,
		"project":  projectChangeCopy,
	}
}

// link returns path (already escaped, starting with "/") on the public UI
// origin, with query as key/value pairs.
func (r *Renderer) link(path string, query ...string) (string, error) {
	if r.uiURL == nil {
		return "", errors.New("link: no public UI URL configured")
	}
	if !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") {
		return "", fmt.Errorf("link: path %q must start with a single /", path)
	}
	if len(query)%2 != 0 {
		return "", fmt.Errorf("link %s: odd number of query arguments", path)
	}
	u := *r.uiURL
	rawPath := u.EscapedPath() + path
	p, err := url.PathUnescape(rawPath)
	if err != nil {
		return "", fmt.Errorf("link: path %q: %w", path, err)
	}
	u.Path, u.RawPath = p, rawPath
	if len(query) > 0 {
		q := url.Values{}
		for pair := range slices.Chunk(query, 2) {
			key, value := pair[0], pair[len(pair)-1]
			if value == "" {
				return "", fmt.Errorf("link %s: empty %s", path, key)
			}
			q.Add(key, value)
		}
		u.RawQuery = q.Encode()
	}
	return u.String(), nil
}

// formatTime formats v, a time.Time or an RFC 3339 string, in UTC.
func formatTime(v any, layout string) (string, error) {
	var t time.Time
	switch x := v.(type) {
	case time.Time:
		t = x
	case string:
		var err error
		if t, err = time.Parse(time.RFC3339Nano, x); err != nil {
			return "", fmt.Errorf("time %q: want RFC 3339", x)
		}
	default:
		return "", fmt.Errorf("time: unsupported type %T", v)
	}
	return t.UTC().Format(layout), nil
}
