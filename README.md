# Understudy

A meeting copilot that knows your work and answers in your voice.

It listens to your meetings on Zoom, Teams, Google Meet or in person, transcribes them live, and shows a private overlay with what to say when you are asked something. The answers are grounded in your own notes (Markdown files you point it at) and a profile of how you work. When a meeting ends, the transcript and notes are saved as Markdown, and Claude can read them directly.

Windows is the supported platform. "Understudy" is a working name.

## Where to start

Install and run it ([Install and run](#install-and-run)), then work down the checklist on the Home page: your name, an AI key, a speech key, a folder of your notes, your profile. That takes a few minutes and then **Start meeting** works. Use **Check what it finds** on the Knowledge page to see what your notes can answer. If you want Claude Desktop or Claude Code to read your meetings, see [Connecting Claude](#connecting-claude). If you use more than one PC, read [Where your files live](#where-your-files-live). If something breaks, see [Fixing bugs with Claude](#fixing-bugs-with-claude). To work on the code, read `CLAUDE.md` first.

## What it does

**Listening and the transcript**

- **Hears any meeting without joining it.** Your microphone (built-in, USB, headset or external) and everything the computer plays are captured as two separate sources. That separation is how it knows who is speaking: the microphone is you, the computer audio is everyone else.
- **Live transcript**, with the other speakers told apart when the provider supports it (Deepgram only). When people talk at once, each utterance is split by speaker, and a short "mm-hmm" from someone else does not cut the sentence the first person is still saying.
- **Naming speakers.** Click "Speaker 2" in the overlay and type a name; earlier and later lines from that voice change too. It can also suggest a name when someone introduces themselves, but nothing is applied until you click. See [Naming the other speakers](#naming-the-other-speakers).
- **A live copy of the transcript** is kept in the Meetings folder while a meeting runs, so another PC can follow along (or Claude can read it, with `get_live_transcript`).

**Answering**

- **Question targeting.** It works out who a question is for: you (by name, in a one-to-one call, or straight after you spoke), someone else by name, or the room. Four modes decide what it does about that (Home chip, overlay, or Settings > Behaviour):

  | Mode | Answers |
  |---|---|
  | On request | Only when you ask (shortcuts or buttons) |
  | Mine | Questions meant for you |
  | Questions | Every question, except ones put to someone else by name (the default) |
  | Suggest | Also speaks up when something is worth raising |

  A question it chose not to answer shows as a one-line hint in the overlay ("Asked of Priya: ...") with an **Answer** button, for 30 seconds.
- **On request, from any window:** what to say next, your opinion, questions to ask, a catch-up on the last few minutes, an answer about what is on your screen, or a private typed question.
- **Remembers the meeting.** When a question relates to something said earlier in the same meeting ("what did we agree about the rollback?"), the few most relevant earlier turns are added to the request, even two hours in. The whole transcript is never sent.
- **Defers instead of guessing.** For status, ownership, dates and internal numbers ("who owns that?", "when will you finish?"), the answer is a short natural line such as "I don't have that in front of me, let me check and come back to you", not an invented fact.
- **Handles vague questions** by answering the most likely reading and telling you the assumption it made.
- **Looks things up online only when it has to.** It answers from your files, your profile and the model's own knowledge first. One quick web search is allowed only for recent or product-specific facts (current defaults, limits, releases, CVEs, pricing), never for opinions, status or ownership. A product fact stated without a search ends with a "Verify:" line. Web search can be switched off in Settings > Answers.
- **A guard against invented company facts.** See [Guarding against invented company facts](#guarding-against-invented-company-facts).
- **Styles** (short, deep technical, diplomatic, devil's advocate, plain English, or your own) that you can switch mid-meeting.

**Your knowledge**

- **Knows you.** It indexes folders of `.md`, `.markdown`, `.mdx` and `.txt` files, keeps a profile of you written from them, and learns from past meetings.
- **Notes folder.** On the Knowledge page, **Quick notes** takes pasted text, a dropped text file or a pasted screenshot (Ctrl+V) and saves it as a note. Claude can save notes there too. Screenshots and other pictures are optionally read by your notes model (the **Read screenshots and images** switch on the same page: off by default, costs a little per image), so the text in them becomes searchable.
- **Architecture diagrams as text.** Diagram files in your folders are read into plain lines ("Payment Service -> Ledger DB: writes transactions") so they can be searched. Formats: Mermaid (`.mmd`, `.mermaid`), PlantUML (`.puml`, `.plantuml`, `.pu`, `.iuml`), Structurizr C4 (`.dsl`), Graphviz (`.dot`, `.gv`), draw.io (`.drawio`, `.drawio.xml`), Excalidraw (`.excalidraw`), AsciiDoc (`.adoc`, `.asciidoc`) and reStructuredText (`.rst`). Diagrams inside fenced blocks in Markdown files are read too.

**After the meeting**

- **Meeting files** in Markdown: summary, decisions, action items (yours and others'), open questions, notable details, a follow-up message, then the full transcript. A `_daily.md` roll-up is written per day. Untitled meetings are named from the conversation afterwards.
- **Tickable action items.** Tick them off on the Meetings page (or ask Claude to). A tick is kept if you rewrite the notes. Follow-up lines you add go under "Updates".
- **Rename a meeting** (click its title) and rename its speakers. The Meetings list refreshes itself when a file arrives from another PC or is changed by another program.
- **Claude connector**: an MCP server so Claude Desktop or Claude Code can read your meetings, notes and problem reports, and tick off action items. See [Connecting Claude](#connecting-claude).

**Around the edges**

- **Keys are checked when you save them** ("Saved. Works." or the reason it did not).
- **Model speed test** (Settings > Answers, or "Find the fastest..." in the Home Answers chip): times every model you have a key for, from your own connection.
- **Home dropdown chips** for microphone, computer audio, speech, answers model, style and mode, so you can change them before you start without opening Settings.
- **Report a problem** and the Issues folder: see [Fixing bugs with Claude](#fixing-bugs-with-claude).
- **One-click shared folder setup** for several PCs: see [Where your files live](#where-your-files-live).
- Every page fits the window without scrolling (the main window is at least 960 by 620; long lists scroll inside their own panel). Both a dark and a light theme.

## Install and run

You need Windows 10 (version 2004 or later) or 11 and [Node.js](https://nodejs.org) 22.12 or newer.

```bash
npm install
```

```bash
npm start
```

To build an installer (`dist\Understudy Setup 0.1.0.exe`):

```bash
npm run dist
```

## First run

The Home page has a checklist of five steps. Once they are all done it disappears and recent meetings take its place. In order:

1. **Tell it who you are** (Settings > You). Your name, and other names you are called. A question containing any of them is treated as aimed at you.
2. **Add an AI key** (Settings > API keys). Anthropic, OpenAI or Gemini.
3. **Add a speech key** (Settings > API keys). Deepgram, AssemblyAI, Groq or OpenAI. Each key is checked when you save it, and the **Test** button on Settings > Speech tries the provider again later. Keys are encrypted with your Windows account (DPAPI).
4. **Add a folder of your notes** (Knowledge > Add folder). Use "Check what it finds" to see which passages a question would pull up. For a small folder of key facts (people, owners, current status), press **Always include** beside it: every file in it then goes with every answer, whole, up to 80 thousand characters, so a word search cannot miss it. Keep that folder short and current, and leave anything private out of it, because it is sent to your AI provider each time. The Knowledge screen says how old the newest file in it is, and asks you to check it when it is more than two weeks old. On Anthropic the always-include text is cached, so questions asked a few minutes apart read it back at a tenth of the price. A passage tagged `[VERIFY]` in your notes is treated as unconfirmed: the answer says so instead of stating it as fact.
5. **Write your profile** (Knowledge > Write it from my files). Read it and correct it: it is sent with every answer.

Then **Start meeting** on Home. Until both keys are saved the button says "Add keys to start".

Connecting Claude is optional and is not part of the checklist: it lives in Settings > Claude.

Use headphones if you can. With loudspeakers the microphone also hears the call; an echo filter removes the duplicates, but headphones are cleaner.

## Using a second PC for the meeting audio

Understudy Recorder sends audio from a recorder PC to your main Understudy PC over Tailscale. Choose **The recorder listens to** in **Settings > Other PC** for either arrangement:

- The meeting plays on the recorder PC. Choose **The computer's audio**. Its computer audio is the other people. If wanted, its microphone carries your voice. **Your voice comes from** chooses the recorder PC's or the main PC's microphone. The Microphone switch in Settings > Speech controls whether your voice is captured.
- The meeting plays aloud on another PC, such as a work PC where you cannot install anything. Put the recorder PC nearby and choose **The room, through its microphone**. This is the default. Its microphone hears everybody, including you. With speaker detection on, everybody is labelled Speaker 1, Speaker 2 and so on. Rename the speaker that is you. The main PC captures nothing. The Microphone and Computer audio switches in Settings > Speech are ignored in this mode.

These settings are read when a meeting starts. End and restart a running meeting for a change to apply.

Understudy Recorder has its own one-click installer for the recorder PC.
Build it with `npm run dist:recorder` to make `dist-recorder\Understudy Recorder Setup 0.1.0.exe`.
The owner installs it by hand. The main Understudy installer is unchanged.

Install Tailscale on both PCs and sign in to the same account.
Turn off key expiry for both devices in Tailscale.
On the main PC, open **Settings > Other PC**, turn it on and press **Find my Tailscale address** to fill in the address, choosing one if several are found.
Press **Copy firewall command**, then run the copied command in an administrator PowerShell on the main PC to allow the saved port from Tailscale (`100.64.0.0/10`, or `fd7a:115c:a1e0::/48` for an IPv6 address).
Press **Test connection** to check the setup without starting a meeting: this PC listens for 30 seconds and says whether the recorder reached it. Start the recorder first, or press the button and then open the recorder. A test stops by itself, and a meeting always takes priority over it.

Press **Copy recorder settings** on the main PC.
Transfer the copied settings privately between the PCs if needed.
On the recorder PC, open **Understudy Recorder** and press **Paste and connect** in its setup window.
You can also paste into the masked text box and press **Connect**.
The recorder saves the token encrypted with your Windows account.
The packaged recorder keeps its data in `%APPDATA%\Understudy Recorder`.
Turn on **Start with Windows** in the setup window or tray menu if wanted. It is off by default.
Closing the window leaves the tray running. Choose **Open** in the tray menu to return to setup, or **Quit** to exit.

The recorder shows **Not connected** until a connection test or meeting is started on the main PC.
The main PC's listener is only open during a test or meeting.
Start the meeting on the main PC as usual.
In computer audio mode, **Your voice comes from** defaults to **The other PC's microphone**. Choose **This PC's microphone** if you speak into the main PC's microphone.
In room mode, the tray says **Sending audio from the microphone** while audio is sent.
It stops capture when you pause, end the meeting or lose the connection.
The tray icon always shows when audio is being sent.
Running `Understudy.exe --recorder` with the main app still works.

## During a meeting

| Shortcut | Does |
|---|---|
| `Alt+Shift+A` | What should I say right now? |
| `Alt+Shift+S` | Read my screen and answer what is on it |
| `Alt+Shift+T` | My take on what is being discussed |
| `Alt+Shift+C` | Catch me up on the last few minutes |
| `Alt+Shift+P` | Pause or resume listening |
| `Alt+Shift+H` | Hide or show the overlay |

All of them can be changed in Settings > Shortcuts: click one and press the new combination. They default to Alt+Shift because Ctrl+Alt is AltGr on many keyboard layouts. The overlay also has the mode switch, the style switch, sound-level meters for both sources, and a running cost estimate. Ending a meeting takes two clicks.

For an in-person meeting, turn "Computer audio" off in Settings > Speech (Audio sources). The single microphone is then treated as the whole room.

### Naming the other speakers

Click a label such as "Speaker 2" in the overlay's transcript and type a name. Earlier and later lines from that voice change too, and so do the saved file and the notes. When someone introduces themselves ("Priya here from platform"), the overlay may suggest a name; nothing is applied until you press **Use**. Suggestions use the live answers model and can be turned off in Settings > Speech. A name is only suggested if it was actually said in the meeting.

After a meeting, click a speaker on the Meetings page to rename them in the saved file. "Speaker 2" is replaced in the notes as well; if a real name was changed, you are offered **Rewrite notes**.

Speaker numbers come from Deepgram and restart whenever the connection does (after a pause, or a network drop), so "Speaker 1" afterwards may be someone else. You are told when that happens with names already given. With other speech providers everyone else is "Them", which you can still rename in a one-to-one call. Voices are never stored or recognised across meetings.

### Guarding against invented company facts

The risk with a copilot that sounds like you is that it states something about how your company does things that is not true. Three layers reduce this:

1. **Before the answer.** A local check (word rules, no model call, no delay) decides whether a question asks for a fact about your organisation: what you use, counts, dates, owners, what was tried or decided. If so, the request carries a strict instruction: only the excerpts of your files and the transcript count, not a likely guess, and the reply is a short line that buys time. Web search is switched off for that question. Any other question put to you gets a lighter rule: explain in general terms, and say "we" or "in our setup" only for what a file or the transcript states.
2. **In the answer.** For status, ownership and similar questions the standing instructions already ask it to defer.
3. **After the answer.** If a finished card states something in the present tense about how your company does things ("we already rotate keys"), and no file backs it, the card gets a muted line: "Mentions how your company does things: check it before you say it."

This is a safety net, not a guarantee. The checks are rules over words, so they miss some cases and flag some harmless ones. Always glance at a card that shows the "check it" line, and treat any claim about your own company with care.

## Providers

| Purpose | Options | Default |
|---|---|---|
| Live answers | Anthropic, OpenAI, Gemini | Anthropic `claude-haiku-5-5` |
| Notes and profile | Anthropic, OpenAI, Gemini | Anthropic `claude-opus-5-5` |
| Speech-to-text, streaming | Deepgram, AssemblyAI | Deepgram `nova-3` |
| Speech-to-text, per utterance | Groq Whisper, OpenAI | |

Other suggested models per provider (used when you switch provider):

| Provider | Live answers | Notes and profile |
|---|---|---|
| Anthropic | `claude-haiku-5-5` | `claude-opus-5-5` (also known: `claude-sonnet-5-5`, `claude-fable-5-2`) |
| OpenAI | `gpt-6-luna` | `gpt-6.1-sol` (also known: `gpt-6.1-terra`, `gpt-6-astra`) |
| Gemini | `gemini-3.5-flash-lite` | `gemini-4-argon` (also known: `gemini-3.6-flash`, `gemini-3.8-flash`) |

Model names are editable, and the **Models** button fetches what your key can use, so new models work without an update. Speech models and the language are under Settings > Speech > Advanced (AssemblyAI `universal-streaming-english`, Groq `whisper-large-v3-turbo`, OpenAI `gpt-transcribe`).

- **Gemini is an AI provider only, not a speech provider.** Pick Deepgram, AssemblyAI, Groq or OpenAI for speech.
- **A free-tier Gemini key** can run out of its web-search quota. When search is refused with a quota error, the app retries without it, answers without search for a while, and says so once per meeting.
- Deepgram is the only speech provider here that separates the other speakers (Speaker 1, Speaker 2).
- With Deepgram, silence is not sent (switchable), so you are billed for speech rather than for the length of the meeting. Pausing closes the connection, so nothing is sent or billed while paused.

## Connecting Claude

Settings > Claude > **Connect Claude Desktop** adds an `understudy` entry to `claude_desktop_config.json` (a copy of the file as it was is kept beside it the first time). Restart Claude Desktop. For Claude Code, use **Copy command** on the same panel (it prints a `claude mcp add` line with the same settings). For anything else, point it at the Meetings folder: the files are plain Markdown.

The entry runs the app's own copy of Node, so nothing else has to be installed, and carries four environment variables:

| Variable | Holds |
|---|---|
| `ELECTRON_RUN_AS_NODE` | `1` (runs the connector with the app's own runtime) |
| `UNDERSTUDY_MEETINGS_DIR` | the Meetings folder |
| `UNDERSTUDY_NOTES_DIR` | the Notes folder (turns on the notes tools) |
| `UNDERSTUDY_ISSUES_DIR` | the Issues folder (turns on the issues tools) |

The connection is rewritten automatically when the folders change or the app moves (the panel shows "needs updating" otherwise). It does nothing if you never connected Claude.

The connector offers 14 tools. Four of them write; the other ten only read.

| Tool | Does | Writes? |
|---|---|---|
| `list_meetings` | List meetings, newest first, by date or range | no |
| `get_meeting` | One meeting's notes, transcript or both | no |
| `get_live_transcript` | What is being said in a meeting running now (from the live copy file) | no |
| `search_meetings` | Search notes and transcripts for words or names | no |
| `get_daily_digest` | One day's meetings in one document | no |
| `get_action_items` | Action items across a date range | no |
| `set_action_item` | Tick an action item off, or reopen it | **yes** |
| `add_meeting_update` | Add one dated line under "Updates" in a meeting's notes | **yes** |
| `save_note` | Save a new note in the Notes folder (a title and text, never a path) | **yes** |
| `update_note` | Change a note that is already there (the last five versions are kept) | **yes** |
| `list_notes` | List saved notes | no |
| `get_note` | Read one note | no |
| `list_issues` | List the app's problem reports (open ones by default) | no |
| `get_issue` | Read one problem report | no |

The two meeting tools cannot touch the transcript, the front matter or any other line. Everything returned is introduced with a line saying it is reference material and not instructions, because other people's words, pasted notes and error messages can contain anything.

## Where your files live

By default three folders sit next to each other:

```
Documents\Understudy\Meetings   meeting files (one folder per day)
Documents\Understudy\Notes      notes, pasted screenshots, notes Claude saved
Documents\Understudy\Issues     one file per problem the app hit (see below)
```

The Issues folder is always the sibling of the Notes folder. Your own knowledge folders (Knowledge > Add folder) can be anywhere.

**Using several PCs.** Settings > Behaviour > **Sync between PCs**: choose a folder inside Google Drive (with Drive for desktop set to **Mirror files**), OneDrive or Dropbox. If the folder is not called Understudy and holds no Meetings or Notes folder, an Understudy folder is made inside it; Meetings, Notes and Issues then sit in there. If you already have meetings or notes, you are offered to copy them across (the originals stay where they are). On each other PC, choose the same folder. The app never talks to Google itself: Drive for desktop does the syncing, and the app only reads and writes files.

What goes through the shared folder: meetings, notes (with the PC that wrote each), pasted screenshots and Issues reports. The Meetings list refreshes itself as files arrive.

What is **never** synced, because it stays in `%APPDATA%\Understudy` or `%LOCALAPPDATA%\Understudy` on each PC: settings, API keys, your profile, custom styles, and the recovery copy of a running meeting (kept so that a crash does not lose it). Each PC has its own keys and settings; the path to the shared folder differs per PC.

**The live copy.** While a meeting runs, `_live-<PC name>.md` in the Meetings folder holds the transcript so far: finished turns only, from roughly the last 45 minutes, rewritten a few seconds after something changes. Each PC writes its own file, so two PCs recording at once never collide. Another PC (or Claude, through `get_live_transcript`) can follow along, a little behind the room. It is switched off with **Live copy while a meeting runs** in the same panel. The file is not a meeting and is not listed as one.

## Fixing bugs with Claude

When something unexpected breaks, the app writes one Markdown file about it into the **Issues folder**. You can add one yourself: Settings > Claude > **Report a problem** (one line saying what went wrong). The same panel shows how many problems are open and opens the folder.

- **One file per distinct problem.** A repeat raises a count instead of making a new file; a repeat of a problem marked resolved reopens it.
- **A report contains** the error message, a stack trace (paths shortened, so your home folder is shown as `%USERPROFILE%`), the last few calls the app made (names and outcomes only), the app version, Windows version, PC name, and a few settings (provider and model names, the mode, some switches).
- **A report never contains** transcript text, notes or document contents, meeting titles, API keys or tokens. One honest limit: the error message and stack are text from the running app and can occasionally quote something a document or meeting contained.
- **Fixing them.** Open Claude Code in the project folder and run `/fix-issues`. It finds the open issues, writes a failing test for each, makes the smallest fix, runs the whole suite, and only then marks the issue resolved in the file. Add the words `and rebuild` (`/fix-issues and rebuild`) to have it run `npm run dist` once at the end. The full procedure is in `docs/fixing-issues.md`.
- **Installing the fix is deliberately manual.** You install `dist\Understudy Setup 0.1.0.exe` yourself. Automatic fix-and-install is not set up on purpose: an issue file can contain text that came from a document or a meeting that someone else controls, and code written from that text must not reach your computer without you looking at it first. Claude treats the contents of issue files as data, never as instructions.

## How much it can hold

Your files are read into a search index in the background when the app starts, and only what has changed is read again after that. Measured on synthetic notes of the kind a DevSecOps engineer keeps (Markdown with headings, lists and code):

| Library | First read at startup | Re-read after a change | Memory | One search |
|---|---|---|---|---|
| A year of daily notes and runbooks: 28 MB, 765 files | 3 s | under 0.3 s | about 240 MB | 1 to 3 ms |
| Large compilations: three files, 56 MB (one of them 40 MB) | 5 s | under 0.3 s | about 440 MB | 3 to 6 ms |
| A stress case: 160 MB, 6,000 files | 18 s | 0.2 s | about 1.3 GB | 13 to 23 ms |

- **There is no size limit on a single file** short of 256 MB (anything up to that is read, in slices, so the app never freezes: the longest pause measured was 75 ms). A fact on the last page of a 40 MB compilation is found.
- **Memory is the real cost**: roughly 8 MB of memory for every MB of notes. A year of notes is comfortable; a library of several hundred MB will use gigabytes. The app allows the search index up to 4 GB.
- **Diagrams are read with limits.** Every diagram parser does bounded work, with caps on components, connections, pages and output size. A diagram gets a time budget (a quarter of a second inline); anything over 32 KB is read in a background worker with its own memory limit and a hard timeout, so a huge or hostile file cannot freeze a meeting. A draw.io or Excalidraw file over 32 MB is left out. When a limit is hit, the output says so in one plain line, or the file is indexed as plain text, or left out with a reason.
- **Pictures** are read only if you switch that on, up to 5 MB each, and each is cached by its contents so a renamed or moved picture is not paid for twice.
- **While it is still reading at startup**, answers use what has been read so far. The Knowledge page shows the counts.
- **Search is by words, not meaning.** It finds the passages that share your question's terms (with simple plural and "-ing/-ed" matching). It will not connect "cycling credentials" to a note that only says "rotation". Phrase the notes the way you say things in meetings, or add the terms you use as headings.
- **Your profile is written from a sample**, because a whole library cannot go into one request: the newest files plus an even spread over the older ones. The confirmation shows how many of your files that is. Live answers always search all of your files.
- **A long meeting** keeps working: the transcript grows turn by turn, and a request carries the recent stretch plus a few recalled earlier turns, not everything.
- Meetings: a year of them (over a thousand files) lists in well under a second.

## Privacy and safety

- **Keys** are encrypted with your Windows account, sent only to their own provider over HTTPS, and never follow environment variables or settings that point somewhere else.
- **Your files** stay on your computer. Passages relevant to a question are sent to your AI provider; anything that looks like a password, key or token is removed first, and a private key inside a diagram label is removed too. Writing your profile asks you to confirm what is being sent, and where. If you switch on picture reading, each new picture is sent once to your notes model.
- **The Issues folder** never receives meeting text, notes, titles or keys (see [Fixing bugs with Claude](#fixing-bugs-with-claude)). Nothing is sent anywhere: the files are the whole mechanism.
- **The overlay is hidden from screen shares and recordings** by default (Settings > Behaviour). A tray icon shows whether Understudy is listening, even with every window closed, and a meeting nobody has spoken in for 20 minutes is ended and saved after a warning (changeable, 0 means never).
- **Other people's words are treated as a record, not as instructions**, in the live answers, in the notes, in what Claude reads through the connector, and in what Claude Code reads when fixing issues. Past meetings feed back in as notes only, never as raw transcripts.
- **The app does not read or write Google, OneDrive or Dropbox itself.** It only uses the folder you choose.
- **A company-facts guard** exists, with the limits stated above. It does not make every answer correct.

## What has and has not been tested

**Automated tests: `npm test`, about 1,020 tests (about three minutes).** Timing-sensitive tests can occasionally miss their limit on a loaded computer and should be rerun alone (`node --test test/<file>.test.js`) before concluding anything. By area:

| Area | What is covered |
|---|---|
| Knowledge | The search index at scale (a 6 MB file, edits while open, 20 MB without freezing), diagrams in every format (including hostile and huge input, the worker and its timeout), pictures and screenshots, removal of secrets |
| Questions and answers | Question detection (real questions and statements, unpunctuated speech, names that are ordinary words), who a question is for and the four modes, the passed-question offer, the answer rules (deferring, web search, "Verify"), the company-facts guard and the "check it" line against real model answers |
| Transcript and speakers | Merging turns, interjections, people talking at once, the echo filter and voice gate, naming speakers and the suggestions, renames in saved files, recall of earlier turns, long and very long meetings |
| Meeting files | Saving, crash recovery, failed saves, last words on Stop, notes and automatic titles, rename, rewrite with ticks kept, action items, the Meetings list watcher, the live copy |
| Providers | Every AI and speech adapter against local stand-ins that speak each provider's wire format, stalled or failing providers, the Gemini search fallback, key checks, the speed test |
| Other PC and recorder | Encrypted Tailscale audio link, token checks, room and computer-audio routing, connection test, standalone recorder mode and installer file rules |
| Connector and files | The MCP server through a real MCP client (all 14 tools), the Claude configuration file, the Notes folder, the shared-folder setup and copy, the Issues folder |
| Hardening | Security fixes, argument checking on every IPC channel, window size and place, error wording |

**Tested by driving the real app** (`test/e2e/run.js`, `test/e2e/overlay-ui.js`; these use Playwright, which is not a project dependency and is installed separately): every page; a whole meeting with a stand-in speech service and a stand-in AI service, from microphone to saved notes; the overlay at its smallest size; the connector through a real MCP client; the shared-folder flow; notes and pasted screenshots; crash recovery.

**Verified on Windows earlier:** real computer-audio loopback capture, all six shortcuts, hiding the overlay from screen capture, the packaged app launching, and the installer building.

**Run once against a real model** (Google Gemini, free tier, about 100 requests in total): answers, deferrals, name suggestions, notes and automatic titles, rename and rewrite, picture description, and error wording.

**Not yet tested:**

- Real Deepgram, Anthropic, OpenAI, AssemblyAI or Groq services. Their adapters were written from each provider's documentation and checked against stand-ins, not against the live APIs.
- Real web search results. The free Gemini key's search quota blocked it, so only the fallback was seen.
- The tray icon.
- Google Drive syncing itself, and the real Claude Desktop connection beyond the configuration file it reads.
- Real overlapping speech: a mixed audio stream cannot be separated by software, so only the splitting of speakers the provider has already told apart is tested.
- Claude Haiku (the default live model) with the newer answer rules and the company-facts guard. The "check it" rules were tuned on a small set of real model answers, not on Haiku's in particular.
- Corporate proxies and TLS inspection: provider calls use Node's networking, not Windows' proxy settings.

**Known weak spots**

- The model can still occasionally state something about the company that is not in your files or profile. The guard and the "check it" line reduce this. Always glance at cards marked "check it", and double-check any claim about how your company works.
- Speaker numbers restart after a reconnect.
- Speaker separation works only with Deepgram.
- Search matches words, not meaning.
- When the meeting app plays somewhere other than the Windows default output device, the meeting-audio meter stays flat, and after about 75 seconds you are told what to change.

If something does not start, the overlay shows the reason at the top.

## Layout

```
CLAUDE.md          rules for working on the code (read this first)
electron-builder.recorder.json  standalone Understudy Recorder build
src/main/          main process
  main.js          windows and IPC handlers
  session.js       one live meeting: audio in, cards out
  triggers.js      who a question is for, and whether to answer it
  transcript.js    turns, interjections, recall of earlier turns
  prompts.js       the instructions sent to the model
  org-question.js  local check: does a question ask for a company fact
  claims.js        local check: does an answer state one ("check it")
  speaker-names.js name suggestions
  settings.js      settings and keys
  validate.js      checks every argument that crosses IPC
  channel-plan.js  chooses local, remote computer or remote room audio
  network-detect.js  finds local Tailscale addresses
  remote-config.js encrypted token and settings for the other PC
  remote-link.js   authenticated WebSocket link between main PC and recorder
  remote-bridge.js feeds remote audio into a live meeting
  remote-test.js   30-second connection test listener
  recorder-entry.js  entry point for the standalone recorder build
  recorder-mode.js tray and setup window on the recorder PC
  issues.js        the Issues folder
  notes-inbox.js   the Notes folder
  shared-folder.js "Sync between PCs"
  live-copy.js     _live-<PC>.md
  keycheck.js      checks a key when it is saved
  claude-connect.js  the Claude Desktop connection
  crashlog.js      local crash log
  window-state.js  window size and place
  knowledge/       Markdown chunking, search, diagrams (and their worker), pictures
  llm/             Anthropic, OpenAI and Gemini adapters, speed test
  stt/             Deepgram, AssemblyAI, per-utterance adapter, silence gate
  meetings/        meeting files, notes, daily digest, rewrite carry-over, folder watcher
src/mcp/           the MCP server Claude connects to
src/renderer/      main window, overlay, recorder setup window, hidden audio-capture window
src/preload.js     the only IPC channels the main and overlay windows may call
src/recorder-preload.js  the only IPC channels the recorder setup window may call
personalities/     built-in styles
assets/            icons
docs/              fixing-issues.md and screenshots
.claude/commands/  /fix-issues
test/              unit and integration tests, stand-ins (mocks.js), end-to-end drivers
```

Data lives in three places: settings, keys, your profile, custom styles and the picture-description cache in `%APPDATA%\Understudy`; the recovery copy of a running meeting and crash logs under `%LOCALAPPDATA%\Understudy` and `%APPDATA%\Understudy\logs`; and meetings, notes and Issues in their folders (by default under `Documents\Understudy`).
