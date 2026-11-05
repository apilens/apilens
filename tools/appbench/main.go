// Command appbench measures what the APILens SDK middleware costs a real app.
//
// It drives `POST /orders` on the three example apps (examples/: FastAPI,
// Express, Spring) over HTTP with JSON bodies of fixed sizes, once per posture
// (`off` = no middleware, then the `metadata`, `redacted` and `full` capture
// profiles), and reports p50/p95 latency, the latency the middleware adds over
// the `off` baseline, and the app's memory after the load.
//
// Two subcommands:
//
//	appbench run    -posture off -target fastapi=http://127.0.0.1:18001 \
//	                -docker fastapi=apilens-example-fastapi-1 -out off.json
//	appbench report -o overhead.md -json overhead.json off.json metadata.json redacted.json full.json
//
// `run` measures one posture (the apps must already run with it) and writes
// JSON; `report` joins the per-posture files against the `off` baseline,
// renders a markdown table and checks the soft thresholds. tools/appbench/bench.sh
// does the whole loop against the compose example apps (`task bench:examples`).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "run":
		err = runCmd(os.Args[2:])
	case "report":
		err = reportCmd(os.Args[2:], os.Stdout)
	case "-h", "--help", "help":
		usage()
		return
	default:
		usage()
		os.Exit(2)
	}
	if errors.Is(err, errThresholdBreached) {
		fmt.Fprintln(os.Stderr, "appbench:", err)
		os.Exit(1)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "appbench:", err)
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage:
  appbench run    -posture <off|metadata|redacted|full> -target name=url ... [-docker name=container ...] [-pid name=pid ...] -out file.json
  appbench report [-o report.md] [-json report.json] [-annotate] [-fail-on-threshold] file.json ...
Run "appbench run -h" or "appbench report -h" for every flag.`)
}

// pairs is a repeatable name=value flag, kept in the order given.
type pairs []pair

type pair struct{ name, value string }

func (p *pairs) String() string {
	parts := make([]string, 0, len(*p))
	for _, kv := range *p {
		parts = append(parts, kv.name+"="+kv.value)
	}
	return strings.Join(parts, ",")
}

func (p *pairs) Set(s string) error {
	name, value, ok := strings.Cut(s, "=")
	if !ok || name == "" || value == "" {
		return fmt.Errorf("want name=value, got %q", s)
	}
	*p = append(*p, pair{name, value})
	return nil
}

func (p pairs) lookup(name string) string {
	for _, kv := range p {
		if kv.name == name {
			return kv.value
		}
	}
	return ""
}

func runCmd(args []string) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	var targets, containers, pids pairs
	posture := fs.String("posture", "", "posture the apps are running with: off, metadata, redacted or full")
	fs.Var(&targets, "target", "app under test as name=base_url (repeatable)")
	fs.Var(&containers, "docker", "read the app's memory from `docker stats` as name=container (repeatable)")
	fs.Var(&pids, "pid", "read the app's RSS from `ps` as name=pid (repeatable)")
	sizes := fs.String("sizes", "1024,32768", "comma-separated JSON request body sizes in bytes")
	concurrency := fs.Int("concurrency", 8, "concurrent connections")
	rate := fs.Float64("rate", 200, "requests per second per app and body size (open loop); 0 sends back to back (closed loop)")
	duration := fs.Duration("duration", 20*time.Second, "timed load per app and body size")
	warmup := fs.Duration("warmup", 5*time.Second, "untimed load before each measurement (JIT, pools, SDK queues)")
	path := fs.String("path", "/orders", "endpoint to drive with POST")
	out := fs.String("out", "", "write the JSON result here (default stdout)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if !validPosture(*posture) {
		return fmt.Errorf("-posture must be one of %s, got %q", strings.Join(postures, ", "), *posture)
	}
	if len(targets) == 0 {
		return errors.New("at least one -target name=url is required")
	}
	bodySizes, err := parseSizes(*sizes)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	res := RunResult{Posture: *posture, StartedAt: time.Now().UTC(), Concurrency: *concurrency, Rate: *rate, Duration: duration.String(), Path: *path}
	for _, t := range targets {
		for _, size := range bodySizes {
			fmt.Fprintf(os.Stderr, "%-8s %-9s %6d B ... ", t.name, *posture, size)
			row, err := measure(ctx, loadSpec{
				url: strings.TrimRight(t.value, "/") + *path, body: orderBody(size),
				concurrency: *concurrency, rate: *rate, warmup: *warmup, duration: *duration,
			})
			if err != nil {
				return fmt.Errorf("%s at %d B: %w", t.name, size, err)
			}
			row.App, row.Posture, row.BodyBytes = t.name, *posture, size
			fmt.Fprintf(os.Stderr, "p50 %s p95 %s, %.0f req/s, %d errors, %d missed\n",
				ms(row.P50Ms), ms(row.P95Ms), row.RPS, row.Errors, row.Missed)
			res.Rows = append(res.Rows, row)
		}
		mem, src, err := readMemory(ctx, containers.lookup(t.name), pids.lookup(t.name))
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s: memory not read: %v\n", t.name, err)
		}
		for i := range res.Rows {
			if res.Rows[i].App == t.name {
				res.Rows[i].MemoryMiB, res.Rows[i].MemorySource = mem, src
			}
		}
	}

	var w io.Writer = os.Stdout
	if *out != "" {
		f, err := os.Create(*out)
		if err != nil {
			return err
		}
		defer func() { _ = f.Close() }()
		w = f
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(res)
}

func reportCmd(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("report", flag.ContinueOnError)
	out := fs.String("o", "", "write the markdown report here (default stdout)")
	jsonOut := fs.String("json", "", "also write the joined rows as JSON here")
	annotate := fs.Bool("annotate", os.Getenv("GITHUB_ACTIONS") == "true", "print a GitHub ::warning:: annotation per threshold breach")
	failOn := fs.Bool("fail-on-threshold", false, "exit 1 when a soft threshold is breached")
	th := defaultThresholds()
	fs.DurationVar(&th.AddedP50Small, "max-added-p50", th.AddedP50Small, "soft limit: added p50 at the smallest body size")
	fs.DurationVar(&th.AddedP95, "max-added-p95", th.AddedP95, "soft limit: added p95 at every body size")
	fs.Float64Var(&th.AddedMemoryMiB, "max-added-memory", th.AddedMemoryMiB, "soft limit: added memory in MiB over the off baseline")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() == 0 {
		return errors.New("report needs the per-posture JSON files from `appbench run`")
	}
	var runs []RunResult
	for _, name := range fs.Args() {
		b, err := os.ReadFile(name) //nolint:gosec // G304: the operator names the input files
		if err != nil {
			return err
		}
		var r RunResult
		if err := json.Unmarshal(b, &r); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		runs = append(runs, r)
	}
	rep, err := buildReport(runs, th)
	if err != nil {
		return err
	}

	md := rep.Markdown()
	if *out == "" {
		_, _ = io.WriteString(stdout, md)
	} else if err := os.WriteFile(*out, []byte(md), 0o644); err != nil { //nolint:gosec // G306: a report meant to be read and uploaded
		return err
	}
	if *jsonOut != "" {
		b, _ := json.MarshalIndent(rep, "", "  ")
		if err := os.WriteFile(*jsonOut, append(b, '\n'), 0o644); err != nil { //nolint:gosec // G306: a report meant to be read and uploaded
			return err
		}
	}
	breaches := rep.Breaches()
	for _, b := range breaches {
		if *annotate {
			_, _ = fmt.Fprintf(stdout, "::warning title=APILens SDK overhead::%s\n", b)
		} else {
			fmt.Fprintln(os.Stderr, "soft threshold breached:", b)
		}
	}
	if *failOn && len(breaches) > 0 {
		return fmt.Errorf("%w (%d)", errThresholdBreached, len(breaches))
	}
	return nil
}

var errThresholdBreached = errors.New("soft threshold breached")
