package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Config lives next to the agent's data (ProgramData) and is readable by SYSTEM and Administrators only.
type Config struct {
	// TCP port the agent listens on.
	Port int `json:"port"`
	// Secret first path segment: anything else on this port answers like an empty web server.
	Prefix string `json:"prefix"`
	// Shared HMAC key (hex). Requests are signed with it; the key itself never travels on the network.
	Secret string `json:"secret"`
	// Addresses (IPs or CIDRs) allowed to connect: the dashboard server. Everyone else is dropped before TLS.
	Allow []string `json:"allow"`
	// Where Windows keeps user profiles (C:\Users).
	ProfilesDir string `json:"profilesDir"`
	// A chat turn younger than this may still be running and is served once it settles.
	SettleSeconds int `json:"settleSeconds"`
}

const certFile, keyFile, configFile = "agent.crt", "agent.key", "config.json"

func randomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b32(b)
}

func b32(b []byte) string {
	return strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b))
}

func loadConfig(dir string) (*Config, error) {
	raw, err := os.ReadFile(filepath.Join(dir, configFile))
	if err != nil {
		return nil, err
	}
	c := &Config{}
	if err := json.Unmarshal(raw, c); err != nil {
		return nil, fmt.Errorf("config.json: %w", err)
	}
	return c, c.validate()
}

func (c *Config) validate() error {
	if c.Port < 1024 || c.Port > 65535 {
		return errors.New("port must be between 1024 and 65535")
	}
	if len(c.Prefix) < 16 {
		return errors.New("prefix must be at least 16 characters")
	}
	if k, err := hex.DecodeString(c.Secret); err != nil || len(k) < 32 {
		return errors.New("secret must be at least 32 bytes of hex")
	}
	if len(c.Allow) == 0 {
		return errors.New("allow must name the dashboard server's address")
	}
	if _, err := parseAllow(c.Allow); err != nil {
		return err
	}
	if c.SettleSeconds <= 0 {
		c.SettleSeconds = 90
	}
	if c.ProfilesDir == "" {
		c.ProfilesDir = defaultProfilesDir()
	}
	return nil
}

func defaultProfilesDir() string {
	d := os.Getenv("SystemDrive")
	if d == "" {
		d = "C:"
	}
	return d + `\Users`
}

func parseAllow(list []string) ([]*net.IPNet, error) {
	var out []*net.IPNet
	for _, a := range list {
		a = strings.TrimSpace(a)
		if !strings.Contains(a, "/") {
			ip := net.ParseIP(a)
			if ip == nil {
				return nil, fmt.Errorf("allow: %q is not an IP address", a)
			}
			if ip.To4() != nil {
				a += "/32"
			} else {
				a += "/128"
			}
		}
		_, n, err := net.ParseCIDR(a)
		if err != nil {
			return nil, fmt.Errorf("allow: %q: %w", a, err)
		}
		out = append(out, n)
	}
	return out, nil
}

// newConfig makes a fresh secret, path prefix and port, and a self-signed certificate.
func newConfig(dir string, allow []string, port int) (*Config, error) {
	if port == 0 {
		n, _ := rand.Int(rand.Reader, big.NewInt(20000))
		port = 40000 + int(n.Int64())
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return nil, err
	}
	c := &Config{Port: port, Prefix: randomToken(15), Secret: hex.EncodeToString(secret), Allow: allow}
	if err := c.validate(); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := writeCert(dir); err != nil {
		return nil, err
	}
	return c, c.save(dir)
}

func (c *Config) save(dir string) error {
	raw, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(filepath.Join(dir, configFile), raw, 0o600)
}

// writeCert makes an ECDSA P-256 self-signed certificate with a meaningless name; the dashboard pins its hash.
func writeCert(dir string) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serial, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	tpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: randomToken(6)},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().AddDate(20, 0, 0),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return err
	}
	kder, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, certFile), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, keyFile), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kder}), 0o600)
}

func certFingerprint(dir string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(dir, certFile))
	if err != nil {
		return "", err
	}
	b, _ := pem.Decode(raw)
	if b == nil {
		return "", errors.New("agent.crt is not PEM")
	}
	sum := sha256.Sum256(b.Bytes)
	return hex.EncodeToString(sum[:]), nil
}

// pairingCode is what the admin pastes into the dashboard: port, path, key and certificate hash in one line.
func pairingCode(c *Config, dir string) (string, error) {
	fp, err := certFingerprint(dir)
	if err != nil {
		return "", err
	}
	host, _ := os.Hostname()
	raw, _ := json.Marshal(map[string]any{"v": 1, "host": host, "port": c.Port, "prefix": c.Prefix, "secret": c.Secret, "cert": fp})
	return "pda1." + base64.RawURLEncoding.EncodeToString(raw), nil
}
