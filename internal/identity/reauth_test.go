package identity

import (
	"net/url"
	"slices"
	"testing"
	"time"

	"github.com/apilens/apilens/internal/identity/audit"
)

func TestReauthMethods(t *testing.T) {
	tests := []struct {
		name string
		f    reauthFacts
		want []string
	}{
		{"email only", reauthFacts{}, []string{ReauthEmail}},
		{"passkey", reauthFacts{passkeys: true}, []string{ReauthPasskey, ReauthEmail}},
		{"two-factor drops email", reauthFacts{totp: true}, []string{ReauthTOTP}},
		{"passkey and two-factor", reauthFacts{passkeys: true, totp: true}, []string{ReauthPasskey, ReauthTOTP}},
		{"sso enforced", reauthFacts{passkeys: true, totp: true, ssoURL: "https://id.example.com/x"}, []string{ReauthSSO}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.f.methods(); !slices.Equal(got, tt.want) {
				t.Fatalf("methods = %v, want %v", got, tt.want)
			}
			for _, m := range []string{ReauthPasskey, ReauthTOTP, ReauthEmail, ReauthSSO} {
				if tt.f.has(m) != slices.Contains(tt.want, m) {
					t.Errorf("has(%s) = %v", m, tt.f.has(m))
				}
			}
		})
	}
}

func TestSSOStartReauthAsksForFreshLogin(t *testing.T) {
	h := newSSOHarness(t)
	f, loc := h.begin(t, "acme", "reauth=true&login_hint=ada%40acme.example.com")
	q := loc.Query()
	if q.Get("prompt") != "login" || q.Get("max_age") != "0" || q.Get("login_hint") != "ada@acme.example.com" {
		t.Fatalf("authorize query = %v", q)
	}
	if st := h.states.m[f.state]; !st.Reauth {
		t.Fatalf("state = %+v, want reauth", st)
	}

	// A plain sign-in asks for neither.
	_, loc = h.begin(t, "acme", "")
	if q := loc.Query(); q.Has("prompt") || q.Has("max_age") {
		t.Fatalf("plain sign-in query = %v", q)
	}
}

func TestSSOCallbackReauth(t *testing.T) {
	h := newSSOHarness(t)
	now := h.s.now()

	// A fresh auth_time signs in and audits the re-authentication.
	f, _ := h.begin(t, "acme", "reauth=true")
	g := ssoGrant(f, "ada@acme.example.com")
	g.claims["auth_time"] = now.Add(-5 * time.Second).Unix()
	h.idp.Grant("c1", g)
	res := h.handedOff(t, h.callback(t, "acme", url.Values{"code": {"c1"}, "state": {f.state}}))
	if res.AccessToken == "" {
		t.Fatalf("handoff = %+v", res)
	}
	ev := h.audit.events[len(h.audit.events)-1]
	if ev.Kind != audit.SessionReauthenticated || ev.Meta["method"] != SSOProvider || ev.Meta["org_id"] != h.org.String() {
		t.Fatalf("audit = %+v", ev)
	}

	// No auth_time, or one from before the attempt: the provider did not
	// authenticate the user again.
	for name, claim := range map[string]any{"missing": nil, "stale": now.Add(-time.Hour).Unix()} {
		t.Run(name, func(t *testing.T) {
			sessions := len(h.sessions.metas)
			f, _ := h.begin(t, "acme", "reauth=true")
			g := ssoGrant(f, "ada@acme.example.com")
			if claim != nil {
				g.claims["auth_time"] = claim
			}
			h.idp.Grant("c-"+name, g)
			wantSignInError(t, h.callback(t, "acme", url.Values{"code": {"c-" + name}, "state": {f.state}}), string(CodeOAuthStateMismatch))
			if len(h.sessions.metas) != sessions {
				t.Fatal("a stale re-authentication signed in")
			}
		})
	}
}
