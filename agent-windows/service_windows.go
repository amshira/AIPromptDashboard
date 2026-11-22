//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	serviceName = "PDAgent"
	displayName = "PD Agent"
	description = "Read-only agent: lets the prompt dashboard read the Cursor chats on this PC."
	ruleName    = "PD Agent"
)

func isService() bool {
	ok, _ := svc.IsWindowsService()
	return ok
}

type handler struct{}

func (handler) Execute(_ []string, req <-chan svc.ChangeRequest, st chan<- svc.Status) (bool, uint32) {
	st <- svc.Status{State: svc.StartPending}
	dir := dataDir()
	logger := fileLogger(dir)
	cfg, err := loadConfig(dir)
	if err != nil {
		logger.Printf("cannot start: %v", err)
		return false, 1
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- serve(ctx, cfg, dir, logger) }()
	st <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case c := <-req:
			switch c.Cmd {
			case svc.Interrogate:
				st <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				st <- svc.Status{State: svc.StopPending, WaitHint: 8000}
				cancel()
				select {
				case <-done:
				case <-time.After(8 * time.Second):
					// serve did not return; leave cleanly so recovery does not bounce a Stop
					os.Exit(0)
				}
				return false, 0
			}
		case err := <-done:
			if err != nil {
				logger.Printf("stopped: %v", err)
				return false, 1
			}
			return false, 0
		}
	}
}

func runService() {
	_ = svc.Run(serviceName, handler{})
}

func run(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %v: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func install(dir string, allow []string, port int, quiet bool) error {
	m, err := mgr.Connect()
	if err != nil {
		return errors.New("run this from an Administrator command prompt")
	}
	defer m.Disconnect()
	if _, err := parseAllow(allow); err != nil {
		return err
	}

	// stop a running copy first, so its exe can be replaced
	if s, err := m.OpenService(serviceName); err == nil {
		_, _ = s.Control(svc.Stop)
		for i := 0; i < 20; i++ {
			if q, err := s.Query(); err != nil || q.State == svc.Stopped {
				break
			}
			time.Sleep(500 * time.Millisecond)
		}
		s.Close()
	}

	pf := os.Getenv("ProgramFiles")
	if pf == "" {
		pf = `C:\Program Files`
	}
	exe := filepath.Join(pf, "PDAgent", "pd-agent.exe")
	self, _ := os.Executable()
	if !strings.EqualFold(filepath.Clean(self), exe) {
		if err := os.MkdirAll(filepath.Dir(exe), 0o755); err != nil {
			return err
		}
		if err := copyFile(self, exe); err != nil {
			return fmt.Errorf("copy to %s: %w", exe, err)
		}
	}

	// a re-install keeps the key and certificate, so the dashboard stays paired
	cfg, err := loadConfig(dir)
	if err == nil {
		cfg.Allow = allow
		if port != 0 {
			cfg.Port = port
		}
		if err := cfg.validate(); err != nil {
			return err
		}
		if err := cfg.save(dir); err != nil {
			return err
		}
	} else if cfg, err = newConfig(dir, allow, port); err != nil {
		return err
	}
	// key, certificate and config: SYSTEM and Administrators only (SIDs, so any Windows language works)
	if err := run("icacls", dir, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"); err != nil {
		return err
	}

	// Windows Firewall: inbound on this port only from the dashboard, only for this program
	_ = run("netsh", "advfirewall", "firewall", "delete", "rule", "name="+ruleName)
	if err := run("netsh", "advfirewall", "firewall", "add", "rule", "name="+ruleName, "dir=in", "action=allow", "protocol=TCP",
		"localport="+strconv.Itoa(cfg.Port), "remoteip="+strings.Join(allow, ","), "program="+exe, "profile=any", "enable=yes"); err != nil {
		return err
	}

	s, err := m.OpenService(serviceName)
	if err != nil {
		s, err = m.CreateService(serviceName, exe, mgr.Config{DisplayName: displayName, Description: description, StartType: mgr.StartAutomatic})
		if err != nil {
			return err
		}
	} else {
		c, _ := s.Config()
		c.BinaryPathName, c.DisplayName, c.Description, c.StartType = `"`+exe+`"`, displayName, description, mgr.StartAutomatic
		if err := s.UpdateConfig(c); err != nil {
			return err
		}
	}
	defer s.Close()
	_ = s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 10 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
		{Type: mgr.ServiceRestart, Delay: time.Minute},
	}, 86400)
	_ = s.SetRecoveryActionsOnNonCrashFailures(true)
	if err := s.Start(); err != nil {
		return fmt.Errorf("start the service: %w", err)
	}
	if quiet {
		fmt.Printf("PD Agent service is installed and running on port %d, only for %s.\n", cfg.Port, strings.Join(allow, ", "))
		return nil
	}
	code, err := pairingCode(cfg, dir)
	if err != nil {
		return err
	}
	fmt.Printf("Installed and started. Listening on port %d, only for %s.\n\nPairing code (paste it in the dashboard: Settings > Servers > Add):\n\n%s\n\n", cfg.Port, strings.Join(allow, ", "), code)
	fmt.Println("The pairing code contains the agent's key: give it only to the dashboard admin.")
	return nil
}

func uninstall() error {
	m, err := mgr.Connect()
	if err != nil {
		return errors.New("run this from an Administrator command prompt")
	}
	defer m.Disconnect()
	_ = run("netsh", "advfirewall", "firewall", "delete", "rule", "name="+ruleName)
	s, err := m.OpenService(serviceName)
	if err != nil {
		fmt.Println("service not installed; firewall rule removed")
		return nil
	}
	defer s.Close()
	_, _ = s.Control(svc.Stop)
	if err := s.Delete(); err != nil {
		return err
	}
	fmt.Printf("Removed the service and the firewall rule. Key and certificate stay in %s (delete it to forget the pairing).\n", dataDir())
	return nil
}
