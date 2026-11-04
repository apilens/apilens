package identity

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/passkey"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// PasskeyRegisterPrefix is the path prefix of the passkey registration
// ceremony.
const PasskeyRegisterPrefix = AuthPrefix + "/passkeys/register"

// maxPasskeyResponse bounds the JSON-encoded registration response. A real
// attestation (certificate chain included) is a few KB.
const maxPasskeyResponse = 64 << 10

// PasskeyRegistrar runs the registration ceremony; *passkey.Registration
// satisfies it.
type PasskeyRegistrar interface {
	Options(ctx context.Context, u db.User) (string, *protocol.CredentialCreation, error)
	Verify(ctx context.Context, u db.User, in passkey.VerifyInput) (db.PasskeyCredential, error)
}

// UserGetter reads an active user by id; *db.Queries satisfies it.
type UserGetter interface {
	GetUserByID(ctx context.Context, id uuid.UUID) (db.User, error)
}

// PasskeysDeps are the collaborators of the passkey registration endpoints.
type PasskeysDeps struct {
	Registrar PasskeyRegistrar
	Users     UserGetter
	Jobs      JobEnqueuer
}

// PasskeyOptionsResponse is the body of POST …/passkeys/register/options.
type PasskeyOptionsResponse struct {
	ChallengeID string          `json:"challenge_id" doc:"Send back with the verify request. Valid for 5 minutes, once."`
	Options     json.RawMessage `json:"options" doc:"CredentialCreationOptions ({publicKey: ...}) for navigator.credentials.create()."`
}

// PasskeyOptionsOutput is the response of POST …/passkeys/register/options.
type PasskeyOptionsOutput struct {
	Body PasskeyOptionsResponse
}

// PasskeyVerifyBody is the request body of POST …/passkeys/register/verify.
type PasskeyVerifyBody struct {
	ChallengeID string          `json:"challenge_id" minLength:"1" maxLength:"128" doc:"The challenge_id from the options response."`
	Response    json.RawMessage `json:"response" doc:"The PublicKeyCredential from navigator.credentials.create(), JSON-encoded (PublicKeyCredential.toJSON())."`
	Name        string          `json:"name,omitempty" maxLength:"64" doc:"Label shown in Security settings. Defaults to the authenticator's name (for example \"iCloud Keychain\") or the browser and OS."`
}

// PasskeyVerifyInput is the request of POST …/passkeys/register/verify.
type PasskeyVerifyInput struct {
	Body PasskeyVerifyBody
}

// Passkey is a registered passkey as listed in Security settings.
type Passkey struct {
	ID             string     `json:"id" format:"uuid"`
	Name           string     `json:"name"`
	AAGUID         string     `json:"aaguid" format:"uuid" doc:"Authenticator model; all zeros when the authenticator did not say."`
	Transports     []string   `json:"transports" doc:"Transport hints the browser reported (usb, nfc, ble, internal, hybrid)."`
	BackupEligible bool       `json:"backup_eligible" doc:"Whether the passkey can be synced across devices."`
	BackupState    bool       `json:"backup_state" doc:"Whether the passkey is currently synced."`
	CreatedAt      time.Time  `json:"created_at"`
	LastUsedAt     *time.Time `json:"last_used_at" nullable:"true" doc:"Last sign-in with this passkey, or null."`
}

// NewPasskey renders c.
func NewPasskey(c db.PasskeyCredential) Passkey {
	p := Passkey{
		ID:             c.ID.String(),
		Name:           c.Name,
		AAGUID:         c.Aaguid.String(),
		Transports:     c.Transports,
		BackupEligible: c.BackupEligible,
		BackupState:    c.BackupState,
		CreatedAt:      c.CreatedAt.UTC(),
	}
	if p.Transports == nil {
		p.Transports = []string{}
	}
	if c.LastUsedAt != nil {
		t := c.LastUsedAt.UTC()
		p.LastUsedAt = &t
	}
	return p
}

// PasskeyVerifyOutput is the response of POST …/passkeys/register/verify.
type PasskeyVerifyOutput struct {
	Body Passkey
}

// Passkeys serves the passkey registration endpoints.
type Passkeys struct {
	deps   PasskeysDeps
	logger *slog.Logger
	now    func() time.Time
}

// NewPasskeys returns the passkey registration endpoints.
func NewPasskeys(deps PasskeysDeps, logger *slog.Logger) *Passkeys {
	return &Passkeys{deps: deps, logger: logger, now: time.Now}
}

// Register mounts POST …/passkeys/register/options and …/register/verify.
// They declare the session scheme, so authn.Middleware must be installed on
// api before.
func (p *Passkeys) Register(api huma.API) {
	security := []map[string][]string{{authn.SchemeSession: {}}}
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "passkey-register-options",
		Method:      http.MethodPost,
		Path:        PasskeyRegisterPrefix + "/options",
		Summary:     "Start registering a passkey",
		Description: "Starts adding a passkey to the signed-in user. Returns a `challenge_id` (valid 5 minutes, once) and the " +
			"`options` for `navigator.credentials.create()`. The user handle is the user id; the user's existing passkeys are excluded.",
		Tags:     []string{server.TagAuth},
		Security: security,
	}, CodeUnauthenticated, CodeSessionExpired, CodeInternal), p.options)

	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "passkey-register-verify",
		Method:      http.MethodPost,
		Path:        PasskeyRegisterPrefix + "/verify",
		Summary:     "Finish registering a passkey",
		Description: "Verifies the authenticator's response to the options of `challenge_id` and stores the passkey. " +
			"Without `name` it is named after the authenticator (or the browser and OS). " +
			"Answers 401 `passkey_failed` when the challenge is unknown, expired or used, or the response does not verify, " +
			"and 409 `passkey_already_registered` for a credential that is already registered. " +
			"Audited as `passkey.added`; the user is emailed a security alert.",
		Tags:          []string{server.TagAuth},
		Security:      security,
		DefaultStatus: http.StatusCreated,
	}, CodeInvalidRequest, CodeUnauthenticated, CodeSessionExpired, CodePasskeyFailed, CodePasskeyExists, CodeInternal), p.verify)
}

func (p *Passkeys) options(ctx context.Context, _ *struct{}) (*PasskeyOptionsOutput, error) {
	u, err := p.user(ctx)
	if err != nil {
		return nil, err
	}
	id, creation, err := p.deps.Registrar.Options(ctx, u)
	if err != nil {
		p.logger.ErrorContext(ctx, "passkey register options", "error", err)
		return nil, Err(CodeInternal)
	}
	b, err := json.Marshal(creation)
	if err != nil {
		p.logger.ErrorContext(ctx, "passkey register options: encode", "error", err)
		return nil, Err(CodeInternal)
	}
	return &PasskeyOptionsOutput{Body: PasskeyOptionsResponse{ChallengeID: id, Options: b}}, nil
}

func (p *Passkeys) verify(ctx context.Context, in *PasskeyVerifyInput) (*PasskeyVerifyOutput, error) {
	if len(in.Body.Response) == 0 || len(in.Body.Response) > maxPasskeyResponse {
		return nil, Err(CodeInvalidRequest)
	}
	u, err := p.user(ctx)
	if err != nil {
		return nil, err
	}
	req := audit.RequestFrom(ctx)
	cred, err := p.deps.Registrar.Verify(ctx, u, passkey.VerifyInput{
		ChallengeID: in.Body.ChallengeID,
		Response:    in.Body.Response,
		Name:        in.Body.Name,
		UserAgent:   req.UserAgent,
	})
	switch {
	case err == nil:
	case errors.Is(err, passkey.ErrChallengeNotFound), errors.Is(err, passkey.ErrVerification):
		p.logger.InfoContext(ctx, "passkey register verify rejected", "error", err)
		return nil, Err(CodePasskeyFailed)
	case errors.Is(err, passkey.ErrCredentialExists):
		return nil, Err(CodePasskeyExists)
	default:
		p.logger.ErrorContext(ctx, "passkey register verify", "error", err)
		return nil, Err(CodeInternal)
	}

	ip := "unknown"
	if req.IP.IsValid() {
		ip = req.IP.String()
	}
	job := email.SendArgs{To: u.Email, Template: email.TemplateSecurityChange, Data: map[string]any{
		"change": email.SecurityChangePasskeyAdded,
		"device": session.DeviceLabel(req.UserAgent),
		"ip":     ip,
		"time":   p.now().UTC(),
	}}
	// The passkey is stored; a failed alert is logged, not returned.
	if _, err := p.deps.Jobs.Insert(ctx, job, nil); err != nil {
		p.logger.ErrorContext(ctx, "passkey register verify: enqueue security alert", "error", err)
	}
	return &PasskeyVerifyOutput{Body: NewPasskey(cred)}, nil
}

// user loads the signed-in user. A user deleted while their access token is
// still valid answers session_expired.
func (p *Passkeys) user(ctx context.Context) (db.User, error) {
	pr, ok := authn.FromContext(ctx)
	if !ok || pr.Kind != authn.KindUser {
		return db.User{}, Err(CodeUnauthenticated)
	}
	u, err := p.deps.Users.GetUserByID(ctx, pr.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return db.User{}, Err(CodeSessionExpired)
	}
	if err != nil {
		p.logger.ErrorContext(ctx, "passkey: load user", "error", err)
		return db.User{}, Err(CodeInternal)
	}
	return u, nil
}
