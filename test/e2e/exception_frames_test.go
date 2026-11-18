package e2e

// Frame counting for the exception e2e (exceptions_e2e_test.go). It has no
// build tag so its own tests run with the unit tests.

import (
	"regexp"
	"strconv"
	"testing"
)

// frameLine matches one stack frame of a function named fn in the payload
// formats of the three SDKs:
//
//	Python  File "/app/main.py", line 183, in _recurse
//	Node        at recurse (file:///app/server.mjs:160:5)
//	Java        at ai.apilens.examples.ExampleController.recurse(ExampleController.java:160)
func frameLine(fn string) *regexp.Regexp {
	q := regexp.QuoteMeta(fn)
	return regexp.MustCompile(`(?m)^\s*(?:File "[^"]*", line \d+, in _?` + q + `\s*$|at (?:[\w$.]+\.)?` + q + `[ (])`)
}

// pythonRepeated is the line Python's traceback prints instead of more than
// three identical frames in a row.
var pythonRepeated = regexp.MustCompile(`\[Previous line repeated (\d+) more times?\]`)

// countFrames counts the frames of fn in an exception payload, the frames
// Python folds into "[Previous line repeated N more times]" included.
func countFrames(payload, fn string) int {
	n := len(frameLine(fn).FindAllStringIndex(payload, -1))
	for _, m := range pythonRepeated.FindAllStringSubmatch(payload, -1) {
		k, _ := strconv.Atoi(m[1])
		n += k
	}
	return n
}

func TestCountFrames(t *testing.T) {
	python := `Traceback (most recent call last):
  File "/app/main.py", line 187, in boom_deep
    _recurse(60)
  File "/app/main.py", line 176, in _recurse
    _recurse(depth - 1)
  File "/app/main.py", line 176, in _recurse
    _recurse(depth - 1)
  File "/app/main.py", line 176, in _recurse
    _recurse(depth - 1)
  [Previous line repeated 56 more times]
  File "/app/main.py", line 175, in _recurse
    raise ValueError("example failure: raised 60 frames deep")
ValueError: example failure: raised 60 frames deep
`
	node := "RangeError: example failure: thrown 60 frames deep\n"
	java := "java.lang.IllegalArgumentException: example failure: thrown 60 frames deep\n"
	for range 60 {
		node += "    at recurse (file:///app/server.mjs:160:11)\n"
		java += "\tat ai.apilens.examples.ExampleController.recurse(ExampleController.java:160)\n"
	}
	node += "    at file:///app/server.mjs:172:3\n"
	java += "\tat ai.apilens.examples.ExampleController.boomDeep(ExampleController.java:119)\n"

	for name, tc := range map[string]struct {
		payload string
		want    int
	}{
		"python":              {python, 60},
		"node":                {node, 60},
		"java":                {java, 60},
		"other function only": {"    at recurseNot (x.js:1:1)\n\tat a.b.notrecurse(B.java:1)\n", 0},
		"empty":               {"", 0},
	} {
		if got := countFrames(tc.payload, "recurse"); got != tc.want {
			t.Errorf("%s: countFrames = %d, want %d", name, got, tc.want)
		}
	}
}
