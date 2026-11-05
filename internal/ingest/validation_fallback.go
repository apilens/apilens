package ingest

import (
	"encoding/json"
	"maps"
	"net/http"
	"slices"
	"strings"

	"github.com/apilens/apilens/internal/pipeline"
)

// maxValidationDepth bounds recursion into nested class-validator children.
const maxValidationDepth = 8

// requestValidationErrors returns the SDK-sent validation errors or, for a 422
// response that carried none (older SDKs, TS/Java before parity), errors
// derived from the stored response payload when it matches a known framework
// shape. The fallback never fails ingestion: unknown or malformed payloads
// yield nil.
func requestValidationErrors(statusCode int, sent json.RawMessage, responsePayload string) []pipeline.ValidationError {
	if out := validationErrors(sent); len(out) > 0 || statusCode != http.StatusUnprocessableEntity {
		return out
	}
	return parseValidationBody(responsePayload)
}

// parseValidationBody recognises the 422 bodies of FastAPI, Django Ninja,
// Litestar, Zod and class-validator (NestJS). The first matching shape wins
// and at most maxValidationErrors entries are kept.
func parseValidationBody(payload string) []pipeline.ValidationError {
	raw := json.RawMessage(strings.TrimSpace(payload))
	switch firstNonSpace(raw) {
	case '{':
	case '[': // a bare class-validator ValidationError[] or Zod issues array
		if out := classValidatorErrors(raw); len(out) > 0 {
			return out
		}
		return zodIssues(raw)
	default:
		return nil
	}
	var body map[string]json.RawMessage
	if json.Unmarshal(raw, &body) != nil {
		return nil
	}
	// FastAPI and Django Ninja: {"detail": [{"loc": [...], "msg": "...", "type": "..."}]}.
	if out := pydanticErrors(body["detail"]); len(out) > 0 {
		return out
	}
	// Litestar: {"status_code": ..., "detail": "...", "extra": [{"message", "key", "source"}]}.
	if out := litestarErrors(body["extra"]); len(out) > 0 {
		return out
	}
	// Zod: a serialised ZodError ({"issues": [...]}), optionally wrapped in
	// "error", or an "errors" array of issues.
	if out := zodIssues(body["issues"]); len(out) > 0 {
		return out
	}
	if firstNonSpace(body["error"]) == '{' {
		var wrapped struct {
			Issues json.RawMessage `json:"issues"`
		}
		if json.Unmarshal(body["error"], &wrapped) == nil {
			if out := zodIssues(wrapped.Issues); len(out) > 0 {
				return out
			}
		}
	}
	if out := zodIssues(body["errors"]); len(out) > 0 {
		return out
	}
	// class-validator: ValidationError[] under "message" or "errors".
	if out := classValidatorErrors(body["message"]); len(out) > 0 {
		return out
	}
	if out := classValidatorErrors(body["errors"]); len(out) > 0 {
		return out
	}
	// NestJS ValidationPipe default: {"statusCode": 422, "message": ["..."], "error": "..."}.
	if _, ok := body["statusCode"]; ok {
		return nestMessages(body["message"])
	}
	return nil
}

// objects decodes raw as a JSON array of objects, skipping other entries.
func objects(raw json.RawMessage) []map[string]json.RawMessage {
	if firstNonSpace(raw) != '[' {
		return nil
	}
	var entries []json.RawMessage
	if json.Unmarshal(raw, &entries) != nil {
		return nil
	}
	out := make([]map[string]json.RawMessage, 0, len(entries))
	for _, e := range entries {
		var obj map[string]json.RawMessage
		if firstNonSpace(e) == '{' && json.Unmarshal(e, &obj) == nil {
			out = append(out, obj)
		}
	}
	return out
}

// appendValidation applies the same caps as SDK-sent entries and drops
// entries without a message. It reports whether the list has room for more.
func appendValidation(out *[]pipeline.ValidationError, loc, msg, typ string) bool {
	if len(*out) >= maxValidationErrors {
		return false
	}
	ve := pipeline.ValidationError{
		Loc:  truncate(strings.TrimSpace(loc), maxValidationLocChars),
		Msg:  short(msg),
		Type: truncate(strings.TrimSpace(typ), maxValidationTypeChars),
	}
	if ve.Msg != "" {
		*out = append(*out, ve)
	}
	return len(*out) < maxValidationErrors
}

func pydanticErrors(raw json.RawMessage) []pipeline.ValidationError {
	var out []pipeline.ValidationError
	for _, e := range objects(raw) {
		if _, ok := e["loc"]; !ok {
			continue
		}
		if !appendValidation(&out, validationLoc(e["loc"]), scalarString(e["msg"]), scalarString(e["type"])) {
			break
		}
	}
	return out
}

func litestarErrors(raw json.RawMessage) []pipeline.ValidationError {
	var out []pipeline.ValidationError
	for _, e := range objects(raw) {
		if _, ok := e["message"]; !ok {
			continue
		}
		loc := scalarString(e["key"])
		if src := scalarString(e["source"]); src != "" && loc != "" {
			loc = src + "." + loc
		}
		if !appendValidation(&out, loc, scalarString(e["message"]), "") {
			break
		}
	}
	return out
}

func zodIssues(raw json.RawMessage) []pipeline.ValidationError {
	var out []pipeline.ValidationError
	for _, e := range objects(raw) {
		if _, ok := e["path"]; !ok {
			continue
		}
		if !appendValidation(&out, validationLoc(e["path"]), scalarString(e["message"]), scalarString(e["code"])) {
			break
		}
	}
	return out
}

func classValidatorErrors(raw json.RawMessage) []pipeline.ValidationError {
	var out []pipeline.ValidationError
	walkClassValidator(&out, raw, "", 0)
	return out
}

// walkClassValidator flattens ValidationError{property, constraints, children}
// trees into one entry per constraint; loc is the dotted property path and
// type the constraint name. It reports whether the list has room for more.
func walkClassValidator(out *[]pipeline.ValidationError, raw json.RawMessage, prefix string, depth int) bool {
	if depth >= maxValidationDepth {
		return true
	}
	for _, e := range objects(raw) {
		prop := scalarString(e["property"])
		if prop == "" {
			continue
		}
		loc := prop
		if prefix != "" {
			loc = prefix + "." + prop
		}
		var constraints map[string]json.RawMessage
		if firstNonSpace(e["constraints"]) == '{' && json.Unmarshal(e["constraints"], &constraints) == nil {
			for _, k := range slices.Sorted(maps.Keys(constraints)) {
				if !appendValidation(out, loc, scalarString(constraints[k]), k) {
					return false
				}
			}
		}
		if !walkClassValidator(out, e["children"], loc, depth+1) {
			return false
		}
	}
	return true
}

// nestMessages reads NestJS's flattened ["name should not be empty", ...].
func nestMessages(raw json.RawMessage) []pipeline.ValidationError {
	if firstNonSpace(raw) != '[' {
		return nil
	}
	var msgs []json.RawMessage
	if json.Unmarshal(raw, &msgs) != nil {
		return nil
	}
	var out []pipeline.ValidationError
	for _, m := range msgs {
		if !appendValidation(&out, "", scalarString(m), "") {
			break
		}
	}
	return out
}
