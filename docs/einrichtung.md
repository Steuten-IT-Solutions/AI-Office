# Einrichtung Etappe 0 – Schritt-für-Schritt-Anleitung für den CEO

> Ergänzt [`etappe-0.md`](etappe-0.md) um konkrete Klickpfade und Befehle. Stand 25.10.2026.
> Quellen stehen jeweils dabei. Was ich nicht in einer Primärquelle prüfen konnte, ist als
> **[Annahme]** markiert.

**Reihenfolge:** Teil 1 zuerst, weil die Antwort von Anthropic dauert. Teil 5 erst nach Teil 3.

| Teil | Inhalt | Dauer (geschätzt) | Wo |
|---|---|---|---|
| 1 | Anfrage an Anthropic abschicken | 10 min | Browser |
| 2 | Repos und GitHub App anlegen | 30 min | Browser |
| 3 | Spikes S1c–S1e ausführen | 30 min | Windows (PowerShell) |
| 4 | Hyper-V-VM mit Ubuntu und Docker | 60–90 min | Windows + VM |
| 5 | Branch-Schutz für `AI-Office` | 10 min | Browser |
| 6 | Firefox für das Office-Webinterface (erst mit P09) | 10 min | Windows |
| 7 | Spikes S1a, S1b, S1f, S1g und S2 | 1–2 h | VM per SSH |

**Grundregel:** Schlüssel, Tokens und Passwörter nie in ein Repo, eine Nachricht oder einen Chat
kopieren, auch nicht an mich.

---

## Teil 1 – Anfrage an Anthropic

1. Text aus [`etappe-0.md`, Abschnitt 2](etappe-0.md#2-entwurf-anfrage-an-anthropic-spike-s4-risiko-r1)
   kopieren und die Platzhalter `<E-Mail-Adresse des Abos>` und `<Name>` ausfüllen.
2. **Weg A (Vertrieb):** <https://www.anthropic.com/contact-sales> öffnen und den Text dort
   einfügen. Die Claude-Code-Doku verweist Fragen zu zulässigen Anmeldewegen ausdrücklich dorthin
   ([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).
3. **Weg B (Support):** In claude.ai unten links auf Ihre Initialen → **Get help** →
   **Send us a message** → **Accept** → Thema wählen → Text einfügen
   ([Support-Artikel](https://support.claude.com/en/articles/9015913)).
4. Datum notieren. Die Antwort kommt per E-Mail; bitte aufheben und mir den Inhalt sagen.

---

## Teil 2 – Repos und GitHub App

### 2.1 Repo `ai-office-supervisor` (privat)

1. <https://github.com/organizations/Steuten-IT-Solutions/repositories/new> öffnen
   (oder: Organisation → **Repositories** → **New repository**).
2. **Repository name:** `ai-office-supervisor`
3. **Private** wählen.
4. **Add a README file** anhaken (damit es einen `main`-Branch gibt).
5. **Create repository**.
6. Mir Bescheid geben. Ich hole das Repo dann in meine Sitzung.

### 2.2 Test-Repo `aio-spike-s1` (öffentlich, nur für Spike S1)

1. Wie 2.1, aber **Repository name** `aio-spike-s1` und **Public**, ebenfalls mit README.
   Öffentlich, weil Branch-Schutz für private Repos im Free-Tarif fehlt
   ([GitHub-Pläne](https://docs.github.com/en/get-started/learning-about-github/githubs-plans)).
2. Im neuen Repo **Add file** → **Create new file**:
   - Dateiname: `.github/workflows/existing.yml`
   - Inhalt:
     ```yaml
     name: existing
     on: workflow_dispatch
     jobs:
       noop:
         runs-on: ubuntu-24.04
         steps:
           - run: echo existing
     ```
   - **Commit changes…** → direkt auf `main`.
3. Noch einmal **Add file** → **Create new file**:
   - Dateiname: `.github/CODEOWNERS`
   - Inhalt: `* @ChrisSteuten`
   - **Commit changes…** → direkt auf `main`.

### 2.3 GitHub App anlegen

Quelle: [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).

1. Profilbild oben rechts → **Your organizations** → bei `Steuten-IT-Solutions` auf
   **Settings** → links **Developer settings** → **GitHub Apps** → **New GitHub App**.
2. Felder:
   - **GitHub App name:** `aio-supervisor` (falls vergeben: `aio-supervisor-steuten`)
   - **Homepage URL:** `https://github.com/Steuten-IT-Solutions/AI-Office`
   - **Webhook → Active:** Haken **entfernen**
3. **Permissions → Repository permissions:**
   | Berechtigung | Wert |
   |---|---|
   | Checks | Read-only |
   | Contents | Read and write |
   | Issues | Read and write |
   | Metadata | Read-only (wird automatisch gesetzt) |
   | Pull requests | Read and write |
   | **Workflows** | **No access** (E30) |
   | alles andere | No access |

   **Organization permissions** und **Account permissions**: alles auf No access lassen.
4. **Where can this GitHub App be installed?** → **Only on this account**.
5. **Create GitHub App**.
6. Auf der folgenden Seite die **App ID** notieren (Zahl oben auf der Seite „General“).

### 2.4 Privaten Schlüssel erzeugen

Quelle: [Managing private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps).

1. Auf der Seite der App links **Credentials** → **Key pairs** → **New key**. (Bei älteren
   Oberflächen heißt es „Generate a private key“ unten auf der Seite „General“.)
2. Der Browser lädt eine `.pem`-Datei herunter.
3. Datei aus dem Download-Ordner verschieben nach `C:\Users\<Ihr Name>\.aio\aio-supervisor.pem`
   (Ordner `.aio` vorher anlegen). **Nicht** in den Ordner des Repos legen.

### 2.5 App installieren

Quelle: [Installing your own GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app).

1. Auf der Seite der App links **Install App** → bei `Steuten-IT-Solutions` **Install**.
2. **Only select repositories** → `AI-Office` und `aio-spike-s1` auswählen.
   **Nicht** `ai-office-supervisor` (E35).
3. **Install**.

---

## Teil 3 – Spikes S1c–S1e unter Windows ausführen

Die Skripte sprechen nur mit GitHub und brauchen die VM noch nicht. Details:
[`spikes/s1-github/README.md`](../spikes/s1-github/README.md).

### 3.1 Werkzeuge installieren (einmalig)

PowerShell öffnen (Startmenü → „PowerShell“).

1. **Git:**
   ```powershell
   winget install --id Git.Git -e
   ```
2. **Node.js 24 LTS:** Installer
   <https://nodejs.org/dist/v24.22.1/node-v24.22.1-x64.msi> herunterladen. Optional die Prüfsumme
   vergleichen:
   ```powershell
   Get-FileHash $HOME\Downloads\node-v24.22.1-x64.msi -Algorithm SHA256
   ```
   Erwartet: `3BDA4BAF1EE709B33CF920DD633106DDB23951E322BFF9C03EC9F64AB8981B01`
   (aus [SHASUMS256.txt](https://nodejs.org/dist/v24.22.1/SHASUMS256.txt)). Dann installieren,
   Standardoptionen genügen.
3. **pnpm über Corepack** (in Node 24 enthalten): PowerShell **als Administrator** öffnen
   (Rechtsklick → „Als Administrator ausführen“):
   ```powershell
   corepack enable
   ```
4. Alle PowerShell-Fenster schließen und eine **normale** PowerShell neu öffnen. Prüfen:
   ```powershell
   git --version
   node --version    # erwartet v24.22.1
   ```

### 3.2 Repo holen und Abhängigkeiten installieren

```powershell
mkdir D:\dev -Force
cd D:\dev
git clone https://github.com/Steuten-IT-Solutions/AI-Office.git
cd AI-Office
pnpm install --frozen-lockfile --ignore-scripts
```

Beim ersten Aufruf fragt Corepack, ob es pnpm 10.34.8 herunterladen darf: mit `Y` bestätigen.

### 3.3 S1c und S1d ausführen

```powershell
cd D:\dev\AI-Office\spikes\s1-github
$env:AIO_APP_ID = "<App ID aus 2.3>"
$env:AIO_APP_KEY_FILE = "$HOME\.aio\aio-supervisor.pem"
pnpm s1c
pnpm s1d
```

Jedes Skript schreibt einen Bericht (`s1c-bericht.md`, `s1d-bericht.md`) in den aktuellen Ordner.
Die Ausgabe in der Konsole zeigt jede Prüfung mit `[erwartet]`, `[ABWEICHUNG]` oder `[info]`.

### 3.4 Branch-Schutz im Test-Repo, dann S1e

1. Im Repo `aio-spike-s1`: **Settings** → **Branches** → **Add classic branch protection rule**
   ([GitHub-Doku](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule)).
2. **Branch name pattern:** `main`
3. Anhaken:
   - **Require a pull request before merging**
     - **Require approvals** (1)
     - **Dismiss stale pull request approvals when new commits are pushed**
     - **Require review from Code Owners**
     - **Require approval of the most recent reviewable push**
   - **Restrict who can push to matching branches** → nur sich selbst eintragen, **nicht** die App
   - **Do not allow bypassing the above settings**
   - **Nicht** anhaken: Status-Checks, Allow force pushes, Allow deletions
4. **Create**.
5. In derselben PowerShell (die Variablen aus 3.3 gelten noch):
   ```powershell
   pnpm s1e
   ```
6. Das Skript hält an und fordert Sie auf, einen PR in GitHub zu approven bzw. die App unter
   „Restrict who can push“ einzutragen. Jeweils im Browser erledigen, dann in der PowerShell
   **Enter** drücken.

### 3.5 Ergebnisse und Aufräumen

1. Die drei Berichte (`s1c-bericht.md`, `s1d-bericht.md`, `s1e-bericht.md`) hier im Chat einfügen.
   Sie enthalten keine Geheimnisse.
2. Danach: App auf `aio-spike-s1` deinstallieren (Organisation → **Settings** →
   **GitHub Apps** → bei der App **Configure** → `aio-spike-s1` aus der Auswahl entfernen) und das
   Repo löschen (**Settings** → ganz unten **Delete this repository**).

---

## Teil 4 – Hyper-V-VM mit Ubuntu und Docker

Begründung für Hyper-V statt WSL: [`etappe-0.md`, Abschnitt 1.1](etappe-0.md#11-zielmaschine-entwicklungsmaschine-des-ceo-vps-zurückgestellt).

### 4.1 Hyper-V aktivieren

PowerShell **als Administrator**:
```powershell
Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All
```
Mit `Y` neu starten
([Microsoft Learn](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/install-hyper-v)).

### 4.2 Ubuntu herunterladen

Ubuntu Server **26.04 LTS** von <https://ubuntu.com/download/server> laden und z. B. unter
`F:\ISO\` ablegen. Docker unterstützt 26.04 und 24.04
([Docker-Doku](https://docs.docker.com/engine/install/ubuntu/)).

### 4.3 VM anlegen

1. **Hyper-V-Manager** öffnen → rechts **Neu** → **Virtueller Computer…**
2. **Name:** `aio-dev`. **Virtuellen Computer an einem anderen Speicherort speichern** anhaken →
   `D:\Hyper-V\`
3. **Generation 2**
4. **Arbeitsspeicher:** `16384` MB, **Dynamischen Arbeitsspeicher … verwenden** **nicht**
   anhaken
5. **Netzwerk:** `Default Switch`
6. **Virtuelle Festplatte erstellen:** Speicherort `D:\Hyper-V\aio-dev\`, Größe `100` GB
   (wird dynamisch erweitert, belegt anfangs nur wenige GB)
7. **Betriebssystem von einer startfähigen Imagedatei installieren** → die ISO aus 4.2
8. **Fertig stellen**, VM noch **nicht** starten.

### 4.4 Einstellungen vor dem ersten Start

Rechtsklick auf `aio-dev` → **Einstellungen…**

1. **Sicherheit** → **Sicherer Start aktivieren** bleibt an, **Vorlage:**
   **Microsoft UEFI-Zertifizierungsstelle**. Mit der Standardvorlage für Windows startet Ubuntu
   nicht ([Canonical: Ubuntu on Hyper-V](https://ubuntu.com/server/docs/how-to/virtualisation/ubuntu-on-hyper-v/)).
2. **Prozessor** → **Anzahl virtueller Prozessoren:** `8`
3. **Automatische Startaktion** → **Immer automatisch starten**
4. **Automatische Stoppaktion** → **Gastbetriebssystem herunterfahren**
5. **OK**.

### 4.5 Ubuntu installieren

1. Doppelklick auf `aio-dev` → **Starten**.
2. Im Installer:
   - Sprache und Tastatur nach Wunsch
   - Installationsart **Ubuntu Server** (nicht „minimized“)
   - Netzwerk: automatisch (DHCP)
   - Festplatte: **Use an entire disk**, Standard übernehmen
   - Profil: Ihr Name, Servername `aio-dev`, Benutzername z. B. `christian`, sicheres Passwort
   - **Install OpenSSH server** anhaken
   - Keine zusätzlichen Snaps auswählen
3. Nach **Reboot Now** ggf. Enter drücken, wenn der Installer zum Entfernen der ISO auffordert.
4. Anmelden und die IP-Adresse anzeigen:
   ```bash
   ip -4 addr show eth0
   ```

### 4.6 Per SSH verbinden und aktualisieren

In einer Windows-PowerShell (OpenSSH ist in Windows 11 enthalten):
```powershell
ssh christian@<IP der VM>
```
In der VM:
```bash
sudo apt update && sudo apt full-upgrade -y
sudo systemctl status unattended-upgrades --no-pager   # sollte "active" zeigen
sudo reboot
```
Falls `unattended-upgrades` nicht aktiv ist: `sudo apt install unattended-upgrades` und
`sudo dpkg-reconfigure -plow unattended-upgrades`.

**Hinweis:** Die Adresse im `Default Switch` kann sich nach einem Neustart von Windows ändern
**[Annahme]**. Dann mit `ip -4 addr show eth0` in der VM-Konsole neu nachsehen. Eine feste Adresse
richte ich mit Paket S16 ein.

### 4.7 Docker Engine installieren

Befehle aus der [offiziellen Docker-Anleitung](https://docs.docker.com/engine/install/ubuntu/),
nach erneuter SSH-Anmeldung:
```bash
sudo apt update
sudo apt install ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo docker run hello-world
```

**Wichtig:** Ihren Benutzer **nicht** in die Gruppe `docker` aufnehmen. Wer Docker steuert, ist
faktisch root; Zugriff bekommt später nur der Nutzer `aio-sup` (E25).

### 4.8 Prüfpunkt und Rückmeldung

1. Hyper-V-Manager → Rechtsklick auf `aio-dev` → **Prüfpunkt**. Den neuen Prüfpunkt in
   „frisch installiert“ umbenennen.
2. Mir diese Ausgaben schicken:
   ```bash
   lsb_release -a
   docker --version
   nproc && free -g && df -h /
   ip -4 addr show eth0
   ```

---

## Teil 5 – Branch-Schutz für `AI-Office`

Erst nach Teil 3, weil S1e klärt, ob die App unter „Restrict who can push“ stehen muss.

**Zwei Stufen (E48):** Solange die PRs unter Ihrem Konto eröffnet werden, können Sie sie nicht
approven: „Pull request authors cannot approve their own pull requests“
([GitHub-Doku](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews)).
Mit Pflicht-Approval und ohne Bypass könnte dann niemand mehr nach `main` mergen. Deshalb gilt
zuerst die Übergangsstufe (5.2) und erst mit dem Merge-Gate des Supervisors (Paket S09) die
Zielstufe (5.3).

### 5.1 Actions

Repo `AI-Office` → **Settings** → **Actions** → **General**:

- **Workflow permissions:** **Read repository contents and packages permissions**
  **[Annahme: genaue Beschriftung]**
- **Fork pull request workflows from outside collaborators:** **Require approval for all
  external contributors**
- **Save**

### 5.2 Übergangsstufe: bis zum Merge-Gate (S09)

**Folge:** Nach `main` kommt nur noch ein PR mit grüner CI auf dem aktuellen Stand. Ein Review
erzwingt GitHub in dieser Stufe nicht. Die Freigabe bleibt Ihre: Sie mergen selbst, oder Sie
schreiben zu genau diesem PR ausdrücklich „Merge“, dann merged Claude per Squash.

**Settings** → **Branches** → **Add classic branch protection rule**:

- **Branch name pattern:** `main`
- **Require a pull request before merging**
  - **Require approvals:** **nicht** anhaken. Damit entfallen auch die Unterpunkte zu Code Owners
    und zum letzten Push. Laut
    [GitHub-Doku](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule)
    ist „Require approvals“ ein eigener, optionaler Schritt.
- **Require status checks to pass before merging**
  - **Require branches to be up to date before merging**
  - Im Suchfeld `check` und `secret-scan` eintragen und auswählen
- **Restrict who can push to matching branches:** sich selbst eintragen
  **[Annahme: Ein Merge, den Claude über Ihre GitHub-Verbindung ausführt, zählt als Ihrer. Falls
  nicht, mergen Sie selbst.]**
- **Do not allow bypassing the above settings**
- **Nicht** anhaken: Allow force pushes, Allow deletions
- **Create**

### 5.3 Zielstufe: ab dem Merge-Gate (S09)

Sobald die GitHub App die PRs öffnet, sind Sie nicht mehr der Autor und können approven. Dann die
Regel aus 5.2 bearbeiten und ergänzen:

- unter **Require a pull request before merging**:
  - **Require approvals** (1)
  - **Dismiss stale pull request approvals when new commits are pushed**
  - **Require review from Code Owners**
  - **Require approval of the most recent reviewable push**
- **Restrict who can push to matching branches:** die App zusätzlich nur, wenn der Bericht von S1e
  zeigt, dass sie dort stehen muss
- **Save changes**

**Folge:** Danach kann niemand mehr ohne Ihr Approve nach `main` mergen. Das ist so gewollt (E26).
PRs, die Sie selbst eröffnen (etwa Workflow-Änderungen über `ceo/*`), öffnet ebenfalls die App
(plan.md Kap. 4.5 Nr. 2).

---

## Teil 6 – Firefox für das Office-Webinterface

Erst nötig, wenn es das Webinterface gibt (P09). Hintergrund: WebRTC kommt an der CSP des
Reverse-Proxys vorbei, und Chrome kann es per Richtlinie nicht ganz abschalten (plan.md E49, R11).
Deshalb öffnen Sie das Webinterface nur in einem Firefox, in dem eine Richtlinie WebRTC abschaltet.

**Wichtig:** Die Richtlinie gilt für die ganze Firefox-Installation, also für alle Profile. In
diesem Firefox gehen danach keine Videoanrufe im Browser mehr. Nutzen Sie Firefox auch sonst,
richten Sie für das Webinterface eine zweite Installation ein, oder sagen Sie mir Bescheid.

### 6.1 Richtlinie anlegen

1. Firefox installieren, falls noch nicht vorhanden (<https://www.mozilla.org/firefox/>).
2. Firefox schließen.
3. Im Ordner, in dem `firefox.exe` liegt (meist `C:\Program Files\Mozilla Firefox` **[Annahme]**),
   einen Ordner `distribution` anlegen. Darin die Datei `policies.json` in UTF-8 anlegen. So steht
   es in der [Mozilla-Doku](https://github.com/mozilla/policy-templates#readme): „On Windows, create
   a directory called `distribution` where the EXE is located and place the file there.“

```json
{
  "policies": {
    "Preferences": {
      "media.peerconnection.enabled": {
        "Value": false,
        "Status": "locked"
      }
    }
  }
}
```

Die Richtlinie `Preferences` darf Einstellungen mit dem Präfix `media.` setzen, und `locked` macht
sie unveränderlich ([Policy-Doku](https://github.com/mozilla/policy-templates/blob/master/docs/index.md#preferences)).
`media.peerconnection.enabled` schaltet RTCPeerConnection ab
([StaticPrefList.yaml](https://github.com/mozilla-firefox/firefox/blob/main/modules/libpref/init/StaticPrefList.yaml)).

### 6.2 Prüfen

1. Firefox starten und `about:policies` öffnen. Dort muss `Preferences` als aktiv stehen, ohne Fehler.
2. `about:config` öffnen und nach `media.peerconnection.enabled` suchen. Erwartet: `false`, mit Schloss.
3. Auf einer beliebigen Seite die Entwicklerwerkzeuge öffnen (F12, Konsole) und
   `typeof RTCPeerConnection` eingeben. Erwartet: `"undefined"` **[Annahme]**.

Bitte melden Sie mir die drei Ergebnisse. Damit ist die **[Annahme]** in E49 geprüft, dass Firefox
dann auch keine Verbindung zu TURN über TCP aufbaut. Das konnte ich nicht messen, weil mir kein
Firefox zur Verfügung stand.

### 6.3 Nutzung

Das Webinterface (`https://office.aio.internal:8444` **[Annahme]**, S13) nur in diesem Firefox
öffnen. In einem anderen Browser bleibt WebRTC als Abflusskanal offen (R11).

## Teil 7 – Spikes S1a, S1b, S1f, S1g und S2 in der VM

Die Skripte liegen in [`spikes/vm/`](../spikes/vm/README.md); die README dort beschreibt jeden
Schritt. Kurz:

1. `ssh aio-dev`, das Repo nach `/opt/aio-spikes/repo` klonen und `sudo bash bauen.sh`.
2. `sudo bash s1g.sh` (braucht noch keinen Zugang).
3. `sudo bash zugang.sh token`: `claude setup-token` läuft im Lauf-Image, Sie bestätigen im
   Browser unter Windows und fügen das Token danach unsichtbar ein. Erst jetzt ein Token erzeugen,
   damit keines ungenutzt herumliegt.
4. `sudo bash s1a.sh`, `sudo bash s1f.sh`, `sudo bash s1b.sh`.
5. `sudo bash zugang.sh voll` (voller Login für `/usage`), dann in einem ruhigen Zeitfenster
   `sudo bash s2.sh`. Währenddessen Claude nirgends nutzen.
6. Berichte aus `/opt/aio-spikes/berichte/` an mich (`scp "aio-dev:/opt/aio-spikes/berichte/*" .`).
