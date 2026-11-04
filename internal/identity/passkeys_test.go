package identity

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
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

// fakeManager is a PasskeyManager returning canned results.
type fakeManager struct {
	creds   []db.PasskeyCredential
	cred    db.PasskeyCredential
	err     error
	renamed []string
	deleted []uuid.UUID
}

func (f *fakeManager) List(context.Context, uuid.UUID) ([]db.PasskeyCredential, error) {
	return f.creds, f.err
}

func (f *fakeManager) Rename(_ context.Context, _, _ uuid.UUID, name string) (db.PasskeyCredential, error) {
	f.renamed = append(f.renamed, name)
	c := f.cred
	c.Name = name
	return c, f.err
}

func (f *fakeManager) Delete(_ context.Context, _, id uuid.UUID) (db.PasskeyCredential, error) {
	f.deleted = append(f.deleted, id)
	return f.cred, f.err
}

func passkeyCode(t *testing.T, body []byte) ErrCode {
	t.Helper()
	var p Problem
	_ = json.Unmarshal(body, &p)
	return p.Code
}

func TestListMyPasskeys(t *testing.T) {
	user := db.User{ID: uuid.New(), Email: "ada@example.com"}
	principal := &authn.Principal{Kind: authn.KindUser, UserID: user.ID}
	icloud := uuid.MustParse("fbfc3007-154e-4ecc-8c0b-6e020557d7bd")

	mgr := &fakeManager{creds: []db.PasskeyCredential{
		{ID: uuid.New(), Name: "Laptop", Aaguid: icloud, BackupEligible: true, BackupState: true},
		{ID: uuid.New(), Name: "Key"},
	}}
	api := newTestPasskeys(t, PasskeysDeps{Manager: mgr, Users: fakeUserByID{user: user}}, principal)
	resp := api.Get(MyPasskeysPath)
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", resp.Code, resp.Body)
	}
	var out struct {
		Passkeys []Passkey `json:"passkeys"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil || len(out.Passkeys) != 2 {
		t.Fatalf("body = %s (%v)", resp.Body, err)
	}
	if p := out.Passkeys[0]; p.Authenticator != "iCloud Keychain" || !p.BackupState || p.Transports == nil {
		t.Errorf("first = %+v", p)
	}
	if p := out.Passkeys[1]; p.Authenticator != "" || p.AAGUID != uuid.Nil.String() {
		t.Errorf("second = %+v", p)
	}

	// Empty is [], not null.
	api = newTestPasskeys(t, PasskeysDeps{Manager: &fakeManager{creds: []db.PasskeyCredential{}}, Users: fakeUserByID{user: user}}, principal)
	if resp := api.Get(MyPasskeysPath); resp.Code != http.StatusOK || !bytes.Contains(resp.Body.Bytes(), []byte(`"passkeys":[]`)) {
		t.Fatalf("empty: %d %s", resp.Code, resp.Body)
	}

	for _, tc := range []struct {
		name   string
		p      *authn.Principal
		users  fakeUserByID
		err    error
		status int
		code   ErrCode
	}{
		{"unauthenticated", nil, fakeUserByID{user: user}, nil, http.StatusUnauthorized, CodeUnauthenticated},
		{"deleted user", principal, fakeUserByID{err: pgx.ErrNoRows}, nil, http.StatusUnauthorized, CodeSessionExpired},
		{"store down", principal, fakeUserByID{user: user}, errors.New("boom"), http.StatusInternalServerError, CodeInternal},
	} {
		t.Run(tc.name, func(t *testing.T) {
			api := newTestPasskeys(t, PasskeysDeps{Manager: &fakeManager{err: tc.err}, Users: tc.users}, tc.p)
			resp := api.Get(MyPasskeysPath)
			if resp.Code != tc.status || passkeyCode(t, resp.Body.Bytes()) != tc.code {
				t.Fatalf("got %d %s, want %d %s", resp.Code, resp.Body, tc.status, tc.code)
			}
		})
	}
}

func TestRenameMyPasskey(t *testing.T) {
	user := db.User{ID: uuid.New(), Email: "ada@example.com"}
	principal := &authn.Principal{Kind: authn.KindUser, UserID: user.ID}
	id := uuid.New()
	for _, tc := range []struct {
		name    string
		body    map[string]any
		err     error
		status  int
		code    ErrCode
		renamed string
	}{
		{"ok, trimmed", map[string]any{"name": "  Work laptop "}, nil, http.StatusOK, "", "Work laptop"},
		{"blank", map[string]any{"name": "   "}, nil, http.StatusBadRequest, CodeInvalidRequest, ""},
		{"empty", map[string]any{"name": ""}, nil, http.StatusUnprocessableEntity, "", ""},
		{"too long", map[string]any{"name": strings.Repeat("x", 65)}, nil, http.StatusUnprocessableEntity, "", ""},
		{"not found", map[string]any{"name": "Key"}, passkey.ErrNotFound, http.StatusGone, CodePasskeyGone, "Key"},
		{"store down", map[string]any{"name": "Key"}, errors.New("boom"), http.StatusInternalServerError, CodeInternal, "Key"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			jobs := &fakeJobs{}
			mgr := &fakeManager{err: tc.err, cred: db.PasskeyCredential{ID: id, Name: "Old"}}
			api := newTestPasskeys(t, PasskeysDeps{Manager: mgr, Users: fakeUserByID{user: user}, Jobs: jobs}, principal)
			resp := api.Patch(MyPasskeysPath+"/"+id.String(), tc.body)
			if resp.Code != tc.status {
				t.Fatalf("status = %d, want %d: %s", resp.Code, tc.status, resp.Body)
			}
			if tc.code != "" && passkeyCode(t, resp.Body.Bytes()) != tc.code {
				t.Errorf("code = %s, want %s", resp.Body, tc.code)
			}
			if tc.renamed == "" && len(mgr.renamed) != 0 || tc.renamed != "" && (len(mgr.renamed) != 1 || mgr.renamed[0] != tc.renamed) {
				t.Errorf("renamed = %q, want %q", mgr.renamed, tc.renamed)
			}
			if tc.status == http.StatusOK {
				var p Passkey
				if err := json.Unmarshal(resp.Body.Bytes(), &p); err != nil || p.ID != id.String() || p.Name != tc.renamed {
					t.Errorf("body = %s (%v)", resp.Body, err)
				}
			}
			if len(jobs.jobs) != 0 {
				t.Errorf("rename enqueued %d alerts", len(jobs.jobs))
			}
		})
	}

	// A malformed id is a schema error.
	api := newTestPasskeys(t, PasskeysDeps{Manager: &fakeManager{}, Users: fakeUserByID{user: user}}, principal)
	if resp := api.Patch(MyPasskeysPath+"/not-a-uuid", map[string]any{"name": "Key"}); resp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad id: %d %s", resp.Code, resp.Body)
	}
}

func TestDeleteMyPasskey(t *testing.T) {
	user := db.User{ID: uuid.New(), Email: "ada@example.com"}
	principal := &authn.Principal{Kind: authn.KindUser, UserID: user.ID}
	id := uuid.New()
	for _, tc := range []struct {
		name     string
		p        *authn.Principal
		err      error
		jobsErr  error
		status   int
		code     ErrCode
		enqueued int
	}{
		{"ok", principal, nil, nil, http.StatusNoContent, "", 1},
		{"alert fails, still deleted", principal, nil, errors.New("queue down"), http.StatusNoContent, "", 0},
		{"unauthenticated", nil, nil, nil, http.StatusUnauthorized, CodeUnauthenticated, 0},
		{"not found", principal, passkey.ErrNotFound, nil, http.StatusGone, CodePasskeyGone, 0},
		{"store down", principal, errors.New("boom"), nil, http.StatusInternalServerError, CodeInternal, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			jobs := &fakeJobs{err: tc.jobsErr}
			mgr := &fakeManager{err: tc.err, cred: db.PasskeyCredential{ID: id, Name: "Key"}}
			api := newTestPasskeys(t, PasskeysDeps{Manager: mgr, Users: fakeUserByID{user: user}, Jobs: jobs}, tc.p)
			resp := api.Delete(MyPasskeysPath + "/" + id.String())
			if resp.Code != tc.status {
				t.Fatalf("status = %d, want %d: %s", resp.Code, tc.status, resp.Body)
			}
			if tc.code != "" && passkeyCode(t, resp.Body.Bytes()) != tc.code {
				t.Errorf("code = %s, want %s", resp.Body, tc.code)
			}
			if len(jobs.jobs) != tc.enqueued {
				t.Fatalf("enqueued %d alerts, want %d", len(jobs.jobs), tc.enqueued)
			}
			if tc.enqueued > 0 {
				if a := jobs.jobs[0]; a.To != user.Email || a.Template != email.TemplateSecurityChange || a.Data["change"] != email.SecurityChangePasskeyRemoved {
					t.Errorf("job = %+v", a)
				}
			}
			if tc.p != nil && (len(mgr.deleted) != 1 || mgr.deleted[0] != id) {
				t.Errorf("deleted = %v", mgr.deleted)
			}
		})
	}
}
