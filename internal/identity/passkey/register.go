package passkey

import (
	"bytes"
	"context"
	"errors"
	"fmt"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/store/db"
)

var (
	// ErrVerification means the registration response failed WebAuthn
	// verification (challenge, origin, RP ID, user, flags or attestation),
	// or could not be parsed.
	ErrVerification = errors.New("passkey: registration verification failed")
	// ErrCredentialExists means the credential id is already registered, to
	// this user or another.
	ErrCredentialExists = errors.New("passkey: credential already registered")
)

// uniqueViolation is the PostgreSQL SQLSTATE of a unique constraint failure.
const uniqueViolation = "23505"

// TxBeginner starts transactions; *pgxpool.Pool satisfies it.
type TxBeginner interface {
	db.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Registration runs the passkey registration ceremony for a signed-in user:
// Options starts it, Verify finishes it and stores the credential.
type Registration struct {
	rp         *webauthn.WebAuthn
	challenges ChallengeStore
	pool       TxBeginner
	q          *db.Queries
	audit      *audit.Recorder
}

// NewRegistration returns the registration ceremony over rp, with pending
// ceremonies in challenges and credentials in pool.
func NewRegistration(rp *webauthn.WebAuthn, challenges ChallengeStore, pool TxBeginner) *Registration {
	return &Registration{rp: rp, challenges: challenges, pool: pool, q: db.New(pool), audit: audit.New(pool)}
}

// Options starts a registration for u. The user handle is the user id's 16
// bytes, and the user's existing passkeys are excluded so an authenticator
// that already holds one for this account declines instead of creating a
// duplicate. It returns the challenge id to send back with Verify and the
// creation options for navigator.credentials.create().
func (r *Registration) Options(ctx context.Context, u db.User) (string, *protocol.CredentialCreation, error) {
	creds, err := r.q.ListPasskeyCredentialsForUser(ctx, u.ID)
	if err != nil {
		return "", nil, fmt.Errorf("passkey: list credentials: %w", err)
	}
	user := newUser(u, creds)
	creation, sd, err := r.rp.BeginRegistration(user,
		webauthn.WithExclusions(webauthn.Credentials(user.creds).CredentialDescriptors()))
	if err != nil {
		return "", nil, fmt.Errorf("passkey: begin registration: %w", err)
	}
	id, err := r.challenges.Put(ctx, CeremonyRegistration, *sd)
	if err != nil {
		return "", nil, err
	}
	return id, creation, nil
}

// VerifyInput is the client's answer to a registration's options.
type VerifyInput struct {
	ChallengeID string
	// Response is the PublicKeyCredential from navigator.credentials.create(),
	// JSON-encoded.
	Response []byte
	// Name is the user's label; empty means DefaultName.
	Name string
	// UserAgent is the registering client's user agent, for DefaultName.
	UserAgent string
}

// Verify finishes the registration of challenge in.ChallengeID for u: it
// consumes the challenge, verifies the response, stores the credential and
// audits passkey.added in one transaction. It returns ErrChallengeNotFound
// for an unknown, expired or used challenge (or one issued to another user),
// ErrVerification for a response that does not verify, and
// ErrCredentialExists for a credential id that is already registered.
func (r *Registration) Verify(ctx context.Context, u db.User, in VerifyInput) (db.PasskeyCredential, error) {
	sd, err := r.challenges.Take(ctx, CeremonyRegistration, in.ChallengeID)
	if err != nil {
		return db.PasskeyCredential{}, err
	}
	if !bytes.Equal(sd.UserID, u.ID[:]) {
		return db.PasskeyCredential{}, ErrChallengeNotFound
	}
	parsed, err := protocol.ParseCredentialCreationResponseBytes(in.Response)
	if err != nil {
		return db.PasskeyCredential{}, fmt.Errorf("%w: %w", ErrVerification, err)
	}
	cred, err := r.rp.CreateCredential(newUser(u, nil), sd, parsed)
	if err != nil {
		return db.PasskeyCredential{}, fmt.Errorf("%w: %w", ErrVerification, err)
	}

	aaguid, err := uuid.FromBytes(cred.Authenticator.AAGUID)
	if err != nil {
		aaguid = uuid.Nil
	}
	name := ClampName(in.Name)
	if name == "" {
		name = DefaultName(aaguid, in.UserAgent)
	}
	transports := make([]string, 0, len(cred.Transport))
	for _, t := range cred.Transport {
		transports = append(transports, string(t))
	}
	attestation := cred.AttestationFormat
	if attestation == "" {
		attestation = string(protocol.AttestationFormatNone)
	}

	var stored db.PasskeyCredential
	err = r.inTx(ctx, func(ctx context.Context, q *db.Queries) error {
		var err error
		stored, err = q.CreatePasskeyCredential(ctx, db.CreatePasskeyCredentialParams{
			ID:              uuid.New(),
			UserID:          u.ID,
			CredentialID:    cred.ID,
			PublicKey:       cred.PublicKey,
			AttestationType: attestation,
			Aaguid:          aaguid,
			SignCount:       int64(cred.Authenticator.SignCount),
			Transports:      transports,
			BackupEligible:  cred.Flags.BackupEligible,
			BackupState:     cred.Flags.BackupState,
			Name:            name,
		})
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == uniqueViolation {
				return ErrCredentialExists
			}
			return fmt.Errorf("passkey: store credential: %w", err)
		}
		return r.audit.Record(ctx, audit.Event{
			User:  &u.ID,
			Actor: &u.ID,
			Kind:  audit.PasskeyAdded,
			Meta: map[string]any{
				"passkey_id":  stored.ID.String(),
				"name":        stored.Name,
				"aaguid":      aaguid.String(),
				"attestation": attestation,
			},
		})
	})
	if err != nil {
		return db.PasskeyCredential{}, err
	}
	return stored, nil
}

// inTx runs fn in a transaction whose audit events commit with it.
func (r *Registration) inTx(ctx context.Context, fn func(context.Context, *db.Queries) error) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("passkey: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(audit.WithTx(ctx, tx), r.q.WithTx(tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("passkey: commit: %w", err)
	}
	return nil
}

// user adapts an identity user and its passkeys to webauthn.User.
type user struct {
	u     db.User
	creds []webauthn.Credential
}

func newUser(u db.User, stored []db.PasskeyCredential) user {
	creds := make([]webauthn.Credential, 0, len(stored))
	for _, c := range stored {
		transports := make([]protocol.AuthenticatorTransport, 0, len(c.Transports))
		for _, t := range c.Transports {
			transports = append(transports, protocol.AuthenticatorTransport(t))
		}
		creds = append(creds, webauthn.Credential{
			ID:        c.CredentialID,
			PublicKey: c.PublicKey,
			Transport: transports,
		})
	}
	return user{u: u, creds: creds}
}

// WebAuthnID is the user handle: the user id's 16 bytes. It carries no
// personal data and never changes.
func (w user) WebAuthnID() []byte { return w.u.ID[:] }

// WebAuthnName is the account name the authenticator shows: the email.
func (w user) WebAuthnName() string { return w.u.Email }

// WebAuthnDisplayName is the user's name, or the email when unset.
func (w user) WebAuthnDisplayName() string {
	if w.u.Name != "" {
		return w.u.Name
	}
	return w.u.Email
}

// WebAuthnCredentials are the user's registered passkeys.
func (w user) WebAuthnCredentials() []webauthn.Credential { return w.creds }
