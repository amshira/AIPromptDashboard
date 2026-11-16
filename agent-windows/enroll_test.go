package main

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheckEnroll(t *testing.T) {
	token := strings.Repeat("ab", 32)
	if err := checkEnroll("", ""); err != nil {
		t.Fatal(err)
	}
	if checkEnroll("https://pd.example.org/install/enroll", "") == nil {
		t.Fatal("token missing was accepted")
	}
	if err := checkEnroll("http://pd.example.org/install/enroll", token); err != nil {
		t.Fatal(err)
	}
	if checkEnroll("https://pd.example.org/install/windows.ps1", token) == nil {
		t.Fatal("wrong path was accepted")
	}
	if checkEnroll("https://pd.example.org/install/enroll?x=1", token) == nil {
		t.Fatal("query string was accepted")
	}
	if err := checkEnroll("https://pd.example.org/install/enroll", token); err != nil {
		t.Fatal(err)
	}
}

func TestPrivateIPv4(t *testing.T) {
	for _, s := range []string{"10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1"} {
		if !privateIPv4(net.ParseIP(s)) {
			t.Fatalf("%s should be private", s)
		}
	}
	for _, s := range []string{"8.8.8.8", "172.32.0.1", "127.0.0.1", "169.254.1.1"} {
		if privateIPv4(net.ParseIP(s)) {
			t.Fatalf("%s should not be sent", s)
		}
	}
}

func TestEnrollPostsThePairingCodeOnce(t *testing.T) {
	dir := t.TempDir()
	cfg, err := newConfig(dir, []string{"10.0.0.1"}, 47123)
	if err != nil {
		t.Fatal(err)
	}
	token := strings.Repeat("cd", 32)
	var gotToken, gotCode string
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/install/enroll" || r.Method != http.MethodPost {
			t.Errorf("request %s %s", r.Method, r.URL.Path)
		}
		gotToken = r.Header.Get("x-install-token")
		b, _ := io.ReadAll(r.Body)
		gotCode = string(b)
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"name":"it-28","address":"10.0.0.8","sources":1}`))
	}))
	defer srv.Close()
	// the production check allows only the public dashboard; this test talks to the local server directly
	note, retry, err := postEnroll(srv.URL+"/install/enroll", token, []byte(`{"code":"pda1.test"}`))
	if err != nil || retry {
		t.Fatal(retry, err)
	}
	if calls != 1 || gotToken != token || !strings.Contains(gotCode, "pda1.test") {
		t.Fatalf("calls=%d token=%s body=%s", calls, gotToken, gotCode)
	}
	if !strings.Contains(note, `"it-28"`) || !strings.Contains(note, "10.0.0.8") {
		t.Fatal(note)
	}
	if _, err := os.Stat(filepath.Join(dir, "agent.key")); err != nil || cfg.Port != 47123 {
		t.Fatal(cfg.Port, err)
	}
}

func TestEnrollRetriesUntilTheServiceAnswers(t *testing.T) {
	token := strings.Repeat("ab", 32)
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls < 3 {
			http.Error(w, "the dashboard cannot reach this PC on port 9", http.StatusUnprocessableEntity)
			return
		}
		_, _ = w.Write([]byte(`{"name":"pc","address":"10.0.0.2","sources":0}`))
	}))
	defer srv.Close()
	note, retry, err := postEnroll(srv.URL+"/install/enroll", token, []byte(`{}`))
	if err == nil || !retry || note != "" {
		t.Fatalf("first answer should be retried: %q %v %v", note, retry, err)
	}
	note, retry, err = postEnroll(srv.URL+"/install/enroll", token, []byte(`{}`))
	if err == nil || !retry {
		t.Fatal("second answer should be retried")
	}
	note, retry, err = postEnroll(srv.URL+"/install/enroll", token, []byte(`{}`))
	if err != nil || retry || !strings.Contains(note, `"pc"`) {
		t.Fatal(note, retry, err)
	}
}
