// Bericht zu Spike S3 aus den Messwerten von messung.js (Markdown, ohne Geheimnisse).

const MIB = 2 ** 20;
const GIB = 2 ** 30;

const mib = (b) => (b === null || b === undefined ? "–" : `${(b / MIB).toFixed(0)} MiB`);
const gib = (b) => (b === null || b === undefined ? "–" : `${(b / GIB).toFixed(2)} GiB`);
const gb = (b) => (b === null || b === undefined ? "–" : `${(b / 1e9).toFixed(1)} GB`);
const sek = (s) => (s === null || s === undefined ? "–" : `${s.toFixed(1)} s`);
const proz = (x) => (x === null || x === undefined ? "–" : `${(x * 100).toFixed(1)} %`);
const zahl = (x, n = 2) => (x === null || x === undefined ? "–" : x.toFixed(n));

function median(werte) {
  const s = [...werte].sort((a, b) => a - b);
  if (s.length === 0) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const SCHRITTE = ["install", "typecheck", "lint", "format", "test"];
const ALLE_SCHRITTE = [...SCHRITTE, "install-standard"];

function durchgangZeilen(d) {
  const zeilen = [`| Klon (Wegwerf-Container) | ${sek(d.klonSekunden)} | – | – | – | – | – |`];
  for (const name of ALLE_SCHRITTE) {
    const s = d.schritte[name];
    if (s === undefined) {
      if (name !== "install-standard") zeilen.push(`| ${name} | fehlt | | | | | |`);
      continue;
    }
    const c = s.cgroup;
    zeilen.push(
      `| ${name} | ${sek(s.sekunden)} | ${s.rc === 0 ? "ok" : `rc ${String(s.rc)}`} | ${mib(c?.currentMax)} | ${mib(c?.hartMax)} | ${zahl(c?.kerne)} | ${sek(c?.gedrosseltSekunden)} |`,
    );
  }
  const c = d.cgroup;
  zeilen.push(
    `| **gesamt (Container)** | ${sek(d.sekunden)} (bis Ende Tests ${sek(d.pflichtSekunden)}) | exit ${String(d.exitCode)} | ${mib(c?.peak)} | ${mib(c?.hartMax)} | ${zahl(c?.kerne)} | ${sek(c?.gedrosseltSekunden)} |`,
  );
  return zeilen;
}

export function bericht(e) {
  const m = e.meta;
  const z = [];
  z.push("# Spike S3 – Statik: Bericht aus aio-dev", "");
  z.push(
    `Messung ${e.beginn} bis ${e.ende ?? "?"} (UTC) mit \`spikes/vm/s3/messung.js\`. Plan: docs/etappe-0.md Kap. 3.3.`,
    "",
  );
  z.push("## Umgebung", "");
  z.push("| Wert | |", "|---|---|");
  z.push(
    `| VM | ${String(m.vcpus)} vCPUs (${m.cpu}), RAM ${gib(m.memTotal)}, Swap ${gib(m.swapTotal)} |`,
  );
  z.push(`| Kernel, Docker, cgroup-Treiber | ${m.kernel}, ${m.docker}, ${m.cgroupTreiber} |`);
  z.push(`| Platte / | ${gb(m.plattegesamt)} gesamt, vorher frei ${gb(m.plattefreiVorher)} |`);
  z.push(
    `| RAM vor der Messung | verfügbar ${gib(m.memVerfuegbarVorher)}, also belegt ${gib(m.memTotal - m.memVerfuegbarVorher)} (OS, Supervisor, Office, Docker) |`,
  );
  z.push(`| Lauf-Image | \`${m.image}\`, CLI ${m.cli} |`);
  z.push(`| Supervisor / Office | \`${m.supervisor}\` / \`${String(m.office)}\` |`);
  z.push(
    `| Werkbank-Limits | RAM ${gib(m.werkbank.memoryBytes)}, CPUs ${String(m.werkbank.cpus)}, PIDs ${String(m.werkbank.pids)}, Arbeitsbereich ${String(m.werkbank.workspaceMiB)} MiB, /tmp ${String(m.werkbank.tmpMiB)} MiB, /home/agent ${String(m.werkbank.homeMiB)} MiB |`,
  );
  z.push(
    `| Admission heute | maxWorkplaces ${String(m.maxWorkplaces)}, minFreeBytes ${gb(m.minFreeBytes)} |`,
  );
  z.push(
    `| Echte Läufe während der Messung | vorher ${String(m.echteLaeufeVorher)}, nachher ${String(m.echteLaeufeNachher)} |`,
  );
  z.push("");

  if (e.s3a !== null) {
    z.push("## S3a – Lauf-Container mit CLI", "");
    const g = e.s3a.grundlast;
    z.push(
      `Grundlast (Startprozess \`tini → node start.ts → sleep 8\`, Limits der Werkbank): RAM-Spitze ${mib(g.cgroup?.peak)}, davon nicht freigebbar ${mib(g.cgroup?.hartMax)}, CPU ${sek(g.cgroup?.cpuSekunden)}.`,
      "",
    );
    z.push(
      "| Lauf | exit | Anlegen | bis `system/init` | bis Ergebnis | Bash-Aufrufe | Ergebnis | Kosten USD | RAM-Spitze | nicht freigebbar | CPU-Zeit | Rohprotokoll |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|",
    );
    e.s3a.haiku.forEach((h, i) => {
      z.push(
        `| ${String(i + 1)} | ${String(h.exitCode)} | ${sek(h.anlegenSekunden)} | ${sek(h.bisInit)} | ${sek(h.ergebnis?.sekunden)} | ${String(h.bashAufrufe)} | ${h.ergebnis?.subtype ?? "–"} | ${String(h.ergebnis?.kostenUsd ?? "–")} | ${mib(h.cgroup?.peak)} | ${mib(h.cgroup?.hartMax)} | ${sek(h.cgroup?.cpuSekunden)} | ${String(h.rohprotokollBytes)} B |`,
      );
    });
    for (const h of e.s3a.haiku) {
      if (h.stderr) z.push("", "```", h.stderr, "```");
    }
    z.push("");
  }

  if (e.s3b.length > 0) {
    z.push("## S3b – Werkbank-Last ohne LLM", "");
    z.push(
      "Spalten: Dauer, Ergebnis, RAM-Spitze im Abschnitt (memory.current), davon nicht freigebbar (anon + shmem + kernel), mittlere Kerne, Zeit gedrosselt durch das CPU-Limit.",
      "",
    );
    for (const d of e.s3b) {
      z.push(
        `### ${d.bezeichnung === "kalt" ? "Kalt (leerer Registry-Cache)" : "Warm (gefüllter Cache)"}`,
        "",
      );
      z.push(
        `Commit ${d.kopf.slice(0, 7)}, \`pnpm store path\` ohne Angabe: \`${d.storePfad}\`${d.storeArg ? `, gemessen mit \`${d.storeArg}\`` : ""}, \`nproc\` im Container: ${d.nproc}.`,
        "",
      );
      z.push(
        "| Schritt | Dauer | Ergebnis | RAM-Spitze | nicht freigebbar | Kerne | gedrosselt |",
        "|---|---|---|---|---|---|---|",
        ...durchgangZeilen(d),
        "",
      );
      const du = Object.entries(d.du)
        .map(([p, b]) => `\`${p}\` ${mib(b)}`)
        .join(", ");
      z.push(
        `Platte: Arbeitsbereich belegt ${mib(d.arbeitsbereichBelegt)} (Dateisystem); je Pfad: ${du}.`,
        "",
      );
      if (d.duStandard) {
        const std = Object.entries(d.duStandard)
          .map(([p, b]) => `\`${p}\` ${mib(b)}`)
          .join(", ");
        z.push(
          `Zusatzschritt \`install-standard\` (pnpm ohne \`--store-dir\`, wie ein Agent es aufruft): danach ${std}. \`/home/agent\` und \`/tmp\` sind tmpfs und zählen zum RAM des Containers.`,
          "",
        );
      }
      z.push(
        `I/O des Containers: gelesen ${mib(d.cgroup?.lesenBytes)}, geschrieben ${mib(d.cgroup?.schreibenBytes)}.`,
        "",
      );
      for (const name of ALLE_SCHRITTE) {
        const s = d.schritte[name];
        if (s !== undefined && s.rc !== 0) {
          z.push(`Ende des Protokolls von \`${name}\`:`, "", "```", s.logEnde, "```", "");
        }
      }
    }
  }

  if (e.s3c.length > 0) {
    z.push("## S3c – Parallelität (warm)", "");
    z.push(
      "| n | alle ok | Dauer Median | Dauer max | RAM-Spitze je Lauf (max) | Summe RAM-Spitzen | Host: RAM verfügbar min | CPU belegt | iowait | steal | PSI cpu some | PSI io some | PSI mem some | Swap max |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    );
    for (const r of e.s3c) {
      if (r.uebersprungen) {
        z.push(`| ${String(r.n)} | ${r.uebersprungen} | | | | | | | | | | | | |`);
        continue;
      }
      const dauer = r.durchgaenge.map((d) => d.pflichtSekunden);
      const spitzen = r.durchgaenge.map((d) => d.cgroup?.peak ?? 0);
      const fehler = r.durchgaenge.flatMap((d) =>
        SCHRITTE.filter((s) => d.schritte[s]?.rc !== 0).map((s) => `${d.bezeichnung} ${s}`),
      );
      const ok = fehler.length === 0 && r.durchgaenge.every((d) => d.exitCode === 0);
      const h = r.host;
      z.push(
        `| ${String(r.n)} | ${ok ? "ja" : `nein (${fehler.join(", ") || "exit"})`} | ${sek(median(dauer))} | ${sek(Math.max(...dauer))} | ${mib(Math.max(...spitzen))} | ${mib(spitzen.reduce((a, b) => a + b, 0))} | ${gib(h?.verfuegbarMin)} | ${proz(h?.cpuBelegt)} | ${proz(h?.iowait)} | ${proz(h?.steal)} | ${proz(h?.psiCpuSome)} | ${proz(h?.psiIoSome)} | ${proz(h?.psiMemSome)} | ${mib(h?.swapBelegtMax)} |`,
      );
    }
    z.push("");
    z.push("Dauer je Schritt (Median über die Läufe der Runde):", "");
    z.push(
      "| n | Klon | install | typecheck | lint | format | test |",
      "|---|---|---|---|---|---|---|",
    );
    for (const r of e.s3c) {
      if (!r.durchgaenge) continue;
      const spalte = (name) =>
        sek(
          median(
            r.durchgaenge.map((d) => d.schritte[name]?.sekunden ?? NaN).filter(Number.isFinite),
          ),
        );
      z.push(
        `| ${String(r.n)} | ${sek(median(r.durchgaenge.map((d) => d.klonSekunden)))} | ${SCHRITTE.map(spalte).join(" | ")} |`,
      );
    }
    z.push("");
  }

  if (e.s3d !== null) {
    const p = e.s3d.platte;
    z.push("## S3d – Plattenhaushalt", "");
    z.push(
      `Lauf-Image: ${mib(p.imageBytes)}. Docker-Logs: \`${JSON.stringify(p.dockerLogOpts)}\` je Container. ${p.journal}`,
      "",
    );
    z.push("| Pfad | Größe |", "|---|---|");
    for (const [pfad, b] of Object.entries(p.groessen)) z.push(`| \`${pfad}\` | ${mib(b)} |`);
    z.push("");
    const r = p.rohprotokolle;
    z.push(
      `Rohprotokolle echter Läufe in \`runs.dataDir\`: ${String(r.anzahl)} Läufe, Median ${mib(r.median)}, Maximum ${mib(r.max)}; Obergrenze stdout ${mib(r.grenzeBytes)}, stderr ${mib(r.stderrGrenzeBytes)}, Aufbewahrung ${String(r.aufbewahrungTage)} Tage.`,
      "",
    );
    z.push("`docker system df`:", "", "```", p.systemDf, "```", "");
    z.push("Images:", "", "```", p.images, "```", "");
    const db = e.s3d.db;
    if (db.echt) {
      z.push(
        `Office-DB echt: ${mib(db.echt.dateiBytes)} (+ WAL ${mib(db.echt.walBytes)}), ${String(db.echt.ereignisse)} Ereignisse aus ${String(db.echt.laeufeMitEreignissen)} Läufen (${db.echt.von ?? "–"} bis ${db.echt.bis ?? "–"}), Payload zusammen ${mib(db.echt.payloadBytes)}. Tabellen: ${db.echt.tabellen.join(", ")}.`,
        "",
      );
      z.push("| Typ | Anzahl | mittlere Payload |", "|---|---|---|");
      for (const t of db.echt.typen)
        z.push(`| ${t.type} | ${String(t.n)} | ${zahl(t.mittel, 0)} B |`);
      z.push("");
    }
    if (db.audit) {
      z.push(
        `Audit-DB: ${mib(db.audit.dateiBytes)}, ${String(db.audit.eintraege)} Einträge, ${String(db.audit.laeufe)} × \`run.prepared\`. Häufigste Arten: ${db.audit.arten.map((a) => `${a.kind} ${String(a.n)}`).join(", ")}.`,
        "",
      );
    }
    if (db.synthetisch) {
      z.push(
        `Office-DB synthetisch (${db.synthetisch.vorlage}): ${db.synthetisch.punkte.map((x) => `${String(x.ereignisse)} Ereignisse ${mib(x.bytes)}`).join(", ")}; **${zahl(db.synthetisch.bytesJeEreignis, 0)} Bytes je Ereignis**, ${sek(db.synthetisch.sekunden)}.`,
        "",
      );
    }
  }

  if (e.statik !== null) {
    const s = e.statik;
    z.push("## Statik (Formel aus Kap. 3.3)", "");
    z.push("| Grenze | Rechnung | Ergebnis |", "|---|---|---|");
    z.push(
      `| RAM | ⌊(${gib(m.memTotal)} − ${gib(s.reserveRam)}) / ${mib(s.ramSpitzeJeLauf)}⌋ | **${String(s.grenzeRam)}** |`,
    );
    z.push(
      `| RAM nur nicht freigebbar (Info) | ⌊(${gib(m.memTotal)} − ${gib(s.reserveRam)}) / ${mib(s.ramHartJeLauf)}⌋ | ${String(s.grenzeRamHart)} |`,
    );
    z.push(
      `| Platte | ⌊(${gb(m.plattefreiVorher)} − ${gb(s.reservePlatte)}) / ${mib(s.plattenJeLauf)}⌋ (Arbeitsbereich belegt + Rohprotokoll-Grenze) | **${String(s.grenzePlatte)}** |`,
    );
    z.push(
      `| Platte, Arbeitsbereich ganz voll (Info) | ⌊(${gb(m.plattefreiVorher)} − ${gb(s.reservePlatte)}) / (${String(m.werkbank.workspaceMiB)} MiB + Rohprotokoll-Grenze)⌋ | ${String(s.grenzePlatteArbeitsbereichVoll)} |`,
    );
    z.push(
      `| CPU | größtes getestetes n mit Median ≤ ${String(s.cpuFaktor)} × Einzellauf [Vorschlag] | **${String(s.grenzeCpu)}**${s.cpuGrenzeNurUntergrenze ? ` (getestet bis ${String(s.cpuGetestetBis)}, also mindestens)` : ""} |`,
    );
    z.push(`| **Statik** | Minimum | **${String(s.statik)}**${s.noGo ? " – No-Go (< 2)" : ""} |`);
    z.push("");
  }
  return `${z.join("\n")}\n`;
}
