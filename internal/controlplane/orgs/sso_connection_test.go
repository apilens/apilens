package orgs

import (
	"errors"
	"strings"
	"testing"
)

func TestValidSSOIssuer(t *testing.T) {
	for _, s := range []string{
		"https://idp.example.com", "https://login.example.com/tenant/v2.0", "https://idp.example.com/",
		"http://localhost:8080", "http://127.0.0.1:5556/dex", "http://[::1]:9000",
	} {
		if !ValidSSOIssuer(s) {
			t.Errorf("%q is not valid", s)
		}
	}
	for _, s := range []string{
		"", "idp.example.com", "http://idp.example.com", "ftp://idp.example.com", "https://", "https://u:p@idp.example.com",
		"https://idp.example.com/?a=b", "https://idp.example.com/#x", " https://idp.example.com", "http://10.0.0.1",
		"https://" + strings.Repeat("a", MaxSSOIssuerLen) + ".com",
	} {
		if ValidSSOIssuer(s) {
			t.Errorf("%q is valid", s)
		}
	}
}

func TestValidateSSO(t *testing.T) {
	ok := SSOSettings{Issuer: "https://idp.example.com", ClientID: "c", Domains: []string{"acme.com", "acme.io", "acme.com"}, DefaultRole: "member"}
	domains, err := validateSSO(ok)
	if err != nil || len(domains) != 2 {
		t.Fatalf("validateSSO = %v, %v", domains, err)
	}
	empty := ""
	for name, mut := range map[string]func(*SSOSettings){
		"no domains":    func(s *SSOSettings) { s.Domains = nil },
		"owner role":    func(s *SSOSettings) { s.DefaultRole = RoleOwner },
		"unknown role":  func(s *SSOSettings) { s.DefaultRole = "guest" },
		"blank client":  func(s *SSOSettings) { s.ClientID = "" },
		"padded client": func(s *SSOSettings) { s.ClientID = " c" },
		"empty secret":  func(s *SSOSettings) { s.ClientSecret = &empty },
		"bad issuer":    func(s *SSOSettings) { s.Issuer = "http://idp.example.com" },
		"bad domain":    func(s *SSOSettings) { s.Domains = []string{"Acme.com"} },
	} {
		s := ok
		mut(&s)
		if _, err := validateSSO(s); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	s := ok
	s.Domains = []string{"gmail.com"}
	var notAllowed *DomainNotAllowedError
	if _, err := validateSSO(s); !errors.As(err, &notAllowed) || notAllowed.Domain != "gmail.com" {
		t.Errorf("public domain: err = %v", err)
	}
}
