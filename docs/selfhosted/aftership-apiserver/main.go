// OpenReach's replacement for cmd/apiserver/main.go in AfterShip/email-verifier (written against v1.5.0).
// MIT licence, like email-verifier itself.
//
// The upstream example creates the verifier without its SMTP check, listens on every network interface
// (":8080") and has no authentication. This version:
//   - turns the SMTP check on (with catch-all detection, always: without the probe every result says
//     catch_all true) and sets the MAIL FROM address and EHLO name;
//   - listens on 127.0.0.1:8080 unless VERIFIER_LISTEN says otherwise;
//   - can require a shared secret in the X-Verifier-Secret header (VERIFIER_SECRET);
//   - answers a check that could not finish (MX lookup failed, port 25 blocked, a 5xx from the mail server)
//     with the partial result as JSON plus an "error" field, instead of a plain-text 500;
//   - answers a malformed address with JSON too (syntax.valid false);
//   - runs at most 2 checks at a time, and adds GET /healthz for OpenReach's "Test connection".
//
// Settings (environment variables):
//
//	VERIFIER_FROM_EMAIL       MAIL FROM address, on a domain you own (required while the SMTP check is on)
//	VERIFIER_HELLO_NAME       EHLO name, ideally the reverse-DNS name of your public IP (required likewise)
//	VERIFIER_LISTEN           address to listen on (default 127.0.0.1:8080)
//	VERIFIER_SECRET           shared secret; when set, every request must carry it in X-Verifier-Secret
//	VERIFIER_SMTP             on | off (default on)
//	VERIFIER_PROXY            optional SOCKS5 proxy for SMTP, e.g. socks5://user:pass@host:1080
//	VERIFIER_CONNECT_TIMEOUT  seconds (default 10)
//	VERIFIER_OPERATION_TIMEOUT seconds (default 10)
package main

import (
	"crypto/subtle"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/julienschmidt/httprouter"

	emailVerifier "github.com/AfterShip/email-verifier"
)

type config struct {
	listen           string
	fromEmail        string
	helloName        string
	secret           string
	proxy            string
	smtp             bool
	connectTimeout   time.Duration
	operationTimeout time.Duration
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func onOff(key string, fallback bool) bool {
	switch strings.ToLower(env(key, "")) {
	case "on", "true", "yes", "1":
		return true
	case "off", "false", "no", "0":
		return false
	}
	return fallback
}

func seconds(key string, fallback int) time.Duration {
	n, err := strconv.Atoi(env(key, strconv.Itoa(fallback)))
	if err != nil || n < 1 || n > 120 {
		log.Fatalf("%s must be a whole number of seconds from 1 to 120", key)
	}
	return time.Duration(n) * time.Second
}

func load() config {
	cfg := config{
		listen:           env("VERIFIER_LISTEN", "127.0.0.1:8080"),
		fromEmail:        env("VERIFIER_FROM_EMAIL", ""),
		helloName:        env("VERIFIER_HELLO_NAME", ""),
		secret:           env("VERIFIER_SECRET", ""),
		proxy:            env("VERIFIER_PROXY", ""),
		smtp:             onOff("VERIFIER_SMTP", true),
		connectTimeout:   seconds("VERIFIER_CONNECT_TIMEOUT", 10),
		operationTimeout: seconds("VERIFIER_OPERATION_TIMEOUT", 10),
	}
	if cfg.smtp && (cfg.fromEmail == "" || cfg.helloName == "") {
		log.Fatal("Set VERIFIER_FROM_EMAIL (an address on a domain you own) and VERIFIER_HELLO_NAME (your host name), or VERIFIER_SMTP=off")
	}
	if host, _, err := net.SplitHostPort(cfg.listen); err != nil {
		log.Fatalf("VERIFIER_LISTEN must look like 127.0.0.1:8080: %v", err)
	} else if ip := net.ParseIP(host); (ip == nil || !ip.IsLoopback()) && host != "localhost" && cfg.secret == "" {
		log.Printf("WARNING: listening on %s without VERIFIER_SECRET: anyone who can reach this port can use your IP for SMTP checks", cfg.listen)
	}
	return cfg
}

func newVerifier(cfg config) *emailVerifier.Verifier {
	v := emailVerifier.NewVerifier()
	if !cfg.smtp {
		return v
	}
	v = v.EnableSMTPCheck().
		FromEmail(cfg.fromEmail).
		HelloName(cfg.helloName).
		ConnectTimeout(cfg.connectTimeout).
		OperationTimeout(cfg.operationTimeout)
	if cfg.proxy != "" {
		v = v.Proxy(cfg.proxy)
	}
	return v
}

// The library's Result with its fields at the top level, plus why a check could not finish.
type answer struct {
	*emailVerifier.Result
	Error string `json:"error,omitempty"`
}

type server struct {
	cfg   config
	slots chan struct{}
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *server) authorized(w http.ResponseWriter, r *http.Request) bool {
	if s.cfg.secret == "" {
		return true
	}
	got := r.Header.Get("X-Verifier-Secret")
	if subtle.ConstantTimeCompare([]byte(got), []byte(s.cfg.secret)) == 1 {
		return true
	}
	writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "wrong or missing X-Verifier-Secret"})
	return false
}

func (s *server) health(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	if !s.authorized(w, r) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok":              true,
		"service":         "email-verifier",
		"smtp_check":      s.cfg.smtp,
		"catch_all_check": s.cfg.smtp,
	})
}

func (s *server) verify(w http.ResponseWriter, r *http.Request, ps httprouter.Params) {
	if !s.authorized(w, r) {
		return
	}
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	case <-r.Context().Done():
		return
	}
	ret, err := newVerifier(s.cfg).Verify(ps.ByName("email"))
	if ret == nil {
		msg := "verification failed"
		if err != nil {
			msg = err.Error()
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": msg})
		return
	}
	out := answer{Result: ret}
	if err != nil {
		out.Error = err.Error()
	}
	writeJSON(w, http.StatusOK, out)
}

func main() {
	cfg := load()
	s := &server{cfg: cfg, slots: make(chan struct{}, 2)}
	router := httprouter.New()
	router.GET("/healthz", s.health)
	router.GET("/v1/:email/verification", s.verify)

	srv := &http.Server{
		Addr:              cfg.listen,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      55 * time.Second,
	}
	smtp := "off"
	if cfg.smtp {
		smtp = "on"
	}
	log.Printf("email-verifier listening on http://%s (SMTP check %s)", cfg.listen, smtp)
	log.Fatal(srv.ListenAndServe())
}
