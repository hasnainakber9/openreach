# Self-hosted email verification with AfterShip email-verifier (Windows, no Docker)

[AfterShip email-verifier](https://github.com/AfterShip/email-verifier) is an open-source Go library (MIT licence) that checks an email address without sending mail. It checks the syntax, looks up the domain's mail servers (MX), flags disposable (throwaway) domains, role addresses (`info@`, `sales@`) and free mail providers, and, when its SMTP check is on, connects to the domain's mail server and asks whether it would accept that mailbox (`RCPT TO`, then hangs up). It also tells catch-all domains apart (they accept every address).

OpenReach talks to it over HTTP through the **Self-hosted verifier (AfterShip email-verifier)** provider. You build one small `.exe` from the library's example API server, with a replacement `main.go` that ships with OpenReach. Nothing here costs money and nothing leaves your computer except the DNS lookups and SMTP conversations themselves.

These steps use **v1.5.0** (released 2026-09-10). They were written from the v1.5.0 source; the `main.go` was type-checked against that API but has not been run against live mail servers.

## 1. First check outbound port 25

The mailbox check needs your computer to open TCP connections to other mail servers on port 25. Most home and mobile ISPs block that, and the email-verifier README warns about it. In PowerShell:

```powershell
Test-NetConnection gmail-smtp-in.l.google.com -Port 25
```

- `TcpTestSucceeded : True`: port 25 is open, so mailbox checks can work.
- `TcpTestSucceeded : False` (or a long wait): it is blocked. The verifier can still check syntax, MX records and disposable domains, but every mailbox check would hang until it times out and come back *unknown*. Start it with `VERIFIER_SMTP=off` (see below) so lookups stay fast, or run it on a server whose provider allows outbound port 25 (many cloud providers block it too until you ask), or send the SMTP checks through a SOCKS5 proxy (`VERIFIER_PROXY`).

**Blocklist risk.** Every check is an SMTP conversation from your IP address. Mail servers watch for that: many refuse connections from home IP ranges outright (Spamhaus PBL and similar lists), and probing many addresses quickly can put your IP on a blocklist, which can then hurt mail you send yourself from that connection. Keep volumes low: OpenReach sends at most one check a second to a verifier, and the `main.go` below runs at most two at a time. Never run it from the same IP as your sending mailboxes if you can avoid it.

## 2. Install Go and Git

- **Go 1.25 or newer** (v1.5.0's `go.mod` says `go 1.25.0`). Either run the `.msi` installer from [go.dev/dl](https://go.dev/dl/) (needs administrator rights), or, without admin, download the `go1.x.y.windows-amd64.zip`, unzip it to `%USERPROFILE%\go-sdk`, and in each PowerShell window you build from run `$env:Path = "$HOME\go-sdk\go\bin;$env:Path"`. Check with `go version`.
- **Git for Windows** from [git-scm.com](https://git-scm.com/download/win), or skip Git and download the source zip of the tag: `https://github.com/AfterShip/email-verifier/archive/refs/tags/v1.5.0.zip`.

The library is pure Go, so no C compiler, OpenSSL or Docker is needed.

## 3. Get the source at the pinned tag and swap in OpenReach's main.go

```powershell
mkdir $HOME\selfhosted -Force; cd $HOME\selfhosted
git clone --depth 1 --branch v1.5.0 https://github.com/AfterShip/email-verifier.git
cd email-verifier
git log -1 --format="%H %cd"     # note the commit you built
Copy-Item "$HOME\Documents\openreach\docs\selfhosted\aftership-apiserver\main.go" cmd\apiserver\main.go -Force
```

(Adjust the OpenReach path if your checkout is elsewhere.) The replacement [`aftership-apiserver/main.go`](aftership-apiserver/main.go) changes the upstream example in these ways:

| Upstream `cmd/apiserver/main.go` | OpenReach's `main.go` |
| --- | --- |
| `NewVerifier()` with no SMTP check | `EnableSMTPCheck()` with catch-all detection, `FromEmail(...)`, `HelloName(...)`, connect and operation timeouts |
| Listens on `:8080` (every network interface) | Listens on `127.0.0.1:8080` unless `VERIFIER_LISTEN` says otherwise |
| No authentication | Optional shared secret in the `X-Verifier-Secret` header (`VERIFIER_SECRET`), compared in constant time |
| A failed check (MX lookup, SMTP) is a plain-text HTTP 500 | The partial result as JSON with an `error` field, so OpenReach records *unknown* with the reason |
| Bad syntax is the plain text `email address syntax is invalid` | The JSON result (`syntax.valid: false`); OpenReach understands both |
| One verifier per request, unlimited concurrency | At most 2 checks at a time; `GET /healthz` for OpenReach's *Test connection* |

Everything else (the route `GET /v1/{email}/verification`, the result fields) is unchanged.

## 4. Build

```powershell
$env:CGO_ENABLED = "0"
go build -trimpath -o email-verifier-api.exe ./cmd/apiserver
```

The first build downloads the library's few dependencies (`julienschmidt/httprouter`, `golang.org/x/net`, `go-edlib`, `golang.org/x/text`) from the Go module proxy and checks them against the repository's `go.sum`. The result is one `email-verifier-api.exe` of a few MB.

## 5. Run it

```powershell
$env:VERIFIER_FROM_EMAIL = "verify@yourcompany.com"   # MAIL FROM: an address on a domain you own
$env:VERIFIER_HELLO_NAME = "mail.yourcompany.com"     # EHLO name: ideally your IP's reverse-DNS name
$env:VERIFIER_SECRET     = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 40 | ForEach-Object { [char]$_ })
$env:VERIFIER_SECRET                                   # copy this into OpenReach
.\email-verifier-api.exe
```

It prints `email-verifier listening on http://127.0.0.1:8080 (SMTP check on)` and keeps running in that window. Don't keep the library's defaults (`user@example.org`, `localhost`): many mail servers reject those at once. Other settings, all optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `VERIFIER_LISTEN` | `127.0.0.1:8080` | Address to listen on. Use a LAN address only with `VERIFIER_SECRET` set (it warns otherwise), and remember the secret travels in plain HTTP. |
| `VERIFIER_SMTP` | `on` | `off` checks only syntax, MX records and disposable domains (for when port 25 is blocked). `VERIFIER_FROM_EMAIL` and `VERIFIER_HELLO_NAME` are then not needed. |
| `VERIFIER_PROXY` | none | A SOCKS5 proxy for SMTP connections, e.g. `socks5://user:pass@host:1080` (only `socks5`/`socks5h`; DNS lookups don't go through it). |
| `VERIFIER_CONNECT_TIMEOUT`, `VERIFIER_OPERATION_TIMEOUT` | `10` | Seconds, 1 to 120. |

Try it from a second PowerShell window:

```powershell
$h = @{ 'X-Verifier-Secret' = '<the secret>' }
Invoke-RestMethod http://127.0.0.1:8080/healthz -Headers $h
Invoke-RestMethod "http://127.0.0.1:8080/v1/someone%40yourcompany.com/verification" -Headers $h
```

Windows Firewall normally doesn't ask about a program that only listens on `127.0.0.1`; if it does, allow private networks only, or cancel.

**Start it with Windows (optional).** Store the settings as user environment variables once (`setx VERIFIER_FROM_EMAIL "verify@yourcompany.com"`, and the same for `VERIFIER_HELLO_NAME` and `VERIFIER_SECRET`; anyone using your Windows account can read them), then:

```powershell
schtasks /Create /SC ONLOGON /TN "email-verifier" /TR "$HOME\selfhosted\email-verifier\email-verifier-api.exe"
```

## 6. Connect OpenReach

1. **Settings → Integrations → Add provider → Email verification → Self-hosted verifier (AfterShip email-verifier)**.
2. **Verifier URL:** leave it empty for `http://127.0.0.1:8080`, or enter where it listens (the part before `/v1`).
3. **Shared secret:** the `VERIFIER_SECRET` value (leave empty if you didn't set one). If you later change the URL, OpenReach asks for the secret again, so it is never sent to a host it wasn't entered for.
4. Press **Test connection**. It reads `/healthz` and says whether the SMTP check is on. Against the stock upstream apiserver it says so instead: that build never checks mailboxes.
5. Only the **first** verifier in the list is used, so drag this one to the top to use it instead of a paid one.

How OpenReach reads the answers (the reason is saved on the lead, prefixed *Self-hosted verifier*):

| Verifier answer | OpenReach status |
| --- | --- |
| Bad syntax (JSON or the plain-text reply), disposable domain | invalid |
| `reachable: "no"` (no mail server, or the server refused or disabled the mailbox), or `smtp.deliverable: false` from a finished check | invalid |
| The stock apiserver's plain-text 500 `Mail server does not exist : ... no such host` (the domain doesn't exist) | invalid |
| An `error` (MX lookup failed, port 25 blocked, the server refused our connection or greeting) | unknown, with the error |
| `reachable: "yes"` / `smtp.deliverable: true` | valid |
| `smtp.catch_all: true` with `disabled` or `full_inbox` (the server refused the made-up test address as "not allowed" or "out of space") | unknown |
| `smtp.catch_all: true` otherwise | risky |
| Anything else, including the SMTP check being off | unknown |

`smtp.catch_all: true` means less than its name says. Before asking about the real mailbox, the verifier asks about a made-up address at the same domain, and v1.5.0 clears `catch_all` only when the server answers that this address doesn't exist. Any other answer leaves it `true`: a real catch-all domain, but also greylisting (a temporary 4xx), a refusal because your IP is on a blocklist, or a timeout halfway through. The real mailbox is then never asked about, so all of these come back *risky*, with the reason "didn't turn away a made-up address".

Any other plain-text 500 from the stock apiserver (an MX lookup that failed for another reason, such as a DNS timeout) is treated as temporary and retried.

It costs no credits, also on hosted plans. On a hosted installation (billing on) the URL must be a public host: `localhost`, `127.0.0.1` and private-network addresses are refused when saved and before every request. Self-hosted installs allow them. Checks wait up to 60 seconds; a timeout or an unreachable verifier is retried later like any other temporary failure.

## Real limits

- **Port 25** (above): without it, only syntax, MX and disposable checks work, and everything else stays *unknown*.
- **Catch-all domains**, common in B2B, can only ever be *risky*: the server accepts every address, so none can be confirmed.
- **Big mailbox providers:** Microsoft 365, Outlook.com and Yahoo often accept every `RCPT TO` or refuse probes from unknown IPs, and v1.5.0 has no special handling for them (its Yahoo/Gmail API checks were removed), so expect many *unknown* or *risky* answers there. Greylisting servers (a temporary 4xx on first contact) and servers that block your IP mid-conversation come back *risky*, not *unknown* (see the note on `catch_all` above).
- **Accuracy is lower than paid verifiers**, which probe from warmed-up IP pools and keep history. Treat *valid* as "the server said yes today".
- **Speed:** each check takes from under a second to 20 to 30 seconds, and OpenReach sends at most one a second.
- **Maintenance:** the API server is an example in the upstream repo, not a supported product; you own the small `main.go`. When you move to a newer tag, rebuild and check that `EnableSMTPCheck`, `FromEmail`, `HelloName`, `ConnectTimeout`, `OperationTimeout` and `Proxy` still exist, and that catch-all detection is still on by default.
- **Legal:** an SMTP check sends no email, but what you do with the addresses afterwards (GDPR, CAN-SPAM, PECR) is still your responsibility.

For higher accuracy on a Linux server with port 25 open, [Reacher](https://github.com/reacherhq/check-if-email-exists) (MIT) is the stronger open-source verifier, but it has no Windows build and has no OpenReach provider yet.
