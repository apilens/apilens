package identity

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"github.com/danielgtaylor/huma/v2/humatest"

	"github.com/apilens/apilens/internal/platform/config"
)

func TestProvidersEndpoint(t *testing.T) {
	both := config.OAuthConfig{
		Google: config.OAuthProviderConfig{ClientID: "g-id", ClientSecret: "g-secret"},
		GitHub: config.OAuthProviderConfig{ClientID: "gh-id", ClientSecret: "gh-secret"},
	}
	for _, tc := range []struct {
		name  string
		oauth config.OAuthConfig
		want  AuthProviders
	}{
		{"none", config.OAuthConfig{}, AuthProviders{Email: true, Passkeys: true}},
		{"google only", config.OAuthConfig{Google: both.Google}, AuthProviders{Email: true, Passkeys: true, Google: true}},
		{"github only", config.OAuthConfig{GitHub: both.GitHub}, AuthProviders{Email: true, Passkeys: true, GitHub: true}},
		{"both", both, AuthProviders{Email: true, Passkeys: true, Google: true, GitHub: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, api := humatest.New(t)
			RegisterProviders(api, config.IdentityConfig{OAuth: tc.oauth}, nil)
			resp := api.Get(AuthPrefix + "/providers")
			if resp.Code != http.StatusOK {
				t.Fatalf("status = %d: %s", resp.Code, resp.Body)
			}
			var got map[string]any
			if err := json.Unmarshal(resp.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			want := map[string]bool{
				"email": tc.want.Email, "passkeys": tc.want.Passkeys,
				"google": tc.want.Google, "github": tc.want.GitHub, "sso": tc.want.SSO,
			}
			for k, v := range want {
				if got[k] != v {
					t.Errorf("%s = %v, want %v (body %s)", k, got[k], v, resp.Body)
				}
			}
			if secret, ok := got["client_secret"]; ok {
				t.Errorf("response leaks client_secret: %v", secret)
			}
		})
	}
}

func TestProvidersOperationIsPublic(t *testing.T) {
	_, api := humatest.New(t)
	RegisterProviders(api, config.IdentityConfig{}, nil)
	op := api.OpenAPI().Paths[AuthPrefix+"/providers"].Get
	if op == nil {
		t.Fatal("GET /auth/providers not registered")
	}
	if len(op.Security) != 0 {
		t.Fatalf("security = %v, want none (public)", op.Security)
	}
}

type fakeSSOAvailability struct {
	any bool
	err error
}

func (f fakeSSOAvailability) AnySSOConnection(context.Context) (bool, error) { return f.any, f.err }

func TestProvidersSSOFollowsConnections(t *testing.T) {
	for _, tc := range []struct {
		name string
		sso  SSOAvailability
		want bool
	}{
		{"a connection exists", fakeSSOAvailability{any: true}, true},
		{"no connection", fakeSSOAvailability{}, false},
		{"lookup fails", fakeSSOAvailability{err: errors.New("db down")}, false},
		{"not wired", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, api := humatest.New(t)
			RegisterProviders(api, config.IdentityConfig{}, tc.sso)
			resp := api.Get(AuthPrefix + "/providers")
			if resp.Code != http.StatusOK {
				t.Fatalf("status = %d: %s", resp.Code, resp.Body)
			}
			var got AuthProviders
			if err := json.Unmarshal(resp.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if got.SSO != tc.want {
				t.Fatalf("sso = %v, want %v", got.SSO, tc.want)
			}
		})
	}
}
