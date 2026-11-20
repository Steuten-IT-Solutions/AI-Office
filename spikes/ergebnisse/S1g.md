# Ergebnis S1g – Netz des Lauf-Containers

Lauf in der VM `aio-dev` am 19.11.2026 mit `spikes/vm/s1g.sh` (Ubuntu 26.04.1, Docker 29.9.3,
Kernel 7.0.0-43). Der Bericht des Skripts steht unverändert unten.

## Einordnung

**Stand 20.11.2026: Go.** Nach der Sperre aus ai-office-supervisor#11 sind alle Prüfungen wie
erwartet, siehe [Wiederholung](#wiederholung-am-20112026). Erster Lauf am 19.11.2026:

**Ergebnis des ersten Laufs: No-Go mit einer Abweichung.**

- Aus dem Lauf-Container ist der SSH-Dienst des Hosts erreichbar, und zwar über das Gateway des
  eigenen Lauf-Netzes (`172.19.0.1:22`). Auch ein Netz mit `--internal` bekommt auf dem Host
  eine Bridge-Adresse; `sshd` lauscht auf allen Adressen (`0.0.0.0:22`).
- Alle anderen Prüfungen sind wie erwartet: kein Internet über IPv4 und IPv6, kein DNS, keine
  anderen Container, kein Host über `docker0` oder den Default Switch. Proxy, Office-API- und
  Gateway-Attrappe sind erreichbar.

**Vorschlag (vom CEO am 19.11.2026 angenommen, umgesetzt in ai-office-supervisor#11):** Eine Regel im Hook `input` von
nftables verwirft Verbindungen von den Bridges der Lauf-Netze an den Host, außer zu Ports, die
S05 ausdrücklich braucht. Zusätzlich oder ersatzweise lauscht `sshd` nur auf den Adressen von
`eth0` und `eth1`. Welche Option Docker 29 für Bridges ohne Adresse auf dem Host bietet, habe ich
nicht geprüft **[Annahme: es gibt eine; prüfen, bevor man sich auf die Regel allein verlässt]**.
Danach S1g wiederholen.

## Bericht des Skripts

Zeitpunkt: 2026-11-19T20:42:50.827Z
Image: aio-spike-lauf:ohne (sha256:a24d8711ac98)
CLI: 2.1.312 (Claude Code)
Docker: 29.9.3, Kernel: 7.0.0-43-generic
Gesamtergebnis: No-Go (Abweichungen)

| Prüfung | Erwartet | Beobachtet | Ergebnis |
|---|---|---|---|
| Proxy erreichbar (TCP aio-spike-proxy:8080) | geht | geht (verbunden) | erwartet |
| Über den Proxy zu api.anthropic.com:443 (CONNECT) | geht | geht (CONNECT 200) | erwartet |
| Office-API-Attrappe (HTTP aio-spike-office:3100) | geht | geht (HTTP 200) | erwartet |
| Gateway-Attrappe (HTTP aio-spike-gateway:3200) | geht | geht (HTTP 200) | erwartet |
| Host über das Gateway des Lauf-Netzes (172.19.0.1:22) | scheitert | geht (verbunden) | ABWEICHUNG |
| Host über docker0 (172.17.0.1:22) | scheitert | scheitert (ENETUNREACH) | erwartet |
| Host über seine Adresse im Default Switch (172.28.50.99:22) | scheitert | scheitert (ENETUNREACH) | erwartet |
| Container im zweiten Lauf-Netz (172.20.0.2:8080) | scheitert | scheitert (ENETUNREACH) | erwartet |
| Container an der Standard-Bridge (172.17.0.2:8080) | scheitert | scheitert (ENETUNREACH) | erwartet |
| Internet direkt (TCP 1.1.1.1:443) | scheitert | scheitert (ENETUNREACH) | erwartet |
| Anthropic direkt (TCP 160.79.104.10:443) | scheitert | scheitert (ENETUNREACH) | erwartet |
| Internet direkt über IPv6 (TCP [2606:4700:4700::1111]:443) | scheitert | scheitert (ENETUNREACH) | erwartet |
| DNS über den Resolver des Containers (example.com) | scheitert | scheitert (EAI_AGAIN) | erwartet |
| DNS direkt (UDP 1.1.1.1:53, example.com) | scheitert | scheitert (ECONNREFUSED) | erwartet |
| DNS direkt (UDP 8.8.8.8:53, example.com) | scheitert | scheitert (ECONNREFUSED) | erwartet |
| DNS direkt am Gateway des Lauf-Netzes (172.19.0.1:53) | scheitert | scheitert (ECONNREFUSED) | erwartet |
| Namen im Lauf-Netz auflösbar (aio-spike-office) | geht | geht (aufgelöst (1 Adresse(n))) | info |

### Folge laut Plan

No-Go: Netzaufbau korrigieren (docs/etappe-0.md 3.1).

## Wiederholung am 20.11.2026

Gleiches Image und gleiches Skript, auf dem Host jetzt mit der Kette `container_zum_host` in der
Tabelle `inet aio_office` (ai-office-supervisor#11, eingespielt mit `provision.sh`). Der Zugriff
auf `172.19.0.1:22` scheitert mit `ECONNREFUSED`; der Zähler der Regel stand danach bei 2
abgelehnten Paketen. Alle anderen Ergebnisse sind unverändert.

### Bericht des Skripts

Zeitpunkt: 2026-11-20T09:07:43.985Z
Image: aio-spike-lauf:ohne (sha256:a24d8711ac98)
CLI: 2.1.312 (Claude Code)
Docker: 29.9.3, Kernel: 7.0.0-43-generic
Gesamtergebnis: Go (alle Prüfungen wie erwartet)

| Prüfung | Erwartet | Beobachtet | Ergebnis |
|---|---|---|---|
| Proxy erreichbar (TCP aio-spike-proxy:8080) | geht | geht (verbunden) | erwartet |
| Über den Proxy zu api.anthropic.com:443 (CONNECT) | geht | geht (CONNECT 200) | erwartet |
| Office-API-Attrappe (HTTP aio-spike-office:3100) | geht | geht (HTTP 200) | erwartet |
| Gateway-Attrappe (HTTP aio-spike-gateway:3200) | geht | geht (HTTP 200) | erwartet |
| Host über das Gateway des Lauf-Netzes (172.19.0.1:22) | scheitert | scheitert (ECONNREFUSED) | erwartet |
| Host über docker0 (172.17.0.1:22) | scheitert | scheitert (ENETUNREACH) | erwartet |
| Host über seine Adresse im Default Switch (172.28.50.99:22) | scheitert | scheitert (ENETUNREACH) | erwartet |
| Container im zweiten Lauf-Netz (172.20.0.2:8080) | scheitert | scheitert (ENETUNREACH) | erwartet |
| Container an der Standard-Bridge (172.17.0.2:8080) | scheitert | scheitert (ENETUNREACH) | erwartet |
| Internet direkt (TCP 1.1.1.1:443) | scheitert | scheitert (ENETUNREACH) | erwartet |
| Anthropic direkt (TCP 160.79.104.10:443) | scheitert | scheitert (ENETUNREACH) | erwartet |
| Internet direkt über IPv6 (TCP [2606:4700:4700::1111]:443) | scheitert | scheitert (ENETUNREACH) | erwartet |
| DNS über den Resolver des Containers (example.com) | scheitert | scheitert (EAI_AGAIN) | erwartet |
| DNS direkt (UDP 1.1.1.1:53, example.com) | scheitert | scheitert (ECONNREFUSED) | erwartet |
| DNS direkt (UDP 8.8.8.8:53, example.com) | scheitert | scheitert (ECONNREFUSED) | erwartet |
| DNS direkt am Gateway des Lauf-Netzes (172.19.0.1:53) | scheitert | scheitert (ECONNREFUSED) | erwartet |
| Namen im Lauf-Netz auflösbar (aio-spike-office) | geht | geht (aufgelöst (1 Adresse(n))) | info |

#### Folge laut Plan

No-Go: Netzaufbau korrigieren (docs/etappe-0.md 3.1).
