# Ergebnis S1a – setup-token für Bash im Container

Lauf in der VM `aio-dev` am 19.11.2026 mit `spikes/vm/s1a.sh` aus PR #25 (Ubuntu 26.04.1, Docker
29.9.3, CLI 2.1.312). Der Bericht des Skripts steht unverändert unten.

## Einordnung

**Ergebnis: No-Go. Die Bash-Sandbox startet im Lauf-Container nicht, die eigentliche Frage ist
daher noch nicht gemessen.**

- Mit eingeschalteter Sandbox scheitert jeder Bash-Aufruf mit der Meldung von bwrap („No
  permissions to create a new namespace“). Der Lauf endet trotzdem mit `success`, nur die Probe
  läuft nicht. Ein Rückfall auf Ausführung ohne Sandbox findet nicht statt. Mit dieser
  Einstellung wären Agenten ohne Bash, also nicht arbeitsfähig.
- Die Positivkontrollen zeigen: Ohne Sandbox liegt das Token in der Umgebung und in
  `/proc/1/environ`, lesbar für jeden Prozess des Agenten. Das ist R5 aus plan.md 5.7.
- **Diagnose:** In einem neuen Container mit `--security-opt seccomp=unconfined` legt bwrap den
  Namespace an und scheitert erst beim Mount („Failed to make / slave“). Mit
  `apparmor=unconfined` allein bleibt es bei der ersten Meldung. Also blockiert zuerst das
  Seccomp-Profil von Docker die User-Namespaces, danach etwas beim Mount
  **[Annahme: das AppArmor-Profil `docker-default` oder die Einschränkung durch
  `kernel.apparmor_restrict_unprivileged_userns = 1`; nicht getrennt gemessen]**.

**Folge (Entscheidung des CEO):**

1. R5 ausdrücklich akzeptieren und Ersatzprüfungen aus 5.13, optional S1a′ (CLI und Bash unter
   getrennten Nutzern), **oder**
2. eigenes Seccomp-Profil (Docker-Standard plus User-Namespaces) und, falls nötig, eigenes
   AppArmor-Profil für die Lauf-Container. Das lockert die Härtung des Containers an einer Stelle,
   damit die Sandbox im Container härter wird. Dafür wäre ein weiterer Messlauf nötig.

## Bericht des Skripts

Zeitpunkt: 2026-11-19T21:23:54.947Z
Image: aio-spike-lauf:sandbox (sha256:1c50ee17edf7)
CLI: 2.1.312 (Claude Code)
Docker: 29.9.3, Kernel: 7.0.0-43-generic
Gesamtergebnis: No-Go (Abweichungen)

| Prüfung | Erwartet | Beobachtet | Ergebnis |
|---|---|---|---|
| Kontrolle: Token in der Umgebung (docker exec, ohne Sandbox) | gefunden | gefunden | erwartet |
| Kontrolle: Token in /proc/1/environ (ohne Sandbox) | gefunden | gefunden | erwartet |
| Kontrolle: Token in einer Datei unter /tmp | gefunden | gefunden | erwartet |
| Probe über claude -p ausgeführt | ja | success; Probe nicht ausgeführt | ABWEICHUNG |
| [streng] Probe über claude -p ausgeführt | ja | success; Probe nicht ausgeführt | info |

### bubblewrap direkt im Container (Diagnose)

```
$ bwrap --unshare-all --proc /proc (eigenes /proc)
bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces. See <https://deb.li/bubblewrap> or <file:///usr/share/doc/bubblewrap/README.Debian.gz>.
Exit 1
$ bwrap --unshare-all --bind /proc /proc (vorhandenes /proc, wie enableWeakerNestedSandbox)
bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces. See <https://deb.li/bubblewrap> or <file:///usr/share/doc/bubblewrap/README.Debian.gz>.
Exit 1
$ bwrap --unshare-all in neuem Container mit --security-opt seccomp=unconfined
bwrap: Failed to make / slave: Permission denied
Exit 1
$ bwrap --unshare-all in neuem Container mit --security-opt apparmor=unconfined
bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces. See <https://deb.li/bubblewrap> or <file:///usr/share/doc/bubblewrap/README.Debian.gz>.
Exit 1
Host: kernel.apparmor_restrict_unprivileged_userns = 1
```

### Folge laut Plan

Go: Bash-Sandbox und Container zusammen (plan.md 5.7). No-Go: R5 ausdrücklich akzeptieren und
Ersatzprüfungen aus 5.13, optional S1a′ (CLI und Bash unter getrennten Nutzern).
