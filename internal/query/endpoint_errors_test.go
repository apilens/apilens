package query

import "testing"

func TestSplitException(t *testing.T) {
	for _, c := range []struct{ in, typ, msg string }{
		{"ValueError: bad order id", "ValueError", "bad order id"},
		{"ValueError:", "ValueError", ""},
		{"IllegalStateException: null", "IllegalStateException", "null"},
		{"java.lang.IllegalStateException: a: b", "java.lang.IllegalStateException", "a: b"},
		{"Outer$Inner_2: boom", "Outer$Inner_2", "boom"},
		{"  KeyError: 'sku'  ", "KeyError", "'sku'"},
		{"no type here", "", "no type here"},
		{"bad thing: happened", "", "bad thing: happened"},
		{": empty type", "", ": empty type"},
		{"", "", ""},
	} {
		typ, msg := splitException(c.in)
		if typ != c.typ || msg != c.msg {
			t.Errorf("splitException(%q) = %q, %q; want %q, %q", c.in, typ, msg, c.typ, c.msg)
		}
	}
}

func TestExceptionLabel(t *testing.T) {
	for _, c := range []struct{ typ, in, wantTyp, wantMsg string }{
		{"app.errors.NotFound", "app.errors.NotFound: order 1", "app.errors.NotFound", "order 1"},
		{"", "ValueError: bad", "ValueError", "bad"},
		{"com.acme.Boom", "plain text", "com.acme.Boom", "plain text"},
		{"", "plain text", "", "plain text"},
	} {
		typ, msg := exceptionLabel(c.typ, c.in)
		if typ != c.wantTyp || msg != c.wantMsg {
			t.Errorf("exceptionLabel(%q, %q) = %q, %q; want %q, %q", c.typ, c.in, typ, msg, c.wantTyp, c.wantMsg)
		}
	}
}
