import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gst from 'gi://Gst';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup';
import St from 'gi://St';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// ── D-Bus ──────────────────────────────────────────────────────────────
// Entry point for text dictated elsewhere (e.g. on a phone, transcribed by
// the server's /v1/dictate). Exported on the Shell's own session-bus
// connection, so callers address org.gnome.Shell.
const DBUS_OBJECT_PATH = '/org/gnome/Shell/Extensions/ClearSTT';
const DBUS_INTERFACE_XML = `
<node>
  <interface name="org.gnome.Shell.Extensions.ClearSTT">
    <method name="InsertText">
      <arg type="s" direction="in" name="text"/>
    </method>
    <method name="PressKey">
      <arg type="s" direction="in" name="key"/>
    </method>
  </interface>
</node>`;

// What PressKey may press. Deliberately short: whoever reaches the bus
// should not be able to trigger arbitrary key combinations.
const PRESSABLE_KEYS: Record<string, number> = {
  Return: Clutter.KEY_Return,
};

// ── Helpers ──────────────────────────────────────────────────────────────

function showShellNotification(messageTitle: string, messageDetails: string): void {
  try { Main.notify(messageTitle, messageDetails); } catch (_) {}
}

let gstreamerRuntimeInitialized = false;
function ensureGStreamerRuntimeInitialized(): void {
  if (gstreamerRuntimeInitialized) return;
  Gst.init(null);
  gstreamerRuntimeInitialized = true;
}

function waitForGStreamerBusEndOfStreamOrError(
  bus: Gst.Bus,
  timeoutMilliseconds: number,
): Promise<Gst.Message | null> {
  return new Promise(resolve => {
    let finished = false;
    let busWatchSourceId = 0;
    let timeoutSourceId = 0;

    const finish = (message: Gst.Message | null, removeBusWatch: boolean) => {
      if (finished) return;
      finished = true;
      if (timeoutSourceId) {
        GLib.source_remove(timeoutSourceId);
        timeoutSourceId = 0;
      }
      if (removeBusWatch && busWatchSourceId) {
        GLib.source_remove(busWatchSourceId);
        busWatchSourceId = 0;
      }
      resolve(message);
    };

    busWatchSourceId = bus.add_watch(GLib.PRIORITY_DEFAULT, (_bus, message) => {
      if (finished) return GLib.SOURCE_REMOVE;
      const messageType = message.type;
      if (messageType === Gst.MessageType.EOS || messageType === Gst.MessageType.ERROR) {
        finish(message, false);
        return GLib.SOURCE_REMOVE;
      }
      return GLib.SOURCE_CONTINUE;
    });

    timeoutSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMilliseconds, () => {
      finish(null, true);
      return GLib.SOURCE_REMOVE;
    });
  });
}

function createGStreamerMicrophoneSourceElement(): Gst.Element {
  const elementFactoryNamesToTry = ['pulsesrc', 'pipewiresrc', 'autoaudiosrc'] as const;
  for (const factoryName of elementFactoryNamesToTry) {
    const element = Gst.ElementFactory.make(factoryName, null);
    if (element) {
      if (factoryName === 'pulsesrc') (element as any).set_property('device', 'default');
      return element;
    }
  }
  throw new Error('No GStreamer microphone element (install gst-plugins-good / PipeWire plugins)');
}

// ── Recorder ─────────────────────────────────────────────────────────────

class SpeechToTextAudioRecorder {
  private pipeline: Gst.Pipeline | null = null;
  private readonly recordingOutputFilePath: string;

  constructor() {
    this.recordingOutputFilePath = GLib.build_filenamev([
      GLib.get_tmp_dir(),
      'speech_to_text_last_recording.wav',
    ]);
  }

  start(): void {
    ensureGStreamerRuntimeInitialized();

    const outputFile = Gio.File.new_for_path(this.recordingOutputFilePath);
    if (outputFile.query_exists(null)) outputFile.delete(null);

    const pipeline = new Gst.Pipeline({ name: 'speech-to-text-record' });
    const source = createGStreamerMicrophoneSourceElement();
    const convert = Gst.ElementFactory.make('audioconvert', null);
    const resample = Gst.ElementFactory.make('audioresample', null);
    const capsFilter = Gst.ElementFactory.make('capsfilter', null);
    const wavEncoder = Gst.ElementFactory.make('wavenc', null);
    const fileSink = Gst.ElementFactory.make('filesink', null);

    if (!convert || !resample || !capsFilter || !wavEncoder || !fileSink) {
      throw new Error('Missing GStreamer elements (need gst-plugins-base/good: audioconvert, wavenc, …)');
    }

    const caps = Gst.Caps.from_string('audio/x-raw,format=S16LE,rate=16000,channels=1');
    (capsFilter as any).set_property('caps', caps);

    (fileSink as any).set_property('location', this.recordingOutputFilePath);
    (fileSink as any).set_property('sync', false);

    pipeline.add(source);
    pipeline.add(convert);
    pipeline.add(resample);
    pipeline.add(capsFilter);
    pipeline.add(wavEncoder);
    pipeline.add(fileSink);

    if (!source.link(convert)) throw new Error('GStreamer link failed (source→convert)');
    if (!convert.link(resample)) throw new Error('GStreamer link failed (convert→resample)');
    if (!resample.link(capsFilter)) throw new Error('GStreamer link failed (resample→capsFilter)');
    if (!capsFilter.link(wavEncoder)) throw new Error('GStreamer link failed (capsFilter→wavEncoder)');
    if (!wavEncoder.link(fileSink)) throw new Error('GStreamer link failed (wavEncoder→fileSink)');

    const stateChangeReturn = pipeline.set_state(Gst.State.PLAYING);
    if (stateChangeReturn === Gst.StateChangeReturn.FAILURE) {
      pipeline.set_state(Gst.State.NULL);
      throw new Error('GStreamer could not start recording (PLAYING failed)');
    }

    this.pipeline = pipeline;
  }

  async stop(): Promise<string | null> {
    const pipeline = this.pipeline;
    if (!pipeline) return null;
    this.pipeline = null;

    const bus = pipeline.get_bus();
    if (!bus) {
      pipeline.set_state(Gst.State.NULL);
      return null;
    }

    pipeline.send_event(Gst.Event.new_eos());
    const busMessage = await waitForGStreamerBusEndOfStreamOrError(bus, 20000);

    pipeline.set_state(Gst.State.NULL);

    if (!busMessage || busMessage.type === Gst.MessageType.ERROR) {
      if (busMessage?.type === Gst.MessageType.ERROR) {
        const [glibError] = busMessage.parse_error();
        log(`[Speech to Text] Recording stop error: ${glibError?.message ?? glibError}`);
      }
      try {
        const file = Gio.File.new_for_path(this.recordingOutputFilePath);
        if (file.query_exists(null)) file.delete(null);
      } catch (_) {}
      return null;
    }

    const file = Gio.File.new_for_path(this.recordingOutputFilePath);
    if (!file.query_exists(null)) return null;
    const fileInfo = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
    if (!fileInfo || fileInfo.get_size() < 44) return null;
    return this.recordingOutputFilePath;
  }

  cancel(): void {
    const pipeline = this.pipeline;
    this.pipeline = null;
    if (!pipeline) return;
    pipeline.set_state(Gst.State.NULL);
    try {
      const outputFile = Gio.File.new_for_path(this.recordingOutputFilePath);
      if (outputFile.query_exists(null)) outputFile.delete(null);
    } catch (_) {}
  }
}

// ── Local transcription (OpenAI-compatible endpoint) ──────────────────────

function buildUserAgentStringFromMetadata(metadata: {
  name?: string;
  url?: string;
  version?: string | number;
}): string {
  const applicationDisplayTitle =
    (metadata.name && String(metadata.name).trim()) ||
    'Speech to Text (GNOME Shell extension)';
  const applicationRefererUrl =
    (metadata.url && String(metadata.url).trim()) ||
    'https://github.com/mad-sol-dev/clearstt';
  const versionString =
    metadata.version !== undefined && metadata.version !== null
      ? String(metadata.version)
      : '0';
  return (
    `${applicationDisplayTitle.replace(/\s+/g, '-')}/${versionString} ` +
    `(GNOME Shell extension; ${applicationRefererUrl})`
  );
}

function deleteFileIfExists(filePath: string): void {
  try {
    const file = Gio.File.new_for_path(filePath);
    if (file.query_exists(null)) file.delete(null);
  } catch {
    // Cleanup is best effort — errors here must not disrupt the flow.
  }
}

type TranscriptionRequestOptions = Readonly<{
  audioFilePath: string;
  apiBaseUrl: string;
  apiKey: string;
  modelIdentifier: string;
  language: string;
  translateToEnglish: boolean;
  removeFillers: boolean;
  markPauses: boolean;
  samplingTemperature: number;
  requestTimeoutSeconds: number;
  userAgentString: string;
  cancellable: Gio.Cancellable;
}>;

function buildMultipartFormDataBody(
  boundary: string,
  textFields: ReadonlyArray<readonly [string, string]>,
  fileFieldName: string,
  fileName: string,
  fileContentType: string,
  fileBytes: Uint8Array,
): Uint8Array {
  const textEncoder = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const [fieldName, fieldValue] of textFields) {
    if (fieldValue === '') continue;
    chunks.push(textEncoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"\r\n\r\n${fieldValue}\r\n`,
    ));
  }

  chunks.push(textEncoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fileFieldName}"; ` +
    `filename="${fileName}"\r\nContent-Type: ${fileContentType}\r\n\r\n`,
  ));
  chunks.push(fileBytes);
  chunks.push(textEncoder.encode(`\r\n--${boundary}--\r\n`));

  const totalByteLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const body = new Uint8Array(totalByteLength);
  let writeOffset = 0;
  for (const chunk of chunks) {
    body.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }
  return body;
}

async function requestTranscription(options: TranscriptionRequestOptions): Promise<string> {
  const audioFile = Gio.File.new_for_path(options.audioFilePath);
  const [fileBytes] = await audioFile.load_contents_async(options.cancellable);
  if (!fileBytes?.length) throw new Error('Failed to read audio file');

  const boundary = `----SttBoundary${GLib.uuid_string_random().replace(/-/g, '')}`;
  const requestBody = buildMultipartFormDataBody(
    boundary,
    [
      ['model', options.modelIdentifier],
      ['language', options.language],
      ['task', options.translateToEnglish ? 'translate' : 'transcribe'],
      ['remove_fillers', options.removeFillers ? 'true' : 'false'],
      ['mark_pauses', options.markPauses ? 'true' : 'false'],
      ['temperature', String(options.samplingTemperature)],
      ['response_format', 'json'],
    ],
    'file',
    'speech.wav',
    'audio/wav',
    fileBytes,
  );

  const endpointUrl = `${options.apiBaseUrl.replace(/\/+$/, '')}/v1/audio/transcriptions`;
  const httpMessage = Soup.Message.new('POST', endpointUrl);
  if (!httpMessage) throw new Error(`Invalid API base URL: ${options.apiBaseUrl}`);

  httpMessage.set_request_body_from_bytes(
    `multipart/form-data; boundary=${boundary}`,
    new GLib.Bytes(requestBody),
  );
  const headers = httpMessage.request_headers;
  if (options.apiKey) headers.append('Authorization', `Bearer ${options.apiKey}`);

  const httpSession = new Soup.Session({ timeout: options.requestTimeoutSeconds });
  httpSession.user_agent = options.userAgentString;

  const responseBytes = await httpSession.send_and_read_async(
    httpMessage,
    GLib.PRIORITY_DEFAULT,
    options.cancellable,
  );
  const httpStatusCode = httpMessage.get_status();
  if (httpStatusCode !== Soup.Status.OK) {
    throw new Error(`HTTP ${httpStatusCode}: ${Soup.status_get_phrase(httpStatusCode)}`);
  }

  const responseUtf8Text = new TextDecoder('utf-8').decode(responseBytes.get_data()!);
  const parsedResponseBody: any = JSON.parse(responseUtf8Text);

  if (parsedResponseBody?.error) {
    const apiErrorMessage =
      parsedResponseBody.error?.message ?? JSON.stringify(parsedResponseBody.error);
    throw new Error(`Transcription API error: ${apiErrorMessage}`);
  }

  const messageContent = parsedResponseBody?.text;
  return typeof messageContent === 'string' ? messageContent.trim() : '';
}

// ── Save and restore the clipboard ─────────────────────────────────────────

/**
 * What was in the clipboard before the dictation.
 *
 * `St.Clipboard.set_content` can only write back *one* format. For
 * multi-format content (rich text as HTML *and* as plain text), only the
 * chosen format survives — the API doesn't offer more.
 */
type ClipboardSnapshot =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'content'; readonly mimetype: string; readonly bytes: Uint8Array };

/**
 * Upper bound for saved non-text content.
 *
 * The copy lives in gnome-shell's memory. A huge image on the clipboard
 * isn't worth saving.
 */
const CLIPBOARD_SNAPSHOT_SIZE_LIMIT = 16 * 1024 * 1024;

/** X11 meta targets that aren't content, but information about the selection. */
const CLIPBOARD_METADATA_TARGETS = new Set([
  'TARGETS', 'MULTIPLE', 'TIMESTAMP', 'SAVE_TARGETS', 'DELETE', 'INSERT_SELECTION',
]);

function isTextClipboardMimetype(mimetype: string): boolean {
  return (
    mimetype.startsWith('text/') ||
    mimetype === 'UTF8_STRING' ||
    mimetype === 'STRING' ||
    mimetype === 'COMPOUND_TEXT'
  );
}

function readClipboardTextAsync(clipboard: St.Clipboard): Promise<string | null> {
  return new Promise(resolve => {
    clipboard.get_text(St.ClipboardType.CLIPBOARD, (_clipboard: any, text: string | null) => {
      resolve(text || null);
    });
  });
}

/**
 * Read non-text content — as our own copy.
 *
 * The `GBytes` from the callback is only *borrowed*: St frees it as soon as
 * the callback returns (`transfer none` in St-16.gir), and GJS holds no
 * reference of its own to it. A later `set_content` with this object would
 * therefore access freed memory — `g_bytes_ref` on a dead refcount, heap
 * corruption, crashing gnome-shell and with it the whole session. The
 * `resolve` below would already run too late: promise continuations only
 * run after the callback returns. The payload is therefore copied into
 * JS-owned memory still inside the callback; after that the `GBytes` is
 * meaningless.
 */
function readClipboardContentAsync(
  clipboard: St.Clipboard,
  mimetype: string,
): Promise<Uint8Array | null> {
  return new Promise(resolve => {
    clipboard.get_content(St.ClipboardType.CLIPBOARD, mimetype, (_clipboard: any, bytes: any) => {
      let copy: Uint8Array | null = null;
      try {
        const size = bytes ? bytes.get_size() : 0;
        if (size > 0 && size <= CLIPBOARD_SNAPSHOT_SIZE_LIMIT) {
          const borrowed = bytes.get_data();
          if (borrowed && borrowed.length > 0) copy = new Uint8Array(borrowed);
        }
      } catch (error) {
        log(`[Speech to Text] Clipboard content: ${error}`);
      }
      resolve(copy);
    });
  });
}

function resolveAfterMilliseconds<T>(milliseconds: number, value: T): Promise<T> {
  return new Promise(resolve => {
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
      resolve(value);
      return GLib.SOURCE_REMOVE;
    });
  });
}

/** Prefers images, otherwise the first real format. */
function pickRestorableNonTextMimetype(mimetypes: readonly string[]): string | null {
  const candidates = mimetypes.filter(m => !CLIPBOARD_METADATA_TARGETS.has(m));
  return candidates.find(m => m === 'image/png')
    ?? candidates.find(m => m.startsWith('image/'))
    ?? candidates[0]
    ?? null;
}

async function captureClipboardSnapshot(): Promise<ClipboardSnapshot | null> {
  const clipboard = St.Clipboard.get_default();
  if (!clipboard) return null;

  let offeredMimetypes: string[] = [];
  try {
    offeredMimetypes = clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD) ?? [];
  } catch (error) {
    log(`[Speech to Text] Clipboard mimetypes: ${error}`);
  }

  const holdsText =
    offeredMimetypes.length === 0 || offeredMimetypes.some(isTextClipboardMimetype);
  if (holdsText) {
    const text = await readClipboardTextAsync(clipboard);
    return text ? { kind: 'text', text } : null;
  }

  const mimetype = pickRestorableNonTextMimetype(offeredMimetypes);
  if (!mimetype) return null;
  const bytes = await readClipboardContentAsync(clipboard, mimetype);
  return bytes ? { kind: 'content', mimetype, bytes } : null;
}

/**
 * Save with a time limit.
 *
 * On Wayland, the owning application delivers the content itself. If it
 * hangs, the response would never arrive — and the dictation would silently
 * stall. After one second, we therefore proceed without a saved snapshot.
 */
function captureClipboardSnapshotWithTimeout(): Promise<ClipboardSnapshot | null> {
  return Promise.race([
    captureClipboardSnapshot().catch(error => {
      log(`[Speech to Text] Clipboard snapshot: ${error}`);
      return null;
    }),
    resolveAfterMilliseconds<ClipboardSnapshot | null>(1000, null),
  ]);
}

function restoreClipboardSnapshot(snapshot: ClipboardSnapshot): void {
  const clipboard = St.Clipboard.get_default();
  if (!clipboard) return;
  try {
    if (snapshot.kind === 'text') {
      clipboard.set_text(St.ClipboardType.CLIPBOARD, snapshot.text);
    } else {
      // Fresh GBytes from our own copy — see readClipboardContentAsync.
      const bytes = new GLib.Bytes(snapshot.bytes);
      clipboard.set_content(St.ClipboardType.CLIPBOARD, snapshot.mimetype, bytes);
    }
  } catch (error) {
    log(`[Speech to Text] Clipboard restore: ${error}`);
  }
}

/** Single-line preview for the menu entry. */
function buildSingleLinePreview(text: string, maximumLength: number = 42): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maximumLength) return collapsed;
  return `${collapsed.slice(0, maximumLength - 1)}…`;
}

// ── Sound (GStreamer playbin) ────────────────────────────────────────────

const GSTREAMER_PLAYBIN_FLAGS_AUDIO_ONLY = 1 << 1;

function playSoundEffectFromFile(filePath: string, volumePercent: number = 100): void {
  const soundFile = Gio.File.new_for_path(filePath);
  if (!soundFile.query_exists(null)) return;

  try {
    ensureGStreamerRuntimeInitialized();
    const playbinElement = Gst.ElementFactory.make('playbin', null) as Gst.Bin | null;
    if (!playbinElement) {
      log('[Speech to Text] playbin element unavailable');
      return;
    }

    const fileUri = soundFile.get_uri();
    (playbinElement as any).set_property('uri', fileUri);
    (playbinElement as any).set_property('volume', Math.max(0, Math.min(1, volumePercent / 100)));
    (playbinElement as any).set_property('flags', GSTREAMER_PLAYBIN_FLAGS_AUDIO_ONLY);

    const bus = playbinElement.get_bus();
    if (!bus) {
      playbinElement.set_state(Gst.State.NULL);
      return;
    }

    let busWatchSourceId = 0;
    busWatchSourceId = bus.add_watch(GLib.PRIORITY_DEFAULT, (_bus, message) => {
      const messageType = message.type;
      if (messageType === Gst.MessageType.EOS || messageType === Gst.MessageType.ERROR) {
        if (messageType === Gst.MessageType.ERROR) {
          const [glibError] = message.parse_error();
          log(`[Speech to Text] Sound playback: ${glibError?.message ?? glibError}`);
        }
        playbinElement.set_state(Gst.State.NULL);
        if (busWatchSourceId) GLib.source_remove(busWatchSourceId);
        return GLib.SOURCE_REMOVE;
      }
      return GLib.SOURCE_CONTINUE;
    });

    const stateChangeReturn = playbinElement.set_state(Gst.State.PLAYING);
    if (stateChangeReturn === Gst.StateChangeReturn.FAILURE) {
      if (busWatchSourceId) GLib.source_remove(busWatchSourceId);
      playbinElement.set_state(Gst.State.NULL);
    }
  } catch (error) {
    log(`[Speech to Text] playSoundEffectFromFile: ${error}`);
  }
}

// ── Extension ────────────────────────────────────────────────────────────

/**
 * Let the language be detected automatically.
 *
 * An *empty* value doesn't work for this: empty form fields aren't sent at
 * all, and the service then falls back to its own default.
 */
const LANGUAGE_AUTO = 'auto';

/**
 * Choices in the panel menu. The labels are functions so that `_()` only
 * runs when the menu is built, not when the module loads — at that point
 * the translation isn't ready yet.
 */
const LANGUAGE_MENU_CHOICES: ReadonlyArray<readonly [string, () => string]> = [
  [LANGUAGE_AUTO, () => _('Automatic')],
  ['de', () => _('German')],
  ['en', () => _('English')],
];

const PANEL_INDICATOR_BOX_LEFT = 'left';
const PANEL_INDICATOR_BOX_CENTER = 'center';
const PANEL_INDICATOR_BOX_RIGHT = 'right';

const GSETTINGS_SCHEMA_KEY_NAMES = {
  API_BASE_URL: 'api-base-url',
  API_KEY: 'api-key',
  LANGUAGE: 'language',
  MAX_RECORDING_SECONDS: 'max-recording-seconds',
  SET_PRIMARY_SELECTION: 'set-primary-selection',
  RESTORE_CLIPBOARD: 'restore-clipboard',
  CLIPBOARD_RESTORE_DELAY: 'clipboard-restore-delay',
  HISTORY_SIZE: 'history-size',
  TRANSLATE_TO_ENGLISH: 'translate-to-english',
  REMOVE_FILLERS: 'remove-fillers',
  MARK_PAUSES: 'mark-pauses',
  MODEL: 'model',
  TEMPERATURE: 'temperature',
  EMPTY_SPEECH_ACTION: 'empty-speech-action',
  EMPTY_SPEECH_PLACEHOLDER: 'empty-speech-placeholder',
  SHOW_ICON: 'show-icon',
  PANEL_INDICATOR_BOX: 'panel-indicator-box',
  PANEL_INDICATOR_POSITION: 'panel-indicator-position',
  PLAY_SOUND: 'play-sound',
  REQUEST_TIMEOUT: 'request-timeout',
  TOGGLE_SHORTCUT: 'toggle-shortcut',
  ENABLE_SHORTCUTS: 'enable-shortcuts',
  SOUND_VOLUME: 'sound-volume',
} as const;

function panelIndicatorBoxKeyForAddToStatusArea(
  settings: Gio.Settings,
): 'left' | 'center' | 'right' {
  const boxKey = settings.get_string(GSETTINGS_SCHEMA_KEY_NAMES.PANEL_INDICATOR_BOX);
  if (boxKey === PANEL_INDICATOR_BOX_LEFT || boxKey === PANEL_INDICATOR_BOX_CENTER || boxKey === PANEL_INDICATOR_BOX_RIGHT) {
    return boxKey;
  }
  return PANEL_INDICATOR_BOX_RIGHT;
}

/**
 * Panel button with separate click behavior.
 *
 * `PanelMenu.Button` opens its menu in `vfunc_event`. An additional
 * `button-press-event` handler would run alongside it instead of replacing
 * it — then both actions would fire at once. `vfunc_event` is therefore
 * fully overridden here: left click records, right click opens the menu.
 */
const SpeechToTextPanelButton = GObject.registerClass(
  class SpeechToTextPanelButton extends PanelMenu.Button {
    public onPrimaryClick: (() => void) | null = null;

    vfunc_event(event: any): boolean {
      const eventType = event.type();
      const isPress =
        eventType === Clutter.EventType.BUTTON_PRESS ||
        eventType === Clutter.EventType.TOUCH_BEGIN;

      if (isPress && this.menu) {
        const pressedButton =
          eventType === Clutter.EventType.BUTTON_PRESS ? event.get_button() : Clutter.BUTTON_PRIMARY;

        if (pressedButton === Clutter.BUTTON_SECONDARY) {
          this.menu.toggle();
          return Clutter.EVENT_STOP;
        }
        if (pressedButton === Clutter.BUTTON_PRIMARY) {
          if ((this.menu as any).isOpen) (this.menu as any).close();
          this.onPrimaryClick?.();
          return Clutter.EVENT_STOP;
        }
      }
      return Clutter.EVENT_PROPAGATE;
    }
  },
);

export default class SpeechToTextExtension extends Extension {
  private settings: Gio.Settings | null = null;
  private recorder: SpeechToTextAudioRecorder | null = null;
  private recording = false;
  private transcribing = false;
  private button: PanelMenu.Button | null = null;
  private iconWidget: St.Bin | null = null;
  private showIconSettingsConnectionId = 0;
  private panelIndicatorPositionSettingsConnectionId = 0;
  private panelIndicatorBoxSettingsConnectionId = 0;
  private enableShortcutsSettingsConnectionId = 0;

  private virtualKeyboardDevice: any = null;
  private contentPurpose: number = Clutter.InputContentPurpose.NORMAL;
  private contentPurposeSignalConnectionId = 0;
  private toggleShortcutSettingsConnectionId = 0;
  private panelButtonPressEventSignalId = 0;
  private pasteIntoActiveFieldTimeoutSourceId = 0;
  private recordingTimeLimitSourceId = 0;
  private transcriptionCancellable: Gio.Cancellable | null = null;
  private statusMenuItem: any = null;
  private menuSettingsConnectionIds: number[] = [];
  private clipboardRestoreTimeoutSourceId = 0;
  private pendingClipboardSnapshot: ClipboardSnapshot | null = null;
  /** Recent dictations, newest first. In-memory only. */
  private transcriptionHistory: string[] = [];
  private historyMenuSection: any = null;
  private languageMenuItem: any = null;
  private languageChoiceItems: Array<[string, any]> = [];
  private layoutManagerStartupCompleteSignalConnectionId = 0;
  private dbusExportedObject: Gio.DBusExportedObject | null = null;

  enable(): void {
    this.settings = this.getSettings();
    this.recorder = new SpeechToTextAudioRecorder();

    this._initVirtualKeyboard();

    this._bindShortcuts();
    if (Main.layoutManager._startingUp) {
      this.layoutManagerStartupCompleteSignalConnectionId = Main.layoutManager.connect(
        'startup-complete',
        () => {
          if (this.layoutManagerStartupCompleteSignalConnectionId) {
            Main.layoutManager.disconnect(this.layoutManagerStartupCompleteSignalConnectionId);
            this.layoutManagerStartupCompleteSignalConnectionId = 0;
          }
          if (!this.settings) return;
          this._rebindShortcuts();
        },
      );
    }

    this.toggleShortcutSettingsConnectionId = this.settings.connect(
      `changed::${GSETTINGS_SCHEMA_KEY_NAMES.TOGGLE_SHORTCUT}`,
      () => this._rebindShortcuts(),
    );
    this.enableShortcutsSettingsConnectionId = this.settings.connect(
      `changed::${GSETTINGS_SCHEMA_KEY_NAMES.ENABLE_SHORTCUTS}`,
      () => this._rebindShortcuts(),
    );

    this.showIconSettingsConnectionId = this.settings.connect(
      `changed::${GSETTINGS_SCHEMA_KEY_NAMES.SHOW_ICON}`,
      () => this._updateIcon(),
    );

    this.panelIndicatorPositionSettingsConnectionId = this.settings.connect(
      `changed::${GSETTINGS_SCHEMA_KEY_NAMES.PANEL_INDICATOR_POSITION}`,
      () => this._repositionPanelIndicatorFromSettings(),
    );
    this.panelIndicatorBoxSettingsConnectionId = this.settings.connect(
      `changed::${GSETTINGS_SCHEMA_KEY_NAMES.PANEL_INDICATOR_BOX}`,
      () => this._repositionPanelIndicatorFromSettings(),
    );

    this._updateIcon();
    this._exportDBusInterface();
  }

  disable(): void {
    this._unexportDBusInterface();
    if (this.recording) this.recorder?.cancel();
    this.recorder = null;

    this._clearRecordingTimeLimit();
    this._cancelPendingClipboardRestore();
    // Don't leave dictations in the shell's memory. This also applies to
    // locking the screen — that deactivates the extension.
    this.transcriptionHistory = [];

    if (this.transcriptionCancellable) {
      this.transcriptionCancellable.cancel();
      this.transcriptionCancellable = null;
    }

    if (this.pasteIntoActiveFieldTimeoutSourceId) {
      GLib.source_remove(this.pasteIntoActiveFieldTimeoutSourceId);
      this.pasteIntoActiveFieldTimeoutSourceId = 0;
    }

    if (this.showIconSettingsConnectionId && this.settings) {
      this.settings.disconnect(this.showIconSettingsConnectionId);
      this.showIconSettingsConnectionId = 0;
    }

    if (this.panelIndicatorPositionSettingsConnectionId && this.settings) {
      this.settings.disconnect(this.panelIndicatorPositionSettingsConnectionId);
      this.panelIndicatorPositionSettingsConnectionId = 0;
    }

    if (this.panelIndicatorBoxSettingsConnectionId && this.settings) {
      this.settings.disconnect(this.panelIndicatorBoxSettingsConnectionId);
      this.panelIndicatorBoxSettingsConnectionId = 0;
    }

    if (this.toggleShortcutSettingsConnectionId && this.settings) {
      this.settings.disconnect(this.toggleShortcutSettingsConnectionId);
      this.toggleShortcutSettingsConnectionId = 0;
    }

    if (this.enableShortcutsSettingsConnectionId && this.settings) {
      this.settings.disconnect(this.enableShortcutsSettingsConnectionId);
      this.enableShortcutsSettingsConnectionId = 0;
    }

    if (this.layoutManagerStartupCompleteSignalConnectionId) {
      Main.layoutManager.disconnect(this.layoutManagerStartupCompleteSignalConnectionId);
      this.layoutManagerStartupCompleteSignalConnectionId = 0;
    }

    this._unbindShortcuts();
    this._destroyVirtualKeyboard();
    this._removeButton();
    this.settings = null;
  }

  // ── Panel button ─────────────────────────────────────────────────────

  private _updateIcon(): void {
    const showIconInPanel = this.settings?.get_boolean(GSETTINGS_SCHEMA_KEY_NAMES.SHOW_ICON) ?? true;
    const needsButton = showIconInPanel || this.recording || this.transcribing;
    if (needsButton && !this.button) {
      this._createButton();
      this._updateIconStyle();
    } else if (!needsButton && this.button) {
      this._removeButton();
    }
  }

  private _buildPanelMenu(): void {
    const settings = this.settings;
    const menu = this.button?.menu as any;
    if (!settings || !menu) return;

    this.statusMenuItem = new PopupMenu.PopupMenuItem(_('Checking service…'), {
      reactive: false,
      style_class: 'popup-inactive-menu-item',
    });
    menu.addMenuItem(this.statusMenuItem);
    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    this.languageMenuItem = new PopupMenu.PopupSubMenuMenuItem(_('Language'), false);
    menu.addMenuItem(this.languageMenuItem);
    this.languageChoiceItems = [];
    for (const [languageCode, label] of LANGUAGE_MENU_CHOICES) {
      const item = new PopupMenu.PopupMenuItem(label());
      item.connect('activate', () => {
        settings.set_string(GSETTINGS_SCHEMA_KEY_NAMES.LANGUAGE, languageCode);
      });
      this.languageMenuItem.menu.addMenuItem(item);
      this.languageChoiceItems.push([languageCode, item]);
    }
    this.menuSettingsConnectionIds.push(
      settings.connect(`changed::${GSETTINGS_SCHEMA_KEY_NAMES.LANGUAGE}`, () =>
        this._syncLanguageMenu(),
      ),
    );
    this._syncLanguageMenu();

    const switches: Array<[string, string]> = [
      [GSETTINGS_SCHEMA_KEY_NAMES.TRANSLATE_TO_ENGLISH, _('Output in English')],
      [GSETTINGS_SCHEMA_KEY_NAMES.REMOVE_FILLERS, _('Remove filler words')],
      [GSETTINGS_SCHEMA_KEY_NAMES.MARK_PAUSES, _('Mark speech pauses')],
    ];

    for (const [settingsKey, label] of switches) {
      const item = new PopupMenu.PopupSwitchMenuItem(label, settings.get_boolean(settingsKey));
      item.connect('toggled', (_source: any, state: boolean) => {
        settings.set_boolean(settingsKey, state);
      });
      const changedId = settings.connect(`changed::${settingsKey}`, () => {
        item.setToggleState(settings.get_boolean(settingsKey));
      });
      this.menuSettingsConnectionIds.push(changedId);
      menu.addMenuItem(item);
    }

    this.historyMenuSection = new PopupMenu.PopupMenuSection();
    menu.addMenuItem(this.historyMenuSection);

    menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    const unloadItem = new PopupMenu.PopupMenuItem(_('Unload model (free VRAM)'));
    unloadItem.connect('activate', () => this._unloadModel());
    menu.addMenuItem(unloadItem);

    const preferencesItem = new PopupMenu.PopupMenuItem(_('Settings'));
    preferencesItem.connect('activate', () => this.openPreferences());
    menu.addMenuItem(preferencesItem);

    this._rebuildHistoryMenuSection();

    // Only query status when opened, not on every extension start.
    menu.connect('open-state-changed', (_source: any, isOpen: boolean) => {
      if (isOpen) {
        this._refreshServiceStatus();
        this._rebuildHistoryMenuSection();
      }
    });
  }

  // ── Language selection ─────────────────────────────────────────────

  private _syncLanguageMenu(): void {
    const currentLanguage =
      this.settings?.get_string(GSETTINGS_SCHEMA_KEY_NAMES.LANGUAGE)?.trim().toLowerCase() ?? '';

    for (const [languageCode, item] of this.languageChoiceItems) {
      item.setOrnament(
        languageCode === currentLanguage ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE,
      );
    }

    if (!this.languageMenuItem) return;
    const knownChoice = LANGUAGE_MENU_CHOICES.find(([code]) => code === currentLanguage);
    // A code freely entered in settings (e.g. fr) has no menu entry —
    // then it at least shows up in the title.
    const currentLabel = knownChoice
      ? knownChoice[1]()
      : (currentLanguage.toUpperCase() || _('Service default'));
    this.languageMenuItem.label.text = `${_('Language')}: ${currentLabel}`;
  }

  // ── Recent dictations ────────────────────────────────────────────────

  private _rememberTranscription(text: string): void {
    const historySize = this.settings?.get_int(GSETTINGS_SCHEMA_KEY_NAMES.HISTORY_SIZE) ?? 0;
    if (historySize <= 0) {
      this.transcriptionHistory = [];
      return;
    }
    const trimmedText = text.trim();
    if (!trimmedText) return;

    this.transcriptionHistory = [
      trimmedText,
      ...this.transcriptionHistory.filter(entry => entry !== trimmedText),
    ].slice(0, historySize);
  }

  private _rebuildHistoryMenuSection(): void {
    const section = this.historyMenuSection;
    if (!section) return;

    section.removeAll();
    const historySize = this.settings?.get_int(GSETTINGS_SCHEMA_KEY_NAMES.HISTORY_SIZE) ?? 0;
    if (historySize <= 0) return;

    section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Recent dictations')));

    if (this.transcriptionHistory.length === 0) {
      section.addMenuItem(new PopupMenu.PopupMenuItem(_('Nothing dictated yet'), {
        reactive: false,
        style_class: 'popup-inactive-menu-item',
      }));
      return;
    }

    for (const transcript of this.transcriptionHistory.slice(0, historySize)) {
      const item = new PopupMenu.PopupMenuItem(buildSingleLinePreview(transcript));
      item.connect('activate', () => this._copyTranscriptToClipboard(transcript));
      section.addMenuItem(item);
    }
  }

  private _copyTranscriptToClipboard(transcript: string): void {
    // A still-pending restore would displace what was just copied — it
    // applies to the previous dictation and is now moot.
    this._cancelPendingClipboardRestore();

    try {
      const clipboard = St.Clipboard.get_default();
      if (!clipboard) return;
      clipboard.set_text(St.ClipboardType.CLIPBOARD, transcript);
      if (this.settings?.get_boolean(GSETTINGS_SCHEMA_KEY_NAMES.SET_PRIMARY_SELECTION)) {
        clipboard.set_text(St.ClipboardType.PRIMARY, transcript);
      }
      showShellNotification(_('Speech to Text'), _('Copied to clipboard.'));
    } catch (error) {
      log(`[Speech to Text] Copy from history: ${error}`);
    }
  }

  // ── Restore the clipboard ───────────────────────────────────────────

  private _cancelPendingClipboardRestore(): void {
    if (this.clipboardRestoreTimeoutSourceId) {
      GLib.source_remove(this.clipboardRestoreTimeoutSourceId);
      this.clipboardRestoreTimeoutSourceId = 0;
    }
    this.pendingClipboardSnapshot = null;
  }

  /**
   * Restores the saved content after `delayMilliseconds`.
   *
   * The delay is unavoidably a guess: there's no feedback on when the
   * target application read the clipboard. Restored too early, and the old
   * content gets pasted.
   *
   * Restoration only happens while the dictation is still on the
   * clipboard. Whoever copies something else in the meantime keeps it.
   */
  private _scheduleClipboardRestore(
    snapshot: ClipboardSnapshot | null,
    dictatedText: string,
    delayMilliseconds: number,
  ): void {
    this._cancelPendingClipboardRestore();
    // Without a saved snapshot there's nothing to restore — an empty
    // clipboard can't be restored through this API anyway.
    if (!snapshot) return;

    this.pendingClipboardSnapshot = snapshot;
    this.clipboardRestoreTimeoutSourceId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      Math.max(1, delayMilliseconds),
      () => {
        this.clipboardRestoreTimeoutSourceId = 0;
        const snapshotToRestore = this.pendingClipboardSnapshot;
        this.pendingClipboardSnapshot = null;
        if (!snapshotToRestore) return GLib.SOURCE_REMOVE;

        const clipboard = St.Clipboard.get_default();
        if (!clipboard) return GLib.SOURCE_REMOVE;

        clipboard.get_text(St.ClipboardType.CLIPBOARD, (_clipboard: any, currentText: string | null) => {
          // Don't touch anything after disable().
          if (!this.settings) return;
          if (currentText === dictatedText) restoreClipboardSnapshot(snapshotToRestore);
        });
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  private _unloadModel(): void {
    const settings = this.settings;
    if (!settings) return;

    const baseUrl = settings.get_string(GSETTINGS_SCHEMA_KEY_NAMES.API_BASE_URL)?.trim() ?? '';
    if (!baseUrl) return;

    const apiKey = settings.get_string(GSETTINGS_SCHEMA_KEY_NAMES.API_KEY)?.trim() ?? '';
    const message = Soup.Message.new('POST', `${baseUrl.replace(/\/+$/, '')}/unload`);
    if (!message) return;
    if (apiKey) message.request_headers.append('Authorization', `Bearer ${apiKey}`);

    const session = new Soup.Session({ timeout: 10 });
    session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null)
      .then(() => {
        if (message.get_status() === Soup.Status.OK) {
          showShellNotification(_('Speech to Text'), _('Model unloaded, VRAM released.'));
        } else {
          showShellNotification(_('Speech to Text'), _('Could not unload the model.'));
        }
        this._refreshServiceStatus();
      })
      .catch(() => {
        showShellNotification(_('Speech to Text'), _('Could not unload the model.'));
      });
  }

  private _refreshServiceStatus(): void {
    const settings = this.settings;
    if (!settings || !this.statusMenuItem) return;

    const baseUrl = settings.get_string(GSETTINGS_SCHEMA_KEY_NAMES.API_BASE_URL)?.trim() ?? '';
    if (!baseUrl) {
      this.statusMenuItem.label.text = _('No service URL configured');
      return;
    }

    this.statusMenuItem.label.text = _('Checking service…');

    const message = Soup.Message.new('GET', `${baseUrl.replace(/\/+$/, '')}/health`);
    if (!message) {
      this.statusMenuItem.label.text = _('Invalid service URL');
      return;
    }

    const session = new Soup.Session({ timeout: 3 });
    session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null)
      .then((bytes: any) => {
        if (!this.statusMenuItem) return;
        if (message.get_status() !== Soup.Status.OK) {
          this.statusMenuItem.label.text = _('Service unreachable');
          return;
        }
        const body: any = JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data()!));
        const modelName = body?.model ?? '?';
        this.statusMenuItem.label.text = body?.loaded
          ? `${_('Ready')} — ${modelName}`
          : `${_('Idle')} — ${modelName}`;
      })
      .catch(() => {
        if (this.statusMenuItem) this.statusMenuItem.label.text = _('Service unreachable');
      });
  }

  private _createButton(): void {
    if (this.button) return;

    this.button = new SpeechToTextPanelButton(0.0, 'Speech to Text', false) as any;
    (this.button as any).onPrimaryClick = () => this._onToggle();

    this.iconWidget = new St.Bin({
      style_class: 'speech-to-text-panel-icon',
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this.button.add_child(this.iconWidget);

    this._buildPanelMenu();

    const panelIndicatorPosition =
      this.settings?.get_int(GSETTINGS_SCHEMA_KEY_NAMES.PANEL_INDICATOR_POSITION) ?? 0;
    const panelIndicatorBoxKey = this.settings
      ? panelIndicatorBoxKeyForAddToStatusArea(this.settings)
      : PANEL_INDICATOR_BOX_RIGHT;
    Main.panel.addToStatusArea(
      'speech-to-text-extension',
      this.button,
      panelIndicatorPosition,
      panelIndicatorBoxKey,
    );
  }

  /** Recreate the panel button so `addToStatusArea` applies a new insert index. */
  private _repositionPanelIndicatorFromSettings(): void {
    if (!this.button) return;
    this._removeButton();
    this._updateIcon();
    this._updateIconStyle();
  }

  private _removeButton(): void {
    if (!this.button) return;
    for (const connectionId of this.menuSettingsConnectionIds) {
      this.settings?.disconnect(connectionId);
    }
    this.menuSettingsConnectionIds = [];
    this.statusMenuItem = null;
    this.historyMenuSection = null;
    this.languageMenuItem = null;
    this.languageChoiceItems = [];
    if (this.panelButtonPressEventSignalId) {
      this.button.disconnect(this.panelButtonPressEventSignalId);
      this.panelButtonPressEventSignalId = 0;
    }
    if (this.iconWidget) {
      this.iconWidget.destroy();
      this.iconWidget = null;
    }
    this.button.destroy();
    this.button = null;
  }

  private _setRecording(isRecording: boolean): void {
    this.recording = isRecording;
    this._updateIconStyle();
    if (!isRecording) this._updateIcon();
  }

  private _armRecordingTimeLimit(maxRecordingSeconds: number): void {
    this._clearRecordingTimeLimit();
    if (maxRecordingSeconds <= 0) return;
    this.recordingTimeLimitSourceId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      maxRecordingSeconds,
      () => {
        this.recordingTimeLimitSourceId = 0;
        if (this.recording) {
          showShellNotification(
            _('Speech to Text'),
            _('Maximum recording length reached — transcribing now.'),
          );
          this._doStop();
        }
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  private _clearRecordingTimeLimit(): void {
    if (this.recordingTimeLimitSourceId) {
      GLib.source_remove(this.recordingTimeLimitSourceId);
      this.recordingTimeLimitSourceId = 0;
    }
  }

  private _setTranscribing(isTranscribing: boolean): void {
    this.transcribing = isTranscribing;
    this._updateIconStyle();
    this._updateIcon();
  }

  private _updateIconStyle(): void {
    if (!this.iconWidget) return;
    this.iconWidget.remove_style_class_name('recording');
    this.iconWidget.remove_style_class_name('transcribing');
    if (this.recording) {
      this.iconWidget.add_style_class_name('recording');
    } else if (this.transcribing) {
      this.iconWidget.add_style_class_name('transcribing');
    }
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────

  private _shortcutsBindingIds: string[] = [];

  private _rebindShortcuts(): void {
    this._unbindShortcuts();
    this._bindShortcuts();
  }

  private _bindShortcuts(): void {
    if (!this.settings?.get_boolean(GSETTINGS_SCHEMA_KEY_NAMES.ENABLE_SHORTCUTS)) return;
    this._bindShortcut(GSETTINGS_SCHEMA_KEY_NAMES.TOGGLE_SHORTCUT, () => this._onToggle());
  }

  private _unbindShortcuts(): void {
    this._shortcutsBindingIds.forEach(keybindingName => {
      Main.wm.removeKeybinding(keybindingName);
    });
    this._shortcutsBindingIds = [];
  }

  private _bindShortcut(keybindingName: string, onActivated: () => void): void {
    Main.wm.addKeybinding(
      keybindingName,
      this.settings!,
      Meta.KeyBindingFlags.NONE,
      Shell.ActionMode.ALL,
      onActivated.bind(this),
    );
    this._shortcutsBindingIds.push(keybindingName);
  }

  // ── Virtual keyboard for pasting ───────────────────────────────────

  private _initVirtualKeyboard(): void {
    try {
      const seat = Clutter.get_default_backend().get_default_seat();
      this.virtualKeyboardDevice = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

      // @ts-ignore GJS-specific signal connection
      this.contentPurposeSignalConnectionId = Main.inputMethod.connectObject(
        'notify::content-purpose',
        (inputMethod: any) => {
          this.contentPurpose = inputMethod.content_purpose;
        },
        this,
      );
    } catch (error) {
      log(`[Speech to Text] Failed to init virtual keyboard: ${error}`);
    }
  }

  private _destroyVirtualKeyboard(): void {
    if (this.contentPurposeSignalConnectionId && Main.inputMethod) {
      // @ts-ignore
      Main.inputMethod.disconnectObject(this);
      this.contentPurposeSignalConnectionId = 0;
    }
    if (this.virtualKeyboardDevice) {
      this.virtualKeyboardDevice = null;
    }
  }

  private _notifyVirtualKey(key: number, keyState: Clutter.KeyState): void {
    if (!this.virtualKeyboardDevice) return;
    this.virtualKeyboardDevice.notify_keyval(
      Clutter.get_current_event_time() * 1000,
      key,
      keyState,
    );
  }

  private _focusedInputBehavesLikeTerminal(): boolean {
    return this.contentPurpose === Clutter.InputContentPurpose.TERMINAL;
  }

  private _pasteIntoActiveField(): Promise<void> {
    return new Promise<void>(resolve => {
      if (this.pasteIntoActiveFieldTimeoutSourceId) {
        GLib.source_remove(this.pasteIntoActiveFieldTimeoutSourceId);
        this.pasteIntoActiveFieldTimeoutSourceId = 0;
      }
      this.pasteIntoActiveFieldTimeoutSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
        this.pasteIntoActiveFieldTimeoutSourceId = 0;
        try {
          if (this._focusedInputBehavesLikeTerminal()) {
            this._notifyVirtualKey(Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
            this._notifyVirtualKey(Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
            this._notifyVirtualKey(Clutter.KEY_Insert, Clutter.KeyState.PRESSED);
            this._notifyVirtualKey(Clutter.KEY_Insert, Clutter.KeyState.RELEASED);
            this._notifyVirtualKey(Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
            this._notifyVirtualKey(Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);
          } else {
            this._notifyVirtualKey(Clutter.KEY_Shift_L, Clutter.KeyState.PRESSED);
            this._notifyVirtualKey(Clutter.KEY_Insert, Clutter.KeyState.PRESSED);
            this._notifyVirtualKey(Clutter.KEY_Insert, Clutter.KeyState.RELEASED);
            this._notifyVirtualKey(Clutter.KEY_Shift_L, Clutter.KeyState.RELEASED);
          }
        } catch (error) {
          log(`[Speech to Text] Paste failed: ${error}`);
        }
        resolve();
        return GLib.SOURCE_REMOVE;
      });
    });
  }

  /**
   * Pastes the text into the focused field: remember it, save the clipboard,
   * set it, Shift+Insert, restore later. Shared by local dictation and by
   * text arriving over D-Bus.
   */
  private async _deliverTranscript(transcribedText: string): Promise<void> {
    const settings = this.settings;
    if (!settings) return;

    // Remember it before pasting: if pasting goes nowhere because no text
    // field has focus, the dictation stays reachable through the panel
    // menu. Without this it would be completely lost once the clipboard
    // is restored.
    this._rememberTranscription(transcribedText);

    const shouldRestoreClipboard = settings.get_boolean(
      GSETTINGS_SCHEMA_KEY_NAMES.RESTORE_CLIPBOARD,
    );
    const clipboardSnapshot = shouldRestoreClipboard
      ? await captureClipboardSnapshotWithTimeout()
      : null;

    try {
      const clipboard = St.Clipboard.get_default();
      if (clipboard) {
        clipboard.set_text(St.ClipboardType.CLIPBOARD, transcribedText);
        // PRIMARY only on request — otherwise the mouse-selection buffer is lost.
        if (settings.get_boolean(GSETTINGS_SCHEMA_KEY_NAMES.SET_PRIMARY_SELECTION)) {
          clipboard.set_text(St.ClipboardType.PRIMARY, transcribedText);
        }
      }
    } catch (_) {}

    await this._pasteIntoActiveField();

    if (shouldRestoreClipboard) {
      this._scheduleClipboardRestore(
        clipboardSnapshot,
        transcribedText,
        settings.get_int(GSETTINGS_SCHEMA_KEY_NAMES.CLIPBOARD_RESTORE_DELAY),
      );
    }
  }

  // ── D-Bus entry point ────────────────────────────────────────────────

  private _exportDBusInterface(): void {
    try {
      this.dbusExportedObject = Gio.DBusExportedObject.wrapJSObject(DBUS_INTERFACE_XML, this.dbusService);
      this.dbusExportedObject.export(Gio.DBus.session, DBUS_OBJECT_PATH);
    } catch (error) {
      this.dbusExportedObject = null;
      log(`[Speech to Text] D-Bus export failed: ${error}`);
    }
  }

  private _unexportDBusInterface(): void {
    this.dbusExportedObject?.unexport();
    this.dbusExportedObject = null;
  }

  /** Method table for wrapJSObject; *Async variants receive the invocation. */
  private readonly dbusService = {
    InsertTextAsync: (parameters: [string], invocation: Gio.DBusMethodInvocation) => {
      const [text] = parameters;
      if (!text?.trim()) {
        invocation.return_value(null);
        return;
      }
      // Don't interfere with a local dictation in progress: its result would
      // overtake this call's clipboard snapshot.
      if (this.recording || this.transcribing) {
        invocation.return_dbus_error(
          'org.gnome.Shell.Extensions.ClearSTT.Error.Busy',
          'Local dictation in progress',
        );
        return;
      }
      this._cancelPendingClipboardRestore();
      this._deliverTranscript(text)
        .then(() => invocation.return_value(null))
        .catch((error: any) =>
          invocation.return_dbus_error(
            'org.gnome.Shell.Extensions.ClearSTT.Error.Failed',
            error?.message ?? String(error),
          ),
        );
    },

    PressKeyAsync: (parameters: [string], invocation: Gio.DBusMethodInvocation) => {
      const [keyName] = parameters;
      const keyval = PRESSABLE_KEYS[keyName];
      if (keyval === undefined) {
        invocation.return_dbus_error(
          'org.gnome.Shell.Extensions.ClearSTT.Error.KeyNotAllowed',
          `Key not allowed: ${keyName}`,
        );
        return;
      }
      this._notifyVirtualKey(keyval, Clutter.KeyState.PRESSED);
      this._notifyVirtualKey(keyval, Clutter.KeyState.RELEASED);
      invocation.return_value(null);
    },
  };

  // ── Actions ──────────────────────────────────────────────────────────

  private _onToggle(): void {
    if (this.recording) {
      this._doStop();
    } else {
      this._doStart();
    }
  }

  private async _doStart(): Promise<void> {
    const settings = this.settings;
    if (!settings) return;

    const apiBaseUrl = settings.get_string(GSETTINGS_SCHEMA_KEY_NAMES.API_BASE_URL)?.trim();
    if (!apiBaseUrl) {
      showShellNotification(
        _('Speech to Text'),
        _('Please set the API base URL in extension settings.'),
      );
      return;
    }

    const modelIdentifier = settings.get_string(GSETTINGS_SCHEMA_KEY_NAMES.MODEL)?.trim();
    if (!modelIdentifier) {
      showShellNotification(
        _('Speech to Text'),
        _('Please set a transcription model in extension settings.'),
      );
      return;
    }

    if (!this.button) this._createButton();

    this._setRecording(true);

    if (settings.get_boolean(GSETTINGS_SCHEMA_KEY_NAMES.PLAY_SOUND)) {
      playSoundEffectFromFile(
        `${this.path}/resources/start.mp3`,
        settings.get_int(GSETTINGS_SCHEMA_KEY_NAMES.SOUND_VOLUME),
      );
    }

    try {
      this.recorder!.start();
      this._armRecordingTimeLimit(
        settings.get_int(GSETTINGS_SCHEMA_KEY_NAMES.MAX_RECORDING_SECONDS),
      );
    } catch (error: any) {
      showShellNotification(
        _('Speech to Text — Error'),
        _('Failed to start recording.') + (error?.message ? ` ${error.message}` : ''),
      );
      this._setRecording(false);
    }
  }

  private async _doStop(): Promise<void> {
    const settings = this.settings;
    if (!settings) return;

    // A still-pending restore applies to the previous dictation and would
    // overwrite the new one.
    this._cancelPendingClipboardRestore();

    if (settings.get_boolean(GSETTINGS_SCHEMA_KEY_NAMES.PLAY_SOUND)) {
      playSoundEffectFromFile(
        `${this.path}/resources/stop.mp3`,
        settings.get_int(GSETTINGS_SCHEMA_KEY_NAMES.SOUND_VOLUME),
      );
    }

    this._setRecording(false);
    this._setTranscribing(true);
    this._clearRecordingTimeLimit();

    const cancellable = new Gio.Cancellable();
    this.transcriptionCancellable = cancellable;

    try {
      const recordedAudioPath = await this.recorder!.stop();
      if (!recordedAudioPath) {
        this._setTranscribing(false);
        return;
      }

      const apiBaseUrl =
        settings.get_string(GSETTINGS_SCHEMA_KEY_NAMES.API_BASE_URL)?.trim() ?? '';
      const apiKey =
        settings.get_string(GSETTINGS_SCHEMA_KEY_NAMES.API_KEY)?.trim() ?? '';
      const language =
        settings.get_string(GSETTINGS_SCHEMA_KEY_NAMES.LANGUAGE)?.trim() ?? '';
      const modelIdentifier =
        settings.get_string(GSETTINGS_SCHEMA_KEY_NAMES.MODEL)?.trim() ?? '';
      const emptySpeechAction =
        settings.get_string(GSETTINGS_SCHEMA_KEY_NAMES.EMPTY_SPEECH_ACTION) || 'placeholder';
      const emptySpeechPlaceholderText =
        settings.get_string(GSETTINGS_SCHEMA_KEY_NAMES.EMPTY_SPEECH_PLACEHOLDER) ?? '';
      const samplingTemperature = settings.get_double(GSETTINGS_SCHEMA_KEY_NAMES.TEMPERATURE);
      const requestTimeoutSeconds = settings.get_int(GSETTINGS_SCHEMA_KEY_NAMES.REQUEST_TIMEOUT);

      let transcribedText = '';
      try {
        transcribedText = await requestTranscription({
          audioFilePath: recordedAudioPath,
          apiBaseUrl,
          apiKey,
          modelIdentifier,
          language,
          translateToEnglish: settings.get_boolean(GSETTINGS_SCHEMA_KEY_NAMES.TRANSLATE_TO_ENGLISH),
          removeFillers: settings.get_boolean(GSETTINGS_SCHEMA_KEY_NAMES.REMOVE_FILLERS),
          markPauses: settings.get_boolean(GSETTINGS_SCHEMA_KEY_NAMES.MARK_PAUSES),
          samplingTemperature,
          requestTimeoutSeconds,
          userAgentString: buildUserAgentStringFromMetadata(this.metadata),
          cancellable,
        });
      } finally {
        // Don't leave the dictation lying around on the filesystem.
        deleteFileIfExists(recordedAudioPath);
      }

      const hasNoTranscribedSpeech = transcribedText === '';
      if (hasNoTranscribedSpeech) {
        if (emptySpeechAction === 'skip') {
          return;
        }
        const trimmedPlaceholder = emptySpeechPlaceholderText.trim();
        if (!trimmedPlaceholder) {
          return;
        }
        transcribedText = trimmedPlaceholder;
      }

      await this._deliverTranscript(transcribedText);
    } catch (error: any) {
      if (error instanceof Gio.IOErrorEnum && error.code === Gio.IOErrorEnum.CANCELLED) {
        return;
      }
      showShellNotification(_('Speech to Text — Error'), error?.message ?? String(error));
    } finally {
      this.transcriptionCancellable = null;
      this._setTranscribing(false);
    }
  }
}
