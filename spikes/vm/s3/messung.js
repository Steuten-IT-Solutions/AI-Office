// Spike S3 – Statik (docs/etappe-0.md Kap. 3.3) in der VM aio-dev.
//
// Zweck: messen, wie viel RAM, CPU und Platte ein Lauf braucht, und daraus die Statik ableiten,
// also wie viele Läufe gleichzeitig laufen dürfen (plan.md Kap. 5.6, Admission `maxWorkplaces`).
//
// Die Messung nutzt die Bausteine des installierten Supervisors (`/opt/aio-supervisor/current`):
// `createArgs` und `prepArgs` (Härtung, Limits, Mounts wie ein echter Lauf), `claudeArgs` (CLI-Aufruf
// eines Laufs), den Egress-Proxy mit Registry-Cache und das Skript für die Arbeitsbereiche
// (eigenes ext4-Dateisystem je Lauf). Sie läuft aber neben dem Supervisor, nicht durch ihn: eigene
// Netze (10.214.0.0/16), eigene Arbeitsbereiche unter /opt/aio-spikes/s3/arbeit, eigener
// Registry-Cache, Container ohne das Label `aio.lauf`. So ändert der Spike nichts am Betrieb, und
// der Abgleich des Supervisors nach einem Neustart (E42) fasst nichts davon an.
//
// Läuft als root (über s3.sh). Gibt nie ein Token aus.
//
// Teile:
//   S3a  Grundlast des Lauf-Containers (Startprozess ohne CLI) und 3 kurze `haiku`-Läufe
//   S3b  Werkbank ohne LLM: Klon, pnpm install über den Registry-Cache, Typecheck, Lint, Format,
//        Tests; einmal mit leerem Cache (kalt), einmal mit gefülltem (warm, zugleich S3c n=1)
//   S3c  dasselbe 2, 4 und 6 Mal gleichzeitig (warm)
//   S3d  Plattenhaushalt und Wachstum der Office-DB (synthetisch)

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const umgebung = process.env;
const S3 = umgebung.AIO_S3_DIR ?? "/opt/aio-spikes/s3";
const BERICHTE = umgebung.AIO_S3_BERICHTE ?? "/opt/aio-spikes/berichte";
const KONFIG = umgebung.AIO_S3_KONFIG ?? "/etc/aio/supervisor.json";
const SUPERVISOR = realpathSync(umgebung.AIO_S3_SUPERVISOR ?? "/opt/aio-supervisor/current");
const OFFICE = umgebung.AIO_S3_OFFICE ?? "/opt/aio-office/current";
const ARBEITSBEREICH_SKRIPT =
  umgebung.AIO_S3_ARBEITSBEREICH ?? "/usr/local/sbin/aio-arbeitsbereich";
const OFFICE_DB = umgebung.AIO_S3_OFFICE_DB ?? "/var/lib/aio-office/office.db";
const PARALLEL = (umgebung.AIO_S3_PARALLEL ?? "2,4,6,8").split(",").map(Number);
const HAIKU_LAEUFE = Number(umgebung.AIO_S3_HAIKU ?? "3");
const TEILE = new Set((umgebung.AIO_S3_TEILE ?? "a,b,c,d").split(","));
const REPO = "Steuten-IT-Solutions/AI-Office";

// Reserve aus etappe-0.md Kap. 3.3 [Annahme]: 3 GB RAM, 20 GB Platte.
const RESERVE_RAM = 3 * 1024 ** 3;
const RESERVE_PLATTE = 20 * 1000 ** 3;
// CPU-Grenze [Vorschlag]: so viele gleichzeitige Läufe, wie der Median der Dauer höchstens das
// 1,5-Fache des Einzellaufs beträgt.
const CPU_FAKTOR = 1.5;
const GIB = 1024 ** 3;

const ARBEIT = join(S3, "arbeit");
const LAEUFE = join(S3, "laeufe");
const CACHE = join(S3, "registry");

// --- Bausteine des Supervisors ----------------------------------------------------------------

const src = join(SUPERVISOR, "packages/supervisor/src");
const laden = (datei) => import(pathToFileURL(join(src, datei)).href);
const { loadConfig } = await laden("config.ts");
const spec = await laden("runs/spec.ts");
const cli = await laden("runs/cli.ts");
const { EgressProxy } = await laden("egress/proxy.ts");
const { RegistryCache } = await laden("egress/registry.ts");
const { tokenDigest } = await laden("egress/anthropic.ts");
const { createLogger } = await laden("logger.ts");

const konfig = loadConfig(KONFIG, { uid: 0 });
if (konfig.runs === null || konfig.egress === null) {
  throw new Error(`${KONFIG} braucht die Abschnitte runs und egress`);
}
const runs = konfig.runs;
const AUDIT_DB = umgebung.AIO_S3_AUDIT_DB ?? konfig.auditDbPath;
const egress = konfig.egress;
const werkbank = runs.types.werkbank;
const quelleName = Object.keys(runs.repos).find((r) => r.toLowerCase() === REPO.toLowerCase());
const quelle = quelleName === undefined ? null : runs.repos[quelleName];

// --- Hilfen ------------------------------------------------------------------------------------

const jetzt = () => Date.now() / 1000;
const zeit = () => new Date().toISOString().slice(11, 19);
const info = (text) => console.log(`\n== ${zeit()} ${text}`);
const notiz = (text) => console.log(`   ${text}`);
const maske = (text) => text.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-***");
const median = (werte) => {
  const s = [...werte].sort((a, b) => a - b);
  if (s.length === 0) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const max = (werte) => (werte.length === 0 ? null : Math.max(...werte));
const lauId = () => `r-${randomBytes(8).toString("hex")}`;

/** Führt einen Befehl aus. stdout höchstens 16 MiB im Speicher (oder in eine Datei). */
function ausfuehren(befehl, args, optionen = {}) {
  return new Promise((resolve) => {
    const t0 = jetzt();
    const kind = spawn(befehl, args, {
      env: optionen.env ?? umgebung,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const zeilen = [];
    let rest = "";
    const datei = optionen.stdoutDatei ? createWriteStream(optionen.stdoutDatei) : null;
    let bytes = 0;
    kind.stdout.on("data", (stueck) => {
      bytes += stueck.length;
      if (datei !== null) datei.write(stueck);
      if (optionen.zeilen) {
        rest += stueck.toString("utf8");
        let i;
        while ((i = rest.indexOf("\n")) >= 0) {
          zeilen.push({ t: jetzt(), text: rest.slice(0, i) });
          rest = rest.slice(i + 1);
        }
      } else if (stdout.length < 16 * 1024 * 1024) {
        stdout += stueck.toString("utf8");
      }
    });
    kind.stderr.on("data", (stueck) => {
      if (stderr.length < 1024 * 1024) stderr += stueck.toString("utf8");
    });
    const timer =
      optionen.timeoutMs === undefined
        ? null
        : setTimeout(() => kind.kill("SIGKILL"), optionen.timeoutMs);
    kind.on("error", (fehler) => {
      stderr += String(fehler);
    });
    kind.on("close", (code) => {
      if (timer !== null) clearTimeout(timer);
      if (rest !== "") zeilen.push({ t: jetzt(), text: rest });
      const fertig = () =>
        resolve({ code, stdout, stderr: maske(stderr), zeilen, bytes, sekunden: jetzt() - t0 });
      if (datei !== null) datei.end(fertig);
      else fertig();
    });
    kind.stdin.on("error", () => {});
    if (optionen.eingabe !== undefined) kind.stdin.end(optionen.eingabe);
    else kind.stdin.end();
  });
}

async function docker(args, optionen = {}) {
  return ausfuehren(runs.dockerPath, args, optionen);
}

async function dockerPflicht(args, optionen = {}) {
  const r = await docker(args, optionen);
  if (r.code !== 0) {
    throw new Error(
      `docker ${args[0]} endete mit ${String(r.code)}: ${r.stderr.trim().slice(0, 400)}`,
    );
  }
  return r;
}

/** Bytes, die `du` für die Pfade zählt (ohne andere Dateisysteme). Fehlt ein Pfad: null. */
async function du(pfade) {
  const ergebnis = {};
  for (const pfad of pfade) {
    if (!existsSync(pfad)) {
      ergebnis[pfad] = null;
      continue;
    }
    const r = await ausfuehren("du", ["-sbx", pfad], { timeoutMs: 600_000 });
    const zahl = Number(r.stdout.split("\t")[0]);
    ergebnis[pfad] = Number.isFinite(zahl) && r.stdout !== "" ? zahl : null;
  }
  return ergebnis;
}

function belegt(pfad) {
  const s = statfsSync(pfad);
  return (s.blocks - s.bfree) * s.bsize;
}

function frei(pfad) {
  const s = statfsSync(pfad);
  return s.bavail * s.bsize;
}

function meminfo() {
  const werte = {};
  for (const zeile of readFileSync("/proc/meminfo", "utf8").split("\n")) {
    const m = /^(\w+):\s+(\d+)/.exec(zeile);
    if (m) werte[m[1]] = Number(m[2]) * 1024;
  }
  return werte;
}

// --- Messung über cgroup v2 -------------------------------------------------------------------

function cgroupVon(id) {
  for (const pfad of [
    `/sys/fs/cgroup/system.slice/docker-${id}.scope`,
    `/sys/fs/cgroup/docker/${id}`,
  ]) {
    if (existsSync(join(pfad, "memory.current"))) return pfad;
  }
  return null;
}

function schluesselwerte(text) {
  const werte = {};
  for (const zeile of text.split("\n")) {
    const [k, v] = zeile.split(" ");
    if (k && v !== undefined) werte[k] = Number(v);
  }
  return werte;
}

/** Tastet die cgroup eines Containers alle 200 ms ab, solange sie existiert. */
class Abtaster {
  constructor(id) {
    this.id = id;
    this.dir = null;
    this.proben = [];
    this.timer = setInterval(() => this.tasten(), 200);
  }

  tasten() {
    this.dir ??= cgroupVon(this.id);
    if (this.dir === null) return;
    try {
      const lies = (datei) => readFileSync(join(this.dir, datei), "utf8");
      const mem = schluesselwerte(lies("memory.stat"));
      const cpu = schluesselwerte(lies("cpu.stat"));
      let rbytes = 0;
      let wbytes = 0;
      for (const zeile of lies("io.stat").split("\n")) {
        rbytes += Number(/rbytes=(\d+)/.exec(zeile)?.[1] ?? 0);
        wbytes += Number(/wbytes=(\d+)/.exec(zeile)?.[1] ?? 0);
      }
      this.proben.push({
        t: jetzt(),
        current: Number(lies("memory.current")),
        peak: Number(lies("memory.peak")),
        anon: mem.anon ?? 0,
        file: mem.file ?? 0,
        shmem: mem.shmem ?? 0,
        kernel: mem.kernel ?? 0,
        cpuUsec: cpu.usage_usec ?? 0,
        throttledUsec: cpu.throttled_usec ?? 0,
        rbytes,
        wbytes,
      });
    } catch {
      // Die cgroup verschwindet mit dem Container.
    }
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Kennzahlen zwischen t0 und t1 (Standard: alles). */
  zusammenfassen(t0 = 0, t1 = Infinity) {
    const p = this.proben.filter((x) => x.t >= t0 && x.t <= t1);
    if (p.length === 0) return null;
    const erste = p[0];
    const letzte = p[p.length - 1];
    const dauer = letzte.t - erste.t;
    const cpu = (letzte.cpuUsec - erste.cpuUsec) / 1e6;
    return {
      proben: p.length,
      // memory.peak zählt seit dem Start des Containers; im Abschnitt zählt nur das Maximum der Proben.
      peak: t0 === 0 ? letzte.peak : max(p.map((x) => x.current)),
      currentMax: max(p.map((x) => x.current)),
      // Nicht freigebbar: anonymer Speicher, tmpfs (shmem) und Kernel. Der Seiten-Cache (file)
      // zählt zum Limit, lässt sich aber zurückholen.
      hartMax: max(p.map((x) => x.anon + x.shmem + x.kernel)),
      anonMax: max(p.map((x) => x.anon)),
      shmemMax: max(p.map((x) => x.shmem)),
      fileMax: max(p.map((x) => x.file)),
      cpuSekunden: cpu,
      kerne: dauer > 0 ? cpu / dauer : null,
      gedrosseltSekunden: (letzte.throttledUsec - erste.throttledUsec) / 1e6,
      lesenBytes: letzte.rbytes - erste.rbytes,
      schreibenBytes: letzte.wbytes - erste.wbytes,
    };
  }
}

/** Tastet den Host jede Sekunde ab: CPU-Zeiten, PSI, verfügbarer Speicher. */
class HostAbtaster {
  constructor() {
    this.proben = [];
    this.tasten();
    this.timer = setInterval(() => this.tasten(), 1000);
  }

  tasten() {
    const cpu = readFileSync("/proc/stat", "utf8").split("\n")[0].split(/\s+/).slice(1).map(Number);
    const psi = {};
    for (const art of ["cpu", "io", "memory"]) {
      try {
        const text = readFileSync(`/proc/pressure/${art}`, "utf8");
        psi[art] = {
          some: Number(/some .*total=(\d+)/.exec(text)?.[1] ?? 0),
          full: Number(/full .*total=(\d+)/.exec(text)?.[1] ?? 0),
        };
      } catch {
        psi[art] = { some: 0, full: 0 };
      }
    }
    const mem = meminfo();
    this.proben.push({
      t: jetzt(),
      cpu,
      psi,
      verfuegbar: mem.MemAvailable,
      swapBelegt: (mem.SwapTotal ?? 0) - (mem.SwapFree ?? 0),
    });
  }

  stop() {
    clearInterval(this.timer);
  }

  zusammenfassen(t0, t1) {
    const p = this.proben.filter((x) => x.t >= t0 - 1 && x.t <= t1 + 1);
    if (p.length < 2) return null;
    const a = p[0];
    const b = p[p.length - 1];
    const d = b.cpu.map((v, i) => v - a.cpu[i]);
    // /proc/stat: user nice system idle iowait irq softirq steal guest guest_nice
    const summe = d.slice(0, 8).reduce((x, y) => x + y, 0) || 1;
    const sekunden = b.t - a.t;
    const anteil = (art, feld) => (b.psi[art][feld] - a.psi[art][feld]) / 1e6 / sekunden;
    return {
      sekunden,
      cpuBelegt: 1 - (d[3] + d[4]) / summe,
      iowait: d[4] / summe,
      steal: d[7] / summe,
      psiCpuSome: anteil("cpu", "some"),
      psiIoSome: anteil("io", "some"),
      psiIoFull: anteil("io", "full"),
      psiMemSome: anteil("memory", "some"),
      verfuegbarMin: Math.min(...p.map((x) => x.verfuegbar)),
      swapBelegtMax: Math.max(...p.map((x) => x.swapBelegt)),
    };
  }
}

// --- Ressourcen eines Messlaufs -----------------------------------------------------------------

const offen = new Set();
let netzNummer = 0;

function netz() {
  const i = netzNummer++;
  const basis = `10.214.${String(i >> 4)}.`;
  const unten = (i & 15) << 4;
  return {
    cidr: `${basis}${String(unten)}/28`,
    gateway: `${basis}${String(unten + 1)}`,
    container: `${basis}${String(unten + 2)}`,
  };
}

const arbeitsbereichUmgebung = { ...umgebung, AIO_ARBEIT_BASIS: ARBEIT };

class Messlauf {
  constructor(art) {
    this.id = lauId();
    this.art = art;
    this.name = `s3-${this.id}`;
    this.netz = null;
    this.listener = null;
    this.arbeitsbereich = null;
    this.container = false;
    this.eingabe = join(LAEUFE, this.id, "eingabe");
    offen.add(this);
  }

  async vorbereiten(proxy, { registryOnly }) {
    mkdirSync(this.eingabe, { recursive: true, mode: 0o755 });
    chmodSync(join(LAEUFE, this.id), 0o755);
    chmodSync(this.eingabe, 0o755);
    copyFileSync(runs.proxyCaPath, join(this.eingabe, "proxy-ca.crt"));
    chmodSync(join(this.eingabe, "proxy-ca.crt"), 0o644);
    this.datei("mcp.json", `${JSON.stringify({ mcpServers: {} })}\n`);
    this.datei("git.conf", spec.PREP_GIT_CONFIG_CONTENT);

    const r = await ausfuehren(
      ARBEITSBEREICH_SKRIPT,
      ["anlegen", `${String(werkbank.workspaceMiB)}-${this.id}`],
      { env: arbeitsbereichUmgebung },
    );
    if (r.code !== 0) throw new Error(`Arbeitsbereich: ${r.stderr.trim()}`);
    this.arbeitsbereich = join(ARBEIT, this.id);

    this.netz = netz();
    await dockerPflicht([
      "network",
      "create",
      "--internal",
      "--driver",
      "bridge",
      "--subnet",
      this.netz.cidr,
      "--gateway",
      this.netz.gateway,
      this.name,
    ]);
    this.listener = await proxy.listen(this.netz.gateway, egress.port, { registryOnly });
  }

  datei(name, inhalt) {
    writeFileSync(join(this.eingabe, name), inhalt, { mode: 0o644 });
    chmodSync(join(this.eingabe, name), 0o644);
  }

  /** Klon wie `prepareCheckout` des Supervisors: Wegwerf-Container ohne Netz. */
  async klonen() {
    const git = (gitArgs) =>
      docker(
        spec.prepArgs({
          image: runs.image,
          source: quelle,
          gitConfig: join(this.eingabe, "git.conf"),
          workspace: this.arbeitsbereich,
          gitArgs,
        }),
        { timeoutMs: 300_000 },
      );
    const r = await git([
      "clone",
      "--quiet",
      "--no-hardlinks",
      "--branch",
      "main",
      "/aio/quelle.git",
      cli.CONTAINER_PATHS.repo,
    ]);
    if (r.code !== 0) throw new Error(`Klon: ${r.stderr.trim().slice(0, 400)}`);
    const kopf = await git(["-C", cli.CONTAINER_PATHS.repo, "rev-parse", "HEAD"]);
    return { sekunden: r.sekunden, kopf: kopf.stdout.trim() };
  }

  /** Container wie `createArgs` eines Laufs, nur mit eigenem Namen und ohne Label `aio.lauf`. */
  async anlegen({ env, workdir, befehl, geheim }) {
    const args = spec.createArgs({
      runId: this.id,
      image: runs.image,
      network: this.name,
      ipAddress: this.netz.container,
      limits: werkbank,
      workspace: this.arbeitsbereich,
      input: this.eingabe,
      managedSettingsDir: runs.managedSettingsDir,
      doku: null,
      workdir,
      stopTimeoutSeconds: 10,
      env: {
        AIO_LAUF_ID: this.id,
        AIO_LEASE_SEKUNDEN: String(werkbank.leaseSeconds),
        AIO_STOPP_STUFE_SEKUNDEN: String(runs.stopStageSeconds),
        AIO_BUNDLE_SEKUNDEN: String(runs.bundleSeconds),
        AIO_AUSGABE: cli.CONTAINER_PATHS.output,
        HTTPS_PROXY: `http://${this.netz.gateway}:${String(egress.port)}`,
        NO_PROXY: this.netz.gateway,
        NODE_EXTRA_CA_CERTS: cli.CONTAINER_PATHS.proxyCa,
        ...env,
      },
      secretEnv: geheim ? ["CLAUDE_CODE_OAUTH_TOKEN"] : [],
      command: befehl,
    });
    const n = args.indexOf("--name");
    args[n + 1] = this.name;
    const l = args.indexOf("--label");
    if (l >= 0) args.splice(l, 2);
    const r = await dockerPflicht(args, { env: geheim ? geheimeUmgebung() : umgebung });
    this.container = true;
    return r.stdout.trim();
  }

  async starten(eingabe, stdoutDatei) {
    return docker(["start", "--attach", "--interactive", this.name], {
      eingabe,
      zeilen: true,
      stdoutDatei,
      timeoutMs: (werkbank.leaseSeconds + 120) * 1000,
    });
  }

  async abbauen() {
    const probleme = [];
    if (this.container) {
      const r = await docker(["rm", "-f", this.name]);
      if (r.code !== 0) probleme.push(`Container: ${r.stderr.trim()}`);
      this.container = false;
    }
    if (this.listener !== null) {
      await this.listener.close();
      this.listener = null;
    }
    if (this.netz !== null) {
      const r = await docker(["network", "rm", this.name]);
      if (r.code !== 0) probleme.push(`Netz: ${r.stderr.trim()}`);
      this.netz = null;
    }
    if (this.arbeitsbereich !== null) {
      const r = await ausfuehren(
        ARBEITSBEREICH_SKRIPT,
        ["entfernen", `${String(werkbank.workspaceMiB)}-${this.id}`],
        { env: arbeitsbereichUmgebung },
      );
      if (r.code !== 0) probleme.push(`Arbeitsbereich: ${r.stderr.trim()}`);
      this.arbeitsbereich = null;
    }
    rmSync(join(LAEUFE, this.id), { recursive: true, force: true });
    offen.delete(this);
    if (probleme.length > 0) notiz(`Aufräumen ${this.id}: ${probleme.join("; ")}`);
  }
}

let token = null;
function geheimeUmgebung() {
  token ??= readFileSync(egress.tokenPath, "utf8").trim();
  return { ...umgebung, CLAUDE_CODE_OAUTH_TOKEN: token };
}

async function allesAufraeumen() {
  for (const lauf of [...offen]) {
    try {
      await lauf.abbauen();
    } catch (fehler) {
      notiz(`Aufräumen ${lauf.id}: ${String(fehler)}`);
    }
  }
}

/** Reste eines abgebrochenen Spikes: Container und Netze `s3-r-…`, Arbeitsbereiche. */
async function resteEntfernen() {
  const c = await docker(["ps", "-aq", "--filter", "name=^s3-r-"]);
  for (const id of c.stdout.split("\n").filter(Boolean)) await docker(["rm", "-f", id]);
  const n = await docker(["network", "ls", "-q", "--filter", "name=^s3-r-"]);
  for (const id of n.stdout.split("\n").filter(Boolean)) await docker(["network", "rm", id]);
  await ausfuehren(ARBEITSBEREICH_SKRIPT, ["aufraeumen"], { env: arbeitsbereichUmgebung });
  rmSync(LAEUFE, { recursive: true, force: true });
  mkdirSync(LAEUFE, { recursive: true, mode: 0o755 });
  chmodSync(LAEUFE, 0o755);
}

async function echteLaeufe() {
  const r = await docker(["ps", "-q", "--filter", `label=${spec.RUN_LABEL}`]);
  return r.stdout.split("\n").filter(Boolean).length;
}

// --- S3a: Lauf-Container mit CLI ----------------------------------------------------------------

const PROMPT_S3A =
  "Führe mit dem Werkzeug Bash genau einmal den Befehl `ls -la /work` aus. Antworte danach nur mit OK.";

function streamAuswerten(zeilen, t0) {
  let init = null;
  let ergebnis = null;
  let bash = 0;
  let rateLimit = null;
  for (const { t, text } of zeilen) {
    let e;
    try {
      e = JSON.parse(text);
    } catch {
      continue;
    }
    if (e.type === "system" && e.subtype === "init" && init === null) init = t - t0;
    if (e.type === "assistant") {
      for (const teil of e.message?.content ?? []) {
        if (teil.type === "tool_use" && teil.name === "Bash") bash++;
      }
    }
    if (e.type === "rate_limit_event") rateLimit = e.rate_limit_info?.status ?? "?";
    if (e.type === "result") {
      ergebnis = {
        sekunden: t - t0,
        subtype: e.subtype,
        isError: e.is_error,
        turns: e.num_turns,
        kostenUsd: e.total_cost_usd,
        dauerMsCli: e.duration_ms,
      };
    }
  }
  return { init, ergebnis, bash, rateLimit };
}

async function s3aGrundlast() {
  const lauf = new Messlauf("s3a-grundlast");
  try {
    await lauf.vorbereiten(proxy, { registryOnly: true });
    const id = await lauf.anlegen({
      env: {},
      workdir: cli.CONTAINER_PATHS.work,
      befehl: ["sleep", "8"],
      geheim: false,
    });
    const abtaster = new Abtaster(id);
    const t0 = jetzt();
    const r = await lauf.starten(undefined);
    abtaster.stop();
    return {
      exitCode: r.code,
      sekunden: jetzt() - t0,
      stderr: r.code === 0 ? "" : r.stderr.slice(-600),
      cgroup: abtaster.zusammenfassen(),
    };
  } finally {
    await lauf.abbauen();
  }
}

async function s3aHaiku(nummer) {
  const lauf = new Messlauf("s3a-haiku");
  try {
    await lauf.vorbereiten(proxy, { registryOnly: false });
    const t00 = jetzt();
    const id = await lauf.anlegen({
      env: {},
      workdir: cli.CONTAINER_PATHS.work,
      befehl: [
        "claude",
        ...cli.claudeArgs({
          runType: "werkbank",
          model: "haiku",
          maxTurns: 3,
          maxBudgetUsd: 0.1,
          gateway: false,
          doku: false,
        }),
      ],
      geheim: true,
    });
    const anlegenSekunden = jetzt() - t00;
    const abtaster = new Abtaster(id);
    const rohDatei = join(S3, `s3a-${String(nummer)}.jsonl`);
    const t0 = jetzt();
    const r = await lauf.starten(PROMPT_S3A, rohDatei);
    abtaster.stop();
    const stream = streamAuswerten(r.zeilen, t0);
    rmSync(rohDatei, { force: true });
    return {
      exitCode: r.code,
      anlegenSekunden,
      sekunden: jetzt() - t0,
      bisInit: stream.init,
      ergebnis: stream.ergebnis,
      bashAufrufe: stream.bash,
      rateLimit: stream.rateLimit,
      rohprotokollBytes: r.bytes,
      stderr: r.code === 0 ? "" : r.stderr.slice(-600),
      cgroup: abtaster.zusammenfassen(),
    };
  } finally {
    await lauf.abbauen();
  }
}

// --- S3b/S3c: Werkbank ohne LLM -----------------------------------------------------------------

const SKRIPT_S3B = `#!/usr/bin/env bash
# S3b im Lauf-Container: Werkbank-Last ohne LLM (etappe-0.md Kap. 3.3).
set -uo pipefail
aus=/aio/ausgabe
schritt() {
  local name=$1 t0 t1 rc
  shift
  t0=$(date +%s.%N)
  "$@" > "$aus/$name.log" 2>&1
  rc=$?
  t1=$(date +%s.%N)
  printf '%s %s %s %s\\n' "$name" "$t0" "$t1" "$rc" >> "$aus/schritte"
}
cd /work/repo
# Wohin legt pnpm seinen Speicher, wenn der Agent nichts angibt? Liegt er nicht im Arbeitsbereich,
# landet er im tmpfs (RAM) oder scheitert; dann misst der Spike mit --store-dir im Arbeitsbereich.
pnpm store path > "$aus/store-pfad" 2> "$aus/store-pfad.err"
store=$(head -n 1 "$aus/store-pfad")
case "$store" in
  /work/*) arg=() ;;
  *) arg=(--store-dir /work/.pnpm-store) ;;
esac
printf '%s\\n' "\${arg[*]:-}" > "$aus/store-arg"
schritt install pnpm install --frozen-lockfile --ignore-scripts "\${arg[@]}" --reporter=append-only
schritt typecheck pnpm typecheck
schritt lint pnpm lint
schritt format pnpm format:check
schritt test pnpm test
# Jeder Pfad für sich: du zählt harte Links sonst nur beim ersten Pfad.
for pfad in /work/repo /work/repo/node_modules /work/.pnpm-store /home/agent /tmp; do
  du -sbx "$pfad" >> "$aus/du" 2> /dev/null
done
nproc > "$aus/nproc"
# Nur im warmen Durchgang: pnpm install so, wie ein Agent es ohne Angabe aufruft. Der Speicher
# liegt dann dort, wo pnpm ihn von selbst hinlegt (oben: store-pfad).
if [ "\${S3_STANDARD:-}" = 1 ]; then
  rm -rf node_modules packages/*/node_modules spikes/*/node_modules
  schritt install-standard pnpm install --frozen-lockfile --ignore-scripts --reporter=append-only
  for pfad in /home/agent /tmp /work/repo; do
    du -sbx "$pfad" >> "$aus/du-standard" 2> /dev/null
  done
fi
`;

async function werkbankDurchgang(bezeichnung, { standard = false } = {}) {
  const lauf = new Messlauf(bezeichnung);
  try {
    await lauf.vorbereiten(proxy, { registryOnly: true });
    const klon = await lauf.klonen();
    lauf.datei("s3b.sh", SKRIPT_S3B);
    const id = await lauf.anlegen({
      env: {
        GIT_AUTHOR_NAME: "s3",
        GIT_AUTHOR_EMAIL: "s3@aio.invalid",
        GIT_COMMITTER_NAME: "s3",
        GIT_COMMITTER_EMAIL: "s3@aio.invalid",
        TZ: "UTC",
        ...(standard ? { S3_STANDARD: "1" } : {}),
        npm_config_registry: `http://${lauf.netz.gateway}:${String(egress.port)}/npm/`,
      },
      workdir: cli.CONTAINER_PATHS.repo,
      befehl: ["bash", `${cli.CONTAINER_PATHS.input}/s3b.sh`],
      geheim: false,
    });
    const abtaster = new Abtaster(id);
    const t0 = jetzt();
    const r = await lauf.starten(undefined);
    const t1 = jetzt();
    abtaster.stop();
    const aus = join(lauf.arbeitsbereich, "ausgabe");
    const lies = (datei) => {
      try {
        return readFileSync(join(aus, datei), "utf8");
      } catch {
        return "";
      }
    };
    const schritte = {};
    for (const zeile of lies("schritte").split("\n").filter(Boolean)) {
      const [name, a, b, rc] = zeile.split(" ");
      const s0 = Number(a);
      const s1 = Number(b);
      schritte[name] = {
        ende: s1,
        sekunden: s1 - s0,
        rc: Number(rc),
        cgroup: abtaster.zusammenfassen(s0, s1),
        logEnde:
          Number(rc) === 0 ? "" : maske(lies(`${name}.log`).split("\n").slice(-25).join("\n")),
      };
    }
    const duLesen = (datei) => {
      const werte = {};
      for (const zeile of lies(datei).split("\n").filter(Boolean)) {
        const [bytes, pfad] = zeile.split("\t");
        werte[pfad] = Number(bytes);
      }
      return werte;
    };
    const duWerte = duLesen("du");
    return {
      id: lauf.id,
      bezeichnung,
      kopf: klon.kopf,
      klonSekunden: klon.sekunden,
      sekunden: t1 - t0,
      // Bis zum Ende der Tests, ohne den Zusatzschritt install-standard: Vergleichswert für S3c.
      pflichtSekunden: (schritte.test?.ende ?? t1) - t0,
      exitCode: r.code,
      stderr: r.code === 0 ? "" : r.stderr.slice(-600),
      t0,
      t1,
      storePfad: lies("store-pfad").trim(),
      storeArg: lies("store-arg").trim(),
      nproc: lies("nproc").trim(),
      schritte,
      du: duWerte,
      duStandard: standard ? duLesen("du-standard") : null,
      arbeitsbereichBelegt: belegt(lauf.arbeitsbereich),
      cgroup: abtaster.zusammenfassen(),
    };
  } finally {
    await lauf.abbauen();
  }
}

const PFLICHT_SCHRITTE = ["install", "typecheck", "lint", "format", "test"];

function alleOk(durchgang) {
  return (
    durchgang.exitCode === 0 && PFLICHT_SCHRITTE.every((name) => durchgang.schritte[name]?.rc === 0)
  );
}

// --- S3d: Plattenhaushalt und Office-DB ---------------------------------------------------------

async function plattenhaushalt() {
  const image = await docker(["image", "inspect", "--format", "{{.Size}}", runs.image]);
  const images = await docker([
    "image",
    "ls",
    "--format",
    "{{.Repository}}:{{.Tag}} {{.ID}} {{.Size}}",
  ]);
  const systemDf = await docker(["system", "df"]);
  const journal = await ausfuehren("journalctl", ["--disk-usage"]);
  let daemon = null;
  try {
    daemon = JSON.parse(readFileSync("/etc/docker/daemon.json", "utf8"));
  } catch {
    // Ohne daemon.json gelten die Standardwerte von Docker.
  }
  const pfade = [
    "/var/lib/docker",
    "/var/lib/docker/containers",
    "/var/lib/containerd",
    egress.registryCacheDir ?? "/var/lib/aio-sup/registry",
    CACHE,
    runs.dataDir,
    "/var/lib/aio-sup",
    "/var/lib/aio-office",
    "/opt/aio-office/releases",
    "/opt/aio-supervisor/releases",
    "/var/backups/aio",
    "/var/lib/aio-doku",
    "/var/log",
    "/swap.img",
  ];
  if (quelle !== null) pfade.push(quelle);
  if (konfig.gitGate !== null) pfade.push(konfig.gitGate.quarantineDir);
  const groessen = await du(pfade);

  // Rohprotokolle echter Läufe (Kap. 5.7: Obergrenze, 90 Tage Aufbewahrung).
  const laufVerzeichnisse = existsSync(runs.dataDir)
    ? readdirSync(runs.dataDir).filter((n) => /^r-[0-9a-f]{16}$/.test(n))
    : [];
  const laufGroessen = [];
  for (const n of laufVerzeichnisse) {
    const g = await du([join(runs.dataDir, n)]);
    const wert = g[join(runs.dataDir, n)];
    if (wert !== null) laufGroessen.push(wert);
  }
  return {
    imageBytes: Number(image.stdout.trim()) || null,
    images: images.stdout.trim(),
    systemDf: systemDf.stdout.trim(),
    journal: journal.stdout.trim(),
    dockerLogOpts: daemon?.["log-opts"] ?? null,
    groessen,
    rohprotokolle: {
      anzahl: laufGroessen.length,
      median: median(laufGroessen),
      max: max(laufGroessen),
      grenzeBytes: runs.rawLogMaxBytes,
      stderrGrenzeBytes: runs.stderrMaxBytes,
      aufbewahrungTage: runs.retentionDays,
    },
    plattefrei: frei("/"),
  };
}

async function officeDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const ergebnis = { echt: null, audit: null, synthetisch: null };
  let vorlagen = [];
  if (existsSync(OFFICE_DB)) {
    const db = new DatabaseSync(OFFICE_DB, { readOnly: true });
    try {
      const seite = db.prepare("PRAGMA page_size").get().page_size;
      const seiten = db.prepare("PRAGMA page_count").get().page_count;
      const gesamt = db
        .prepare(
          "SELECT count(*) AS n, coalesce(sum(length(payload)), 0) AS payload, count(DISTINCT run_id) AS laeufe, min(occurred_at) AS von, max(occurred_at) AS bis FROM events",
        )
        .get();
      const typen = db
        .prepare(
          "SELECT type, count(*) AS n, avg(length(payload)) AS mittel FROM events GROUP BY type ORDER BY n DESC LIMIT 25",
        )
        .all();
      const tabellen = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((t) => t.name);
      ergebnis.echt = {
        dateiBytes: statSync(OFFICE_DB).size,
        walBytes: existsSync(`${OFFICE_DB}-wal`) ? statSync(`${OFFICE_DB}-wal`).size : 0,
        seitenBytes: seite * seiten,
        ereignisse: gesamt.n,
        payloadBytes: gesamt.payload,
        laeufeMitEreignissen: gesamt.laeufe,
        von: gesamt.von,
        bis: gesamt.bis,
        typen,
        tabellen,
      };
      vorlagen = db
        .prepare(
          "SELECT type, version, actor, run_id AS runId, payload FROM events ORDER BY seq DESC LIMIT 2000",
        )
        .all();
    } finally {
      db.close();
    }
  }
  if (existsSync(AUDIT_DB)) {
    const db = new DatabaseSync(AUDIT_DB, { readOnly: true });
    try {
      const n = db.prepare("SELECT count(*) AS n FROM audit_entries").get().n;
      const arten = db
        .prepare(
          "SELECT kind, count(*) AS n FROM audit_entries GROUP BY kind ORDER BY n DESC LIMIT 20",
        )
        .all();
      const laeufe = db
        .prepare("SELECT count(*) AS n FROM audit_entries WHERE kind = 'run.prepared'")
        .get().n;
      ergebnis.audit = { dateiBytes: statSync(AUDIT_DB).size, eintraege: n, laeufe, arten };
    } finally {
      db.close();
    }
  }

  // Synthetisch: 20.000 Ereignisse mit Typen und Inhalten wie die letzten echten (ohne Inhalte
  // auszugeben), sonst Nachrichten mit 600 Zeichen. Über das EventStore des installierten Office.
  const storePfad = join(OFFICE, "packages/office/src/events/event-store.ts");
  if (!existsSync(storePfad)) return ergebnis;
  const { EventStore } = await import(pathToFileURL(storePfad).href);
  const dir = join(S3, "office-db");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const datei = join(dir, "office.db");
  const ersatz = {
    type: "message.sent",
    version: 1,
    actor: "cto",
    runId: "r-0000000000000000",
    payload: JSON.stringify({ to: "coo", kind: "info", text: "x".repeat(600) }),
  };
  const quelleListe = vorlagen.length >= 20 ? vorlagen : [ersatz];
  const groesse = () =>
    statSync(datei).size + (existsSync(`${datei}-wal`) ? statSync(`${datei}-wal`).size : 0);
  const punkte = [];
  let n = 0;
  const t0 = jetzt();
  for (const ziel of [2000, 20000]) {
    const store = EventStore.open(datei);
    while (n < ziel) {
      store.transaction(() => {
        for (let i = 0; i < 100 && n < ziel; i++, n++) {
          const v = quelleListe[n % quelleListe.length];
          store.append({
            type: v.type,
            version: v.version,
            actor: v.actor,
            ...(v.runId ? { runId: `r-${n.toString(16).padStart(16, "0")}` } : {}),
            payload: JSON.parse(v.payload),
          });
        }
      });
    }
    store.close();
    punkte.push({ ereignisse: n, bytes: groesse() });
  }
  ergebnis.synthetisch = {
    vorlage:
      quelleListe === vorlagen
        ? `letzte ${String(vorlagen.length)} echte Ereignisse`
        : "Ersatz (600 Zeichen)",
    punkte,
    bytesJeEreignis:
      (punkte[1].bytes - punkte[0].bytes) / (punkte[1].ereignisse - punkte[0].ereignisse),
    sekunden: jetzt() - t0,
  };
  rmSync(dir, { recursive: true, force: true });
  return ergebnis;
}

// --- Ablauf -------------------------------------------------------------------------------------

const ergebnis = {
  version: 1,
  beginn: new Date().toISOString(),
  meta: {},
  s3a: null,
  s3b: [],
  s3c: [],
  s3d: null,
  statik: null,
  hinweise: [],
};

info("Voraussetzungen");
if (quelle === null) throw new Error(`runs.repos enthält ${REPO} nicht`);
mkdirSync(S3, { recursive: true, mode: 0o755 });
mkdirSync(ARBEIT, { recursive: true, mode: 0o755 });
chmodSync(ARBEIT, 0o755);
await resteEntfernen();
rmSync(CACHE, { recursive: true, force: true });
mkdirSync(CACHE, { recursive: true, mode: 0o700 });

const mem0 = meminfo();
const version = (await docker(["version", "--format", "{{.Server.Version}}"])).stdout.trim();
const cliVersion = await docker([
  "run",
  "--rm",
  "--network",
  "none",
  "--entrypoint",
  "claude",
  runs.image,
  "--version",
]);
ergebnis.meta = {
  kernel: readFileSync("/proc/sys/kernel/osrelease", "utf8").trim(),
  vcpus: Number((await ausfuehren("nproc", [])).stdout.trim()),
  cpu: /model name\s*:\s*(.*)/.exec(readFileSync("/proc/cpuinfo", "utf8"))?.[1] ?? "?",
  memTotal: mem0.MemTotal,
  memVerfuegbarVorher: mem0.MemAvailable,
  swapTotal: mem0.SwapTotal,
  plattefreiVorher: frei("/"),
  plattegesamt: statfsSync("/").blocks * statfsSync("/").bsize,
  docker: version,
  image: runs.image,
  cli: cliVersion.stdout.trim(),
  supervisor: SUPERVISOR,
  office: existsSync(OFFICE) ? realpathSync(OFFICE) : null,
  werkbank,
  maxWorkplaces: konfig.admission?.maxWorkplaces ?? null,
  minFreeBytes: konfig.admission?.minFreeBytes ?? null,
  echteLaeufeVorher: await echteLaeufe(),
  cgroupTreiber: (await docker(["info", "--format", "{{.CgroupDriver}}"])).stdout.trim(),
};
notiz(
  `${String(ergebnis.meta.vcpus)} vCPUs, RAM ${(mem0.MemTotal / GIB).toFixed(2)} GiB, frei ${(ergebnis.meta.plattefreiVorher / 1e9).toFixed(1)} GB, CLI ${ergebnis.meta.cli}`,
);

const proxyLog = createWriteStream(join(S3, "proxy.log"), { flags: "a" });
const proxy = new EgressProxy({
  logger: createLogger({ level: "warn", sink: proxyLog }),
  anthropicCert: readFileSync(egress.tlsCertPath),
  anthropicKey: readFileSync(egress.tlsKeyPath),
  tokenDigest: tokenDigest(geheimeUmgebung().CLAUDE_CODE_OAUTH_TOKEN),
  registry: new RegistryCache({
    dir: CACHE,
    logger: createLogger({ level: "warn", sink: proxyLog }),
  }),
});
const host = new HostAbtaster();

let abbruch = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (abbruch) return;
    abbruch = true;
    console.log(`\n${signal}: räume auf`);
    void allesAufraeumen().then(() => process.exit(130));
  });
}

try {
  if (TEILE.has("a")) {
    info("S3a Grundlast: Startprozess ohne CLI (sleep 8)");
    const grundlast = await s3aGrundlast();
    notiz(`RAM-Spitze ${((grundlast.cgroup?.peak ?? 0) / 2 ** 20).toFixed(0)} MiB`);
    const haiku = [];
    for (let i = 1; i <= HAIKU_LAEUFE; i++) {
      info(`S3a haiku-Lauf ${String(i)}/${String(HAIKU_LAEUFE)}`);
      const r = await s3aHaiku(i);
      haiku.push(r);
      notiz(
        `exit ${String(r.exitCode)}, ${r.sekunden.toFixed(1)} s, init nach ${r.bisInit?.toFixed(1) ?? "?"} s, Bash ${String(r.bashAufrufe)}, ${String(r.ergebnis?.kostenUsd ?? "?")} USD, RAM-Spitze ${((r.cgroup?.peak ?? 0) / 2 ** 20).toFixed(0)} MiB`,
      );
    }
    ergebnis.s3a = { grundlast, haiku };
  }

  if (TEILE.has("b")) {
    info("S3b kalt: Werkbank mit leerem Registry-Cache");
    const kalt = await werkbankDurchgang("kalt");
    ergebnis.s3b.push(kalt);
    notiz(
      `${kalt.sekunden.toFixed(0)} s, ok ${String(alleOk(kalt))}, RAM-Spitze ${((kalt.cgroup?.peak ?? 0) / 2 ** 20).toFixed(0)} MiB, Store ${kalt.storePfad}`,
    );
    info("S3b warm: Werkbank mit gefülltem Cache (zugleich S3c n=1)");
    const t0 = jetzt();
    const warm = await werkbankDurchgang("warm", { standard: true });
    ergebnis.s3b.push(warm);
    ergebnis.s3c.push({ n: 1, durchgaenge: [warm], host: host.zusammenfassen(t0, jetzt()) });
    notiz(
      `${warm.sekunden.toFixed(0)} s, ok ${String(alleOk(warm))}, RAM-Spitze ${((warm.cgroup?.peak ?? 0) / 2 ** 20).toFixed(0)} MiB`,
    );
  }

  if (TEILE.has("c") && ergebnis.s3b.length === 2) {
    const referenz = ergebnis.s3b[1];
    const hartJeLauf = max(ergebnis.s3b.map((d) => d.cgroup?.hartMax ?? 0)) ?? 0;
    for (const n of PARALLEL) {
      const verfuegbar = meminfo().MemAvailable;
      const bedarf = n * hartJeLauf + GIB;
      const platte = frei("/");
      if (bedarf > verfuegbar || platte < n * werkbank.workspaceMiB * 2 ** 20 + RESERVE_PLATTE) {
        const grund = `n=${String(n)} übersprungen: RAM verfügbar ${(verfuegbar / GIB).toFixed(1)} GiB, gebraucht ${(bedarf / GIB).toFixed(1)} GiB; Platte frei ${(platte / 1e9).toFixed(1)} GB`;
        notiz(grund);
        ergebnis.s3c.push({ n, uebersprungen: grund });
        continue;
      }
      info(
        `S3c: ${String(n)} Werkbank-Läufe gleichzeitig (echte Läufe gerade: ${String(await echteLaeufe())})`,
      );
      const t0 = jetzt();
      const durchgaenge = await Promise.all(
        Array.from({ length: n }, (_, i) => werkbankDurchgang(`n${String(n)}-${String(i + 1)}`)),
      );
      const t1 = jetzt();
      ergebnis.s3c.push({ n, durchgaenge, host: host.zusammenfassen(t0, t1) });
      notiz(
        `Median ${median(durchgaenge.map((d) => d.pflichtSekunden)).toFixed(0)} s (Einzellauf ${referenz.pflichtSekunden.toFixed(0)} s), alle ok ${String(durchgaenge.every(alleOk))}`,
      );
    }
  }

  if (TEILE.has("d")) {
    info("S3d Plattenhaushalt");
    ergebnis.s3d = { platte: await plattenhaushalt() };
    info("S3d Office-DB (synthetisch)");
    ergebnis.s3d.db = await officeDb();
    notiz(
      `synthetisch ${ergebnis.s3d.db.synthetisch?.bytesJeEreignis.toFixed(0) ?? "?"} Bytes je Ereignis`,
    );
  }
} finally {
  host.stop();
  await allesAufraeumen();
  await proxy.close();
  rmSync(CACHE, { recursive: true, force: true });
}

// --- Statik (etappe-0.md Kap. 3.3) -------------------------------------------------------------

ergebnis.ende = new Date().toISOString();
ergebnis.meta.echteLaeufeNachher = await echteLaeufe();
if (ergebnis.s3b.length > 0) {
  const werkbankLaeufe = [...ergebnis.s3b, ...ergebnis.s3c.flatMap((r) => r.durchgaenge ?? [])];
  const ramSpitze = max(werkbankLaeufe.map((d) => d.cgroup?.peak ?? 0));
  const ramHart = max(werkbankLaeufe.map((d) => d.cgroup?.hartMax ?? 0));
  const haikuSpitze = max((ergebnis.s3a?.haiku ?? []).map((h) => h.cgroup?.peak ?? 0)) ?? 0;
  const plattenJeLauf =
    max(werkbankLaeufe.map((d) => d.arbeitsbereichBelegt)) + runs.rawLogMaxBytes;
  const einzel = ergebnis.s3b[ergebnis.s3b.length - 1].pflichtSekunden;
  const cpuRunden = ergebnis.s3c.filter((r) => r.durchgaenge);
  const tragbar = cpuRunden.filter(
    (r) =>
      // Gezählt wird die Dauer. Ein Test, der nur unter Last scheitert, steht im Bericht, verschiebt
      // aber nicht die CPU-Grenze; ein Durchgang ohne alle Schritte zählt nicht.
      r.durchgaenge.every(
        (d) => d.exitCode === 0 && PFLICHT_SCHRITTE.every((n) => d.schritte[n]),
      ) && median(r.durchgaenge.map((d) => d.pflichtSekunden)) <= CPU_FAKTOR * einzel,
  );
  const cpuGrenze = tragbar.length === 0 ? null : max(tragbar.map((r) => r.n));
  const getestetMax = max(cpuRunden.map((r) => r.n));
  const ram = Math.floor((ergebnis.meta.memTotal - RESERVE_RAM) / Math.max(ramSpitze, haikuSpitze));
  const ramHartGrenze = Math.floor((ergebnis.meta.memTotal - RESERVE_RAM) / ramHart);
  const platte = Math.floor((ergebnis.meta.plattefreiVorher - RESERVE_PLATTE) / plattenJeLauf);
  const platteVoll = Math.floor(
    (ergebnis.meta.plattefreiVorher - RESERVE_PLATTE) /
      (werkbank.workspaceMiB * 2 ** 20 + runs.rawLogMaxBytes),
  );
  const kandidaten = [ram, platte, ...(cpuGrenze === null ? [] : [cpuGrenze])];
  ergebnis.statik = {
    reserveRam: RESERVE_RAM,
    reservePlatte: RESERVE_PLATTE,
    ramSpitzeJeLauf: Math.max(ramSpitze, haikuSpitze),
    ramHartJeLauf: ramHart,
    plattenJeLauf,
    grenzeRam: ram,
    grenzeRamHart: ramHartGrenze,
    grenzePlatte: platte,
    grenzePlatteArbeitsbereichVoll: platteVoll,
    cpuFaktor: CPU_FAKTOR,
    grenzeCpu: cpuGrenze,
    cpuGetestetBis: getestetMax,
    cpuGrenzeNurUntergrenze: cpuGrenze !== null && cpuGrenze === getestetMax,
    statik: Math.min(...kandidaten),
    noGo: Math.min(...kandidaten) < 2,
  };
}

writeFileSync(join(BERICHTE, "S3-messwerte.json"), `${JSON.stringify(ergebnis, null, 2)}\n`, {
  mode: 0o644,
});
chmodSync(join(BERICHTE, "S3-messwerte.json"), 0o644);
const { bericht } = await import(pathToFileURL(join(import.meta.dirname, "bericht.js")).href);
writeFileSync(join(BERICHTE, "S3-bericht.md"), bericht(ergebnis), { mode: 0o644 });
chmodSync(join(BERICHTE, "S3-bericht.md"), 0o644);
info(
  `Fertig. Bericht: ${join(BERICHTE, "S3-bericht.md")}, Messwerte: ${join(BERICHTE, "S3-messwerte.json")}`,
);
process.exit(0);
