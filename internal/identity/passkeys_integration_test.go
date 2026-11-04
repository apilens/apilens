//go:build integration

package identity

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"slices"
	"strings"
	"testing"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/valkey-io/valkey-go"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/passkey"
	"github.com/apilens/apilens/internal/identity/passkey/passkeytest"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/testutil"
)

const passkeyOrigin = "http://localhost:3000"

const chromeMacUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

// onePasswordAAGUID is in the default-name table.
var onePasswordAAGUID = uuid.MustParse("bada5566-a7aa-401f-bd96-45619a55120d")

type passkeyFixture struct {
	*meFixture
	jobs *fakeJobs
	vk   valkey.Client
	rp   *webauthn.WebAuthn
}

// setupPasskeys serves the passkey endpoints over real Postgres and
// Valkey behind the real session middleware.
func setupPasskeys(t *testing.T) *passkeyFixture {
	t.Helper()
	f := setupMe(t)
	vk, err := cache.Connect(context.Background(), testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(vk.Close)
	rp, err := passkey.NewRelyingParty(config.WebAuthnConfig{RPID: "localhost", RPName: "APILens", Origins: []string{passkeyOrigin}})
	if err != nil {
		t.Fatal(err)
	}
	jobs := &fakeJobs{}
	// audit.Middleware's job in the server: the client for audit and alerts.
	f.api.UseMiddleware(func(ctx huma.Context, next func(huma.Context)) {
		next(huma.WithContext(ctx, audit.WithRequest(ctx.Context(), audit.Request{
			IP: netip.MustParseAddr("203.0.113.5"), UserAgent: ctx.Header("User-Agent"),
		})))
	})
	NewPasskeys(PasskeysDeps{
		Registrar: passkey.NewRegistration(rp, passkey.NewValkeyChallengeStore(vk), f.pool),
		Manager:   passkey.NewManager(f.pool),
		Users:     f.q,
		Jobs:      jobs,
	}, testutil.Logger(t)).Register(f.api)
	return &passkeyFixture{meFixture: f, jobs: jobs, vk: vk, rp: rp}
}

type registerOptions struct {
	ChallengeID string          `json:"challenge_id"`
	Options     json.RawMessage `json:"options"`
}

func (f *passkeyFixture) options(t *testing.T, auth string) registerOptions {
	t.Helper()
	resp := f.api.Post(PasskeyRegisterPrefix+"/options", auth, map[string]any{})
	if resp.Code != http.StatusOK {
		t.Fatalf("options: status = %d: %s", resp.Code, resp.Body)
	}
	var o registerOptions
	if err := json.Unmarshal(resp.Body.Bytes(), &o); err != nil || o.ChallengeID == "" {
		t.Fatalf("options: %s (%v)", resp.Body, err)
	}
	return o
}

func (f *passkeyFixture) verify(t *testing.T, auth, challengeID string, response json.RawMessage, name string) *httptest.ResponseRecorder {
	t.Helper()
	body := map[string]any{"challenge_id": challengeID, "response": response}
	if name != "" {
		body["name"] = name
	}
	return f.api.Post(PasskeyRegisterPrefix+"/verify", auth, "User-Agent: "+chromeMacUA, body)
}

func passkeyProblemCode(t *testing.T, r *httptest.ResponseRecorder) ErrCode {
	t.Helper()
	var p Problem
	if err := json.Unmarshal(r.Body.Bytes(), &p); err != nil {
		t.Fatalf("decode problem %s: %v", r.Body, err)
	}
	return p.Code
}

func TestPasskeyRegisterIntegration(t *testing.T) {
	f := setupPasskeys(t)
	u, auth := f.signIn(t, "passkey@example.com")

	// Options: rp, user handle = user id bytes, a challenge, no exclusions yet.
	o := f.options(t, auth)
	var opts struct {
		PublicKey struct {
			RP struct {
				ID string `json:"id"`
			} `json:"rp"`
			User struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"user"`
			Challenge   string            `json:"challenge"`
			ExcludeList []json.RawMessage `json:"excludeCredentials"`
		} `json:"publicKey"`
	}
	if err := json.Unmarshal(o.Options, &opts); err != nil {
		t.Fatal(err)
	}
	handle, err := base64.RawURLEncoding.DecodeString(opts.PublicKey.User.ID)
	if err != nil || !bytes.Equal(handle, u.ID[:]) {
		t.Fatalf("user handle = %q, want the user id bytes", opts.PublicKey.User.ID)
	}
	if opts.PublicKey.RP.ID != "localhost" || opts.PublicKey.User.Name != u.Email || opts.PublicKey.Challenge == "" || len(opts.PublicKey.ExcludeList) != 0 {
		t.Fatalf("options = %s", o.Options)
	}

	// Verify with a virtual authenticator: stored, named after the AAGUID.
	authr := passkeytest.New(passkeyOrigin, onePasswordAAGUID)
	authr.BackupEligible, authr.BackupState = true, true
	resp, err := authr.Register(o.Options)
	if err != nil {
		t.Fatal(err)
	}
	r := f.verify(t, auth, o.ChallengeID, resp, "")
	if r.Code != http.StatusCreated {
		t.Fatalf("verify: status = %d: %s", r.Code, r.Body)
	}
	var pk Passkey
	if err := json.Unmarshal(r.Body.Bytes(), &pk); err != nil {
		t.Fatal(err)
	}
	if pk.Name != "1Password" || pk.AAGUID != onePasswordAAGUID.String() || !pk.BackupEligible || !pk.BackupState ||
		!slices.Equal(pk.Transports, []string{"internal", "hybrid"}) || pk.LastUsedAt != nil {
		t.Fatalf("passkey = %+v", pk)
	}
	creds, err := f.q.ListPasskeyCredentialsForUser(f.ctx, u.ID)
	if err != nil || len(creds) != 1 {
		t.Fatalf("stored = %d (%v)", len(creds), err)
	}
	if c := creds[0]; !bytes.Equal(c.CredentialID, authr.CredentialID) || len(c.PublicKey) == 0 || c.AttestationType != "none" || c.ID.String() != pk.ID {
		t.Fatalf("stored credential = %+v", c)
	}

	// Audited and alerted.
	evs := f.events(t, u.ID, audit.PasskeyAdded)
	if len(evs) != 1 || evs[0].ActorUserID == nil || *evs[0].ActorUserID != u.ID {
		t.Fatalf("passkey.added events = %+v", evs)
	}
	if len(f.jobs.jobs) != 1 {
		t.Fatalf("jobs = %+v", f.jobs.jobs)
	}
	if j := f.jobs.jobs[0]; j.To != u.Email || j.Template != email.TemplateSecurityChange ||
		j.Data["change"] != email.SecurityChangePasskeyAdded || j.Data["device"] != "Chrome on macOS" || j.Data["ip"] != "203.0.113.5" {
		t.Fatalf("job = %+v", j)
	}

	// The challenge is single use.
	if r := f.verify(t, auth, o.ChallengeID, resp, ""); r.Code != http.StatusUnauthorized || passkeyProblemCode(t, r) != CodePasskeyFailed {
		t.Fatalf("reused challenge: %d %s", r.Code, r.Body)
	}

	// The next options exclude the registered passkey.
	o2 := f.options(t, auth)
	if err := json.Unmarshal(o2.Options, &opts); err != nil {
		t.Fatal(err)
	}
	if len(opts.PublicKey.ExcludeList) != 1 {
		t.Fatalf("excludeCredentials = %d, want 1: %s", len(opts.PublicKey.ExcludeList), o2.Options)
	}

	// A duplicate credential id is rejected, whoever registers it.
	dup, err := authr.Register(o2.Options)
	if err != nil {
		t.Fatal(err)
	}
	if r := f.verify(t, auth, o2.ChallengeID, dup, ""); r.Code != http.StatusConflict || passkeyProblemCode(t, r) != CodePasskeyExists {
		t.Fatalf("duplicate: %d %s", r.Code, r.Body)
	}
	other, otherAuth := f.signIn(t, "other@example.com")
	o3 := f.options(t, otherAuth)
	dup, err = authr.Register(o3.Options)
	if err != nil {
		t.Fatal(err)
	}
	if r := f.verify(t, otherAuth, o3.ChallengeID, dup, ""); r.Code != http.StatusConflict || passkeyProblemCode(t, r) != CodePasskeyExists {
		t.Fatalf("duplicate for another user: %d %s", r.Code, r.Body)
	}
	if n, _ := f.q.CountPasskeyCredentialsForUser(f.ctx, other.ID); n != 0 {
		t.Fatalf("other user has %d passkeys", n)
	}
	if n, _ := f.q.CountPasskeyCredentialsForUser(f.ctx, u.ID); n != 1 {
		t.Fatalf("user has %d passkeys, want 1", n)
	}
	if evs := f.events(t, u.ID, audit.PasskeyAdded); len(evs) != 1 {
		t.Fatalf("passkey.added events after duplicates = %d", len(evs))
	}

	// A second authenticator with a name the user chose.
	o4 := f.options(t, auth)
	resp, err = passkeytest.New(passkeyOrigin, uuid.Nil).Register(o4.Options)
	if err != nil {
		t.Fatal(err)
	}
	r = f.verify(t, auth, o4.ChallengeID, resp, "  Work laptop ")
	if r.Code != http.StatusCreated {
		t.Fatalf("named: %d %s", r.Code, r.Body)
	}
	if err := json.Unmarshal(r.Body.Bytes(), &pk); err != nil || pk.Name != "Work laptop" || pk.AAGUID != uuid.Nil.String() {
		t.Fatalf("named passkey = %+v (%v)", pk, err)
	}
}

func TestPasskeyRegisterRejectsIntegration(t *testing.T) {
	f := setupPasskeys(t)
	u, auth := f.signIn(t, "reject@example.com")
	_, otherAuth := f.signIn(t, "thief@example.com")

	// No session.
	if r := f.api.Post(PasskeyRegisterPrefix+"/options", map[string]any{}); r.Code != http.StatusUnauthorized {
		t.Fatalf("options without session: %d %s", r.Code, r.Body)
	}

	// Another user's challenge.
	o := f.options(t, auth)
	resp, err := passkeytest.New(passkeyOrigin, uuid.Nil).Register(o.Options)
	if err != nil {
		t.Fatal(err)
	}
	if r := f.verify(t, otherAuth, o.ChallengeID, resp, ""); r.Code != http.StatusUnauthorized || passkeyProblemCode(t, r) != CodePasskeyFailed {
		t.Fatalf("other user's challenge: %d %s", r.Code, r.Body)
	}

	// A response from a foreign origin.
	o = f.options(t, auth)
	resp, err = passkeytest.New("https://evil.example", uuid.Nil).Register(o.Options)
	if err != nil {
		t.Fatal(err)
	}
	if r := f.verify(t, auth, o.ChallengeID, resp, ""); r.Code != http.StatusUnauthorized || passkeyProblemCode(t, r) != CodePasskeyFailed {
		t.Fatalf("foreign origin: %d %s", r.Code, r.Body)
	}

	// Garbage and unknown challenges.
	o = f.options(t, auth)
	if r := f.verify(t, auth, o.ChallengeID, json.RawMessage(`{"id":"x"}`), ""); r.Code != http.StatusUnauthorized {
		t.Fatalf("garbage response: %d %s", r.Code, r.Body)
	}
	if r := f.verify(t, auth, "nope", json.RawMessage(`{}`), ""); r.Code != http.StatusUnauthorized {
		t.Fatalf("unknown challenge: %d %s", r.Code, r.Body)
	}

	if n, _ := f.q.CountPasskeyCredentialsForUser(f.ctx, u.ID); n != 0 {
		t.Fatalf("stored %d passkeys after rejections", n)
	}
	if len(f.jobs.jobs) != 0 {
		t.Fatalf("alerts sent after rejections: %+v", f.jobs.jobs)
	}
}

// register adds a passkey from a fresh virtual authenticator to the user
// signed in with auth.
func (f *passkeyFixture) register(t *testing.T, auth string, aaguid uuid.UUID, name string) Passkey {
	t.Helper()
	o := f.options(t, auth)
	authr := passkeytest.New(passkeyOrigin, aaguid)
	authr.BackupEligible, authr.BackupState = true, true
	resp, err := authr.Register(o.Options)
	if err != nil {
		t.Fatal(err)
	}
	r := f.verify(t, auth, o.ChallengeID, resp, name)
	if r.Code != http.StatusCreated {
		t.Fatalf("register: %d %s", r.Code, r.Body)
	}
	var pk Passkey
	if err := json.Unmarshal(r.Body.Bytes(), &pk); err != nil {
		t.Fatal(err)
	}
	return pk
}

func (f *passkeyFixture) listPasskeys(t *testing.T, auth string) []Passkey {
	t.Helper()
	r := f.api.Get(MyPasskeysPath, auth)
	if r.Code != http.StatusOK {
		t.Fatalf("list: %d %s", r.Code, r.Body)
	}
	var out struct {
		Passkeys []Passkey `json:"passkeys"`
	}
	if err := json.Unmarshal(r.Body.Bytes(), &out); err != nil || out.Passkeys == nil {
		t.Fatalf("list body %s (%v)", r.Body, err)
	}
	return out.Passkeys
}

func TestPasskeyManageIntegration(t *testing.T) {
	f := setupPasskeys(t)
	u, auth := f.signIn(t, "manage@example.com")
	other, otherAuth := f.signIn(t, "bystander@example.com")

	// No session.
	if r := f.api.Get(MyPasskeysPath); r.Code != http.StatusUnauthorized {
		t.Fatalf("list without session: %d %s", r.Code, r.Body)
	}

	// An empty list is [], not null.
	if got := f.listPasskeys(t, auth); len(got) != 0 {
		t.Fatalf("initial list = %+v", got)
	}

	first := f.register(t, auth, onePasswordAAGUID, "")
	second := f.register(t, auth, uuid.Nil, "Work key")
	foreign := f.register(t, otherAuth, uuid.Nil, "Theirs")
	f.jobs.jobs = nil

	// List: oldest first, with vendor and backup state; another user's
	// passkey is not listed.
	list := f.listPasskeys(t, auth)
	if len(list) != 2 || list[0].ID != first.ID || list[1].ID != second.ID {
		t.Fatalf("list = %+v", list)
	}
	if list[0].Authenticator != "1Password" || list[0].Name != "1Password" || !list[0].BackupState ||
		list[0].CreatedAt.IsZero() || list[0].LastUsedAt != nil {
		t.Fatalf("first = %+v", list[0])
	}
	if list[1].Authenticator != "" || list[1].Name != "Work key" {
		t.Fatalf("second = %+v", list[1])
	}

	// Rename: trimmed, audited, no alert.
	r := f.api.Patch(MyPasskeysPath+"/"+first.ID, auth, map[string]any{"name": "  Personal laptop  "})
	if r.Code != http.StatusOK {
		t.Fatalf("rename: %d %s", r.Code, r.Body)
	}
	var pk Passkey
	if err := json.Unmarshal(r.Body.Bytes(), &pk); err != nil || pk.ID != first.ID || pk.Name != "Personal laptop" || pk.Authenticator != "1Password" {
		t.Fatalf("renamed = %+v (%v)", pk, err)
	}
	if got := f.listPasskeys(t, auth); got[0].Name != "Personal laptop" {
		t.Fatalf("list after rename = %+v", got)
	}
	evs := f.events(t, u.ID, audit.PasskeyRenamed)
	if len(evs) != 1 || evs[0].ActorUserID == nil || *evs[0].ActorUserID != u.ID {
		t.Fatalf("passkey.renamed events = %+v", evs)
	}
	var meta map[string]any
	if err := json.Unmarshal(evs[0].Metadata, &meta); err != nil || meta["passkey_id"] != first.ID ||
		meta["from"] != "1Password" || meta["to"] != "Personal laptop" {
		t.Fatalf("passkey.renamed metadata = %s (%v)", evs[0].Metadata, err)
	}
	// Renaming to the current name changes nothing and records nothing.
	if r := f.api.Patch(MyPasskeysPath+"/"+first.ID, auth, map[string]any{"name": "Personal laptop"}); r.Code != http.StatusOK {
		t.Fatalf("same name: %d %s", r.Code, r.Body)
	}
	if evs := f.events(t, u.ID, audit.PasskeyRenamed); len(evs) != 1 {
		t.Fatalf("passkey.renamed events after a no-op = %d", len(evs))
	}
	if len(f.jobs.jobs) != 0 {
		t.Fatalf("rename sent alerts: %+v", f.jobs.jobs)
	}

	// Rename rejects a blank or too long name, another user's passkey and an
	// unknown id.
	if r := f.api.Patch(MyPasskeysPath+"/"+first.ID, auth, map[string]any{"name": "   "}); r.Code != http.StatusBadRequest || passkeyProblemCode(t, r) != CodeInvalidRequest {
		t.Fatalf("blank name: %d %s", r.Code, r.Body)
	}
	if r := f.api.Patch(MyPasskeysPath+"/"+first.ID, auth, map[string]any{"name": strings.Repeat("x", 65)}); r.Code != http.StatusUnprocessableEntity {
		t.Fatalf("long name: %d %s", r.Code, r.Body)
	}
	if r := f.api.Patch(MyPasskeysPath+"/"+foreign.ID, auth, map[string]any{"name": "Mine now"}); r.Code != http.StatusGone || passkeyProblemCode(t, r) != CodePasskeyGone {
		t.Fatalf("rename another user's: %d %s", r.Code, r.Body)
	}
	if r := f.api.Patch(MyPasskeysPath+"/"+uuid.NewString(), auth, map[string]any{"name": "Ghost"}); r.Code != http.StatusGone || passkeyProblemCode(t, r) != CodePasskeyGone {
		t.Fatalf("rename unknown: %d %s", r.Code, r.Body)
	}

	// Deleting another user's passkey is 410 and leaves it alone.
	if r := f.api.Delete(MyPasskeysPath+"/"+foreign.ID, auth); r.Code != http.StatusGone || passkeyProblemCode(t, r) != CodePasskeyGone {
		t.Fatalf("delete another user's: %d %s", r.Code, r.Body)
	}
	if n, _ := f.q.CountPasskeyCredentialsForUser(f.ctx, other.ID); n != 1 {
		t.Fatalf("other user has %d passkeys after a foreign delete", n)
	}
	if got := f.listPasskeys(t, otherAuth); len(got) != 1 || got[0].Name != "Theirs" {
		t.Fatalf("other user's list = %+v", got)
	}

	// Delete own: 204, gone, audited, alerted.
	r = f.api.Delete(MyPasskeysPath+"/"+second.ID, auth, "User-Agent: "+chromeMacUA)
	if r.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", r.Code, r.Body)
	}
	if got := f.listPasskeys(t, auth); len(got) != 1 || got[0].ID != first.ID {
		t.Fatalf("list after delete = %+v", got)
	}
	evs = f.events(t, u.ID, audit.PasskeyRemoved)
	if len(evs) != 1 || evs[0].ActorUserID == nil || *evs[0].ActorUserID != u.ID {
		t.Fatalf("passkey.removed events = %+v", evs)
	}
	meta = nil
	if err := json.Unmarshal(evs[0].Metadata, &meta); err != nil || meta["passkey_id"] != second.ID || meta["name"] != "Work key" {
		t.Fatalf("passkey.removed metadata = %s (%v)", evs[0].Metadata, err)
	}
	if len(f.jobs.jobs) != 1 {
		t.Fatalf("jobs = %+v", f.jobs.jobs)
	}
	if j := f.jobs.jobs[0]; j.To != u.Email || j.Template != email.TemplateSecurityChange ||
		j.Data["change"] != email.SecurityChangePasskeyRemoved || j.Data["device"] != "Chrome on macOS" || j.Data["ip"] != "203.0.113.5" {
		t.Fatalf("job = %+v", j)
	}

	// Deleting it again is 410, with no second event or alert.
	if r := f.api.Delete(MyPasskeysPath+"/"+second.ID, auth); r.Code != http.StatusGone || passkeyProblemCode(t, r) != CodePasskeyGone {
		t.Fatalf("delete twice: %d %s", r.Code, r.Body)
	}
	if evs := f.events(t, u.ID, audit.PasskeyRemoved); len(evs) != 1 || len(f.jobs.jobs) != 1 {
		t.Fatalf("after a second delete: events = %d, jobs = %d", len(evs), len(f.jobs.jobs))
	}
}
