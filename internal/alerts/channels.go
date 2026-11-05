// Package alerts holds threshold alerting over api_requests_1m: rules, the
// incidents (events) they raise and the notification channels they notify.
// The schema is internal/migrations/postgres/00016_alerts.sql and the queries
// are internal/controlplane/store/queries/alerts.sql.
package alerts

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"

	idkeys "github.com/apilens/apilens/internal/identity/keys"
)

// ChannelType is notification_channels.type.
type ChannelType string

// The channel types notification_channels accepts.
const (
	ChannelEmail   ChannelType = "email"
	ChannelSlack   ChannelType = "slack"
	ChannelTeams   ChannelType = "teams"
	ChannelWebhook ChannelType = "webhook"
)

// Valid reports whether t is a type notification_channels accepts.
func (t ChannelType) Valid() bool {
	switch t {
	case ChannelEmail, ChannelSlack, ChannelTeams, ChannelWebhook:
		return true
	}
	return false
}

// ErrConfigNotObject is returned when a channel config is not a JSON object.
var ErrConfigNotObject = errors.New("alerts: channel config must be a JSON object")

// ChannelConfigAD is the additional data a channel's sealed config
// (notification_channels.config_enc) is bound to, so a ciphertext copied onto
// another channel's row fails to open.
func ChannelConfigAD(channel uuid.UUID) []byte {
	return []byte("notification_channels:" + channel.String())
}

// SealChannelConfig encrypts a channel's JSON config (addresses, webhook
// URLs, signing secrets) for notification_channels.config_enc with the
// identity key-encryption key. config must be a JSON object.
func SealChannelConfig(sealer *idkeys.Sealer, channel uuid.UUID, config json.RawMessage) ([]byte, error) {
	if !isJSONObject(config) {
		return nil, ErrConfigNotObject
	}
	b, err := sealer.Seal(config, ChannelConfigAD(channel))
	if err != nil {
		return nil, fmt.Errorf("alerts: seal channel config: %w", err)
	}
	return b, nil
}

// OpenChannelConfig decrypts a channel's stored config. It returns
// idkeys.ErrDecrypt when the KEK is wrong, the ciphertext was tampered with
// or it belongs to another channel.
func OpenChannelConfig(sealer *idkeys.Sealer, channel uuid.UUID, sealed []byte) (json.RawMessage, error) {
	b, err := sealer.Open(sealed, ChannelConfigAD(channel))
	if err != nil {
		return nil, err
	}
	return json.RawMessage(b), nil
}

func isJSONObject(b []byte) bool {
	var m map[string]json.RawMessage
	return json.Unmarshal(b, &m) == nil && m != nil
}
