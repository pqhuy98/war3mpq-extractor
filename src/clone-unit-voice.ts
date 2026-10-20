import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env") });

const FISH_API = "https://api.fish.audio";
const EXTRACTED = path.join(ROOT, "extracted-mpq");
const UNIT_SOUNDS_PATH = path.join(ROOT, "object-data", "unit-sounds.json");
const FFMPEG = path.join(ROOT, "bin", "ffmpeg-7.0.2-essentials_build", "bin", "ffmpeg.exe");
const OUT_ROOT = path.join(ROOT, "output", "fish-voices");
const WC3_TAG = "wc3-unit-voice";
const SOUND_TYPES = ["What", "Pissed", "YesAttack", "Yes", "Ready", "Warcry"] as const;
const MAX_UPLOAD_FILES = 20;
const CAMPAIGN_CHUNK_SEC = 25;
const CAMPAIGN_PACK_BUDGET_SEC = 90;
const ASR_CONCURRENCY = 3;
const DIALOG_SLK_PATHS = [
  path.join(ROOT, "extracted-mpq", "war3.w3mod", "ui", "soundinfo", "dialogsounds.slk"),
  path.join(ROOT, "extracted-mpq", "UI", "SoundInfo", "DialogSounds.slk"),
];
const UNIT_STRING_PATHS = [
  path.join(ROOT, "extracted-mpq", "war3.w3mod", "_locales", "enus.w3mod", "units", "campaignunitstrings.txt"),
  path.join(ROOT, "extracted-mpq", "war3.w3mod", "_locales", "enus.w3mod", "units", "unitstrings.txt"),
  path.join(ROOT, "extracted-mpq", "Units", "CampaignUnitStrings.txt"),
  path.join(ROOT, "extracted-mpq", "Units", "UnitStrings.txt"),
];

type SoundType = (typeof SOUND_TYPES)[number];
type VoiceKind = SoundType | "Campaign";

type SoundGroup = {
  FileNames: string;
  DirectoryBase: string;
  Channel: number;
  SoundName: string;
};

type UnitSounds = {
  id: string;
  name: string;
  sounds: Record<SoundType, SoundGroup[]>;
};

type Clip = {
  fileName: string;
  soundType: VoiceKind;
  sourcePath: string;
  clipPath: string;
  bytes: number;
  durationSec: number;
};

type Transcript = {
  fileName: string;
  soundType: VoiceKind;
  text: string;
  bytes: number;
};

type PackFile = {
  fileName: string;
  soundType: VoiceKind;
  packPath: string;
  clipFileNames: string[];
  text: string;
};

type VoiceCache = {
  modelId: string;
  title: string;
  fingerprint: string;
  visibility: string;
  uploadedAt: string;
};

type SlotRegistry = {
  voices: Record<string, { modelId: string; lastUsedAt: string }>;
};

type FishModel = {
  _id: string;
  title: string;
  state: string;
  tags: string[];
  visibility: string;
  created_at: string;
  updated_at: string;
};

type Args = {
  command: "prepare" | "generate";
  unit: string;
  id?: string;
  text?: string;
  textFile?: string;
  model: string;
  force: boolean;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === undefined) {
    printUsage();
    process.exit(1);
  }

  const units = loadUnitSounds();
  const unit = findUnit(units, args.unit);
  const dir = unitDir(unit);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`${unit.id} (${unit.name}) -> ${path.relative(ROOT, dir)}`);

  const clips = await gatherClips(unit, units, dir);
  const transcripts = await transcribeClips(clips, dir);
  writeHowHeTalks(unit, transcripts, dir);
  const pack = await buildPack(clips, transcripts, dir);

  if (args.command === "prepare") {
    console.log(`Prepare done. Transcripts: ${path.relative(ROOT, path.join(dir, "how-he-talks.md"))}`);
    return;
  }

  const apiKey = requireApiKey();
  const voice = await ensureRemoteVoice(unit, pack, dir, apiKey, args.force);
  const lineText = resolveGenerateText(args);
  const lineId = args.id ?? slug(lineText).slice(0, 48);
  await synthesizeLine(unit, voice, lineId, lineText, dir, apiKey, args.model, args.force);
}

function parseArgs(argv: string[]): Args {
  const out: { command?: string; unit?: string; id?: string; text?: string; textFile?: string; model?: string; force?: string } = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        (out as Record<string, string>)[key === "text-file" ? "textFile" : key] = next;
        i++;
      } else {
        (out as Record<string, string>)[key] = "true";
      }
    } else {
      rest.push(a);
    }
  }
  const command = out.command ?? rest[0];
  const unit = out.unit ?? rest[1];
  if (command !== "prepare" && command !== "generate") {
    printUsage();
    process.exit(1);
  }
  if (!unit) {
    printUsage();
    throw new Error("Missing --unit (fourcc or unit-sounds name, e.g. Orex / rexxar)");
  }
  return {
    command,
    unit,
    id: out.id,
    text: out.text,
    textFile: out.textFile,
    model: out.model ?? "drama-3",
    force: out.force === "true",
  };
}

function printUsage(): void {
  console.log(`Clone a WC3 unit voice with Fish Audio.

  npx tsx src/clone-unit-voice.ts prepare --unit Orex
  npx tsx src/clone-unit-voice.ts generate --unit Orex --id marrowgar-bladestorm-hint --text "..."

prepare  gather clips, transcribe, write how-he-talks.md, build upload pack
generate prepare, then upload/reuse the Fish voice and synthesize a line

--unit       fourcc or name from object-data/unit-sounds.json
--id         cache key for the generated line
--text       spoken text (Drama 3 tags allowed, e.g. [grim warning] ...)
--text-file  read --text from a file
--model      Fish TTS model (default drama-3)
--force      redo upload and/or line even if cached
`);
}

function loadUnitSounds(): UnitSounds[] {
  return JSON.parse(fs.readFileSync(UNIT_SOUNDS_PATH, "utf8")) as UnitSounds[];
}

function findUnit(units: UnitSounds[], query: string): UnitSounds {
  const q = query.trim().toLowerCase();
  const found = units.find((u) => u.id.toLowerCase() === q) ?? units.find((u) => u.name.toLowerCase() === q);
  if (!found) {
    throw new Error(`No unit-sounds entry for "${query}"`);
  }
  return found;
}

function unitDir(unit: UnitSounds): string {
  return path.join(OUT_ROOT, `${unit.id}-${unit.name}`);
}

async function gatherClips(unit: UnitSounds, units: UnitSounds[], dir: string): Promise<Clip[]> {
  const clipsDir = path.join(dir, "clips");
  const clips: Clip[] = [];
  for (const soundType of SOUND_TYPES) {
    for (const group of unit.sounds[soundType] ?? []) {
      const files = group.FileNames.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      for (const fileName of files) {
        const sourcePath = resolveMpqAudio(group.DirectoryBase, fileName);
        if (!sourcePath) {
          throw new Error(`Missing MPQ audio ${group.DirectoryBase}${fileName}`);
        }
        const clipPath = path.join(clipsDir, soundType, fileName);
        copyIfChanged(sourcePath, clipPath);
        clips.push({
          fileName,
          soundType,
          sourcePath,
          clipPath,
          bytes: fs.statSync(clipPath).size,
          durationSec: await probeDuration(clipPath),
        });
      }
    }
  }
  const campaign = await gatherCampaignClips(unit, units, dir);
  clips.push(...campaign);
  if (clips.length === 0) {
    throw new Error(`No voice clips for ${unit.id}`);
  }
  const unitCount = clips.filter((c) => c.soundType !== "Campaign").length;
  console.log(`Gathered ${unitCount} unit + ${campaign.length} campaign clips`);
  return clips;
}

function resolveMpqAudio(directoryBase: string, fileName: string): string | undefined {
  const rel = path.join(...directoryBase.split(/[\\/]/), fileName);
  const lowerRel = path.join(...directoryBase.split(/[\\/]/).map((p) => p.toLowerCase()), fileName);
  const candidates = [
    path.join(EXTRACTED, rel),
    path.join(EXTRACTED, "war3.w3mod", rel),
    path.join(EXTRACTED, lowerRel),
    path.join(EXTRACTED, "war3.w3mod", lowerRel),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

function copyIfChanged(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size) {
    return;
  }
  fs.copyFileSync(src, dest);
}

async function gatherCampaignClips(unit: UnitSounds, units: UnitSounds[], dir: string): Promise<Clip[]> {
  const needles = speakerNeedles(unit, units);
  if (needles.length === 0) return [];
  const rows = loadDialogSounds().filter((row) => needles.some((n) => nameMatches(row.soundName, n) || nameMatches(row.fileNames, n)));
  const clipsDir = path.join(dir, "clips", "Campaign");
  const clips: Clip[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.soundName)) continue;
    const sourcePath = resolveDialogAudio(row.fileNames);
    if (!sourcePath) {
      console.log(`Missing campaign audio ${row.fileNames}`);
      continue;
    }
    seen.add(row.soundName);
    const fileName = `${row.soundName}.wav`;
    const clipPath = path.join(clipsDir, fileName);
    await ensureWav(sourcePath, clipPath);
    clips.push({
      fileName,
      soundType: "Campaign",
      sourcePath,
      clipPath,
      bytes: fs.statSync(clipPath).size,
      durationSec: await probeDuration(clipPath),
    });
  }
  clips.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return clips;
}

function speakerNeedles(unit: UnitSounds, units: UnitSounds[]): string[] {
  const names = new Set<string>();
  addNeedle(names, unit.name);
  const proper = loadProperNames();
  for (const name of proper.get(unit.id.toLowerCase()) ?? []) addNeedle(names, name);

  const bases = soundDirectories(unit);
  for (const other of units) {
    if (other.id === unit.id) continue;
    const otherBases = soundDirectories(other);
    if (!bases.some((b) => otherBases.includes(b))) continue;
    addNeedle(names, other.name);
    for (const name of proper.get(other.id.toLowerCase()) ?? []) addNeedle(names, name);
  }
  return [...names];
}

function addNeedle(names: Set<string>, raw: string): void {
  const n = raw.trim().toLowerCase();
  if (n.length >= 4) names.add(n);
  const first = n.split(/\s+/)[0];
  if (first.length >= 4) names.add(first);
}

function soundDirectories(unit: UnitSounds): string[] {
  const dirs = new Set<string>();
  for (const soundType of SOUND_TYPES) {
    for (const group of unit.sounds[soundType] ?? []) {
      if (group.DirectoryBase) dirs.add(group.DirectoryBase.toLowerCase());
    }
  }
  return [...dirs];
}

function nameMatches(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle);
}

type DialogRow = { soundName: string; fileNames: string };

let dialogSoundCache: DialogRow[] | undefined;

function loadDialogSounds(): DialogRow[] {
  if (dialogSoundCache) return dialogSoundCache;
  const byName = new Map<string, DialogRow>();
  for (const slkPath of DIALOG_SLK_PATHS) {
    if (!fs.existsSync(slkPath)) continue;
    for (const row of parseDialogSlk(slkPath)) {
      const existing = byName.get(row.soundName);
      if (!existing || (row.fileNames.toLowerCase().endsWith(".flac") && !existing.fileNames.toLowerCase().endsWith(".flac"))) {
        byName.set(row.soundName, row);
      }
    }
  }
  dialogSoundCache = [...byName.values()];
  return dialogSoundCache;
}

function parseDialogSlk(slkPath: string): DialogRow[] {
  const rows: DialogRow[] = [];
  let soundName = "";
  let fileNames = "";
  const flush = (): void => {
    if (soundName && fileNames && soundName !== "SoundName") {
      rows.push({ soundName, fileNames });
    }
    soundName = "";
    fileNames = "";
  };
  for (const line of fs.readFileSync(slkPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^C;X(\d+)(?:;Y(\d+))?;K(.*)$/);
    if (!m) continue;
    const x = Number(m[1]);
    if (m[2]) flush();
    const raw = m[3];
    const value = raw.startsWith("\"") ? raw.slice(1, raw.endsWith("\"") ? raw.length - 1 : undefined).replaceAll("\"\"", "\"") : raw;
    if (x === 1) soundName = value;
    if (x === 3) fileNames = value;
  }
  flush();
  return rows;
}

function resolveDialogAudio(fileNames: string): string | undefined {
  const rel = path.join(...fileNames.split(/[\\/]/));
  const locales = path.join(EXTRACTED, "war3.w3mod", "_locales", "enus.w3mod", rel);
  const candidates = [
    locales,
    path.join(EXTRACTED, "war3.w3mod", rel),
    path.join(EXTRACTED, rel),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

let properNameCache: Map<string, string[]> | undefined;

function loadProperNames(): Map<string, string[]> {
  if (properNameCache) return properNameCache;
  const map = new Map<string, string[]>();
  for (const filePath of UNIT_STRING_PATHS) {
    if (!fs.existsSync(filePath)) continue;
    let id = "";
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const header = line.match(/^\[([^\]]+)\]/);
      if (header) {
        id = header[1].toLowerCase();
        continue;
      }
      const proper = line.match(/^Propernames=(.+)/);
      if (proper && id) {
        const names = proper[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        const prev = map.get(id) ?? [];
        map.set(id, [...new Set([...prev, ...names])]);
      }
    }
  }
  properNameCache = map;
  return map;
}

async function ensureWav(src: string, dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest) && fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs) return;
  if (src.toLowerCase().endsWith(".wav")) {
    fs.copyFileSync(src, dest);
    return;
  }
  await run(FFMPEG, ["-y", "-i", src, "-ac", "1", "-ar", "44100", "-sample_fmt", "s16", dest]);
}

async function probeDuration(filePath: string): Promise<number> {
  const ffprobe = path.join(path.dirname(FFMPEG), "ffprobe.exe");
  const out = await runCapture(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const n = Number(out.trim());
  return Number.isFinite(n) ? n : 4;
}

async function transcribeClips(clips: Clip[], dir: string): Promise<Transcript[]> {
  const cachePath = path.join(dir, "transcripts.json");
  const cached = readJson<Transcript[]>(cachePath) ?? [];
  const byName = new Map(cached.map((t) => [t.fileName, t]));
  const apiKey = process.env.FISH_AUDIO_API_KEY ?? process.env.FISH_API_KEY;
  const pending = clips.filter((clip) => {
    const hit = byName.get(clip.fileName);
    return !(hit && hit.bytes === clip.bytes && hit.text.trim().length > 0);
  });
  if (pending.length > 0 && !apiKey) {
    throw new Error("FISH_AUDIO_API_KEY is required to transcribe (or reuse transcripts.json)");
  }
  console.log(`Transcribe ${pending.length} new / ${clips.length - pending.length} cached`);

  const flush = (): void => {
    writeJson(cachePath, [...byName.values()].sort((a, b) => a.fileName.localeCompare(b.fileName)));
  };

  await mapPool(pending, ASR_CONCURRENCY, async (clip) => {
    console.log(`Transcribe ${clip.soundType}/${clip.fileName}`);
    try {
      const text = sanitizeTranscript(await fishTranscribe(clip.clipPath, apiKey ?? ""));
      byName.set(clip.fileName, { fileName: clip.fileName, soundType: clip.soundType, text, bytes: clip.bytes });
    } catch (err) {
      console.log(`Skip ${clip.fileName}: ${err instanceof Error ? err.message : String(err)}`);
    }
    flush();
  });

  const out: Transcript[] = [];
  for (const clip of clips) {
    const hit = byName.get(clip.fileName);
    if (hit && hit.text.trim().length > 0) {
      out.push({ ...hit, soundType: clip.soundType, text: sanitizeTranscript(hit.text), bytes: clip.bytes });
    }
  }
  writeJson(cachePath, out);
  console.log(`Transcripts ${out.length} lines`);
  return out;
}

function writeHowHeTalks(unit: UnitSounds, transcripts: Transcript[], dir: string): void {
  const campaign = transcripts.filter((t) => t.soundType === "Campaign");
  const unitLines = transcripts.filter((t) => t.soundType !== "Campaign");
  const campaignWords = campaign.map((t) => t.text.split(/\s+/).filter(Boolean).length);
  const unitWords = unitLines.map((t) => t.text.split(/\s+/).filter(Boolean).length);
  const avg = (xs: number[]): number => xs.length > 0 ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;

  const campaignSection = campaign.length > 0
    ? `## Campaign dialogue\n\nStory lines from Frozen Throne / Reign of Chaos. Match this register for cinematic hints.\n\n${campaign.map((t) => `- ${t.fileName}: ${t.text}`).join("\n")}\n`
    : "";
  const unitSections = SOUND_TYPES.map((soundType) => {
    const lines = transcripts.filter((t) => t.soundType === soundType);
    if (lines.length === 0) return "";
    return `## ${soundType}\n\n${lines.map((t) => `- ${t.fileName}: ${t.text}`).join("\n")}\n`;
  }).filter((s) => s.length > 0);

  const md = `# ${unit.id} (${unit.name})

Use this file to match diction, length, and attitude when writing new lines.

- Campaign story lines: ${campaign.length} (typical ~${avg(campaignWords)} words)
- Hero click responses: ${unitLines.length} (typical ~${avg(unitWords)} words)
- What / Yes / Ready: short acknowledgements
- YesAttack / Warcry: shouted combat
- Pissed: irritated click spam, including jokes — do not copy those for story hints

${campaignSection}
${unitSections.join("\n")}
## Writer notes

Campaign dialogue is the voice for story. Keep new cinematic lines in that register: first-person, concrete, no narrator. Hero click lines are shorter and barkier. Drama 3 direction tags go in square brackets before the spoken words.
`;
  fs.writeFileSync(path.join(dir, "how-he-talks.md"), md);
}

async function buildPack(clips: Clip[], transcripts: Transcript[], dir: string): Promise<PackFile[]> {
  const packDir = path.join(dir, "pack");
  fs.mkdirSync(packDir, { recursive: true });
  const pack: PackFile[] = [];

  for (const soundType of SOUND_TYPES) {
    const typeClips = clips.filter((c) => c.soundType === soundType);
    if (typeClips.length === 0) continue;
    pack.push(await writePackFile(packDir, `${soundType}.wav`, soundType, typeClips, transcripts));
  }

  const campaignClips = clips.filter((c) => c.soundType === "Campaign").sort((a, b) => a.fileName.localeCompare(b.fileName));
  const chunks = chunkClips(campaignClips, CAMPAIGN_CHUNK_SEC, CAMPAIGN_PACK_BUDGET_SEC, MAX_UPLOAD_FILES - pack.length);
  for (let i = 0; i < chunks.length; i++) {
    pack.push(await writePackFile(packDir, `Campaign-${i + 1}.wav`, "Campaign", chunks[i], transcripts));
  }

  if (pack.length > MAX_UPLOAD_FILES) {
    throw new Error(`Pack has ${pack.length} files; Fish allows ${MAX_UPLOAD_FILES}`);
  }
  writeJson(path.join(dir, "pack.json"), pack.map((p) => ({
    fileName: p.fileName,
    soundType: p.soundType,
    clipFileNames: p.clipFileNames,
    text: p.text,
  })));
  console.log(`Upload pack: ${pack.length} files`);
  return pack;
}

async function writePackFile(
  packDir: string,
  fileName: string,
  soundType: VoiceKind,
  typeClips: Clip[],
  transcripts: Transcript[],
): Promise<PackFile> {
  const packPath = path.join(packDir, fileName);
  const clipFileNames = typeClips.map((c) => c.fileName);
  const needed = typeClips.some((c) => !fs.existsSync(packPath) || fs.statSync(c.clipPath).mtimeMs > fs.statSync(packPath).mtimeMs);
  if (needed) {
    await concatWavs(typeClips.map((c) => c.clipPath), packPath);
  } else {
    console.log(`Skip pack ${fileName}`);
  }
  const text = typeClips
    .map((c) => transcripts.find((t) => t.fileName === c.fileName)?.text ?? "")
    .filter((t) => t.length > 0)
    .join(" ");
  return { fileName, soundType, packPath, clipFileNames, text };
}

function chunkClips(clips: Clip[], chunkSec: number, budgetSec: number, maxChunks: number): Clip[][] {
  const chunks: Clip[][] = [];
  let current: Clip[] = [];
  let currentSec = 0;
  let usedSec = 0;
  for (const clip of clips) {
    if (chunks.length >= maxChunks || usedSec >= budgetSec) break;
    if (current.length > 0 && currentSec + clip.durationSec > chunkSec) {
      chunks.push(current);
      usedSec += currentSec;
      current = [];
      currentSec = 0;
      if (chunks.length >= maxChunks || usedSec >= budgetSec) break;
    }
    current.push(clip);
    currentSec += clip.durationSec;
  }
  if (current.length > 0 && chunks.length < maxChunks && usedSec < budgetSec) {
    chunks.push(current);
  }
  return chunks;
}

async function ensureRemoteVoice(
  unit: UnitSounds,
  pack: PackFile[],
  dir: string,
  apiKey: string,
  force: boolean,
): Promise<VoiceCache> {
  const cachePath = path.join(dir, "voice.json");
  const fingerprint = packFingerprint(pack);
  const cached = readJson<VoiceCache>(cachePath);
  if (!force && cached && cached.fingerprint === fingerprint) {
    const remote = await fishGetModel(cached.modelId, apiKey);
    if (remote && remote.state === "trained") {
      console.log(`Reuse Fish voice ${cached.modelId}`);
      touchSlot(unit.id, cached.modelId);
      return cached;
    }
    console.log("Cached voice missing remotely, re-uploading");
  }

  if (cached?.modelId) {
    try {
      await fishDeleteModel(cached.modelId, apiKey);
      console.log(`Removed stale Fish voice ${cached.modelId}`);
    } catch (err) {
      console.log(`Could not delete stale voice: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const title = `wc3-${unit.id}-${unit.name}`;
  let created: FishModel;
  try {
    created = await fishCreateVoice(title, pack, "private", apiKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isSlotError(0, message) || /private|visibility/i.test(message)) {
      console.log("Retrying voice upload:", message);
      await evictLru(apiKey);
      try {
        created = await fishCreateVoice(title, pack, "private", apiKey);
      } catch (err2) {
        const message2 = err2 instanceof Error ? err2.message : String(err2);
        console.log("Private slot failed, retrying public:", message2);
        await evictLru(apiKey);
        created = await fishCreateVoice(title, pack, "public", apiKey);
      }
    } else {
      throw err;
    }
  }

  const voice: VoiceCache = {
    modelId: created._id,
    title,
    fingerprint,
    visibility: created.visibility,
    uploadedAt: new Date().toISOString(),
  };
  writeJson(cachePath, voice);
  touchSlot(unit.id, voice.modelId);
  console.log(`Uploaded Fish voice ${voice.modelId} (${created.visibility})`);
  return voice;
}

async function evictLru(apiKey: string): Promise<void> {
  const registry = loadSlots();
  const models = await fishListSelf(apiKey);
  const tagged = models.filter((m) => m.tags.includes(WC3_TAG));
  const pool = tagged.length > 0 ? tagged : models;
  if (pool.length === 0) return;

  const lru = [...pool].sort((a, b) => {
    const aUsed = registry.voices[slotKeyForModel(a, registry)]?.lastUsedAt ?? a.updated_at;
    const bUsed = registry.voices[slotKeyForModel(b, registry)]?.lastUsedAt ?? b.updated_at;
    return Date.parse(aUsed) - Date.parse(bUsed);
  })[0];
  if (!lru) return;
  console.log(`Recycle LRU voice ${lru.title} ${lru._id}`);
  await fishDeleteModel(lru._id, apiKey);
  for (const [unitId, row] of Object.entries(registry.voices)) {
    if (row.modelId === lru._id) delete registry.voices[unitId];
  }
  saveSlots(registry);
}

function slotKeyForModel(model: FishModel, registry: SlotRegistry): string {
  const hit = Object.entries(registry.voices).find(([, v]) => v.modelId === model._id);
  return hit?.[0] ?? model._id;
}

async function synthesizeLine(
  unit: UnitSounds,
  voice: VoiceCache,
  lineId: string,
  text: string,
  dir: string,
  apiKey: string,
  model: string,
  force: boolean,
): Promise<void> {
  const linesDir = path.join(dir, "lines");
  fs.mkdirSync(linesDir, { recursive: true });
  const wavPath = path.join(linesDir, `${lineId}.wav`);
  const metaPath = path.join(linesDir, `${lineId}.json`);
  if (!force && fs.existsSync(wavPath) && fs.existsSync(metaPath)) {
    console.log(`Skip existing line ${path.relative(ROOT, wavPath)}`);
    return;
  }

  console.log(`TTS ${model} ${lineId}: ${text}`);
  let audio: Buffer;
  try {
    audio = await fishTts(text, voice.modelId, model, apiKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (model !== "s2.1-pro-free" && /402|credit|quota|payment/i.test(message)) {
      console.log("Falling back to s2.1-pro-free");
      audio = await fishTts(text, voice.modelId, "s2.1-pro-free", apiKey);
    } else {
      throw err;
    }
  }

  const sourcePath = path.join(linesDir, `${lineId}.source.wav`);
  fs.writeFileSync(sourcePath, audio);
  await resampleForWc3(sourcePath, wavPath);
  writeJson(metaPath, {
    unitId: unit.id,
    unitName: unit.name,
    lineId,
    text,
    model,
    voiceId: voice.modelId,
    wav: path.relative(ROOT, wavPath),
    generatedAt: new Date().toISOString(),
  });
  touchSlot(unit.id, voice.modelId);
  console.log(`Wrote ${path.relative(ROOT, wavPath)}`);
}

function resolveGenerateText(args: Args): string {
  if (args.textFile) {
    const p = path.isAbsolute(args.textFile) ? args.textFile : path.join(ROOT, args.textFile);
    return fs.readFileSync(p, "utf8").trim();
  }
  if (args.text && args.text.trim().length > 0) return args.text.trim();
  throw new Error("generate needs --text or --text-file");
}

function packFingerprint(pack: PackFile[]): string {
  const payload = pack.map((p) => ({
    fileName: p.fileName,
    bytes: fs.statSync(p.packPath).size,
    text: p.text,
    clips: p.clipFileNames,
  }));
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function slotsPath(): string {
  return path.join(OUT_ROOT, "slots.json");
}

function loadSlots(): SlotRegistry {
  return readJson<SlotRegistry>(slotsPath()) ?? { voices: {} };
}

function saveSlots(registry: SlotRegistry): void {
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  writeJson(slotsPath(), registry);
}

function touchSlot(unitId: string, modelId: string): void {
  const registry = loadSlots();
  registry.voices[unitId] = { modelId, lastUsedAt: new Date().toISOString() };
  saveSlots(registry);
}

function requireApiKey(): string {
  const key = process.env.FISH_AUDIO_API_KEY ?? process.env.FISH_API_KEY;
  if (!key) throw new Error("Set FISH_AUDIO_API_KEY in .env");
  return key;
}

async function fishTranscribe(audioPath: string, apiKey: string): Promise<string> {
  const form = new FormData();
  form.append("audio", new Blob([fs.readFileSync(audioPath)]), path.basename(audioPath));
  form.append("language", "en");
  form.append("ignore_timestamps", "true");
  form.append("tag_audio_events", "false");
  const json = await fishJson("POST", "/v1/asr", apiKey, form, { model: "transcribe-1-pro" });
  const text = typeof json.text === "string" ? json.text.trim() : "";
  if (text.length === 0) throw new Error(`Empty transcript for ${audioPath}`);
  return text;
}

async function fishListSelf(apiKey: string): Promise<FishModel[]> {
  const items: FishModel[] = [];
  let page = 1;
  for (;;) {
    const json = await fishJson("GET", `/model?self=true&page_size=100&page_number=${page}&sort_by=created_at`, apiKey);
    const batch = Array.isArray(json.items) ? json.items as FishModel[] : [];
    items.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return items;
}

async function fishGetModel(id: string, apiKey: string): Promise<FishModel | undefined> {
  try {
    const json = await fishJson("GET", `/model/${id}`, apiKey);
    return json as unknown as FishModel;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/\b404\b/.test(message)) return undefined;
    throw err;
  }
}

async function fishDeleteModel(id: string, apiKey: string): Promise<void> {
  await fishJson("DELETE", `/model/${id}`, apiKey);
}

async function fishCreateVoice(
  title: string,
  pack: PackFile[],
  visibility: "private" | "public",
  apiKey: string,
): Promise<FishModel> {
  const form = new FormData();
  form.append("type", "tts");
  form.append("title", title);
  form.append("train_mode", "fast");
  form.append("visibility", visibility);
  form.append("enhance_audio_quality", "false");
  form.append("tags", WC3_TAG);
  form.append("description", "Warcraft III unit soundset clone");
  for (const file of pack) {
    form.append("voices", new Blob([fs.readFileSync(file.packPath)]), file.fileName);
    form.append("texts", file.text);
  }
  const created = await fishJson("POST", "/model", apiKey, form) as unknown as FishModel;
  if (created.state === "trained") return created;
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const latest = await fishGetModel(created._id, apiKey);
    if (latest?.state === "trained") return latest;
    if (latest?.state === "failed") throw new Error(`Voice training failed: ${created._id}`);
  }
  throw new Error(`Voice ${created._id} did not become trained`);
}

async function fishTts(text: string, referenceId: string, model: string, apiKey: string): Promise<Buffer> {
  const res = await fetch(`${FISH_API}/v1/tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      model,
    },
    body: JSON.stringify({
      text,
      reference_id: referenceId,
      format: "wav",
      sample_rate: 44100,
      normalize: true,
      language: "en",
      temperature: 0.7,
      top_p: 0.7,
    }),
  });
  if (!res.ok) {
    throw new Error(`TTS ${res.status}: ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function fishJson(
  method: string,
  pathname: string,
  apiKey: string,
  body?: FormData,
  extraHeaders?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    ...extraHeaders,
  };
  const res = await fetch(`${FISH_API}${pathname}`, {
    method,
    headers,
    body,
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${pathname} ${res.status}: ${raw}`);
  }
  return raw.length > 0 ? JSON.parse(raw) as Record<string, unknown> : {};
}

function isSlotError(status: number, raw: string): boolean {
  if (status !== 0 && status !== 400 && status !== 403 && status !== 409) return false;
  return /slot|limit|quota|maximum|too many models|voice slots/i.test(raw);
}

async function concatWavs(inputs: string[], output: string): Promise<void> {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (inputs.length === 1) {
    fs.copyFileSync(inputs[0], output);
    return;
  }
  const listPath = `${output}.concat.txt`;
  const lines = inputs.map((p) => `file '${p.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`);
  fs.writeFileSync(listPath, lines.join("\n"));
  try {
    try {
      await run(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", output]);
    } catch {
      await run(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-ac", "1", "-ar", "44100", "-sample_fmt", "s16", output]);
    }
  } finally {
    fs.rmSync(listPath, { force: true });
  }
}

async function resampleForWc3(input: string, output: string): Promise<void> {
  await run(FFMPEG, ["-y", "-i", input, "-ac", "1", "-ar", "22050", "-sample_fmt", "s16", output]);
}

function run(cmd: string, args: string[]): Promise<void> {
  return runCapture(cmd, args).then(() => undefined);
}

function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (buf: Buffer) => {
      out += buf.toString();
    });
    child.stderr.on("data", (buf: Buffer) => {
      err += buf.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(cmd)} exited ${code}\n${err}`));
    });
  });
}

async function mapPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (items.length === 0) return;
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i];
      i += 1;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

function readJson<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sanitizeTranscript(text: string): string {
  return text
    .replace(/<\|speaker:\d+\|>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
