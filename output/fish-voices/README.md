# Fish unit voices

Clone a Warcraft III unit soundset with [Fish Audio](https://fish.audio) Drama 3, then generate new campaign lines.

Needs `FISH_AUDIO_API_KEY` in the repo `.env`, plus `extracted-mpq/` and `object-data/unit-sounds.json`.

## Commands

From the extractor root:

```
npm run clone-unit-voice -- prepare --unit Orex
npm run clone-unit-voice -- generate --unit Orex --id marrowgar-bladestorm-hint --text-file output/fish-voices/Orex-rexxar/lines/marrowgar-bladestorm-hint.txt
```

`--unit` is a fourcc or `unit-sounds.json` name (`Orex`, `rexxar`). `--force` remakes the Fish voice and/or the line.

- **prepare** copies clips, transcribes them, writes `how-he-talks.md`, builds the upload pack. No TTS.
- **generate** does prepare, uploads/reuses the Fish voice, then synthesizes one line.

## Folder

`output/fish-voices/<fourcc>-<name>/` (example: `Orex-rexxar/`)

| Path | What |
| --- | --- |
| `clips/` | Unit What/Yes/… plus Frozen Throne campaign WAVs |
| `transcripts.json` | ASR cache |
| `how-he-talks.md` | How this unit talks — read before writing a new line |
| `pack/` | Concatenated WAVs sent to Fish (≤20 files, ~90 s of campaign) |
| `voice.json` | Cached Fish model id |
| `lines/<id>.txt` | Prompt (Drama 3 tags + spoken words) |
| `lines/<id>.source.wav` | Fish output, 44.1 kHz |
| `lines/<id>.wav` | Warcraft III format: 22050 Hz mono 16-bit |
| `lines/<id>.json` | Line metadata |

`slots.json` (this folder) tracks Fish voice slots so unused clones can be recycled.

## Writing a line

1. Read that unit’s `how-he-talks.md`. Story hints match **Campaign dialogue**, not hero-click barks. Ignore Pissed jokes.
2. Keep it short, first-person, concrete. Do not say “scatter” (it is a WC3 order).
3. Direct Drama 3 like a voice actor: `[emotion, intent, who he is talking to]`, then the line. `[short pause]` between beats. `<emphasis>word</emphasis>` (also `whisper`, `stress`, `soft`, `forceful`, `slow`, `fast`) for one phrase. Do not describe the clone’s timbre, and do not write negatives like `not a narrator`.
4. Show the prompt to the user, then generate.

## Map import

The `.wav` is already 22 kHz. Campaign maps usually want MP3 next to the other boss lines, then `getSoundGroup` + `playSpeech`. Dialogue `text` is the spoken words only — drop the tags.

```
bin/ffmpeg-7.0.2-essentials_build/bin/ffmpeg.exe -y -i output/fish-voices/<unit>/lines/<id>.wav -codec:a libmp3lame -q:a 4 <map>/maps/assets/wotlk/<map>/sounds/<namespace>/<file>.mp3
```
