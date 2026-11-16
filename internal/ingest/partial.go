package ingest

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/google/uuid"
)

// Partial accept (D7 of #897): one bad record never rejects the rest of a
// batch. The batch endpoints decode and validate every record on its own,
// store the valid ones and answer 200 with the index and reason of each
// invalid record; only a body that does not parse at all is a 400.

// maxRecordErrors caps the per-record errors one answer lists; invalid
// counts them all.
const maxRecordErrors = 20

// maxRecordErrorChars caps the reason of one record error.
const maxRecordErrorChars = 256

// recordError names one record a call refused as invalid.
type recordError struct {
	Index  int    `json:"index"`
	Reason string `json:"reason"`
}

// invalidRecords collects the records of a call refused as invalid.
type invalidRecords struct {
	n      int
	errs   []recordError
	idents []string // app identifier of every invalid record, for health counters
}

func (v *invalidRecords) add(i int, ident, reason string) {
	v.n++
	v.idents = append(v.idents, ident)
	if len(v.errs) < maxRecordErrors {
		v.errs = append(v.errs, recordError{Index: i, Reason: truncate(reason, maxRecordErrorChars)})
	}
}

// decodeBatch reads a batch body into v. A body that is not JSON of the
// expected shape answers 400; the records themselves are left raw so that
// each one is validated on its own.
func (e *Edge) decodeBatch(w http.ResponseWriter, r *http.Request, v any) (int, *apiError) {
	if mt := mediaType(r); mt != "" && mt != "application/json" {
		return 0, &apiError{status: http.StatusUnsupportedMediaType, Code: "unsupported_media_type", Detail: "Content-Type must be application/json"}
	}
	body, aerr := e.readBody(w, r)
	if aerr != nil {
		return 0, aerr
	}
	if err := json.NewDecoder(bytes.NewReader(body)).Decode(v); err != nil {
		return 0, &apiError{status: http.StatusBadRequest, Code: "invalid_body", Detail: fmt.Sprintf("invalid JSON: %v", err)}
	}
	return len(body), nil
}

// parseRecords decodes every raw record of field and checks it with check,
// which answers why a decoded record is invalid ("" when it is valid). It
// returns the valid records in order; the invalid ones go to inv under their
// index in the body.
func parseRecords[T any](raw []json.RawMessage, field string, ident func(T) string, check func(T) string, inv *invalidRecords) []T {
	out := make([]T, 0, len(raw))
	for i, m := range raw {
		var rec T
		if err := json.Unmarshal(m, &rec); err != nil {
			var named struct {
				AppID json.RawMessage `json:"app_id"`
			}
			_ = json.Unmarshal(m, &named)
			var id string
			_ = json.Unmarshal(named.AppID, &id)
			inv.add(i, id, fmt.Sprintf("%s[%d]: %v", field, i, err))
			continue
		}
		if reason := check(rec); reason != "" {
			inv.add(i, ident(rec), fmt.Sprintf("%s[%d]%s", field, i, reason))
			continue
		}
		out = append(out, rec)
	}
	return out
}

// rejectInvalid counts the invalid records of a call in Prometheus and, when
// their app resolves, in the app's ingest health as ReasonInvalid.
func (e *Edge) rejectInvalid(ctx context.Context, projectID uuid.UUID, signal string, inv *invalidRecords, t tally) {
	if inv.n == 0 {
		return
	}
	e.rejectRecordsFor(ctx, projectID, signal, inv.idents, ReasonInvalid, t)
}

// answer writes the 200 of a batch call: n records stored, the app-level
// rejections of b and the invalid records of inv.
func (e *Edge) answer(w http.ResponseWriter, signal string, n int, b *appBatch, inv *invalidRecords) {
	e.records.WithLabelValues(signal, "accepted").Add(float64(n))
	e.batches.WithLabelValues(signal, "200").Inc()
	out := accepted{Accepted: n}
	if b != nil {
		out.Rejected = b.report
	}
	if inv != nil && inv.n > 0 {
		out.Invalid, out.Errors = inv.n, inv.errs
	}
	writeJSON(w, http.StatusOK, out)
}
