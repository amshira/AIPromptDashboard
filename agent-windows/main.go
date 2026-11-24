// pd-agent: a read-only agent for Windows that lets the prompt dashboard pull the Cursor and Codex chats of this PC.
//
// It listens on one TCP port, accepts connections only from the dashboard's address, speaks TLS 1.3 with its
// own certificate (pinned by the dashboard) and answers only signed GET requests under a random path. It never
// connects anywhere, runs no commands and opens Cursor's database read-only.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"time"
)

// versionTag is one contiguous literal so the dashboard can read the running agent's version straight out of
// the exe bytes (to decide whether to push an update). Bump the number here, nowhere else.
const versionTag = "PDAGENT_VERSION=1.7.6"

var version = strings.TrimPrefix(versionTag, "PDAGENT_VERSION=")

func dataDir() string {
	if d := os.Getenv("PD_AGENT_DIR"); d != "" {
		return d
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		if _, err := os.Stat(filepath.Join(dir, configFile)); err == nil {
			return dir
		}
	}
	pd := os.Getenv("ProgramData")
	if pd == "" {
		pd = `C:\ProgramData`
	}
	return filepath.Join(pd, "PDAgent")
}

func usage() {
	fmt.Fprintf(os.Stderr, `pd-agent %s

  pd-agent install --allow <dashboard IP>[,<IP or CIDR>...] [--port N] [--enroll <url> --token <hex>]
        (as Administrator) copy the agent to Program Files, make its key and certificate, add a firewall
        rule that admits only those addresses, and start it as a Windows service. With --enroll it also
        pairs this PC with the dashboard once. The service itself never connects anywhere.
  pd-agent pairing      print the pairing code again
  pd-agent status       what the agent can read on this PC (no chat text)
  pd-agent uninstall    stop and remove the service and the firewall rule (keeps %s)
  pd-agent run          run in the foreground (for testing)
`, version, dataDir())
}

func main() {
	if isService() {
		runService()
		return
	}
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	dir := dataDir()
	switch os.Args[1] {
	case "install":
		fs := flag.NewFlagSet("install", flag.ExitOnError)
		allow := fs.String("allow", "", "dashboard address(es), comma separated")
		port := fs.Int("port", 0, "TCP port (default: a random one from 40000-59999)")
		enrollURL := fs.String("enroll", "", "dashboard /install/enroll URL; the service is paired once, then never calls out")
		token := fs.String("token", "", "install-link token sent only to --enroll")
		logPath := fs.String("log", "", "write the result here as well as to the console")
		_ = fs.Parse(os.Args[2:])
		if strings.TrimSpace(*allow) == "" {
			finish(*logPath, "", fmt.Errorf("--allow is required: the dashboard server's IP address"))
		}
		if err := checkEnroll(*enrollURL, *token); err != nil {
			finish(*logPath, "", err)
		}
		if err := install(dir, splitList(*allow), *port, *enrollURL != ""); err != nil {
			finish(*logPath, "", err)
		}
		if *enrollURL == "" {
			finish(*logPath, "PD Agent service is installed.", nil)
		}
		note, err := enroll(*enrollURL, *token, dir)
		finish(*logPath, note, err)
	case "init":
		// config, key and certificate only, no service: for running in the foreground or testing
		fs := flag.NewFlagSet("init", flag.ExitOnError)
		allow := fs.String("allow", "", "dashboard address(es), comma separated")
		port := fs.Int("port", 0, "TCP port")
		_ = fs.Parse(os.Args[2:])
		if _, err := loadConfig(dir); err == nil {
			fail(fmt.Errorf("%s already has a config", dir))
		}
		cfg, err := newConfig(dir, splitList(*allow), *port)
		fail(err)
		code, err := pairingCode(cfg, dir)
		fail(err)
		fmt.Println(code)
	case "uninstall":
		fail(uninstall())
	case "pairing":
		cfg, err := loadConfig(dir)
		fail(err)
		code, err := pairingCode(cfg, dir)
		fail(err)
		fmt.Println(code)
	case "status":
		cfg, err := loadConfig(dir)
		profiles := defaultProfilesDir()
		if err == nil {
			profiles = cfg.ProfilesDir
		}
		cur := newCursorStore(profiles, 90*time.Second)
		cod := newCodexStore(profiles, 90*time.Second)
		res, _ := mergeSources(cur, cod)
		list, _ := res["sources"].([]sourceInfo)
		for _, s := range list {
			line := fmt.Sprintf("%-32s chats: %-5d account: %s", s.Name, s.Chats, s.Account)
			if s.Email != "" {
				line += "  cursor: " + s.Email
			}
			if s.Error != "" {
				line += "  ERROR: " + s.Error
			}
			fmt.Println(line)
		}
		if len(list) == 0 {
			fmt.Println("no Cursor or Codex profile found under", profiles)
		}
	case "run":
		cfg, err := loadConfig(dir)
		fail(err)
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
		defer stop()
		fail(serve(ctx, cfg, dir, log.New(os.Stderr, "", log.LstdFlags)))
	case "version":
		fmt.Println(version)
	default:
		usage()
		os.Exit(2)
	}
}

func splitList(s string) []string {
	var out []string
	for _, x := range strings.Split(s, ",") {
		if x = strings.TrimSpace(x); x != "" {
			out = append(out, x)
		}
	}
	return out
}

func fail(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

// fileLogger writes to agent.log in the data folder, starting over past 5 MB. Chat text is never logged.
func fileLogger(dir string) *log.Logger {
	f := filepath.Join(dir, "agent.log")
	if st, err := os.Stat(f); err == nil && st.Size() > 5<<20 {
		_ = os.Rename(f, f+".old")
	}
	w, err := os.OpenFile(f, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return log.New(os.Stderr, "", log.LstdFlags)
	}
	return log.New(w, "", log.LstdFlags)
}
