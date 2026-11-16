package query

import "strings"

// Exception grouping. An exception log groups by its fingerprint: the
// exception type plus the normalised top in-app frame of its stack trace,
// so the same failure groups together whatever ids its message carries.
// Without an in-app frame the message stands in, with uuids, hex and digit
// runs replaced. Two different exception types never share a group.
//
// The fingerprint is computed at read time from the stored row, so rows
// written before it existed group the same way. The SQL below reads the
// api_logs columns message, attributes and payload. Regexes are RE2 inside
// SQL string literals, where \n is a newline and \\b a word boundary.

// exceptionTypeSQL is the exception class of a row: the exception.type
// attribute the SDKs set, else the class name before the first colon of
// the "<type>: <message>" message.
const exceptionTypeSQL = `if(attributes['exception.type'] != '', attributes['exception.type'],
	extract(message, '^[ ]*([A-Za-z0-9_.$]+):'))`

// Frames of libraries, the runtime and the SDK itself, which are never the
// top in-app frame.
const (
	pythonLibraryFrame = `(site-packages|dist-packages|/lib/python[0-9.]*/|^<frozen |^<string>)`
	nodeLibraryFrame   = `(node_modules|^node:|^internal/|^<anonymous>$|^native$)`
	javaLibraryFrame   = `^(java|javax|jakarta|jdk|sun|com[.]sun|kotlin|kotlinx|scala|groovy|org[.]springframework|` +
		`org[.]apache|org[.]eclipse|org[.]hibernate|org[.]glassfish|org[.]junit|io[.]netty|io[.]undertow|io[.]micrometer|` +
		`reactor|com[.]fasterxml|com[.]zaxxer|net[.]bytebuddy|ai[.]apilens)[.]`
)

// normaliseSQL replaces the ids of a text: uuids, 0x and long hex runs, and
// digit runs, so "order 123 not found" and "order 9 not found" read the same.
func normaliseSQL(expr string) string {
	for _, r := range [][2]string{
		{`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`, `<uuid>`},
		{`\\b0[xX][0-9a-fA-F]+\\b`, `<hex>`},
		{`\\b[0-9a-fA-F]*([0-9][a-fA-F]|[a-fA-F][0-9])[0-9a-fA-F]*\\b`, `<hex>`},
		{`[0-9]+`, `<n>`},
	} {
		expr = "replaceRegexpAll(" + expr + ", '" + r[0] + "', '" + r[1] + "')"
	}
	return expr
}

// exceptionFrameSQL is the normalised top in-app frame of a row's stack
// trace, empty when it has none:
//   - Python tracebacks list the innermost frame last (and the raised
//     exception after its causes): the last frame outside the libraries,
//     as "path:function";
//   - Java stacks list the innermost frame first (causes follow): the first
//     "at pkg.Class.method(" outside the libraries, module prefix dropped;
//   - V8 stacks list the innermost frame first: the first "at fn (file:l:c)"
//     outside node_modules and node internals, as "file:fn".
//
// Line numbers are dropped (they move with every deploy) and ids in the
// frame normalised (lambda and generated class names carry counters).
var exceptionFrameSQL = normaliseSQL(`multiIf(
	notEmpty(arrayFilter(f -> NOT match(f[1], '` + pythonLibraryFrame + `'),
		extractAllGroupsVertical(payload, 'File "([^"]+)", line [0-9]+, in ([^ \n]+)')) AS py),
	concat(py[-1][1], ':', py[-1][2]),
	notEmpty(arrayFilter(f -> NOT match(f, '` + javaLibraryFrame + `'),
		extractAll(payload, '\n[ \t]*at (?:[^ \t\n(/]*/)*([^ \t\n(/]+)[(]')) AS jv),
	jv[1],
	notEmpty(arrayFilter(f -> NOT match(f[2], '` + nodeLibraryFrame + `'),
		extractAllGroupsVertical(payload, '\n[ \t]*at (?:async )?(?:new )?(?:([^ \t\n()]+) [(])?([^ \t\n()]+?):[0-9]+:[0-9]+[)]?')) AS js),
	concat(js[1][2], ':', js[1][1]),
	'')`)

// exceptionKeySQL is the part of the fingerprint after the type: the top
// in-app frame, else the normalised message.
var exceptionKeySQL = "if(exc_frame != '', concat('frame:', exc_frame), concat('message:', " +
	normaliseSQL("message") + "))"

// exceptionRowsSQL selects the api_logs rows matching where with their
// exception type (exc_type), top in-app frame (exc_frame) and fingerprint
// key (exc_key) next to the columns listed in cols; group on
// (exc_type, exc_key) to group by fingerprint.
func exceptionRowsSQL(cols []string, where string) string {
	return "SELECT " + strings.Join(cols, ", ") + ", " + exceptionTypeSQL + " AS exc_type, " +
		exceptionFrameSQL + " AS exc_frame, " + exceptionKeySQL + " AS exc_key FROM api_logs WHERE " + where
}

// exceptionFingerprintSQL is the fingerprint of a group, as 16 hex digits.
const exceptionFingerprintSQL = "lower(leftPad(hex(cityHash64(exc_type, exc_key)), 16, '0'))"

// exceptionLabel splits the latest message of a group into its type and
// message, the group's type winning over the one the message names.
func exceptionLabel(typ, msg string) (string, string) {
	t, m := splitException(msg)
	if typ == "" {
		typ = t
	}
	return typ, m
}
