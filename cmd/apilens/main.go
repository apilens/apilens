// Command apilens is the single APILens binary. Each process runs one or
// more roles selected with -target (see `apilens help`).
package main

import (
	"os"

	"github.com/apilens/apilens/internal/app"
)

func main() {
	os.Exit(app.Main(os.Args[1:], os.Stdout, os.Stderr, os.Environ()))
}
