#!/usr/bin/env bash
# Spike S1a: Findet ein Bash-Prozess im Lauf-Container das setup-token? (docs/etappe-0.md 3.1)
#
# Aufruf: bash /opt/spike/probe/probe.sh <bezeichnung>
# Schreibt /work/probe-<bezeichnung>.txt (Verzeichnis per AIO_PROBE_DIR änderbar, nur für Tests). Die Datei enthält nie das Token und nie einen Fund,
# nur je Fundort „lesbar“, „Treffer ja/nein“ und die Zahl token-ähnlicher Zeichenfolgen.
#
# Verglichen wird über SHA-256: AIO_ERWARTET_SHA256 ist der Hash des Tokens. Jeder Kandidat
# (Wert einer Umgebungsvariable, Argument, Zeile einer Datei, Zeichenfolge im Muster sk-ant-…)
# wird gehasht und mit diesem Wert verglichen. Kandidaten verlassen nie die Pipeline.
set -u
export LC_ALL=C

label="${1:?Bezeichnung fehlt}"
case "$label" in
  *[!a-z0-9-]*) echo "Bezeichnung nur aus a-z, 0-9 und -" >&2; exit 2 ;;
esac
erwartet="${AIO_ERWARTET_SHA256:-}"
arbeit="${AIO_PROBE_DIR:-/work}"
out="$arbeit/probe-${label}.txt"
muster='sk-ant-[A-Za-z0-9_-]{16,}'

if [ -z "$erwartet" ]; then
  printf 'fehler\tAIO_ERWARTET_SHA256 fehlt\n' > "$out"
  exit 1
fi

# Liest Kandidaten zeilenweise von stdin. Ausgabe: "ja" oder "nein". Geprüft werden nur Zeilen,
# die ein Token sein könnten (20 bis 400 Zeichen ohne Leer- und Sonderzeichen); das hält die Zahl
# der Hash-Aufrufe klein. Ob das Format passt, zeigen die Positivkontrollen in s1a.sh.
pruefe() {
  local kandidat
  grep -aE '^[A-Za-z0-9_.+/=-]{20,400}$' | while IFS= read -r kandidat; do
    [ -n "$kandidat" ] || continue
    if [ "$(printf '%s' "$kandidat" | sha256sum | cut -d' ' -f1)" = "$erwartet" ]; then
      echo ja
      break
    fi
  done | grep -q ja && echo ja || echo nein
}

# Zahl der token-ähnlichen Zeichenfolgen auf stdin.
aehnlich() {
  grep -aoE "$muster" | wc -l | tr -d ' '
}

: > "$out"
zeile() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$out"; }

# 1. Eigene Umgebung (die des Bash-Prozesses, den das CLI startet)
env_treffer=$(env -0 | while IFS= read -r -d '' kv; do printf '%s\n' "${kv#*=}"; done | pruefe)
env_aehnlich=$(env -0 | tr '\0' '\n' | aehnlich)
zeile env ja "$env_treffer" "$env_aehnlich"

# 2. und 3. /proc/<pid>/environ und /proc/<pid>/cmdline aller sichtbaren Prozesse
sichtbar=0
environ_lesbar=0
environ_treffer=nein
environ_aehnlich=0
cmdline_lesbar=0
cmdline_treffer=nein
cmdline_aehnlich=0
claude_sichtbar=nein
for dir in /proc/[0-9]*; do
  [ -d "$dir" ] || continue
  sichtbar=$((sichtbar + 1))
  if inhalt=$( { tr '\0' '\n' < "$dir/environ"; } 2>/dev/null) && [ -n "$inhalt" ]; then
    environ_lesbar=$((environ_lesbar + 1))
    if [ "$(printf '%s\n' "$inhalt" | sed 's/^[^=]*=//' | pruefe)" = ja ]; then
      environ_treffer=ja
    fi
    environ_aehnlich=$((environ_aehnlich + $(printf '%s\n' "$inhalt" | aehnlich)))
  fi
  if inhalt=$( { tr '\0' '\n' < "$dir/cmdline"; } 2>/dev/null) && [ -n "$inhalt" ]; then
    cmdline_lesbar=$((cmdline_lesbar + 1))
    if [ "$(printf '%s\n' "$inhalt" "$(printf '%s\n' "$inhalt" | sed 's/^[^=]*=//')" | pruefe)" = ja ]; then
      cmdline_treffer=ja
    fi
    cmdline_aehnlich=$((cmdline_aehnlich + $(printf '%s\n' "$inhalt" | aehnlich)))
    case "$inhalt" in
      *claude*) claude_sichtbar=ja ;;
    esac
  fi
done
unset inhalt
zeile proc_environ "$environ_lesbar/$sichtbar" "$environ_treffer" "$environ_aehnlich"
zeile proc_cmdline "$cmdline_lesbar/$sichtbar" "$cmdline_treffer" "$cmdline_aehnlich"

# 4. Dateien unter $HOME, CLAUDE_CONFIG_DIR, /tmp und /work (ohne die eigenen Ergebnisse)
dateien=0
dateien_treffer=nein
dateien_aehnlich=0
while IFS= read -r -d '' datei; do
  case "$datei" in
    "$arbeit"/probe-*.txt) continue ;;
  esac
  [ -r "$datei" ] || continue
  dateien=$((dateien + 1))
  if [ "$( { cat "$datei"; echo; grep -aoE "$muster" "$datei"; } 2>/dev/null | pruefe)" = ja ]; then
    dateien_treffer=ja
  fi
  dateien_aehnlich=$((dateien_aehnlich + $( { aehnlich < "$datei"; } 2>/dev/null || echo 0)))
done < <(find "${HOME:-/nonexistent}" "${CLAUDE_CONFIG_DIR:-/nonexistent}" /tmp "$arbeit" \
  -xdev -type f -size -5M -print0 2>/dev/null)
zeile dateien "$dateien" "$dateien_treffer" "$dateien_aehnlich"

# Hinweise auf die Sandbox: eigener User-/PID-Namespace (bubblewrap), sichtbare Prozesse
printf 'info\tns_user\t%s\n' "$(readlink /proc/self/ns/user 2>/dev/null || echo ?)" >> "$out"
printf 'info\tns_pid\t%s\n' "$(readlink /proc/self/ns/pid 2>/dev/null || echo ?)" >> "$out"
printf 'info\tns_mnt\t%s\n' "$(readlink /proc/self/ns/mnt 2>/dev/null || echo ?)" >> "$out"
printf 'info\tprozesse_sichtbar\t%s\n' "$sichtbar" >> "$out"
printf 'info\tclaude_prozess_sichtbar\t%s\n' "$claude_sichtbar" >> "$out"
printf 'info\tuid\t%s\n' "$(id -u)" >> "$out"
printf 'ende\tok\n' >> "$out"
echo "Probe fertig: $out"
