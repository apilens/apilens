package orgs

import (
	"errors"
	"slices"
	"strings"
	"testing"
)

func TestValidDomain(t *testing.T) {
	for _, d := range []string{"acme.com", "eu.acme.co.uk", "a-b.io", "x1.dev", "xn--bcher-kva.de"} {
		if !ValidDomain(d) {
			t.Errorf("%q is not valid", d)
		}
	}
	for _, d := range []string{
		"", "acme", "Acme.com", "ACME.COM", "acme.com.", ".acme.com", "-acme.com", "acme-.com",
		"acme..com", "user@acme.com", "acme.com/x", "acme .com", "10.0.0.1", "acme.123",
		strings.Repeat("a", 64) + ".com", strings.Repeat("a.", 126) + "com",
	} {
		if ValidDomain(d) {
			t.Errorf("%q is valid", d)
		}
	}
}

func TestValidateUpdate(t *testing.T) {
	s := &Service{}
	str := func(v string) *string { return &v }
	domains := func(v ...string) *[]string { return &v }

	p, err := s.validate(Update{Name: str("  Acme  "), AllowedDomains: domains("acme.com", "acme.io", "acme.com")})
	if err != nil || *p.Name != "Acme" || !slices.Equal(p.AllowedDomains, []string{"acme.com", "acme.io"}) || p.DomainJoin != nil {
		t.Fatalf("params = %+v (%v)", p, err)
	}
	p, err = s.validate(Update{AllowedDomains: domains()})
	if err != nil || p.AllowedDomains == nil || len(p.AllowedDomains) != 0 {
		t.Fatalf("clearing domains: %+v (%v)", p, err)
	}

	for _, d := range []string{"gmail.com", "outlook.com", "yahoo.co.uk"} {
		var na *DomainNotAllowedError
		if _, err := s.validate(Update{AllowedDomains: domains("acme.com", d)}); !errors.As(err, &na) || na.Domain != d {
			t.Errorf("%s: err = %v", d, err)
		}
	}
	for _, u := range []Update{
		{Name: str("   ")},
		{Slug: str("Not A Slug")},
		{AllowedDomains: domains("Acme.com")},
		{AllowedDomains: domains("not a domain")},
	} {
		if _, err := s.validate(u); !errors.Is(err, ErrInvalid) {
			t.Errorf("%+v: err = %v", u, err)
		}
	}
	many := make([]string, MaxAllowedDomains+1)
	for i := range many {
		many[i] = "d" + strings.Repeat("x", i) + ".com"
	}
	if _, err := s.validate(Update{AllowedDomains: &many}); !errors.Is(err, ErrInvalid) {
		t.Errorf("too many domains: err = %v", err)
	}
}

func TestCanManage(t *testing.T) {
	for role, want := range map[string]bool{"owner": true, "admin": true, "member": false, "viewer": false, "": false} {
		if CanManage(role) != want {
			t.Errorf("CanManage(%q) = %v", role, !want)
		}
	}
}
