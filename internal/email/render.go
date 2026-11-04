package email

import (
	"bytes"
	"embed"
	"errors"
	"fmt"
	htmltemplate "html/template"
	"io/fs"
	"slices"
	"strings"
	texttemplate "text/template"
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
}

// DefaultRenderer returns a Renderer over the built-in templates.
func DefaultRenderer() (*Renderer, error) {
	sub, err := fs.Sub(embedded, "templates")
	if err != nil {
		return nil, err
	}
	return NewRenderer(sub)
}

// NewRenderer parses every template in fsys (top level only) up front, so a
// broken template fails at startup rather than in a job.
func NewRenderer(fsys fs.FS) (*Renderer, error) {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return nil, fmt.Errorf("email: read templates: %w", err)
	}
	has := func(name string) bool {
		return slices.ContainsFunc(entries, func(e fs.DirEntry) bool { return e.Name() == name })
	}
	r := &Renderer{templates: map[string]compiled{}}
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
		c.text, err = texttemplate.New(e.Name()).Option("missingkey=error").ParseFS(fsys, files...)
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
			c.html, err = htmltemplate.New(name+htmlExt).Option("missingkey=error").ParseFS(fsys, files...)
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
