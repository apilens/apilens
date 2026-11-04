package identity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/passkey"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/authn"
)

// fakeRegistrar is a PasskeyRegistrar returning canned results.
type fakeRegistrar struct {
	cred   db.PasskeyCredential
	err    error
	inputs []passkey.VerifyInput
}

func (f *fakeRegistrar) Options(context.Context, db.User) (string, *protocol.CredentialCreation, error) {
	return "ch_1", &protocol.CredentialCreation{}, f.err
}

func (f *fakeRegistrar) Verify(_ context.Context, _ db.User, in passkey.VerifyInput) (db.PasskeyCredential, error) {
	f.inputs = append(f.inputs, in)
	return f.cred, f.err
}

type fakeUserByID struct {
	user db.User
	err  error
}

func (f fakeUserByID) GetUserByID(context.Context, uuid.UUID) (db.User, error) { return f.user, f.err }

func newTestPasskeys(t *testing.T, deps PasskeysDeps, p *authn.Principal) humatest.TestAPI {
	t.Helper()
	_, api := humatest.New(t)
	api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		if p != nil {
			ctx = huma.WithContext(ctx, authn.WithPrincipal(ctx.Context(), *p))
		}
		next(ctx)
	})
	NewPasskeys(deps, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))).Register(api)
	return api
}

func TestPasskeyRegisterErrors(t *testing.T) {
	user := db.User{ID: uuid.New(), Email: "ada@example.com"}
	principal := &authn.Principal{Kind: authn.KindUser, UserID: user.ID}
	body := map[string]any{"challenge_id": "ch_1", "response": map[string]any{"id": "x"}}
	for _, tc := range []struct {
		name     string
		p        *authn.Principal
		users    fakeUserByID
		regErr   error
		status   int
		code     ErrCode
		enqueued int
	}{
		{"unauthenticated", nil, fakeUserByID{user: user}, nil, http.StatusUnauthorized, CodeUnauthenticated, 0},
		{"deleted user", principal, fakeUserByID{err: pgx.ErrNoRows}, nil, http.StatusUnauthorized, CodeSessionExpired, 0},
		{"unknown challenge", principal, fakeUserByID{user: user}, passkey.ErrChallengeNotFound, http.StatusUnauthorized, CodePasskeyFailed, 0},
		{"bad response", principal, fakeUserByID{user: user}, passkey.ErrVerification, http.StatusUnauthorized, CodePasskeyFailed, 0},
		{"duplicate", principal, fakeUserByID{user: user}, passkey.ErrCredentialExists, http.StatusConflict, CodePasskeyExists, 0},
		{"store down", principal, fakeUserByID{user: user}, errors.New("boom"), http.StatusInternalServerError, CodeInternal, 0},
		{"ok", principal, fakeUserByID{user: user}, nil, http.StatusCreated, "", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			jobs := &fakeJobs{}
			reg := &fakeRegistrar{err: tc.regErr, cred: db.PasskeyCredential{ID: uuid.New(), Name: "1Password"}}
			api := newTestPasskeys(t, PasskeysDeps{Registrar: reg, Users: tc.users, Jobs: jobs}, tc.p)
			resp := api.Post(PasskeyRegisterPrefix+"/verify", body)
			if resp.Code != tc.status {
				t.Fatalf("status = %d, want %d: %s", resp.Code, tc.status, resp.Body)
			}
			if tc.code != "" {
				var p Problem
				_ = json.Unmarshal(resp.Body.Bytes(), &p)
				if p.Code != tc.code {
					t.Errorf("code = %q, want %q", p.Code, tc.code)
				}
			}
			if len(jobs.jobs) != tc.enqueued {
				t.Fatalf("enqueued %d jobs, want %d", len(jobs.jobs), tc.enqueued)
			}
			if tc.enqueued > 0 {
				a := jobs.jobs[0]
				if a.To != user.Email || a.Template != email.TemplateSecurityChange || a.Data["change"] != email.SecurityChangePasskeyAdded {
					t.Errorf("job = %+v", a)
				}
			}
		})
	}
}

func TestPasskeyRegisterAlertFailureStillSucceeds(t *testing.T) {
	user := db.User{ID: uuid.New(), Email: "ada@example.com"}
	jobs := &fakeJobs{err: errors.New("queue down")}
	api := newTestPasskeys(t, PasskeysDeps{
		Registrar: &fakeRegistrar{cred: db.PasskeyCredential{ID: uuid.New(), Name: "Key"}},
		Users:     fakeUserByID{user: user},
		Jobs:      jobs,
	}, &authn.Principal{Kind: authn.KindUser, UserID: user.ID})
	resp := api.Post(PasskeyRegisterPrefix+"/verify", map[string]any{"challenge_id": "ch_1", "response": map[string]any{}})
	if resp.Code != http.StatusCreated {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
}

func TestPasskeyRegisterOptionsShape(t *testing.T) {
	user := db.User{ID: uuid.New(), Email: "ada@example.com"}
	api := newTestPasskeys(t, PasskeysDeps{Registrar: &fakeRegistrar{}, Users: fakeUserByID{user: user}},
		&authn.Principal{Kind: authn.KindUser, UserID: user.ID})
	resp := api.Post(PasskeyRegisterPrefix+"/options", map[string]any{})
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	var out struct {
		ChallengeID string         `json:"challenge_id"`
		Options     map[string]any `json:"options"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil || out.ChallengeID != "ch_1" || out.Options == nil {
		t.Fatalf("body = %s (%v)", resp.Body, err)
	}
}
