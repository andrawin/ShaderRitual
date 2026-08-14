/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { live } from 'lit/directives/live.js';
import './shader-view';
import { SHADERS, getShader, sanitizeConfig } from './shader-registry';
import type { Band, CameraMode, PartInfo, PartSetting, ReactTarget, ShaderRitualConfig } from './types';

function defaultPart(): PartSetting {
  return { band: 'none', amount: 1.0, target: 'scale', visible: true };
}

const STORAGE_KEY = 'shader-ritual-settings-v1';
const MIDI_MAP_KEY = 'shader-ritual-midi-map-v1';
// Cross-window bus that keeps a detached control panel and the render window
// in lock-step (config edits, live band meter, audio start/stop).
const SYNC_CHANNEL = 'shader-ritual-sync';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

interface MidiMapping {
  path: string;
  type: 'cc' | 'pb' | 'note';
}

/** ArrayBuffer <-> base64 (model uploads over the WebSocket relay). */
function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as any);
  }
  return btoa(bin);
}
function b64ToBuf(s: string): ArrayBuffer {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

@customElement('shader-ritual-app')
export class ShaderRitualApp extends LitElement {
  @state() isRecording = false;
  @state() status = 'Open the menu and ignite audio';
  @state() error = '';
  @state() showSettings = false;

  // MIDI state
  @state() midiActive = false;
  @state() lastMidiMsg = 'Ready for MIDI...';
  @state() midiDevices: { id: string; name: string }[] = [];
  @state() selectedMidiId = 'all';
  @state() learningParam: string | null = null;
  @state() midiMappings: Record<string, MidiMapping> = JSON.parse(
    localStorage.getItem(MIDI_MAP_KEY) || '{}',
  );
  @state() midiPulse = false;
  @state() modelName = '';

  // MeshRitual engine: parts surfaced from the loaded model + screen capture.
  @state() partInfos: PartInfo[] = [];
  /** How many part cards are rendered at once (see renderPartsMenu). */
  @state() private partsShown = 40;
  @state() isCapturing = false;
  private captureStream: MediaStream | null = null;

  private onModelFile = async (e: any) => {
    const file = e.target.files?.[0];
    if (!file) return;
    this.modelName = 'Loading…';
    try {
      const buf = await file.arrayBuffer();
      if (this.isController) {
        // No WebGL in the detached window — ship the bytes to the render window.
        this.post({ type: 'modelUpload', buffer: buf, name: file.name });
        return;
      }
      const err = await this.viewEl?.loadModel?.(buf);
      this.modelName = err ? `⚠ ${err}` : file.name;
      this.post({ type: 'modelStatus', name: this.modelName });
    } catch (e: any) {
      this.modelName = `⚠ ${e?.message || 'Failed to load'}`;
      this.post({ type: 'modelStatus', name: this.modelName });
    }
  };
  private clearModel = () => {
    if (this.isController) {
      this.post({ type: 'command', name: 'removeModel' });
    } else {
      this.viewEl?.removeModel?.();
      this.post({ type: 'modelStatus', name: '' });
    }
    this.modelName = '';
    this.partInfos = [];
  };

  /** Decomposed parts arrived from the render view — build per-part settings. */
  private onPartsChanged = (e: CustomEvent<PartInfo[]>) => {
    const infos = e.detail || [];
    this.partInfos = infos;
    this.partsShown = 40;
    const parts: Record<string, PartSetting> = {};
    for (const info of infos) parts[info.id] = this.config.model.parts[info.id] || defaultPart();
    this.config = { ...this.config, model: { ...this.config.model, parts } };
    this.persist();
    this.broadcastConfig();
    this.post({ type: 'partInfos', partInfos: infos });
  };

  /** Distribute parts across the three bands / first three targets. */
  private autoDistribute = () => {
    const bands: Band[] = ['low', 'mid', 'high'];
    const targets: ReactTarget[] = ['scale', 'emissive', 'explode'];
    const parts = { ...this.config.model.parts };
    this.partInfos.forEach((info, i) => {
      parts[info.id] = {
        ...(parts[info.id] || defaultPart()),
        band: bands[i % 3],
        target: targets[Math.floor(i / 3) % 3],
        visible: true,
      };
    });
    this.config = { ...this.config, model: { ...this.config.model, parts } };
    this.persist();
    this.broadcastConfig();
  };

  /** Fire a physics action (works from either window). */
  private triggerPhysics = (action: 'burst' | 'implode' | 'reset') => {
    if (this.isController) {
      this.post({ type: 'command', name: action });
    } else {
      this.viewEl?.[action]?.();
    }
  };

  /** Share-a-window screen capture, projected onto the model scene. */
  private toggleCapture = async () => {
    if (this.isController) {
      this.post({ type: 'command', name: this.isCapturing ? 'stopCapture' : 'startCapture' });
      return;
    }
    if (this.isCapturing) {
      this.captureStream?.getTracks().forEach((t) => t.stop());
      this.captureStream = null;
      this.isCapturing = false;
      this.viewEl?.setCaptureStream?.(null);
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.error = 'Screen capture not supported in this browser.';
      return;
    }
    try {
      this.error = '';
      // Cap what the browser hands us — an uncapped 4K/60 share is by far the
      // most expensive thing in the pipeline.
      const fps = this.config.model.capture.fps || 30;
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'window',
          frameRate: { max: fps },
          width: { max: 1920 },
          height: { max: 1080 },
        } as any,
        audio: false,
      });
      this.captureStream = stream;
      this.isCapturing = true;
      this.viewEl?.setCaptureStream?.(stream);
      stream.getTracks()[0].addEventListener('ended', () => {
        this.captureStream = null;
        this.isCapturing = false;
        this.viewEl?.setCaptureStream?.(null);
      });
    } catch (err: any) {
      this.error = `Capture failed: ${err?.message || err}`;
      this.isCapturing = false;
    }
  };

  private pendingMidiUpdate = false;
  private monitorRaf = 0;

  // Detached control-panel / code-window support.
  private readonly params = new URLSearchParams(location.search);
  private readonly isController = this.params.has('control');
  private readonly isCodeWindow = this.params.has('code');
  /** True only for the render window that owns the WebGL view. */
  private get isMain() {
    return !this.isController && !this.isCodeWindow;
  }
  private sync: BroadcastChannel | null = null;
  private codeWindowOpen = false;
  @state() private remoteBands: any = null;

  // Live-coding code panel.
  @state() showCode = false;
  @state() codeTab: 'buffer' | 'image' = 'buffer';
  @state() editBuffer = '';
  @state() editImage = '';
  @state() codeError = '';
  @state() codeValues: Record<string, number> = {};
  private codeShaderId = '';
  private codeApplyTimer: any = null;
  private lastCodeValueTick = 0;

  @state() config: ShaderRitualConfig = this.loadSavedConfig();

  private loadSavedConfig(): ShaderRitualConfig {
    const saved = localStorage.getItem(STORAGE_KEY);
    try {
      return sanitizeConfig(saved ? JSON.parse(saved) : null);
    } catch (e) {
      return sanitizeConfig(null);
    }
  }

  private audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  @state() audioNode = this.audioContext.createGain();
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;

  static styles = css`
    :host { font-family: 'Segoe UI', Tahoma, sans-serif; }

    #status {
      position: absolute; bottom: 20px; right: 20px; z-index: 10;
      color: rgba(255,255,255,0.6); font-size: 11px; text-transform: uppercase;
      background: rgba(0,0,0,0.3); padding: 4px 8px; border-radius: 4px;
      backdrop-filter: blur(2px); font-family: monospace; letter-spacing: 1px;
    }

    .settings-btn {
      position: absolute; top: 20px; right: 20px; z-index: 20;
      background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);
      color: rgba(255,255,255,0.7); cursor: pointer; padding: 10px; border-radius: 8px;
      backdrop-filter: blur(10px); transition: 0.2s;
    }
    .settings-btn:hover { background: rgba(255,255,255,0.2); color: white; }
    .settings-btn svg { width: 30px; height: 30px; fill: currentColor; }

    .settings-panel {
      position: absolute; top: 0; right: 0; bottom: 0; width: 360px;
      background: rgba(10,10,15,0.96); backdrop-filter: blur(35px); z-index: 30;
      padding: 20px; transform: translateX(100%);
      transition: transform 0.3s cubic-bezier(0.4,0,0.2,1);
      overflow-y: auto; color: #ddd; border-left: 1px solid rgba(255,255,255,0.1);
    }
    .settings-panel.open { transform: translateX(0); }

    /* Detached controller window: panel fills the whole tab. */
    :host(.controller-host) { display: block; }
    .settings-panel.controller {
      position: static; width: auto; transform: none; height: 100vh;
      border-left: none; box-sizing: border-box;
    }

    .header-actions { display: flex; align-items: center; gap: 6px; }
    .live-dot {
      display: inline-flex; align-items: center; gap: 6px; font-size: 0.65rem;
      color: #10b981; text-transform: uppercase; letter-spacing: 1px;
    }
    .live-dot::before {
      content: ''; width: 8px; height: 8px; border-radius: 50%;
      background: #10b981; box-shadow: 0 0 8px #10b981; animation: pulse 1.5s infinite;
    }

    .panel-header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px;
    }
    .panel-header h2 { margin: 0; font-size: 1.1rem; font-weight: 500; color: white; }

    .icon-btn {
      background: none; border: none; color: #aaa; cursor: pointer; padding: 5px;
      border-radius: 4px; font-size: 1.2rem; line-height: 1;
    }
    .icon-btn:hover { color: white; background: rgba(255,255,255,0.1); }

    .monitor-container {
      background: #000; border: 1px solid #333; margin-bottom: 15px;
      border-radius: 4px; height: 80px; position: relative; overflow: hidden;
    }
    #monitorCanvas { width: 100%; height: 100%; display: block; }

    .setting-group { margin-bottom: 25px; }
    .group-title {
      text-transform: uppercase; font-size: 0.7rem; color: #a855f7;
      margin-bottom: 12px; display: block; font-weight: bold;
      border-left: 3px solid #a855f7; padding-left: 8px;
    }

    .control-row {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 10px; font-size: 0.85rem; gap: 8px;
    }
    .control-row label { flex: 1; color: #bbb; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    input[type="range"] { width: 100px; accent-color: #a855f7; }
    select, input[type="text"] {
      background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);
      color: white; padding: 4px 6px; border-radius: 4px; width: 110px; font-size: 0.8rem;
    }
    input[type="checkbox"] { accent-color: #a855f7; }

    .midi-learn-btn {
      width: 18px; height: 18px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.2);
      background: rgba(255,255,255,0.05); color: #888; font-size: 10px; display: flex;
      align-items: center; justify-content: center; cursor: pointer; transition: 0.2s; flex-shrink: 0;
    }
    .midi-learn-btn:hover { background: rgba(255,255,255,0.15); color: white; }
    .midi-learn-btn.active {
      background: #a855f7; color: white; border-color: #c084fc;
      box-shadow: 0 0 8px #a855f7; animation: pulse 1s infinite;
    }
    .midi-learn-btn.mapped { border-color: #10b981; color: #10b981; }

    @keyframes pulse {
      0% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(1.1); }
      100% { opacity: 1; transform: scale(1); }
    }

    .midi-log {
      font-family: monospace; font-size: 0.7rem; color: #10b981;
      background: rgba(16,185,129,0.1); padding: 6px 10px; border-radius: 4px;
      margin-top: 8px; display: block; border: 1px solid rgba(16,185,129,0.2);
      transition: 0.1s; min-height: 28px;
    }
    .midi-log.learning {
      color: #f59e0b; background: rgba(245,158,11,0.1); border-color: #f59e0b;
      font-weight: bold; animation: pulse 1s infinite;
    }
    .midi-log.pulse { background: rgba(255,255,255,0.3); color: #fff; }

    .mapping-table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 0.65rem; color: #999; }
    .mapping-table th { text-align: left; padding: 4px; border-bottom: 1px solid #333; color: #bbb; }
    .mapping-table td { padding: 4px; border-bottom: 1px solid #222; }
    .del-map { cursor: pointer; color: #ef4444; border: none; background: none; font-size: 0.75rem; padding: 2px 4px; }
    .del-map:hover { color: white; }

    .device-select { width: 100% !important; margin-top: 8px; font-size: 0.7rem; }
    .shader-select { width: 100% !important; font-size: 0.85rem; }

    .action-row { gap: 8px; justify-content: flex-start !important; }
    .action-btn {
      background: rgba(255,255,255,0.05); color: white; padding: 8px 12px; border-radius: 6px;
      cursor: pointer; border: 1px solid rgba(255,255,255,0.1); transition: 0.2s; font-size: 0.75rem;
    }
    .action-btn:hover { background: rgba(255,255,255,0.15); }
    .action-btn.active { border-color: #a855f7; color: #a855f7; }
    .action-btn.small { padding: 4px 8px; font-size: 0.65rem; }

    .element-card {
      border: 1px solid rgba(255,255,255,0.08); border-radius: 8px;
      padding: 10px 12px; margin-bottom: 12px; background: rgba(255,255,255,0.02);
    }
    .element-card.hidden-el { opacity: 0.45; }
    .element-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
    .element-name { font-size: 0.85rem; color: #eee; font-weight: 600; }
    .element-desc { font-size: 0.65rem; color: #777; margin-bottom: 8px; line-height: 1.3; }
    .vis-toggle {
      background: none; border: 1px solid rgba(255,255,255,0.2); color: #aaa;
      border-radius: 4px; cursor: pointer; font-size: 0.65rem; padding: 2px 6px;
    }
    .vis-toggle.on { color: #10b981; border-color: #10b981; }
    .vis-toggle.off { color: #ef4444; border-color: #ef4444; }

    input[type="number"].bpm-num {
      width: 64px; text-align: center; -moz-appearance: textfield;
    }

    /* ----- Live-coding code panel ----- */
    .code-btn {
      position: absolute; top: 20px; right: 78px; z-index: 20;
      background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);
      color: rgba(255,255,255,0.7); cursor: pointer; padding: 10px 12px;
      border-radius: 8px; backdrop-filter: blur(10px); transition: 0.2s;
      font-family: monospace; font-weight: bold; font-size: 1rem; height: 50px;
    }
    .code-btn:hover { background: rgba(255,255,255,0.2); color: white; }
    .code-btn.active { border-color: #a855f7; color: #a855f7; }

    /* In-page panel sits transparently over the shader so the code reads as
       part of the visual layer. The detached window adds .windowed for a
       solid backdrop (no shader behind it there). */
    .code-panel {
      position: absolute; top: 0; left: 0; bottom: 0; width: 46vw; max-width: 720px;
      background: transparent; z-index: 25;
      display: flex; flex-direction: column; color: #e6edf3;
      transform: translateX(-100%); transition: transform 0.25s ease;
      text-shadow: 0 1px 3px rgba(0,0,0,0.95), 0 0 2px rgba(0,0,0,0.9);
      pointer-events: none;
    }
    .code-panel.open { transform: translateX(0); }
    /* Re-enable interaction only on the controls/editor, not the whole strip. */
    .code-panel .code-head,
    .code-panel .code-textarea,
    .code-panel .code-foot,
    .code-panel .code-values { pointer-events: auto; }

    .code-panel.windowed {
      position: fixed; inset: 0; width: 100%; max-width: none; transform: none;
      background: rgba(8,8,12,0.97); text-shadow: none; pointer-events: auto;
    }

    .code-head {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px; flex-wrap: wrap;
    }
    .code-head .title { font-family: monospace; font-size: 0.8rem; color: #c4a7f7; margin-right: auto; }
    .code-tab {
      background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.2); color: #cbd5e1;
      border-radius: 4px; padding: 3px 8px; font-size: 0.7rem; cursor: pointer; font-family: monospace;
    }
    .code-tab.active { color: #fff; border-color: #a855f7; background: rgba(168,85,247,0.3); }

    .code-values {
      font-family: monospace; font-size: 0.68rem; line-height: 1.5;
      padding: 8px 12px; max-height: 26%; overflow-y: auto;
      color: #a8f0e0; white-space: pre-wrap; word-break: break-all;
    }
    .code-values .k { color: #fbe09a; }
    .code-textarea {
      flex: 1; width: 100%; box-sizing: border-box; resize: none; border: none;
      background: transparent; color: #e6edf3; font-family: monospace;
      font-size: 0.72rem; line-height: 1.4; padding: 10px 12px; outline: none;
      tab-size: 2; text-shadow: inherit;
    }
    .code-foot {
      display: flex; align-items: center; gap: 8px; padding: 8px 12px; font-size: 0.7rem;
    }
    .code-error {
      flex: 1; font-family: monospace; font-size: 0.66rem; color: #ff9db1;
      white-space: pre-wrap; max-height: 60px; overflow-y: auto;
    }
    .code-ok { flex: 1; font-family: monospace; font-size: 0.66rem; color: #b6f0a8; }

    /* Near-invisible hairline scrollbars so the editor melts into the layer. */
    .code-values, .code-textarea { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.06) transparent; }
    .code-values::-webkit-scrollbar, .code-textarea::-webkit-scrollbar { width: 3px; height: 3px; }
    .code-values::-webkit-scrollbar-track, .code-textarea::-webkit-scrollbar-track { background: transparent; }
    .code-values::-webkit-scrollbar-thumb, .code-textarea::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,0.06); border-radius: 3px;
    }
  `;

  firstUpdated() {
    this.setupSync();
    this.initMidi();
    this.startMonitor();
    if (this.isMain) {
      window.addEventListener('keydown', (e) => {
        const el = e.composedPath()[0] as HTMLElement;
        const tag = el?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey) {
          this.showCode = !this.showCode;
        }
      });
    }
  }

  updated() {
    // Render window: keep the code editor in sync with the active shader's
    // source and push it to any detached code window.
    if (this.isMain && this.config.activeShader !== this.codeShaderId) {
      this.codeShaderId = this.config.activeShader;
      const src = this.viewEl?.getActiveSource?.();
      const def = getShader(this.codeShaderId);
      this.editBuffer = src?.buffer ?? def.bufferShader;
      this.editImage = src?.image ?? def.imageShader;
      this.codeError = '';
      this.broadcastCodeState();
    }
  }

  private get viewEl(): any {
    return this.shadowRoot?.querySelector('shader-ritual-view');
  }

  /* ------------------------- Live coding -------------------------- */

  private onCodeInput = (which: 'buffer' | 'image', value: string) => {
    if (which === 'buffer') this.editBuffer = value;
    else this.editImage = value;
    if (this.isCodeWindow) {
      // No WebGL here — push edits to the render window to compile.
      clearTimeout(this.codeApplyTimer);
      this.codeApplyTimer = setTimeout(
        () => this.post({ type: 'codeEdit', buffer: this.editBuffer, image: this.editImage }),
        500,
      );
    } else {
      clearTimeout(this.codeApplyTimer);
      this.codeApplyTimer = setTimeout(() => this.applyCode(), 500);
    }
  };

  private applyCode = () => {
    if (this.isCodeWindow) {
      this.post({ type: 'codeEdit', buffer: this.editBuffer, image: this.editImage });
      return;
    }
    const err = this.viewEl?.applySource?.(this.editBuffer, this.editImage);
    this.codeError = err || '';
    this.broadcastCodeState();
  };

  private resetCode = () => {
    if (this.isCodeWindow) {
      this.post({ type: 'codeReset' });
      return;
    }
    this.viewEl?.resetSource?.();
    const def = getShader(this.config.activeShader);
    this.editBuffer = def.bufferShader;
    this.editImage = def.imageShader;
    this.codeError = '';
    this.broadcastCodeState();
  };

  /** Open the live-code editor in its own window, synced via BroadcastChannel. */
  private detachCode = () => {
    window.open(`${location.pathname}?code`, 'shader-ritual-code', 'width=640,height=900');
  };

  private broadcastCodeState() {
    this.post({
      type: 'codeState',
      buffer: this.editBuffer,
      image: this.editImage,
      error: this.codeError,
    });
  }

  /* ----------------------- Cross-window sync ---------------------- */

  private setupSync() {
    if (this.isController) {
      // This window only drives the controls; force the panel open and let the
      // host fill the tab.
      this.showSettings = true;
      (this as any).classList?.add('controller-host');
    }
    if (this.isCodeWindow) {
      this.showCode = true;
    }
    if (typeof BroadcastChannel !== 'undefined') {
      this.sync = new BroadcastChannel(SYNC_CHANNEL);
      this.sync.onmessage = (e) => this.receive(e.data);
    }
    this.connectRemote();
    // A freshly opened satellite window asks the render window for current state.
    if (this.isController) this.post({ type: 'request' });
    if (this.isCodeWindow) this.post({ type: 'codeRequest' });
  }

  /* ------------------- Remote (LAN / phone) sync ------------------- */
  // BroadcastChannel only reaches windows of the same browser on the same
  // machine. For a phone / tablet controller, every window also connects to
  // the WebSocket relay (relay.mjs, `npm run remote`) when it's reachable.
  // Messages go out on BOTH channels with a sender id + sequence number so
  // receivers can drop the duplicate copy.

  private ws: WebSocket | null = null;
  private wsRetryTimer: any = null;
  @state() private wsOk = false;
  @state() private remoteUrls: string[] = [];
  private readonly syncSid = Math.random().toString(36).slice(2);
  private syncSeq = 0;
  private seenSeq: Record<string, number> = {};

  private connectRemote() {
    // file:// has no host to connect to; a `?ws=host:port` param overrides.
    const override = this.params.get('ws');
    if (!override && !location.hostname) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const target = override || `${location.hostname}:8787`;
    try {
      this.ws = new WebSocket(`${proto}://${target}`);
    } catch (e) {
      this.scheduleRemoteRetry();
      return;
    }
    this.ws.onopen = () => {
      this.wsOk = true;
      // Re-request state so a phone that connected late catches up.
      if (this.isController) this.post({ type: 'request' });
      if (this.isCodeWindow) this.post({ type: 'codeRequest' });
    };
    this.ws.onmessage = (e) => {
      try {
        this.receive(JSON.parse(e.data));
      } catch (err) {}
    };
    this.ws.onclose = () => {
      this.wsOk = false;
      this.ws = null;
      this.scheduleRemoteRetry();
    };
    this.ws.onerror = () => {
      try { this.ws?.close(); } catch (e) {}
    };
  }

  private scheduleRemoteRetry() {
    clearTimeout(this.wsRetryTimer);
    this.wsRetryTimer = setTimeout(() => this.connectRemote(), 8000);
  }

  /** Send a sync message to every other window, local or remote. */
  private post(msg: any) {
    const m = { ...msg, _sid: this.syncSid, _seq: ++this.syncSeq };
    this.sync?.postMessage(m);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        if (m.type === 'modelUpload' && m.buffer instanceof ArrayBuffer) {
          this.ws.send(JSON.stringify({ ...m, buffer: bufToB64(m.buffer), _b64: true }));
        } else {
          this.ws.send(JSON.stringify(m));
        }
      } catch (e) {}
    }
  }

  /** Receive from either channel; drop own echoes + cross-channel duplicates. */
  private receive(msg: any) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'remoteHello') {
      // The relay announces the LAN URLs it's serving on.
      this.remoteUrls = Array.isArray(msg.urls) ? msg.urls : [];
      return;
    }
    if (msg._sid) {
      if (msg._sid === this.syncSid) return;
      const last = this.seenSeq[msg._sid] || 0;
      if (msg._seq <= last) return;
      this.seenSeq[msg._sid] = msg._seq;
    }
    if (msg._b64 && typeof msg.buffer === 'string') msg.buffer = b64ToBuf(msg.buffer);
    this.handleSync(msg);
  }

  private handleSync(msg: any) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'request':
        // Render window answers a controller with the full current config + parts.
        if (this.isMain) {
          this.broadcastConfig();
          this.post({ type: 'partInfos', partInfos: this.partInfos });
        }
        break;
      case 'partInfos': {
        // Controller mirrors the render window's decomposed part list, and
        // seeds a settings entry for each part — otherwise editing one part
        // would broadcast a parts map containing only that part.
        if (!this.isController) break;
        const infos: PartInfo[] = msg.partInfos || [];
        this.partInfos = infos;
        this.partsShown = 40;
        const parts: Record<string, PartSetting> = {};
        for (const info of infos) parts[info.id] = this.config.model.parts[info.id] || defaultPart();
        this.config = { ...this.config, model: { ...this.config.model, parts } };
        break;
      }
      case 'modelUpload':
        // Render window loads a model uploaded from the detached controller.
        if (this.isMain) {
          this.modelName = 'Loading…';
          (async () => {
            let name = msg.name || 'model';
            try {
              const err = await this.viewEl?.loadModel?.(msg.buffer);
              name = err ? `⚠ ${err}` : name;
            } catch (e: any) {
              name = `⚠ ${e?.message || 'Failed to load'}`;
            }
            this.modelName = name;
            this.post({ type: 'modelStatus', name });
          })();
        }
        break;
      case 'modelStatus':
        // Controller mirrors the render window's load result.
        if (!this.isMain) this.modelName = msg.name || '';
        break;
      case 'config': {
        // sanitizeConfig always clears model.parts (they belong to whichever
        // model is loaded, not to saved settings). Carry them across the sync
        // instead, or a round-trip would silently wipe every part's band and
        // reaction — which is what happens the moment a controller is attached.
        const next = sanitizeConfig(msg.config);
        const incomingParts = msg.config?.model?.parts;
        next.model.parts =
          incomingParts && Object.keys(incomingParts).length
            ? incomingParts
            : this.config.model.parts;
        this.config = next;
        this.persist();
        break;
      }
      case 'bands':
        // Controller mirrors the render window's live meter + audio state.
        if (this.isController) {
          this.remoteBands = msg.bands;
          this.isRecording = msg.isRecording;
          this.status = msg.status;
          this.error = msg.error || '';
          this.isCapturing = !!msg.isCapturing;
        }
        break;
      case 'command':
        if (this.isMain) this.runCommand(msg.name);
        break;
      case 'codeRequest':
        // Render window registers the code window and sends current source.
        if (this.isMain) {
          this.codeWindowOpen = true;
          this.broadcastCodeState();
        }
        break;
      case 'codeEdit':
        // Render window compiles an edit from the detached code window.
        if (this.isMain) {
          this.editBuffer = msg.buffer;
          this.editImage = msg.image;
          this.applyCode();
        }
        break;
      case 'codeReset':
        if (this.isMain) this.resetCode();
        break;
      case 'codeState':
        // Code window mirrors the render window's source + compile result.
        if (this.isCodeWindow) {
          this.editBuffer = msg.buffer;
          this.editImage = msg.image;
          this.codeError = msg.error || '';
        }
        break;
      case 'codeValues':
        if (this.isCodeWindow) this.codeValues = msg.values;
        break;
    }
  }

  private broadcastTimer: any = null;
  private lastBroadcastAt = 0;

  /**
   * Push the live config to the other windows. Throttled: a slider drag fires
   * on every mousemove and each send serialises the whole config, which is
   * heavy once a model's parts are in there. Always sends a trailing update so
   * the final value lands.
   */
  private broadcastConfig() {
    const now = performance.now();
    const since = now - this.lastBroadcastAt;
    clearTimeout(this.broadcastTimer);
    if (since >= 60) {
      this.lastBroadcastAt = now;
      this.post({ type: 'config', config: this.config });
    } else {
      this.broadcastTimer = setTimeout(() => {
        this.lastBroadcastAt = performance.now();
        this.post({ type: 'config', config: this.config });
      }, 60 - since);
    }
  }

  private runCommand(name: string) {
    if (name === 'startAudio') this.startRecording();
    else if (name === 'stopAudio') this.stopRecording();
    else if (name === 'scanMidi') this.initMidi();
    else if (name === 'burst' || name === 'implode' || name === 'reset') this.viewEl?.[name]?.();
    else if (name === 'startCapture' || name === 'stopCapture') this.toggleCapture();
    else if (name === 'removeModel') {
      this.viewEl?.removeModel?.();
      this.modelName = '';
      this.post({ type: 'modelStatus', name: '' });
    }
  }

  /** Open the control panel in its own window, kept in sync via BroadcastChannel. */
  private detachControls = () => {
    window.open(
      `${location.pathname}?control`,
      'shader-ritual-control',
      'width=440,height=920',
    );
  };

  /** Audio toggle that works from either window (controller proxies a command). */
  private toggleAudio = () => {
    if (this.isController) {
      this.post({
        type: 'command',
        name: this.isRecording ? 'stopAudio' : 'startAudio',
      });
    } else if (this.isRecording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  };

  /* ----------------------------- MIDI ----------------------------- */

  private initMidi = async () => {
    if (!navigator.requestMIDIAccess) {
      this.lastMidiMsg = 'MIDI not supported in this browser.';
      return;
    }
    try {
      this.lastMidiMsg = 'Requesting MIDI access...';
      const access = await navigator.requestMIDIAccess({ sysex: true });
      this.midiActive = true;

      const updateDevicesList = () => {
        const devs: { id: string; name: string }[] = [];
        access.inputs.forEach((input) => devs.push({ id: input.id, name: input.name || 'Unknown Device' }));
        this.midiDevices = devs;
        if (!this.learningParam) {
          this.lastMidiMsg = devs.length > 0 ? `Ready. ${devs.length} devices.` : 'No devices found.';
        }
        (this as any).requestUpdate();
      };

      const setupInput = (input: any) => {
        input.onmidimessage = (msg: any) => {
          const deviceId = msg.target?.id || msg.srcElement?.id;
          if (this.selectedMidiId !== 'all' && deviceId !== this.selectedMidiId) return;
          this.handleMidiMessage(msg);
        };
      };

      access.inputs.forEach(setupInput);
      updateDevicesList();

      access.onstatechange = (e: any) => {
        if (e.port.type === 'input') {
          if (e.port.state === 'connected') setupInput(e.port);
          updateDevicesList();
        }
      };
    } catch (err) {
      this.lastMidiMsg = 'MIDI Access Denied or busy.';
    }
  };

  private handleMidiMessage = (msg: any) => {
    const [status, data1, data2] = msg.data;
    if (status >= 0xf0) return;
    const channel = status & 0x0f;
    const msgType = status & 0xf0;
    if (msgType === 0xe0) {
      this.processMidiEvent(`pb-${channel}`, (data2 << 7) | data1, 'pb');
    } else if (msgType === 0xb0) {
      this.processMidiEvent(`cc-${channel}-${data1}`, data2, 'cc');
    } else if (msgType === 0x90 && data2 > 0) {
      this.processMidiEvent(`note-${channel}-${data1}`, data2, 'note');
    }
  };

  private processMidiEvent = (id: string, value: number, type: 'cc' | 'pb' | 'note') => {
    // A control that reports anything between the extremes is a knob/fader,
    // not a button — remembered so dropdowns scrub rather than step.
    if (type === 'pb' || (type === 'cc' && value !== 0 && value !== 127)) {
      this.midiContinuous[id] = true;
    }
    this.midiPulse = true;
    setTimeout(() => {
      this.midiPulse = false;
      (this as any).requestUpdate();
    }, 80);

    if (this.learningParam) {
      this.midiMappings = { ...this.midiMappings, [id]: { path: this.learningParam, type } };
      localStorage.setItem(MIDI_MAP_KEY, JSON.stringify(this.midiMappings));
      this.lastMidiMsg = `BOUND: ${id.toUpperCase()} to ${this.learningParam.split('.').pop()}`;
      this.learningParam = null;
      (this as any).requestUpdate();
    } else {
      const mapping = this.midiMappings[id];
      if (mapping) {
        const normalized = type === 'pb' ? value / 16383 : value / 127;
        this.lastMidiMsg = `${id.toUpperCase()} → ${mapping.path.replace(/^!/, '')}`;
        this.applyMidiValue(mapping.path, normalized, type, id);
      } else {
        this.lastMidiMsg = `${id.toUpperCase()} value: ${value} (Unmapped)`;
      }
    }
    (this as any).requestUpdate();
  };

  private getParamRange = (path: string) => {
    const rangeMap: Record<string, { min: number; max: number }> = {
      'sensitivity.low': { min: 0, max: 5 },
      'sensitivity.mid': { min: 0, max: 5 },
      'sensitivity.high': { min: 0, max: 10 },
      fftSmoothing: { min: 0, max: 0.95 },
      renderScale: { min: 0.25, max: 1 },
      'camera.bpm': { min: 60, max: 200 },
      'camera.orbitSpeed': { min: 0, max: 3 },
      'camera.distance': { min: 0.3, max: 2.5 },
      'camera.height': { min: -1, max: 1 },
      'camera.fov': { min: 20, max: 120 },
      'camera.reactAmount': { min: 0, max: 3 },
      'camera.cutChance': { min: 0, max: 1 },
      'motion.idle': { min: 0, max: 1 },
      'motion.gain': { min: 0, max: 3 },
      'overlay.opacity': { min: 0, max: 1 },
      'model.scale': { min: 0.1, max: 5 },
      'model.opacity': { min: 0, max: 1 },
      'model.posX': { min: -3, max: 3 },
      'model.posY': { min: -3, max: 3 },
      'model.posZ': { min: -3, max: 3 },
      'model.bpm': { min: 0, max: 300 },
      'model.motionAmount': { min: 0, max: 3 },
      'model.quality': { min: 0.25, max: 1 },
      'model.fracture.fragments': { min: 2, max: 250 },
      'model.capture.opacity': { min: 0, max: 1 },
      'model.capture.scale': { min: 0.1, max: 4 },
      'model.fracture.physics.gravity': { min: 0, max: 4 },
      'model.fracture.physics.burstStrength': { min: 0, max: 4 },
      'model.fracture.physics.spin': { min: 0, max: 5 },
      'model.fracture.physics.restitution': { min: 0, max: 0.95 },
      'model.fracture.physics.implodeStrength': { min: 1, max: 20 },
      'model.fracture.physics.beatThreshold': { min: 0.05, max: 1 },
    };
    if (rangeMap[path]) return rangeMap[path];
    if (path.startsWith('postfx') && path.endsWith('.amount')) return { min: 0, max: 1 };
    if (path.endsWith('.amount')) return { min: 0, max: 3 };
    if (path.endsWith('.level')) return { min: 0, max: 2 };
    if (path.includes('thresholds') || path.includes('Threshold')) return { min: 0, max: 1 };
    return { min: 0, max: 1 };
  };

  /** Read the current value at a dotted config path. */
  private readPath(path: string): any {
    return path.split('.').reduce((o: any, k) => (o == null ? o : o[k]), this.config as any);
  }

  /**
   * Discrete choices for a path that's shown as a dropdown. A continuous
   * control (fader / knob) scrubs across the list; a note button steps to the
   * next choice on each press.
   */
  private getPathOptions(path: string): any[] | null {
    if (path === 'activeShader' || path === 'overlay.shader') return SHADERS.map((s) => s.id);
    if (path === 'overlay.blend') return ['add', 'screen', 'mix'];
    if (path === 'camera.mode') return ['manual', 'bpm', 'audio'];
    if (path === 'model.mode') return ['none', 'parts', 'fracture'];
    if (path === 'model.motion') return ['none', 'spin', 'bob', 'sway', 'orbit', 'tumble'];
    if (path === 'model.capture.mode') return ['background', 'floating'];
    if (path === 'model.fracture.physics.beatAction') return ['burst', 'implode', 'pulse', 'alternate'];
    if (path === 'renderScale' || path === 'model.quality') return [1, 0.75, 0.5, 0.35];
    if (path === 'model.capture.fps') return [60, 30, 15, 8];
    if (path.endsWith('.target')) return ['scale', 'emissive', 'explode', 'rotate'];
    if (path.endsWith('.band') || path.endsWith('Band')) return ['none', 'low', 'mid', 'high'];
    return null;
  }

  /** Paths that hold an on/off flag rather than a number. */
  private isBooleanPath(path: string): boolean {
    return /\.(visible|on|enabled|floor|distribute|reactive|audioGated)$/.test(path);
  }

  /** Last normalised value seen per MIDI control, for rising-edge detection. */
  private lastMidiNorm: Record<string, number> = {};
  /** Controls that have sent something other than 0 / 127 — i.e. real knobs. */
  private midiContinuous: Record<string, boolean> = {};

  /**
   * True until a control proves itself continuous. Pads and buttons only ever
   * send the extremes, so they step dropdowns instead of scrubbing them.
   */
  private isButtonLike(id: string): boolean {
    return !this.midiContinuous[id];
  }

  /** One-shot actions (buttons), mappable to a MIDI note. */
  private readonly MIDI_ACTIONS: Record<string, () => void> = {
    '!burst': () => this.triggerPhysics('burst'),
    '!implode': () => this.triggerPhysics('implode'),
    '!reset': () => this.triggerPhysics('reset'),
    '!audio': () => this.toggleAudio(),
    '!capture': () => this.toggleCapture(),
    '!nextShader': () => this.stepShader(1),
    '!prevShader': () => this.stepShader(-1),
  };

  private stepShader(dir: number) {
    const i = SHADERS.findIndex((s) => s.id === this.config.activeShader);
    const next = SHADERS[(i + dir + SHADERS.length) % SHADERS.length];
    this.updateConfig('activeShader', next.id);
  }

  /**
   * Apply an incoming MIDI value to a mapped target. Numbers scale across the
   * parameter range, dropdowns pick an option, on/off flags toggle (note) or
   * follow the control's position (fader), and `!actions` fire once.
   */
  private applyMidiValue = (path: string, norm: number, type: 'cc' | 'pb' | 'note', id = '') => {
    // Rising edge = the control just crossed into its top half. Notes always
    // count (they only arrive on press). This makes momentary pads that send
    // CC 127-on-press / 0-on-release latch instead of following the button.
    const prev = this.lastMidiNorm[id] ?? 0;
    this.lastMidiNorm[id] = norm;
    const rising = type === 'note' || (norm >= 0.5 && prev < 0.5);

    if (path.startsWith('!')) {
      if (rising) this.MIDI_ACTIONS[path]?.();
      return;
    }

    const cur = this.readPath(path);
    let value: any;

    if (this.isBooleanPath(path)) {
      if (!rising) return; // ignore the release and any mid-sweep chatter
      value = !cur;
    } else {
      const opts = this.getPathOptions(path);
      if (opts) {
        if (type === 'note' || this.isButtonLike(id)) {
          if (!rising) return;
          const i = opts.indexOf(cur);
          value = opts[(i + 1) % opts.length]; // step to the next choice
        } else {
          value = opts[Math.min(opts.length - 1, Math.floor(norm * opts.length))];
        }
      } else {
        const range = this.getParamRange(path);
        value = range.min + norm * (range.max - range.min);
        if (path === 'model.fracture.fragments') value = Math.round(value);
      }
    }

    const keys = path.split('.');
    let ref: any = this.config;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!ref[keys[i]]) ref[keys[i]] = {};
      ref = ref[keys[i]];
    }
    if (ref[keys[keys.length - 1]] !== value) {
      ref[keys[keys.length - 1]] = value;
      const shown = typeof value === 'number' ? value.toFixed(2) : String(value);
      this.lastMidiMsg = `${keys.slice(-2).join('.')} = ${shown}`;
      if (!this.pendingMidiUpdate) {
        this.pendingMidiUpdate = true;
        requestAnimationFrame(() => {
          this.config = { ...this.config };
          this.pendingMidiUpdate = false;
          this.broadcastConfig();
          this.persist();
        });
      }
    }
  };

  /** The little ● MIDI-learn dot. Works for any mappable target. */
  private learnDot = (path: string) => html`
    <button
      class="midi-learn-btn ${this.learningParam === path ? 'active' : ''} ${this.isMapped(path) ? 'mapped' : ''}"
      title="MIDI learn"
      @click=${() => this.toggleMidiLearn(path)}>●</button>
  `;

  /** A dropdown with a MIDI-learn dot: a knob scrubs it, a pad steps it. */
  private renderSelect = (
    label: string,
    path: string,
    options: { value: string; label: string }[],
  ) => html`
    <div class="control-row">
      <label>${label}</label>
      ${this.learnDot(path)}
      <select .value=${live(String(this.readPath(path)))}
        @change=${(e: any) => this.updateConfig(path, e.target.value)}>
        ${options.map((o) => html`<option value=${o.value}>${o.label}</option>`)}
      </select>
    </div>
  `;

  /** An on/off toggle with a MIDI-learn dot: a pad flips it. */
  private renderToggle = (label: string, path: string) => html`
    <div class="control-row">
      <label>${label}</label>
      ${this.learnDot(path)}
      <input type="checkbox" .checked=${!!this.readPath(path)}
        @change=${(e: any) => this.updateConfig(path, e.target.checked)} />
    </div>
  `;

  private toggleMidiLearn = (path: string) => {
    this.learningParam = this.learningParam === path ? null : path;
    this.lastMidiMsg = this.learningParam
      ? 'LEARN: move a knob/fader, or hit a pad...'
      : 'Learn mode off.';
    (this as any).requestUpdate();
  };

  private deleteMapping = (id: string) => {
    const newMaps = { ...this.midiMappings };
    delete newMaps[id];
    this.midiMappings = newMaps;
    localStorage.setItem(MIDI_MAP_KEY, JSON.stringify(this.midiMappings));
    (this as any).requestUpdate();
  };

  private isMapped(path: string) {
    return Object.values(this.midiMappings).some((m) => m.path === path);
  }

  /* --------------------------- Audio ----------------------------- */

  private startRecording = async () => {
    if (this.isRecording) return;
    // Chrome only exposes the mic on secure origins (https or localhost).
    // Opened via a LAN IP over plain http, mediaDevices is undefined.
    if (!navigator.mediaDevices?.getUserMedia) {
      this.error =
        'Mic blocked: browsers only allow the microphone on https or localhost. ' +
        `Open the render window at http://localhost:${location.port || 8787} on this machine ` +
        '(the phone/tablet controller can keep using the IP address).';
      this.status = 'Mic needs localhost';
      return;
    }
    try {
      this.status = 'Initializing mic...';
      if (this.audioContext.state === 'suspended') await this.audioContext.resume();
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.sourceNode.connect(this.audioNode);
      this.isRecording = true;
      this.error = '';
      this.status = 'Shader reactive';
    } catch (err: any) {
      this.error = `Microphone error: ${err.message}`;
      this.stopRecording();
    }
  };

  private stopRecording = () => {
    this.isRecording = false;
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    this.status = 'Audio paused';
  };

  private startMonitor = () => {
    let lastBroadcast = 0;
    const draw = () => {
      this.monitorRaf = requestAnimationFrame(draw);

      // Render window: stream the live meter + audio state to any controller.
      if (!this.isController && this.sync) {
        const view = this.shadowRoot?.querySelector('shader-ritual-view') as any;
        const bands = view?.getBandData?.();
        const now = performance.now();
        if (bands && now - lastBroadcast > 60) {
          lastBroadcast = now;
          this.post({
            type: 'bands',
            bands,
            isRecording: this.isRecording,
            status: this.status,
            error: this.error,
            isCapturing: this.isCapturing,
          });
        }
      }

      // Live uniform values for the code panel (~10fps). The render window
      // serves both its own in-page panel and any detached code window.
      if (this.isMain && (this.showCode || this.codeWindowOpen)) {
        const tnow = performance.now();
        if (tnow - this.lastCodeValueTick > 100) {
          this.lastCodeValueTick = tnow;
          const snap = this.viewEl?.getUniformSnapshot?.();
          if (snap) {
            this.codeValues = snap;
            if (this.codeWindowOpen) this.post({ type: 'codeValues', values: snap });
          }
        }
      }

      if (!this.showSettings) return;
      const canvas = this.shadowRoot?.querySelector('#monitorCanvas') as HTMLCanvasElement;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const data = this.isController
        ? this.remoteBands
        : (this.shadowRoot?.querySelector('shader-ritual-view') as any)?.getBandData?.();
      if (!ctx || !data) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const bands = [
        { val: data.rawLow, threshold: this.config.thresholds.low, col: '#3b82f6', label: 'LOW' },
        { val: data.rawMid, threshold: this.config.thresholds.mid, col: '#10b981', label: 'MID' },
        { val: data.rawHigh, threshold: this.config.thresholds.high, col: '#ef4444', label: 'HIGH' },
      ];
      const w = canvas.width / 3;
      bands.forEach((b, i) => {
        const h = Math.min(1, b.val) * canvas.height;
        ctx.fillStyle = b.col + '66';
        ctx.fillRect(i * w, canvas.height - h, w - 2, h);
        const thY = (1 - b.threshold) * canvas.height;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.moveTo(i * w, thY);
        ctx.lineTo((i + 1) * w - 2, thY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = b.val > b.threshold ? '#fff' : '#ffffff44';
        ctx.font = 'bold 10px monospace';
        ctx.fillText(b.label, i * w + 5, 15);
      });
    };
    draw();
  };

  /* --------------------------- Config ---------------------------- */

  private updateConfig = (key: string, value: any) => {
    const keys = key.split('.');
    let ref: any = this.config;
    for (let i = 0; i < keys.length - 1; i++) {
      ref[keys[i]] = { ...ref[keys[i]] };
      ref = ref[keys[i]];
    }
    ref[keys[keys.length - 1]] = value;
    this.config = { ...this.config };
    this.persist();
    this.broadcastConfig();
  };

  private persistTimer: any = null;

  /**
   * Save to localStorage, debounced. Dragging a slider fires this on every
   * mousemove, and `setItem` is a synchronous write — with a decomposed model
   * in the config that stalls the UI. `model.parts` is dropped because it is
   * rebuilt from the model on load anyway (sanitizeConfig clears it).
   */
  private persist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      try {
        const { model, ...rest } = this.config;
        const { parts, ...modelRest } = model;
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...rest, model: modelRest }));
      } catch (e) {}
    }, 400);
  }

  /* ----------------------------- UI ------------------------------ */

  private renderSlider = (label: string, path: string, min: number, max: number, step: number) => {
    const value = path.split('.').reduce((o, i) => o[i], this.config as any);
    return html`
      <div class="control-row">
        <label>${label}</label>
        <button
          class="midi-learn-btn ${this.learningParam === path ? 'active' : ''} ${this.isMapped(path) ? 'mapped' : ''}"
          @click=${() => this.toggleMidiLearn(path)}>●</button>
        <input type="range" min=${min} max=${max} step=${step} .value=${value}
          @input=${(e: any) => this.updateConfig(path, parseFloat(e.target.value))} />
      </div>
    `;
  };

  private renderModelSection() {
    const m = this.config.model;
    return html`
      <div class="setting-group">
        <span class="group-title">3D Model</span>
        <div class="control-row">
          <label>Upload GLB</label>
          <input type="file" accept=".glb,.gltf" @change=${this.onModelFile} />
        </div>
        <div class="element-desc" style="margin-bottom:8px;">
          ${this.modelName || 'No models loaded'}
          ${this.modelName
            ? html`· <a style="color:#a855f7;cursor:pointer;" @click=${this.clearModel}>remove</a>`
            : ''}
        </div>
        ${this.renderToggle('Visible', 'model.visible')}
        ${this.renderSlider('Scale', 'model.scale', 0.1, 5, 0.05)}
        ${this.renderSlider('Opacity', 'model.opacity', 0, 1, 0.02)}
        ${this.renderSlider('Position X', 'model.posX', -3, 3, 0.05)}
        ${this.renderSlider('Position Y', 'model.posY', -3, 3, 0.05)}
        ${this.renderSlider('Position Z', 'model.posZ', -3, 3, 0.05)}
        <div class="control-row">
          <label>BPM (0 = global)</label>
          <input class="bpm-num" type="number" min="0" max="300" step="1" .value=${String(Math.round(m.bpm))}
            @input=${(e: any) => this.updateConfig('model.bpm', parseFloat(e.target.value) || 0)} />
        </div>
        ${this.renderSelect('Movement', 'model.motion', [
          { value: 'none', label: 'Still (no movement)' },
          { value: 'spin', label: 'Spin (turntable)' },
          { value: 'bob', label: 'Bob (float)' },
          { value: 'sway', label: 'Sway (pendulum)' },
          { value: 'orbit', label: 'Orbit (circle)' },
          { value: 'tumble', label: 'Tumble (off-axis)' },
        ])}
        ${this.renderSlider('Movement depth', 'model.motionAmount', 0, 3, 0.05)}
        <div class="element-desc" style="margin-bottom:8px;">
          The Movement setting drives the model on its own. BPM only sets the
          rate — leave it at 0 to follow the global camera tempo.
        </div>
        <div class="control-row">
          <label>3D quality</label>
          <select .value=${live(String(m.quality))}
            @change=${(e: any) => this.updateConfig('model.quality', parseFloat(e.target.value))}>
            <option value="1">100% (Full)</option>
            <option value="0.75">75%</option>
            <option value="0.5">50%</option>
            <option value="0.35">35%</option>
          </select>
        </div>
        <div class="element-desc" style="margin-bottom:8px;">
          Resolution of the 3D layer only (model + capture) — the shader stays sharp.
          Drop to 50% on a big screen or projector.
        </div>

        <div class="element-desc" style="margin:10px 0 6px;">Break it apart:</div>
        ${this.renderSelect('Mode', 'model.mode', [
          { value: 'none', label: 'Whole' },
          { value: 'parts', label: 'Parts (by mesh)' },
          { value: 'fracture', label: 'Fracture (shatter)' },
        ])}

        ${m.mode === 'parts' ? this.renderPartsMenu() : ''}
        ${m.mode === 'fracture' ? this.renderFractureControls() : ''}
      </div>

      <!-- Screen capture is its own layer — it works with or without a model. -->
      <div class="setting-group">
        <span class="group-title">Screen Capture</span>
        ${this.renderCaptureSection()}
      </div>
    `;
  }

  private renderBandSelect(path: string, value: Band) {
    return html`
      <select .value=${value} @change=${(e: any) => this.updateConfig(path, e.target.value)}>
        <option value="none">None</option>
        <option value="low">Low</option>
        <option value="mid">Mid</option>
        <option value="high">High</option>
      </select>
    `;
  }

  private renderPartsMenu() {
    if (this.partInfos.length === 0) {
      return html`<div class="element-desc">Upload a model to list its parts. Each mesh becomes
        an element you can wire to Low / Mid / High, choose a reaction, and hide.</div>`;
    }
    // Each card is ~6 live controls, and Lit rebuilds them on every config
    // change — a model with hundreds of meshes would stall the panel. Show a
    // page at a time instead.
    const total = this.partInfos.length;
    const shown = Math.min(this.partsShown, total);
    return html`
      <div class="control-row" style="margin:6px 0;gap:6px;justify-content:flex-start;">
        <button class="action-btn" style="font-size:0.7rem;padding:4px 8px;"
          @click=${this.autoDistribute}>Auto-distribute bands</button>
      </div>
      ${this.partInfos.slice(0, shown).map((info) => this.renderPart(info))}
      ${shown < total
        ? html`<div class="control-row" style="gap:6px;justify-content:flex-start;">
            <button class="action-btn" style="font-size:0.7rem;padding:4px 8px;"
              @click=${() => (this.partsShown = this.partsShown + 40)}>
              Show more (${shown} of ${total})
            </button>
          </div>`
        : ''}
    `;
  }

  private renderPart(info: PartInfo) {
    const s = this.config.model.parts[info.id] || defaultPart();
    const base = `model.parts.${info.id}`;
    return html`
      <div class="element-card" style="opacity:${s.visible ? '1' : '0.5'};">
        <div class="element-head" style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px;">
          <span class="element-name" title=${info.name}
            style="font-size:0.8rem;color:#eee;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${info.name}</span>
          <button class="vis-toggle ${s.visible ? 'on' : 'off'}"
            @click=${() => this.updateConfig(`${base}.visible`, !s.visible)}>${s.visible ? 'SHOWN' : 'HIDDEN'}</button>
        </div>
        <div class="control-row">
          <label>Band / React</label>
          ${this.renderBandSelect(`${base}.band`, s.band)}
          <select .value=${s.target}
            @change=${(e: any) => this.updateConfig(`${base}.target`, e.target.value)}>
            <option value="scale">Scale</option>
            <option value="emissive">Glow</option>
            <option value="explode">Explode</option>
            <option value="rotate">Rotate</option>
          </select>
        </div>
        ${this.renderSlider('Amount', `${base}.amount`, 0, 3, 0.05)}
      </div>
    `;
  }

  private renderFractureControls() {
    const f = this.config.model.fracture;
    if (this.partInfos.length === 0) {
      return html`<div class="element-desc">Upload a model, then it shatters into reactive
        fragments — works even on a single fused mesh.</div>`;
    }
    return html`
      <div class="control-row">
        <label>Fragments visible</label>
        ${this.learnDot('model.fracture.visible')}
        <button class="vis-toggle ${f.visible ? 'on' : 'off'}"
          @click=${() => this.updateConfig('model.fracture.visible', !f.visible)}>${f.visible ? 'SHOWN' : 'HIDDEN'}</button>
      </div>
      <div class="control-row">
        <label>Fragments</label>
        <input class="bpm-num" type="number" min="2" max="250" step="1" .value=${String(Math.round(f.fragments))}
          @input=${(e: any) => this.updateConfig('model.fracture.fragments', parseFloat(e.target.value) || 2)} />
      </div>
      <div class="control-row">
        <label>Distribute across bands</label>
        ${this.learnDot('model.fracture.distribute')}
        <input type="checkbox" .checked=${f.distribute}
          @change=${(e: any) => this.updateConfig('model.fracture.distribute', e.target.checked)} />
      </div>
      ${f.distribute
        ? ''
        : html`<div class="control-row"><label>Explode band</label>${this.renderBandSelect('model.fracture.explodeBand', f.explodeBand)}</div>`}
      ${this.renderSlider('Explode amt', 'model.fracture.explodeAmount', 0, 3, 0.05)}
      ${f.distribute
        ? ''
        : html`<div class="control-row"><label>Scale band</label>${this.renderBandSelect('model.fracture.scaleBand', f.scaleBand)}</div>`}
      ${this.renderSlider('Scale amt', 'model.fracture.scaleAmount', 0, 3, 0.05)}
      <div class="control-row"><label>Spin band</label>${this.renderBandSelect('model.fracture.spinBand', f.spinBand)}</div>
      ${this.renderSlider('Spin amt', 'model.fracture.spinAmount', 0, 3, 0.05)}
      ${this.renderPhysics()}
    `;
  }

  private renderPhysics() {
    const p = this.config.model.fracture.physics;
    return html`
      <div style="margin-top:12px;border-top:1px solid rgba(255,255,255,0.08);padding-top:10px;">
        <div class="control-row">
          <label><strong>Physics</strong> (burst · fall · tumble)</label>
          ${this.learnDot('model.fracture.physics.enabled')}
          <input type="checkbox" .checked=${p.enabled}
            @change=${(e: any) => this.updateConfig('model.fracture.physics.enabled', e.target.checked)} />
        </div>
        ${!p.enabled
          ? html`<div class="element-desc">When on, fragments fly apart and fall under gravity.
              Trigger a burst / implode by hand or on a beat.</div>`
          : html`
              <div class="control-row" style="gap:6px;justify-content:flex-start;flex-wrap:wrap;margin-bottom:8px;">
                ${this.learnDot('!burst')}
                <button class="action-btn" style="font-size:0.7rem;padding:4px 8px;" @click=${() => this.triggerPhysics('burst')}>💥 Burst</button>
                ${this.learnDot('!implode')}
                <button class="action-btn" style="font-size:0.7rem;padding:4px 8px;" @click=${() => this.triggerPhysics('implode')}>🧲 Implode</button>
                ${this.learnDot('!reset')}
                <button class="action-btn" style="font-size:0.7rem;padding:4px 8px;" @click=${() => this.triggerPhysics('reset')}>↺ Reset</button>
              </div>
              ${this.renderSlider('Gravity', 'model.fracture.physics.gravity', 0, 4, 0.05)}
              ${this.renderSlider('Burst force', 'model.fracture.physics.burstStrength', 0, 4, 0.05)}
              ${this.renderSlider('Tumble spin', 'model.fracture.physics.spin', 0, 5, 0.05)}
              ${this.renderSlider('Implode pull', 'model.fracture.physics.implodeStrength', 1, 20, 0.5)}
              <div class="control-row">
                <label>Floor collision</label>
                ${this.learnDot('model.fracture.physics.floor')}
                <input type="checkbox" .checked=${p.floor}
                  @change=${(e: any) => this.updateConfig('model.fracture.physics.floor', e.target.checked)} />
              </div>
              ${this.renderSlider('Bounce', 'model.fracture.physics.restitution', 0, 0.95, 0.05)}
              <div class="control-row">
                <label>Beat trigger</label>
                ${this.renderBandSelect('model.fracture.physics.beatBand', p.beatBand)}
                ${this.learnDot('model.fracture.physics.beatAction')}
                <select .value=${live(p.beatAction)}
                  @change=${(e: any) => this.updateConfig('model.fracture.physics.beatAction', e.target.value)}>
                  <option value="burst">Burst</option>
                  <option value="implode">Implode</option>
                  <option value="pulse">Pulse</option>
                  <option value="alternate">Alternate</option>
                </select>
              </div>
              ${this.renderSlider('Beat sensitivity', 'model.fracture.physics.beatThreshold', 0.05, 1, 0.01)}
            `}
      </div>
    `;
  }

  private renderCaptureSection() {
    const c = this.config.model.capture;
    return html`
      <div>
        <div class="element-desc" style="margin-bottom:6px;">
          Project a shared window into the scene. Works on its own — no 3D model needed.
        </div>
        <div class="control-row" style="gap:8px;justify-content:flex-start;">
          ${this.learnDot('!capture')}
          <button class="action-btn ${this.isCapturing ? 'active' : ''}" style="font-size:0.72rem;padding:6px 10px;"
            @click=${this.toggleCapture}>${this.isCapturing ? 'Stop Capture' : 'Share a Window'}</button>
          ${this.learnDot('model.capture.visible')}
          <button class="vis-toggle ${c.visible ? 'on' : 'off'}"
            @click=${() => this.updateConfig('model.capture.visible', !c.visible)}>${c.visible ? 'SHOWN' : 'HIDDEN'}</button>
        </div>
        ${this.renderSlider('Capture opacity', 'model.capture.opacity', 0, 1, 0.05)}
        ${this.renderSlider('Capture scale', 'model.capture.scale', 0.1, 4, 0.1)}
        <div class="control-row">
          <label>Capture rate</label>
          <select .value=${live(String(c.fps))}
            @change=${(e: any) => this.updateConfig('model.capture.fps', parseFloat(e.target.value))}>
            <option value="60">60 fps</option>
            <option value="30">30 fps</option>
            <option value="15">15 fps</option>
            <option value="8">8 fps</option>
          </select>
        </div>
        <div class="element-desc" style="margin-bottom:8px;">
          Each captured frame is a full texture upload. Lower this first if
          sharing feels heavy — re-share the window to apply the new rate.
        </div>
        <div class="control-row">
          <label>Projection</label>
          ${this.learnDot('model.capture.mode')}
          <select .value=${live(c.mode)}
            @change=${(e: any) => this.updateConfig('model.capture.mode', e.target.value)}>
            <option value="background">Rear Wall</option>
            <option value="floating">Floating Plane</option>
          </select>
        </div>
        <div class="control-row">
          <label>Audio reactive</label>
          ${this.learnDot('model.capture.reactive')}
          <input type="checkbox" .checked=${c.reactive}
            @change=${(e: any) => this.updateConfig('model.capture.reactive', e.target.checked)} />
          ${this.renderBandSelect('model.capture.reactiveBand', c.reactiveBand)}
        </div>
      </div>
    `;
  }

  private renderFx = (name: string, label: string) => {
    const fx = (this.config.postfx as any)[name];
    const onPath = `postfx.${name}.on`;
    const amtPath = `postfx.${name}.amount`;
    const bandPath = `postfx.${name}.band`;
    return html`
      <div class="element-card ${fx.on ? '' : 'hidden-el'}">
        <div class="element-head">
          <span class="element-name">${label}</span>
          ${this.learnDot(onPath)}
          <button class="vis-toggle ${fx.on ? 'on' : 'off'}"
            @click=${() => this.updateConfig(onPath, !fx.on)}>${fx.on ? 'ON' : 'OFF'}</button>
        </div>
        <div class="control-row">
          <label>Amount</label>
          <button
            class="midi-learn-btn ${this.learningParam === amtPath ? 'active' : ''} ${this.isMapped(amtPath) ? 'mapped' : ''}"
            @click=${() => this.toggleMidiLearn(amtPath)}>●</button>
          <input type="range" min="0" max="1" step="0.02" .value=${fx.amount}
            @input=${(e: any) => this.updateConfig(amtPath, parseFloat(e.target.value))} />
        </div>
        <div class="control-row">
          <label>React band</label>
          ${this.learnDot(bandPath)}
          <select .value=${live(fx.band)}
            @change=${(e: any) => this.updateConfig(bandPath, e.target.value as Band)}>
            <option value="none">None</option>
            <option value="low">Low</option>
            <option value="mid">Mid</option>
            <option value="high">High</option>
          </select>
        </div>
      </div>
    `;
  };

  private renderElement = (shaderId: string, elementId: string) => {
    const def = getShader(shaderId);
    const meta = def.elements.find((e) => e.id === elementId)!;
    const setting = this.config.shaders[shaderId].elements[elementId];
    const bandPath = `shaders.${shaderId}.elements.${elementId}.band`;
    const amountPath = `shaders.${shaderId}.elements.${elementId}.amount`;
    const levelPath = `shaders.${shaderId}.elements.${elementId}.level`;
    const visiblePath = `shaders.${shaderId}.elements.${elementId}.visible`;
    return html`
      <div class="element-card ${setting.visible ? '' : 'hidden-el'}">
        <div class="element-head">
          <span class="element-name">${meta.name}</span>
          ${meta.canHide
            ? html`
                ${this.learnDot(visiblePath)}
                <button
                  class="vis-toggle ${setting.visible ? 'on' : 'off'}"
                  @click=${() => this.updateConfig(visiblePath, !setting.visible)}>
                  ${setting.visible ? 'SHOWN' : 'HIDDEN'}
                </button>`
            : ''}
        </div>
        <div class="element-desc">${meta.description}</div>
        <div class="control-row">
          <label>Audio band</label>
          ${this.learnDot(bandPath)}
          <select
            .value=${live(setting.band)}
            @change=${(e: any) => this.updateConfig(bandPath, e.target.value as Band)}>
            <option value="none">None</option>
            <option value="low">Low</option>
            <option value="mid">Mid</option>
            <option value="high">High</option>
          </select>
        </div>
        <div class="control-row">
          <label>Reactive amount</label>
          <button
            class="midi-learn-btn ${this.learningParam === amountPath ? 'active' : ''} ${this.isMapped(amountPath) ? 'mapped' : ''}"
            @click=${() => this.toggleMidiLearn(amountPath)}>●</button>
          <input type="range" min="0" max="3" step="0.05" .value=${setting.amount}
            @input=${(e: any) => this.updateConfig(amountPath, parseFloat(e.target.value))} />
        </div>
        <div class="control-row">
          <label title="Manual baseline added to the reactive value — drive this element by hand (set band to None for pure manual control)">Manual level</label>
          <button
            class="midi-learn-btn ${this.learningParam === levelPath ? 'active' : ''} ${this.isMapped(levelPath) ? 'mapped' : ''}"
            @click=${() => this.toggleMidiLearn(levelPath)}>●</button>
          <input type="range" min="0" max="2" step="0.02" .value=${setting.level}
            @input=${(e: any) => this.updateConfig(levelPath, parseFloat(e.target.value))} />
        </div>
      </div>
    `;
  };

  private tapTimes: number[] = [];
  private tapTempo = () => {
    const now = performance.now();
    this.tapTimes = this.tapTimes.filter((t) => now - t < 3000);
    this.tapTimes.push(now);
    if (this.tapTimes.length >= 2) {
      let sum = 0;
      for (let i = 1; i < this.tapTimes.length; i++) sum += this.tapTimes[i] - this.tapTimes[i - 1];
      const avg = sum / (this.tapTimes.length - 1);
      const bpm = Math.max(40, Math.min(240, Math.round(60000 / avg)));
      this.updateConfig('camera.bpm', bpm);
    }
  };

  private renderCameraSection() {
    const cam = this.config.camera;
    const modes: { id: CameraMode; label: string }[] = [
      { id: 'manual', label: 'Manual orbit' },
      { id: 'bpm', label: 'BPM cuts' },
      { id: 'audio', label: 'Audio reactive' },
    ];
    return html`
      <div class="setting-group">
        <span class="group-title">Camera · Motion</span>
        <div class="element-desc" style="margin-bottom:10px;">
          Drives the whole shot independently of element reactivity — orbit,
          framing and field of view. Pick how it's animated below.
        </div>
        <div class="control-row">
          <label>Mode</label>
          ${this.learnDot('camera.mode')}
          <select
            .value=${live(cam.mode)}
            @change=${(e: any) => this.updateConfig('camera.mode', e.target.value as CameraMode)}>
            ${modes.map((m) => html`<option value=${m.id}>${m.label}</option>`)}
          </select>
        </div>
        <div class="control-row">
          <label>Tempo (BPM)</label>
          <button
            class="midi-learn-btn ${this.learningParam === 'camera.bpm' ? 'active' : ''} ${this.isMapped('camera.bpm') ? 'mapped' : ''}"
            @click=${() => this.toggleMidiLearn('camera.bpm')}>●</button>
          <input class="bpm-num" type="number" min="40" max="240" step="1" .value=${String(Math.round(cam.bpm))}
            @input=${(e: any) => this.updateConfig('camera.bpm', parseFloat(e.target.value) || cam.bpm)} />
          <button class="action-btn small" @click=${this.tapTempo}>Tap</button>
        </div>
        ${this.renderSlider('· fine', 'camera.bpm', 60, 200, 1)}
        ${cam.mode !== 'bpm'
          ? this.renderSlider('Orbit speed', 'camera.orbitSpeed', 0, 3, 0.05)
          : this.renderSlider('Cut variety', 'camera.cutChance', 0, 1, 0.05)}
        ${cam.mode === 'audio'
          ? html`<div class="control-row">
              <label>Drive band</label>
              <select
                .value=${cam.audioBand}
                @change=${(e: any) => this.updateConfig('camera.audioBand', e.target.value as Band)}>
                <option value="none">None</option>
                <option value="low">Low</option>
                <option value="mid">Mid</option>
                <option value="high">High</option>
              </select>
            </div>`
          : ''}
        ${cam.mode !== 'manual'
          ? this.renderSlider('React amount', 'camera.reactAmount', 0, 3, 0.05)
          : ''}
        ${this.renderSlider('Distance', 'camera.distance', 0.3, 2.5, 0.05)}
        ${this.renderSlider('Height', 'camera.height', -1, 1, 0.02)}
        ${this.renderSlider('Field of view', 'camera.fov', 20, 120, 1)}
      </div>
    `;
  }

  private fmt(v: number) {
    if (!Number.isFinite(v)) return String(v);
    return Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3);
  }

  private renderCodePanel() {
    const def = getShader(this.config.activeShader);
    const src = this.codeTab === 'buffer' ? this.editBuffer : this.editImage;
    const keys = Object.keys(this.codeValues).sort();
    return html`
      <div class="code-panel ${this.showCode ? 'open' : ''} ${this.isCodeWindow ? 'windowed' : ''}">
        <div class="code-head">
          <span class="title">${def.name} · live source${this.isCodeWindow ? ' · detached' : ''}</span>
          <button class="code-tab ${this.codeTab === 'buffer' ? 'active' : ''}"
            @click=${() => (this.codeTab = 'buffer')}>Buffer A</button>
          <button class="code-tab ${this.codeTab === 'image' ? 'active' : ''}"
            @click=${() => (this.codeTab = 'image')}>Image</button>
          ${this.isCodeWindow
            ? ''
            : html`<button class="icon-btn" title="Pop the code editor out to its own window"
                @click=${this.detachCode}>⧉</button>`}
          <button class="icon-btn"
            @click=${() => (this.isCodeWindow ? window.close() : (this.showCode = false))}>&times;</button>
        </div>
        <div class="code-values">${keys.map(
          (k) => html`<span class="k">${k}</span> = ${this.fmt(this.codeValues[k])}\n`,
        )}</div>
        <textarea class="code-textarea" spellcheck="false" .value=${live(src)}
          @input=${(e: any) => this.onCodeInput(this.codeTab, e.target.value)}></textarea>
        <div class="code-foot">
          ${this.codeError
            ? html`<div class="code-error">${this.codeError}</div>`
            : html`<div class="code-ok">✓ compiled · edits apply ~0.5s after you stop typing</div>`}
          <button class="action-btn small" @click=${this.applyCode}>Apply</button>
          <button class="action-btn small" @click=${this.resetCode}>Reset</button>
        </div>
      </div>
    `;
  }

  private renderOverlaySection() {
    const ov = this.config.overlay;
    const ovDef = getShader(ov.shader);
    return html`
      <div class="setting-group">
        <span class="group-title">Overlay Layer · combine across shaders</span>
        <div class="element-desc" style="margin-bottom:10px;">
          Composite a second shader on top of the active one, then hide the
          overlay's other elements to keep only the part you want — e.g. set this
          to Mandala and hide all but its Light Columns to ride its beams over any
          shader. Add / Screen drop the overlay's dark areas out.
        </div>
        ${this.renderToggle('Enable overlay', 'overlay.enabled')}
        ${ov.enabled
          ? html`
              <div class="control-row">
                <label>Overlay shader</label>
                ${this.learnDot('overlay.shader')}
                <select .value=${live(ov.shader)}
                  @change=${(e: any) => this.updateConfig('overlay.shader', e.target.value)}>
                  ${SHADERS.map((s) => html`<option value=${s.id}>${s.name}</option>`)}
                </select>
              </div>
              <div class="control-row">
                <label>Blend</label>
                ${this.learnDot('overlay.blend')}
                <select .value=${live(ov.blend)}
                  @change=${(e: any) => this.updateConfig('overlay.blend', e.target.value)}>
                  <option value="add">Add (glow)</option>
                  <option value="screen">Screen</option>
                  <option value="mix">Mix</option>
                </select>
              </div>
              ${this.renderSlider('Opacity', 'overlay.opacity', 0, 1, 0.02)}
              <div class="element-desc" style="margin:12px 0 6px;">
                ${ovDef.name} elements — hide what you don't want:
              </div>
              ${ovDef.elements.map((el) => this.renderElement(ovDef.id, el.id))}
            `
          : ''}
      </div>
    `;
  }

  private renderSettings() {
    const def = getShader(this.config.activeShader);
    return html`
      <div class="settings-panel ${this.showSettings ? 'open' : ''} ${this.isController ? 'controller' : ''}">
        <div class="panel-header">
          <h2>Shader Ritual</h2>
          <div class="header-actions">
            ${this.isController
              ? html`<span class="live-dot">Live control</span>`
              : html`
                  <button class="icon-btn" title="Pop controls out to a separate window"
                    @click=${this.detachControls}>⧉</button>
                  <button class="icon-btn" @click=${() => (this.showSettings = false)}>&times;</button>
                `}
          </div>
        </div>

        <div class="monitor-container"><canvas id="monitorCanvas" width="300" height="80"></canvas></div>

        <!-- SHADER SELECT -->
        <div class="setting-group">
          <span class="group-title">Active Shader</span>
          <div style="display:flex;align-items:center;gap:6px;">
            ${this.learnDot('activeShader')}
            <select
              class="shader-select"
              style="flex:1;"
              .value=${live(this.config.activeShader)}
              @change=${(e: any) => this.updateConfig('activeShader', e.target.value)}>
              ${SHADERS.map((s) => html`<option value=${s.id}>${s.name}</option>`)}
            </select>
          </div>
          <div class="control-row" style="gap:6px;justify-content:flex-start;margin-top:8px;">
            ${this.learnDot('!prevShader')}
            <button class="action-btn small" @click=${() => this.stepShader(-1)}>‹ Prev</button>
            ${this.learnDot('!nextShader')}
            <button class="action-btn small" @click=${() => this.stepShader(1)}>Next ›</button>
          </div>
          <div class="element-desc" style="margin-top:8px;">${def.description}</div>
          <div class="element-desc">
            Map the dot beside the list to a knob to scrub shaders, or map
            Prev/Next to two pads.
          </div>
        </div>

        <!-- PERFORMANCE -->
        <div class="setting-group">
          <span class="group-title">Performance</span>
          <div class="control-row">
            <label>Render scale</label>
            <select .value=${live(String(this.config.renderScale))}
              @change=${(e: any) => this.updateConfig('renderScale', parseFloat(e.target.value))}>
              <option value="1">100% (Full)</option>
              <option value="0.75">75%</option>
              <option value="0.5">50%</option>
              <option value="0.35">35%</option>
            </select>
          </div>
          <div class="element-desc">
            Lowers the internal resolution. Drop this to 50–75% for external
            displays / projectors on Mac, where a Retina buffer is the biggest
            GPU cost.
          </div>
        </div>

        <!-- CAMERA / MOTION (global) -->
        ${this.renderCameraSection()}

        <!-- AUDIO-GATED MOTION -->
        <div class="setting-group">
          <span class="group-title">Motion · Calm on silence</span>
          <div class="element-desc" style="margin-bottom:10px;">
            Animation speed follows the audio. With this on, the scene calms (or
            freezes, at Idle 0) when no sound is coming in.
          </div>
          ${this.renderToggle('Audio-gated', 'motion.audioGated')}
          ${this.renderSlider('Idle drift', 'motion.idle', 0, 1, 0.01)}
          ${this.renderSlider('Audio gain', 'motion.gain', 0, 3, 0.05)}
        </div>

        <!-- ELEMENT -> AUDIO ALLOCATION (per shader) -->
        <div class="setting-group">
          <span class="group-title">${def.name} · Element Allocation</span>
          ${def.elements.map((el) => this.renderElement(def.id, el.id))}
        </div>

        <!-- OVERLAY LAYER (combine elements across shaders) -->
        ${this.renderOverlaySection()}

        <!-- RESPONSE PROFILE -->
        <div class="setting-group">
          <span class="group-title">Response Profile</span>
          ${this.renderSlider('FFT Smoothing', 'fftSmoothing', 0, 0.95, 0.05)}
          ${this.renderSlider('Low Gain', 'sensitivity.low', 0, 5, 0.1)}
          ${this.renderSlider('Mid Gain', 'sensitivity.mid', 0, 5, 0.1)}
          ${this.renderSlider('High Gain', 'sensitivity.high', 0, 10, 0.1)}
        </div>

        <!-- NOISE GATES -->
        <div class="setting-group">
          <span class="group-title">Noise Gates</span>
          ${this.renderSlider('Low Gate', 'thresholds.low', 0, 1, 0.01)}
          ${this.renderSlider('Mid Gate', 'thresholds.mid', 0, 1, 0.01)}
          ${this.renderSlider('High Gate', 'thresholds.high', 0, 1, 0.01)}
        </div>

        <!-- POST FX (global, all shaders) -->
        <div class="setting-group">
          <span class="group-title">Post FX · global filters</span>
          <div class="element-desc" style="margin-bottom:10px;">
            Image-wide filters layered over every shader. Assign a band to a
            filter to make its strength pulse with the audio.
          </div>
          ${this.renderFx('pixelate', 'Pixelate')}
          ${this.renderFx('edge', 'Edge Detect')}
          ${this.renderFx('posterize', 'Posterize')}
          ${this.renderFx('rgbShift', 'RGB Shift')}
          ${this.renderFx('scanlines', 'Scanlines')}
          ${this.renderFx('glitch', 'Glitch (block swap)')}
          ${this.renderFx('mosaic', 'Mosaic Shuffle')}
        </div>

        <!-- 3D MODEL -->
        ${this.renderModelSection()}

        <!-- MIDI -->
        <div class="setting-group">
          <span class="group-title">MIDI Bridge</span>
          <div class="midi-log ${this.midiPulse ? 'pulse' : ''} ${this.learningParam ? 'learning' : ''}">
            ${this.learningParam ? 'LEARNING...' : this.lastMidiMsg}
          </div>
          <div class="element-desc" style="margin-top:8px;">
            Hit any ● to learn, then move a control. Knobs / faders sweep values
            and scrub dropdowns; pads step a dropdown to its next choice, flip an
            on/off, or fire a button.
          </div>
          <select
            class="device-select"
            @change=${(e: any) => (this.selectedMidiId = e.target.value)}
            .value=${this.selectedMidiId}>
            <option value="all">Listen to All Devices</option>
            ${this.midiDevices.map((d) => html`<option value=${d.id}>Only: ${d.name}</option>`)}
          </select>
          ${Object.keys(this.midiMappings).length > 0
            ? html`
                <table class="mapping-table">
                  <thead><tr><th>ID</th><th>Target</th><th></th></tr></thead>
                  <tbody>
                    ${Object.entries(this.midiMappings).map(
                      ([id, map]) => html`
                        <tr>
                          <td>${id.toUpperCase()}</td>
                          <td>${map.path.split('.').slice(-2).join('.')}</td>
                          <td style="text-align:right;">
                            <button class="del-map" @click=${() => this.deleteMapping(id)}>🗑️</button>
                          </td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              `
            : ''}
          <div class="control-row action-row" style="margin-top:10px;">
            <button class="action-btn small" @click=${this.initMidi}>Hardware Scan</button>
            <button
              class="action-btn small"
              @click=${() => {
                this.midiMappings = {};
                localStorage.removeItem(MIDI_MAP_KEY);
                (this as any).requestUpdate();
              }}>
              Clear Mappings
            </button>
          </div>
        </div>

        <!-- SYSTEM -->
        <div class="setting-group">
          <span class="group-title">System</span>
          <div class="control-row action-row">
            ${this.learnDot('!audio')}
            <button
              class="action-btn ${this.isRecording ? 'active' : ''}"
              @click=${this.toggleAudio}>
              ${this.isRecording ? 'Kill Audio' : 'Ignite Audio'}
            </button>
          </div>
        </div>

        <!-- REMOTE (phone / tablet controller over the LAN) -->
        <div class="setting-group">
          <span class="group-title">Remote · phone / tablet</span>
          ${this.wsOk
            ? html`
                <div class="live-dot" style="margin-bottom:8px;">Relay connected</div>
                ${this.remoteUrls.length
                  ? html`<div class="element-desc">
                      Controller on another device:
                      ${this.remoteUrls.map((u) => html`<div><a style="color:#a855f7;" href="${u}?control" target="_blank">${u}?control</a></div>`)}
                      Keep the render window on <strong>localhost</strong> on the host
                      machine — browsers only allow the mic on https/localhost.
                    </div>`
                  : ''}
              `
            : html`<div class="element-desc">
                Not connected. Run <strong>npm run remote</strong> in the project folder,
                open the printed URL here and on your phone/tablet with
                <strong>?control</strong> appended — the panel syncs live over your
                local network.
              </div>`}
        </div>
      </div>
    `;
  }

  render() {
    // Detached controller window: just the panel, no render canvas / gear.
    if (this.isController) {
      return html`<div>${this.renderSettings()}</div>`;
    }
    // Detached code window: just the editor, synced to the render window.
    if (this.isCodeWindow) {
      return html`<div>${this.renderCodePanel()}</div>`;
    }
    return html`
      <div>
        <button class="code-btn ${this.showCode ? 'active' : ''}" title="Live code panel (C)"
          @click=${() => (this.showCode = !this.showCode)}>&lt;/&gt;</button>
        <button class="settings-btn" @click=${() => (this.showSettings = !this.showSettings)}>
          <svg viewBox="0 0 24 24">
            <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" />
          </svg>
        </button>
        ${this.renderCodePanel()}
        ${this.renderSettings()}
        <div id="status">${this.error || this.status}</div>
        <shader-ritual-view .config=${this.config} .inputNode=${this.audioNode}
          @parts-changed=${this.onPartsChanged}></shader-ritual-view>
      </div>
    `;
  }
}
