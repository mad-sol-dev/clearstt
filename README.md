# ClearSTT

Dictation for GNOME on Wayland: press a shortcut, speak, and the transcript
lands in whatever text field has focus. Transcription runs locally.

## What it is

ClearSTT is two pieces that work together:

- **`extension/`** — a GNOME Shell extension. It records from the
  microphone, sends the audio to a transcription service, and pastes the
  result into the focused field via a simulated `Shift+Insert`
  (`Ctrl+Shift+Insert` in terminals).
- **`server/`** — a small local FastAPI service that wraps
  [faster-whisper](https://github.com/SYSTRAN/faster-whisper) behind an
  OpenAI-compatible `/v1/audio/transcriptions` endpoint, plus deterministic
  post-processing (filler-word removal, pause marking).

Everything runs on your own machine. No cloud service is required, though
the extension will talk to any OpenAI-compatible endpoint you point it at.

## How it differs

Said honestly, without superlatives — ClearSTT is neither the first nor the
only GNOME dictation extension. Two others are worth knowing about:

- **[Blurt](https://github.com/QuantiusBenignus/blurt)** — offline speech
  to text via whisper.cpp. Text lands in the PRIMARY selection; you paste
  it yourself with the middle mouse button.
- **[GNOME Speech2Text](https://github.com/kavehtehrani/speech2text-extension)**
  — pastes automatically at the cursor, but only on X11 (it uses `xdotool`
  for text insertion, which has no Wayland equivalent).

What ClearSTT does differently:

- **Automatic pasting on Wayland.** It simulates `Shift+Insert` /
  `Ctrl+Shift+Insert` through GNOME's virtual keyboard device, which works
  under Wayland. Since pasting means overwriting the clipboard, it saves
  whatever was there beforehand and restores it a configurable delay after
  pasting (best-effort — there's no signal for "the target application has
  read the clipboard", see [Configuration](#configuration)).
- **Deterministic post-processing, no LLM.** A word-list-based filler
  filter with separate lists for German and English (see
  [Text post-processing](#text-post-processing)), plus pause marking from
  Whisper's word timestamps. Same input, same output, no added latency.
- **A swappable backend.** The extension talks to any OpenAI-compatible
  `/v1/audio/transcriptions` endpoint via a configurable base URL — not a
  hardcoded whisper.cpp binary or a fixed cloud provider. Point it at the
  bundled `server/`, at a self-hosted vLLM/Voxtral deployment, or at a
  hosted OpenAI-compatible API.

## How this was built

The code in this project — both `server/` and the changes to `extension/`
— was written largely by large language models. Martin's contribution is
system design, the direction of the feature and API decisions, and review,
not typing the lines. Design choices worth naming as evidence that
something was actually being decided along the way: keeping German and
English filler-word lists separate (see below), `LEGITIMATE_DOUBLES` as an
allowlist rather than a blocklist, saving and restoring the clipboard
instead of simulating raw input events, and choosing a swappable
OpenAI-compatible endpoint over a hardwired backend.

If you use this project, factor that into how you read the code.

Questions, bugs, and suggestions: please open a
[GitHub issue](https://github.com/mad-sol-dev/clearstt/issues) — there is
deliberately no email contact for this project.

*Not legal advice: the copyright status of LLM-generated code isn't fully
settled in Germany or the US, and here it also combines with GPL-licensed
code from a third party. For a hobby project that's academic; for any
commercial use, consult a lawyer.*

## Requirements

- GNOME Shell 47–50
- An NVIDIA GPU with CUDA support for the default configuration (e.g. an
  RTX 3070 with ~2 GB free VRAM for `large-v3` in `int8_float16`); CPU-only
  operation works via `STT_DEVICE=cpu` but is noticeably slower
- Python ≥ 3.11
- Node.js ≥ 20, or [bun](https://bun.sh/) — either builds the extension

## Install

### Server

```bash
git clone https://github.com/mad-sol-dev/clearstt.git ~/clearstt
cd ~/clearstt/server
python3 -m venv .venv
.venv/bin/pip install -e .

mkdir -p ~/.config/systemd/user
cp clearstt.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now clearstt.service
```

Check it came up:

```bash
systemctl --user status clearstt
curl -s http://127.0.0.1:5112/health
```

The unit file assumes the repo lives at `~/clearstt`; edit
`WorkingDirectory` and `ExecStart` in `clearstt.service` if you cloned it
elsewhere.

### Extension

With Node (no bun required):

```bash
cd ~/clearstt/extension
npm install --ignore-scripts --include=dev   # see Troubleshooting
./build.sh
```

Or with bun:

```bash
cd ~/clearstt/extension
bun install
bun run build
```

Then install and enable it:

```bash
./install.sh
# log out and back in (Wayland reloads the shell only on session restart)
gnome-extensions enable clearstt@m-a-d.solutions
```

Open extension preferences (via the panel menu, or
`gnome-extensions prefs clearstt@m-a-d.solutions`) and set the **API base
URL** to `http://127.0.0.1:5112` if it isn't already.

## Configuration

### Server (`clearstt.service` environment)

| Variable | Default | Meaning |
|---|---|---|
| `STT_MODEL` | `large-v3` | faster-whisper model name |
| `STT_DEVICE` | `cuda` | `cuda` or `cpu` |
| `STT_COMPUTE_TYPE` | `int8_float16` | CTranslate2 compute type |
| `STT_LANGUAGE` | *(unset)* | Default language when the request omits one |
| `STT_LANGUAGE_FALLBACK` | `de` | Language used when auto-detection is uncertain |
| `STT_LANGUAGE_DETECT_THRESHOLD` | `0.6` | Below this detection confidence, fall back |
| `STT_API_KEY` | *(unset)* | Optional bearer token; unset means no auth |
| `STT_IDLE_UNLOAD_SECONDS` | `900` | Unload the model from VRAM after this much idle time |
| `STT_MAX_UPLOAD_BYTES` | `67108864` (64 MiB) | Reject larger uploads |
| `STT_REMOVE_FILLERS` | `1` | Default for the `remove_fillers` request field |
| `STT_MARK_PAUSES` | `1` | Default for the `mark_pauses` request field |
| `STT_PAUSE_THRESHOLD` | `0.8` | Seconds of silence that become `…` |
| `STT_PARAGRAPH_THRESHOLD` | `2.0` | Seconds of silence that become a paragraph break |
| `STT_PAUSE_MARKER` | `" … "` | The marker text itself |
| `STT_INITIAL_PROMPT` | *(unset)* | Whisper initial prompt — biases style and vocabulary |
| `STT_HOST` | `127.0.0.1` | Bind address |
| `STT_PORT` | `5112` | Bind port |
| `STT_REMOTE_NETWORKS` | *(unset)* | Comma-separated networks allowed to connect from outside, e.g. `10.0.0.5/32` |
| `STT_REMOTE_API_KEY` | *(unset)* | Bearer token required from those networks; unset means no remote access at all |

### Extension (preferences window / panel menu)

- **API base URL / API key / model / temperature / request timeout** —
  connection to the transcription service.
- **Language** — Automatic / German / English in the panel menu, or any
  ISO code typed into preferences. Leaving it empty is *not* the same as
  automatic: an empty form field isn't sent at all, and the server then
  falls back to its own `STT_LANGUAGE`. `auto` is the explicit value for
  "detect it".
- **Restore clipboard after pasting**, with a configurable delay — see
  [How it differs](#how-it-differs).
- **Also write to PRIMARY** — off by default; needed for pasting into
  terminals via middle-click instead of `Shift+Insert`.
- **Recent dictations kept** — how many transcripts the panel menu offers
  for copying back, for when a paste went nowhere because no field had
  focus. In-memory only, never written to disk, cleared on screen lock.
  `0` disables the list.
- **Keyboard shortcut** — `Super+z` by default, changeable or disable-able.
- **Remove filler words / Mark speech pauses / Translate to English** — the
  three server-side post-processing toggles, exposed in the panel menu.

## Remote dictation

The server can take dictation recorded on another device — a phone, say —
and have the extension paste it into whatever field has focus on the
desktop:

```bash
curl -X POST http://<desktop>:5112/v1/dictate \
  -H "Authorization: Bearer $STT_REMOTE_API_KEY" \
  -F "file=@recording.m4a" -F "language=auto" -F "mode=paste"
# -> {"text": "...", "mode": "paste", "delivered": true, "error": null}
```

`mode=paste` hands the transcript to the extension over D-Bus
(`org.gnome.Shell.Extensions.ClearSTT.InsertText` on `org.gnome.Shell`),
which pastes it the same way as a local dictation, clipboard restore
included. `mode=text` only returns it. If pasting fails — screen locked
(GNOME disables extensions on the lock screen), extension off, a local
dictation in progress — the request still succeeds with `delivered: false`
and the text, so the caller can show or read it out instead of losing it.

To submit what was just pasted, `POST /v1/key` with `key=Return` presses
Enter in the focused window (same gate, same D-Bus object, method
`PressKey`). Only keys on a short allowlist are accepted — currently just
`Return`.

Remote access is off unless configured. Loopback works exactly as before;
any other sender must be in `STT_REMOTE_NETWORKS` **and** present
`STT_REMOTE_API_KEY`, otherwise it gets 403/401. To enable it, create
`~/.config/clearstt/remote.env` (the unit reads it if present):

```bash
STT_HOST=0.0.0.0
STT_REMOTE_NETWORKS=10.0.0.5/32
STT_REMOTE_API_KEY=<openssl rand -hex 24>
```

Keep the allowed networks narrow — ideally a VPN address. Whoever passes
the gate can type into your focused window. HTTP is plain text, so only
use this over a network that is already encrypted (WireGuard or similar).

## Text post-processing

`textpost.py` on the server does mechanical, deterministic cleanup — no
LLM, no added latency, same input always gives the same output. It only
removes and marks; it never rephrases.

**Filler words and stuttering** (`remove_fillers`, on by default):
hesitation sounds like "äh", "ähm", "um", "hm" are stripped, and immediate
word repetitions are collapsed ("the the the" → "the").

The interesting part is that the filler-word lists are split by language,
deliberately:

- `FILLER_WORDS` is the German/language-agnostic base set — and it's
  deliberately short. "eh" and "na" are *not* in it, because they're real
  German words ("eh klar", "na gut") that a blanket filter would eat.
- `ENGLISH_ONLY_FILLERS` (`um`, `umm`, `er`, `err`, `erm`) is added only
  when the detected language is English. The reason is a bug that shipped
  first: `um` was originally in the unconditional list, and "Ich komme um
  5 Uhr" (*I'll arrive at 5 o'clock*) turned into "Ich komme 5 Uhr" — in
  English `um` is a filler, in German it's one of the most common
  prepositions. Same reasoning that kept "eh" and "na" out, applied one
  language later.
- `AMBIGUOUS_FILLERS` ("hm", "hmm", "mhm", …) is the trickiest case. As a
  standalone utterance these carry meaning — hesitation, doubt, or (for
  "mhm") agreement — but mid-sentence they're just a stumble. The filter
  only removes them in *embedded* position: not at the start or end of a
  sentence, not directly after sentence-final punctuation, and not as a
  standalone utterance between pause markers.

  | Input | Output | Why |
  |---|---|---|
  | `Hmm. I don't know how to go on.` | unchanged | standalone |
  | `Hmm, that's a good question.` | unchanged | start of sentence |
  | `Mhm, exactly what I meant.` | unchanged | agreement |
  | `That's … hmm … difficult.` | unchanged | between pause markers |
  | `That's hmm difficult to say.` | `That's difficult to say.` | embedded |

  "mm" is deliberately *not* in this list, although Whisper occasionally
  writes a hum that way: it's also millimetres. "5 mm dick" used to become
  "5 dick", and "Angabe in mm" has no number in front that a guard could
  check.

  Known edge case, left unfixed on purpose: if a comma before the embedded
  filler belongs to the previous clause, it's discarded along with the
  filler — "I wanted, hmm, to just ask" becomes "I wanted, to just ask".
  Deciding whether that comma is grammatically required would need real
  syntax analysis, which a word-list filter can't do.
- `LEGITIMATE_DOUBLES` is an **allowlist**, not a blocklist: words whose
  doubling carries meaning ("sehr sehr gut" / "very very good") and are
  therefore *not* collapsed as stuttering — one entry too many in this list
  lets at most one extra repetition through; one missing entry eats
  meaning. It's deliberately language-agnostic, mixing German and English
  entries ("sehr", "ganz", "ja" alongside "very", "really", "so") with no
  case distinction. German articles and "sie" are in it too: "die Frau,
  die die Tür öffnet" and "dass das das Beste ist" are regular grammar,
  so a stuttered "die die" is the price.
- Two more things never count as stuttering: **numbers** ("11 11", phone
  numbers) and **repetitions across punctuation** ("was er hat, hat er
  verdient", "Yes. Yes."). The price here is a stuttered "I, I" with a
  comma. `server/test_textpost.py` pins all of these cases down.

**Speech pauses** (`mark_pauses`, on by default): the gap between two
consecutive words, from Whisper's word timestamps, becomes `…` above
`STT_PAUSE_THRESHOLD` (0.8 s) or a paragraph break above
`STT_PARAGRAPH_THRESHOLD` (2.0 s). Requires `word_timestamps=True`
internally, which is only turned on when this option is active. In one
manual check, the marker landed one token away from the actual pause — fine
for paragraph structure, not precise enough for anything that needs
second-accurate timing.

Both toggles are per-request:

```bash
curl -X POST http://127.0.0.1:5112/v1/audio/transcriptions \
  -F "file=@recording.wav" -F "language=en" \
  -F "remove_fillers=false" -F "mark_pauses=false"
```

`STT_INITIAL_PROMPT` works one level earlier, at recognition time rather
than post-processing: Whisper tends to continue the tone of the prompt, so
a cleanly punctuated example sentence without filler words reduces how
often they show up in the first place. The same mechanism can bias
recognition toward domain vocabulary — put proper nouns or jargon in the
prompt and Whisper mishears them as common words less often.

## Troubleshooting

**`NODE_ENV=production` in your shell breaks the build.** It makes npm set
`omit=dev` internally and skip all devDependencies — silently, with a
misleading "up to date". `node_modules/` stays empty, `tsc` is missing, and
nothing points at the cause. Always pass `--include=dev`, or unset
`NODE_ENV`. This affects any Node project, not just this one.

**Why `package.json` has `overrides`.** `@girs/gnome-shell` pulls in its
own copies of the GObject typings (Clutter, St, Gio, …). Without a lockfile,
npm can resolve those to versions that don't match the top-level ones, and
`tsc` then fails with long "types of property … are incompatible" errors —
which also makes `build.sh` abort. The overrides pin the nested copies to the
same ranges as `devDependencies`.

**`npm install` runs `install.sh`.** The upstream `package.json` this
extension is forked from defines an `install` script, which npm treats as
a lifecycle hook and runs on every `npm install`. That's why the install
commands above use `--ignore-scripts`.

**`xgettext` needs `--language=JavaScript` for `.ts` files.** Without it,
`xgettext` parses TypeScript as C, where single quotes are character
literals — every `_('...')` call is silently skipped and the `.pot` file
doesn't change. The `i18n:refresh` npm script already passes this flag.

**Wayland doesn't hot-reload the shell.** After every `build.sh` /
`bun run build`, log out and back in. `Alt+F2` → `r` only works on X11.

**GPU stuck at a low power limit.** Some NVIDIA laptop GPUs (observed on
an RTX 3070) can get stuck capped at a fraction of their rated power limit
— e.g. 40 W instead of 115 W — which also collapses memory clock (observed:
810 MHz instead of 7001 MHz, roughly an eighth of normal bandwidth). Since
`int8_float16` inference is memory-bandwidth bound, this cost a measured
3.8× slowdown in one comparison (1.87 s vs. 0.49 s for the same dictation).
Nothing in the system flags this: `nvidia-smi` reports the card as healthy
and CUDA works fine, just slowly.

```bash
nvidia-smi -q -d POWER | grep 'Current Power Limit'
nvidia-smi --query-gpu=clocks.mem,clocks.max.mem --format=csv
```

A power limit well below the card's rated maximum, or a memory clock far
below its rated maximum under load, is the signature. In the case observed
here, unplugging and replugging the power adapter cleared it; a vendor
performance-mode toggle and `powerprofilesctl set performance` did not.
Worth checking first if dictation suddenly gets sluggish after a suspend
cycle.

## Origin / Credits / License

`extension/` is a fork of
[d-kurchenko/gnome-shell-extension-stt](https://github.com/d-kurchenko/gnome-shell-extension-stt)
(GPL-2.0-or-later). `server/` is original work with no code from that
project. Full attribution, including UI translation credits, is in
[CREDITS.md](CREDITS.md).

Licensed under GPL-2.0 — see [LICENSE](LICENSE). The disclosure above about
how this project was built is information, not a license restriction.

The measurements quoted in this README (timings, VRAM usage) are single
observations on one machine and one GPU, not benchmarks — they'll vary with
hardware, model, and audio length.
