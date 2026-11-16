package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

// checkEnroll rejects a pairing target that is not the dashboard's enroll route.
// An empty URL means a manual install: the pairing code is printed and nothing is sent.
func checkEnroll(rawURL, token string) error {
	if rawURL == "" && token == "" {
		return nil
	}
	if rawURL == "" || token == "" {
		return fmt.Errorf("install --enroll and --token are used together")
	}
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(token) {
		return fmt.Errorf("install token is not valid")
	}
	if !regexp.MustCompile(`^https?://[A-Za-z0-9.:\[\]-]+/install/enroll$`).MatchString(rawURL) {
		return fmt.Errorf("enroll address must be the dashboard /install/enroll URL")
	}
	return nil
}

// enroll runs once, from the install command, after the Windows service is up.
// The service process never calls this and never connects out.
func enroll(rawURL, token, dir string) (string, error) {
	cfg, err := loadConfig(dir)
	if err != nil {
		return "", err
	}
	code, err := pairingCode(cfg, dir)
	if err != nil {
		return "", err
	}
	host, _ := os.Hostname()
	body, _ := json.Marshal(map[string]any{"code": code, "host": host, "addresses": localPrivateIPv4()})

	var last error
	for try := 1; try <= 5; try++ {
		note, retry, err := postEnroll(rawURL, token, body)
		if err == nil {
			return note, nil
		}
		last = err
		if !retry || try == 5 {
			break
		}
		time.Sleep(time.Second)
	}
	return "", fmt.Errorf("the PD Agent service is installed, but the dashboard did not pair this PC: %w", last)
}

func postEnroll(rawURL, token string, body []byte) (string, bool, error) {
	req, err := http.NewRequest(http.MethodPost, rawURL, bytes.NewReader(body))
	if err != nil {
		return "", false, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-install-token", token)
	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return "", true, err
	}
	defer res.Body.Close()
	msg, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
	if res.StatusCode != http.StatusOK {
		// the service may still be opening its port; only that failure is worth a retry
		text := strings.TrimSpace(string(msg))
		return "", res.StatusCode == http.StatusUnprocessableEntity && strings.Contains(text, "cannot reach"), fmt.Errorf("%s", text)
	}
	var out struct {
		Name    string `json:"name"`
		Address string `json:"address"`
		Sources int    `json:"sources"`
	}
	if json.Unmarshal(msg, &out) != nil || out.Name == "" {
		return "", false, fmt.Errorf("the dashboard answer could not be read")
	}
	return fmt.Sprintf("Done. This PC is %q in the dashboard, reached at %s.\nWindows profiles with Cursor: %d", out.Name, out.Address, out.Sources), false, nil
}

func localPrivateIPv4() []string {
	addrs, _ := net.InterfaceAddrs()
	var out []string
	seen := map[string]bool{}
	for _, a := range addrs {
		ip, ok := a.(*net.IPNet)
		if !ok || !privateIPv4(ip.IP) {
			continue
		}
		s := ip.IP.To4().String()
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func privateIPv4(ip net.IP) bool {
	v := ip.To4()
	if v == nil || v.IsLoopback() || v.IsLinkLocalUnicast() {
		return false
	}
	return v[0] == 10 || (v[0] == 172 && v[1] >= 16 && v[1] <= 31) || (v[0] == 192 && v[1] == 168)
}

// finish records the install result where the non-elevated window can read it, then exits.
// The pairing code is never written there.
func finish(logPath, note string, err error) {
	text := note
	if err != nil {
		text = "error: " + err.Error()
		fmt.Fprintln(os.Stderr, text)
	}
	if logPath != "" && text != "" {
		_ = os.WriteFile(logPath, []byte(text+"\n"), 0o644)
	}
	if err != nil {
		os.Exit(1)
	}
	os.Exit(0)
}
