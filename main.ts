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
import type { AudioSignal, Band, LiveEvent, StrobeConfig, CameraMode, Modulation, PartInfo, PartSetting, ReactTarget, ShaderRitualConfig } from './types';
import { HIT_ACTIONS, SIGNAL_PRESETS, describeEvent, eventSignal, freqToX, isCore, newSignalId, suggestMatch, xToFreq } from './audio-signals';
import { modulatable, paramRange } from './param-ranges';
import { TEXT_MAX } from './types';

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
  @state() modelInfo = '';
  @state() videoName = '';
  @state() videoInfo = '';
  /** Watchdog for a clip handed to the render window from a detached panel. */
  private videoRelayTimer: any = null;

  // MeshRitual engine: parts surfaced from the loaded model + screen capture.
  @state() partInfos: PartInfo[] = [];
  /** How many part cards are rendered at once (see renderPartsMenu). */
  @state() private partsShown = 40;
  @state() isCapturing = false;
  /** Cameras the render window can see; mirrored to controllers with the meter. */
  @state() cameras: { id: string; label: string }[] = [];
  /** source|cameraId of the running capture, to notice when either changes. */
  private captureKey = '';
  private captureBusy = false;
  private captureStream: MediaStream | null = null;

  private onModelFile = async (e: any) => {
    const file = e.target.files?.[0];
    if (!file) return;
    this.modelName = 'Loading…';
    this.modelInfo = '';
    try {
      const buf = await file.arrayBuffer();
      if (this.isController) {
        // No WebGL in the detached window — ship the bytes to the render window.
        this.post({ type: 'modelUpload', buffer: buf, name: file.name });
        return;
      }
      const view = this.viewEl;
      if (!view?.loadModel) {
        // Optional chaining here would resolve undefined and read as success,
        // leaving the panel showing a filename for a model nothing ever loaded.
        this.modelName = '⚠ Renderer not ready — try again in a moment';
        return;
      }
      const err = await view.loadModel(buf);
      this.modelName = err ? `⚠ ${err}` : file.name;
      this.modelInfo = err ? '' : this.describeModel();
      this.post({ type: 'modelStatus', name: this.modelName, info: this.modelInfo });
    } catch (e: any) {
      this.modelName = `⚠ ${e?.message || 'Failed to load'}`;
      this.post({ type: 'modelStatus', name: this.modelName, info: '' });
    }
  };

  /** "12 meshes · 34.2k tris", so a load that found nothing is obvious. */
  private describeModel(): string {
    const i = this.viewEl?.modelInfo?.();
    if (!i) return '';
    const t = i.tris >= 1000 ? `${(i.tris / 1000).toFixed(1)}k` : String(i.tris);
    return `${i.meshes} mesh${i.meshes === 1 ? '' : 'es'} · ${t} tris`;
  }
  /**
   * Open a clip. The file is handed straight to the renderer, which turns it
   * into an object URL — it is never read into an ArrayBuffer, so size is not
   * a factor and a multi-gigabyte clip loads as fast as a small one.
   *
   * An object URL is only valid in the document that created it, so a detached
   * panel cannot make one and send it. It can send the File itself: a Blob is
   * structured-cloneable and the browser passes it by reference rather than by
   * value, so relaying a 4 GB clip over the channel costs nothing and the
   * render window makes its own URL. That only works between windows of the
   * same browser — a controller attached over the network relay has no such
   * channel, and is told so rather than appearing to work.
   */
  private onVideoFile = async (e: any) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (this.isController) {
      if (!this.sync) {
        this.videoName = '⚠ Open the clip in the render window — a remote panel cannot send a file';
        return;
      }
      this.videoName = 'Loading…';
      this.videoInfo = '';
      this.post({ type: 'videoUpload', file, name: file.name });
      // BroadcastChannel exists in every browser, but it only reaches windows
      // on this machine — a controller on a phone has one that goes nowhere.
      // Nothing comes back from that, so treat silence as a refusal rather
      // than leaving the panel on "Loading…" for good.
      clearTimeout(this.videoRelayTimer);
      this.videoRelayTimer = setTimeout(() => {
        if (this.videoName === 'Loading…') {
          this.videoName = '⚠ No answer from the render window — open the clip there instead';
        }
      }, 6000);
      return;
    }
    this.videoName = 'Loading…';
    this.videoInfo = '';
    try {
      const err = await this.viewEl?.setVideoFile?.(file);
      if (err) {
        this.videoName = `⚠ ${err}`;
      } else {
        this.videoName = file.name;
        const i = this.viewEl?.videoInfo?.();
        if (i) {
          const mm = Math.floor(i.duration / 60);
          const ss = Math.floor(i.duration % 60).toString().padStart(2, '0');
          this.videoInfo = `${i.width}×${i.height} · ${mm}:${ss}`;
        }
      }
    } catch (err: any) {
      this.videoName = `⚠ ${err?.message || 'Failed to load'}`;
    }
    this.post({ type: 'videoStatus', name: this.videoName, info: this.videoInfo });
  };

  /** Restart the paragraph from the top, here or in the render window. */
  private fireText() {
    if (this.isController) this.post({ type: 'command', name: 'textFire' });
    else this.viewEl?.textTrigger?.();
  }

  /** Fire one slice trigger now, whatever the auto mode is doing. */
  private fireVideo(kind: string) {
    if (this.isController) this.post({ type: 'command', name: 'vid:' + kind });
    else this.viewEl?.videoTrigger?.(kind);
  }

  private clearVideoClip = () => {
    if (this.isController) {
      this.post({ type: 'command', name: 'removeVideo' });
    } else {
      this.viewEl?.clearVideo?.();
    }
    this.videoName = '';
    this.videoInfo = '';
    this.post({ type: 'videoStatus', name: '', info: '' });
  };

  /**
   * Put the model back where it can be seen. A saved config carries mode,
   * opacity, scale and position across sessions, so a model can load correctly
   * and still be invisible because of how the last one was left — shattered
   * with fragments hidden, at zero opacity, or pushed out of frame.
   */
  private resetModelView = () => {
    this.updateConfig('model.visible', true);
    this.updateConfig('model.opacity', 1);
    this.updateConfig('model.scale', 1);
    this.updateConfig('model.posX', 0);
    this.updateConfig('model.posY', 0);
    this.updateConfig('model.posZ', 0);
    this.updateConfig('model.quality', 1);
    this.updateConfig('model.mode', 'none');
    this.updateConfig('model.fracture.visible', true);
  };

  private clearModel = () => {
    if (this.isController) {
      this.post({ type: 'command', name: 'removeModel' });
    } else {
      this.viewEl?.removeModel?.();
      this.post({ type: 'modelStatus', name: '', info: '' });
    }
    this.modelName = '';
    this.modelInfo = '';
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

  /** The capture layer: a shared window, or a camera. */
  private toggleCapture = async () => {
    if (this.isController) {
      this.post({ type: 'command', name: this.isCapturing ? 'stopCapture' : 'startCapture' });
      return;
    }
    if (this.isCapturing) this.stopCapture();
    else await this.startCapture();
  };

  private stopCapture() {
    this.captureStream?.getTracks().forEach((t) => t.stop());
    this.captureStream = null;
    this.isCapturing = false;
    this.captureKey = '';
    this.viewEl?.setCaptureStream?.(null);
  }

  private async startCapture() {
    if (this.captureBusy) return;
    this.captureBusy = true;
    const c = this.config.model.capture;
    try {
      this.error = '';
      const stream = c.source === 'camera' ? await this.openCamera() : await this.openScreen();
      if (!stream) return;
      // A stream that was replaced while this one was opening is dropped.
      this.captureStream?.getTracks().forEach((t) => t.stop());
      this.captureStream = stream;
      this.isCapturing = true;
      this.captureKey = `${c.source}|${c.source === 'camera' ? c.cameraId : ''}`;
      this.viewEl?.setCaptureStream?.(stream);
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        // Only if it is still the live one — a camera swap ends the old track.
        if (this.captureStream !== stream) return;
        this.stopCapture();
      });
      if (c.source === 'camera') this.refreshCameras();
    } catch (err: any) {
      const name = err?.name || '';
      this.error =
        name === 'NotAllowedError'
          ? `${c.source === 'camera' ? 'Camera' : 'Screen capture'} permission was refused.`
          : name === 'NotFoundError' || name === 'OverconstrainedError'
            ? 'That camera is not connected.'
            : name === 'NotReadableError'
              ? 'The camera is in use by another app.'
              : `Capture failed: ${err?.message || err}`;
      this.isCapturing = false;
    } finally {
      this.captureBusy = false;
    }
  }

  private async openScreen(): Promise<MediaStream | null> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.error = 'Screen capture not supported in this browser.';
      return null;
    }
    // Cap what the browser hands us — an uncapped 4K/60 share is by far the
    // most expensive thing in the pipeline.
    const fps = this.config.model.capture.fps || 30;
    return navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: 'window',
        frameRate: { max: fps },
        width: { max: 1920 },
        height: { max: 1080 },
      } as any,
      audio: false,
    });
  }

  private async openCamera(): Promise<MediaStream | null> {
    // Like the mic, the camera is only exposed on https or localhost.
    if (!navigator.mediaDevices?.getUserMedia) {
      this.error =
        'Camera blocked: browsers only allow it on https or localhost. ' +
        `Open the render window at http://localhost:${location.port || 8787} on this machine.`;
      return null;
    }
    const c = this.config.model.capture;
    const fps = c.fps || 30;
    const video: MediaTrackConstraints = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: Math.min(fps, 30), max: fps },
    };
    // `exact`, so a camera that has gone away says so instead of silently
    // falling back to another one in the middle of a set.
    if (c.cameraId) video.deviceId = { exact: c.cameraId };
    return navigator.mediaDevices.getUserMedia({ video, audio: false });
  }

  /** List the cameras. Labels only appear once camera permission is granted. */
  private refreshCameras = async () => {
    if (this.isController || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      this.cameras = devs
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
    } catch (e) {}
  };

  /**
   * Called every frame on the render window. Changing the source or the camera
   * while capturing — from this panel, a controller or MIDI — swaps the feed:
   * a new camera opens straight away. A screen share needs a click in this
   * window (the browser insists), so switching to Screen just stops the camera.
   */
  private syncCaptureSource() {
    if (!this.isCapturing || this.captureBusy) return;
    const c = this.config.model.capture;
    const key = `${c.source}|${c.source === 'camera' ? c.cameraId : ''}`;
    if (key === this.captureKey) return;
    if (c.source === 'camera') this.startCapture();
    else this.stopCapture();
  }

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
  /** Controller copies of the render window's spectrum and signal levels. */
  private remoteSpectrum: number[] | null = null;
  private remoteLevels: Record<string, number> = {};
  /** The signal being mapped: the next ● clicked becomes its target. */
  @state() private modSource: string | null = null;
  @state() private modNote = '';
  @state() private selSignal: string | null = null;
  /** When each signal last hit (performance.now()), for the flashes. */
  private hitAt: Record<string, number> = {};
  /** The latest live events, newest first, for the panel's log. */
  @state() private eventLog: { t: number; ev: LiveEvent }[] = [];
  private eventLogDirty = false;
  private eventLogTimer: any = null;
  private eventCount = 0;
  private hitSeen: Record<string, number> = {};
  private actionAt: Record<string, number> = {};
  private remoteHits: Record<string, number> = {};
  private palStep: Record<string, number> = {};
  private sigDrag: { id: string; mode: 'lo' | 'hi' | 'move'; x0: number; lo: number; hi: number } | null = null;

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
    .midi-learn-btn.modulated { box-shadow: 0 0 0 2px #c77dff; }
    .spectrum-wrap { position: relative; margin: 4px 0 10px; }
    .event-log {
      font: 10px/1.35 monospace;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 4px;
      padding: 4px;
      margin-bottom: 6px;
      max-height: 150px;
      overflow: hidden;
    }
    .event-row {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      padding: 1px 3px;
      cursor: pointer;
      border-radius: 2px;
      opacity: 0.75;
    }
    .event-row:hover { background: rgba(255, 255, 255, 0.08); opacity: 1; }
    .event-row.fresh { opacity: 1; color: #fff; }
    .event-src {
      display: inline-block;
      min-width: 48px;
      color: #7cff6b;
      text-transform: uppercase;
    }
    .sig-match {
      flex: 1;
      min-width: 0;
      background: rgba(0, 0, 0, 0.35);
      color: inherit;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 3px;
      padding: 3px 5px;
      font: 11px monospace;
    }
    #spectrumCanvas {
      width: 100%; height: 150px; display: block; border-radius: 6px;
      background: #07070b; cursor: crosshair; touch-action: none;
    }
    .sig-card { border-left: 3px solid var(--sig, #888); }
    .sig-card.sel { background: rgba(255,255,255,0.07); }
    .sig-name {
      flex: 1; min-width: 0; background: transparent; border: none; color: white;
      font: inherit; font-weight: 700; padding: 2px 0;
    }
    .sig-color { width: 22px; height: 22px; padding: 0; border: none; background: none; }
    .sig-hz { width: 64px; }
    .map-btn { font-size: 0.65rem; padding: 3px 8px; }
    .map-btn.active { background: #c77dff; color: #000; }
    .mod-row { display: flex; align-items: center; gap: 6px; font-size: 0.7rem; margin: 4px 0; }
    .mod-row .mod-label { flex: 0 0 46%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #d9c2ff; }
    .mod-row input[type=range] { flex: 1; }
    .mod-note { font-size: 0.72rem; color: #d9c2ff; margin: 6px 0; min-height: 1em; }

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
    if (!this.isController) {
      this.refreshCameras();
      navigator.mediaDevices?.addEventListener?.('devicechange', this.refreshCameras);
    }
    if (this.isMain) {
      window.addEventListener('keydown', (e) => {
        const el = e.composedPath()[0] as HTMLElement;
        const tag = el?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey) {
          this.showCode = !this.showCode;
        }
        // S held: strobe at the free rate until it is let go.
        if ((e.key === 's' || e.key === 'S') && !e.metaKey && !e.ctrlKey && !e.repeat) {
          this.setStrobeHold(true);
        }
      });
      window.addEventListener('keyup', (e) => {
        if (e.key === 's' || e.key === 'S') this.setStrobeHold(false);
      });
      window.addEventListener('blur', () => this.setStrobeHold(false));
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
    this.watchRemoteWake();
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
    if (this.ws) {
      // Never two sockets at once.
      const old = this.ws;
      old.onclose = old.onmessage = old.onerror = null;
      try { old.close(); } catch (e) {}
      this.ws = null;
    }
    try {
      this.ws = new WebSocket(`${proto}://${target}`);
    } catch (e) {
      this.scheduleRemoteRetry();
      return;
    }
    this.ws.onopen = () => {
      this.wsOk = true;
      this.wsRetryDelay = 1000; // reset the backoff on a good connection
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

  private wsRetryDelay = 1000;

  private scheduleRemoteRetry() {
    clearTimeout(this.wsRetryTimer);
    this.wsRetryTimer = setTimeout(() => this.connectRemote(), this.wsRetryDelay);
    // Back off gradually so a relay that is simply not running does not get
    // hammered, but a transient drop reconnects almost immediately.
    this.wsRetryDelay = Math.min(this.wsRetryDelay * 2, 10000);
  }

  /**
   * Phones suspend a backgrounded tab and kill its socket. Reconnect the
   * instant the page is looked at again (or the network returns) rather than
   * waiting out the backoff — that wait is what makes it feel like the phone
   * "won't connect".
   */
  private watchRemoteWake() {
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      // Connecting counts too: a second socket would get every message twice.
      if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
      this.wsRetryDelay = 1000;
      clearTimeout(this.wsRetryTimer);
      this.connectRemote();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);
  }

  /** Send a sync message to every other window, local or remote. */
  private post(msg: any) {
    const m = { ...msg, _sid: this.syncSid, _seq: ++this.syncSeq };
    this.sync?.postMessage(m);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        if (m.type === 'videoUpload') {
          // A File has no JSON form, and the clip is deliberately never read
          // into memory — so this one stays on the same-browser channel.
          return;
        }
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
    if (msg.type === 'liveEvent') {
      // Straight from Strudel or the relay's OSC port, never echoed.
      this.onLiveEvent(msg);
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
          this.modelInfo = '';
          (async () => {
            let name = msg.name || 'model';
            let info = '';
            try {
              const err = await this.viewEl?.loadModel?.(msg.buffer);
              name = err ? `⚠ ${err}` : name;
              info = err ? '' : this.describeModel();
            } catch (e: any) {
              name = `⚠ ${e?.message || 'Failed to load'}`;
            }
            this.modelName = name;
            this.modelInfo = info;
            this.post({ type: 'modelStatus', name, info });
          })();
        }
        break;
      case 'modelStatus':
        // Controller mirrors the render window's load result.
        if (!this.isMain) {
          this.modelName = msg.name || '';
          this.modelInfo = msg.info || '';
        }
        break;
      case 'videoUpload':
        // Render window opens a clip picked in the detached panel. The File
        // arrived by reference over the channel, so the bytes never moved and
        // the object URL is made here, in the document that will play it.
        if (this.isMain && msg.file) {
          this.videoName = 'Loading…';
          this.videoInfo = '';
          // Answer at once so the panel knows the file arrived; a large clip
          // can take a while to report its duration.
          this.post({ type: 'videoStatus', name: 'Loading…', info: '' });
          (async () => {
            let name = msg.name || 'clip';
            let info = '';
            try {
              const err = await this.viewEl?.setVideoFile?.(msg.file);
              if (err) {
                name = `⚠ ${err}`;
              } else {
                const i = this.viewEl?.videoInfo?.();
                if (i) {
                  const mm = Math.floor(i.duration / 60);
                  const ss = Math.floor(i.duration % 60).toString().padStart(2, '0');
                  info = `${i.width}×${i.height} · ${mm}:${ss}`;
                }
              }
            } catch (e: any) {
              name = `⚠ ${e?.message || 'Failed to load'}`;
            }
            this.videoName = name;
            this.videoInfo = info;
            this.post({ type: 'videoStatus', name, info });
          })();
        }
        break;
      case 'videoStatus':
        // A clip lives in the window that opened it, so a detached panel has
        // to be told what the render window actually has loaded.
        if (!this.isMain) {
          clearTimeout(this.videoRelayTimer);
          this.videoName = msg.name || '';
          this.videoInfo = msg.info || '';
        }
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
          if (Array.isArray(msg.cameras)) this.cameras = msg.cameras;
          if (Array.isArray(msg.spectrum)) this.remoteSpectrum = msg.spectrum;
          if (msg.levels) this.remoteLevels = msg.levels;
          if (msg.hits) this.remoteHits = msg.hits;
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
    else if (name === 'camCut') this.viewEl?.cameraCut?.();
    else if (name === 'strobeFlash') this.viewEl?.strobeFlash?.();
    else if (name === 'strobeHold:1' || name === 'strobeHold:0') this.setStrobeHold(name.endsWith('1'));
    else if (name.startsWith('vid:')) this.viewEl?.videoTrigger?.(name.slice(4));
    else if (name === 'textFire') this.viewEl?.textTrigger?.();
    else if (name === 'removeVideo') {
      this.viewEl?.clearVideo?.();
      this.videoName = '';
      this.videoInfo = '';
      this.post({ type: 'videoStatus', name: '', info: '' });
    }
    else if (name === 'removeModel') {
      this.viewEl?.removeModel?.();
      this.modelName = '';
      this.modelInfo = '';
      this.post({ type: 'modelStatus', name: '', info: '' });
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
    } else if (msgType === 0x80 || msgType === 0x90) {
      // Note off matters only to the strobe's Hold, which is momentary.
      if (this.midiMappings[`note-${channel}-${data1}`]?.path === '!strobeHold') this.setStrobeHold(false);
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

  private getParamRange = (path: string) => paramRange(path);

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
    if (path === 'video.blend' || path === 'model.capture.blend')
      return ['normal', 'screen', 'add', 'multiply', 'overlay', 'difference', 'lighten', 'darken'];
    if (path === 'video.fit') return ['cover', 'contain', 'stretch'];
    if (path === 'text.effect') return ['type', 'word', 'fade', 'wipe', 'scroll', 'glitch'];
    if (path === 'text.align') return ['left', 'center', 'right'];
    if (path === 'video.sliceMode') return ['off', 'retrigger', 'jump', 'ladder'];
    if (path === 'video.surface') return ['off', 'luma', 'lumaInv'];
    if (path === 'video.sliceDiv') return [0.25, 0.5, 1, 2, 4];
    if (path === 'video.slices') return [2, 4, 8, 16, 32];
    if (path === 'video.fps') return [60, 30, 15, 8];
    if (path === 'model.capture.mode') return ['background', 'floating'];
    if (path === 'model.capture.source') return ['screen', 'camera'];
    if (path === 'model.fracture.physics.beatAction') return ['burst', 'implode', 'pulse', 'alternate'];
    if (path === 'renderScale' || path === 'model.quality') return [1, 0.75, 0.5, 0.35];
    if (path === 'model.capture.fps') return [60, 30, 15, 8];
    if (path === 'strobe.drive') return ['tempo', 'free', 'hits', 'gate'];
    if (path === 'strobe.style') return ['white', 'colour', 'black', 'invert'];
    if (path === 'strobe.division') return [0.25, 0.5, 1, 2, 4];
    if (path === 'strobe.source') return ['none', ...this.config.audio.signals.map((g) => g.id)];
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
    '!camCut': () => {
      if (this.isController) this.post({ type: 'command', name: 'camCut' });
      else this.viewEl?.cameraCut?.();
    },
    '!strobe': () => this.strobeFlash(),
    '!strobeOn': () => this.updateConfig('strobe.on', !this.config.strobe.on),
    '!palNext': () => {
      const def = getShader(this.config.activeShader);
      const n = def.palettes?.length || 0;
      if (!n) return;
      const k = ((this.palStep[def.id] ?? -1) + 1) % n;
      this.palStep[def.id] = k;
      this.applyPalette(`${def.id}:${k}`);
    },
    '!implode': () => this.triggerPhysics('implode'),
    '!reset': () => this.triggerPhysics('reset'),
    '!audio': () => this.toggleAudio(),
    '!capture': () => this.toggleCapture(),
    '!videoPlay': () => this.updateConfig('video.playing', !this.config.video.playing),
    // Hand-fired slice triggers. Each is its own action, so a pad hits one
    // thing rather than cycling a dropdown to reach it.
    '!textFire': () => this.fireText(),
    '!textShow': () => this.updateConfig('text.visible', !this.config.text.visible),
    '!textType': () => this.updateConfig('text.effect', 'type'),
    '!textWord': () => this.updateConfig('text.effect', 'word'),
    '!textFade': () => this.updateConfig('text.effect', 'fade'),
    '!textWipe': () => this.updateConfig('text.effect', 'wipe'),
    '!textScroll': () => this.updateConfig('text.effect', 'scroll'),
    '!textGlitch': () => this.updateConfig('text.effect', 'glitch'),
    '!vidRetrig': () => this.fireVideo('retrigger'),
    '!vidJump': () => this.fireVideo('jump'),
    '!vidNext': () => this.fireVideo('next'),
    '!vidPrev': () => this.fireVideo('prev'),
    '!vidHome': () => this.fireVideo('home'),
    // And the auto mode, one action per mode for the same reason.
    '!vidAutoOff': () => this.updateConfig('video.sliceMode', 'off'),
    '!vidAutoRetrig': () => this.updateConfig('video.sliceMode', 'retrigger'),
    '!vidAutoJump': () => this.updateConfig('video.sliceMode', 'jump'),
    '!vidAutoLadder': () => this.updateConfig('video.sliceMode', 'ladder'),
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

    if (path === '!strobeHold') {
      // Momentary: on while the pad or button is down.
      this.setStrobeHold(type === 'note' || norm >= 0.5);
      return;
    }
    if (path.startsWith('!')) {
      if (rising) {
        if (path.startsWith('!pal:')) this.applyPalette(path.slice(5));
        else this.MIDI_ACTIONS[path]?.();
      }
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
      class="midi-learn-btn ${this.learningParam === path ? 'active' : ''} ${this.isMapped(path) ? 'mapped' : ''} ${this.isModulated(path) ? 'modulated' : ''}"
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
    if (this.modSource) {
      this.finishMapping(path);
      return;
    }
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

  private isModulated(path: string) {
    return (this.config.audio?.mods || []).some((m) => m.target === path);
  }

  /* ----------------------- Audio signals ------------------------- */

  /**
   * Notice new hits: flash them, and in the render window fire each signal's
   * On hit action. Actions are spaced out (a shader change at most every
   * 1.5 s, anything else every 120 ms) so a busy hat line cannot flood them.
   */
  private pollHits() {
    const hits: Record<string, number> = this.isController
      ? this.remoteHits
      : (this.shadowRoot?.querySelector('shader-ritual-view') as any)?.getSignalHits?.() || {};
    const now = performance.now();
    for (const sg of this.config.audio?.signals || []) {
      const n = hits[sg.id] ?? 0;
      const seen = this.hitSeen[sg.id];
      this.hitSeen[sg.id] = n;
      if (seen === undefined || n <= seen) continue;
      this.hitAt[sg.id] = now;
      if (this.isController || !sg.action) continue;
      const gap = sg.action === '!nextShader' || sg.action === '!prevShader' ? 1500 : 120;
      if (now - (this.actionAt[sg.id] || 0) < gap) continue;
      this.actionAt[sg.id] = now;
      this.MIDI_ACTIONS[sg.action]?.();
    }
  }

  private bandOptions(value: string) {
    const opt = (v: string, label: string) => html`<option value=${v} ?selected=${v === value}>${label}</option>`;
    return html`${opt('none', 'None')}${(this.config.audio?.signals || []).map((sg) => opt(sg.id, sg.name))}`;
  }

  private setSignals(signals: AudioSignal[], mods?: Modulation[]) {
    this.updateConfig('audio', { ...this.config.audio, signals, mods: mods ?? this.config.audio.mods });
  }

  private patchSignal(id: string, patch: Partial<AudioSignal>) {
    this.setSignals(this.config.audio.signals.map((sg) => (sg.id === id ? { ...sg, ...patch } : sg)));
  }

  /* ------------------------- Live events -------------------------- */

  private onLiveEvent(msg: any) {
    const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params)
      ? msg.params
      : { value: msg.params };
    const ev: LiveEvent = {
      src: String(msg.src || 'osc').toLowerCase(),
      address: typeof msg.address === 'string' ? msg.address : '',
      params,
      delay: Number.isFinite(+msg.delay) ? +msg.delay : 0,
    };
    if (this.isMain) this.viewEl?.pushEvent?.(ev);
    this.eventCount++;
    this.eventLog.unshift({ t: performance.now(), ev });
    if (this.eventLog.length > 10) this.eventLog.length = 10;
    // Redraw the log a few times a second at most: a 16th-note hat line
    // would otherwise re-render the panel on every note.
    if (!this.eventLogTimer) {
      this.eventLogTimer = setTimeout(() => {
        this.eventLogTimer = null;
        this.eventLog = [...this.eventLog];
      }, 200);
    }
  }

  private addEventSignal(match = '*', name = 'Event') {
    const signals = this.config.audio.signals;
    const id = newSignalId(signals);
    const hues = ['#7cff6b', '#ff6bd6', '#6bd0ff', '#ffe66b', '#b36bff', '#ff8a5c'];
    const n = signals.filter((sg) => sg.kind === 'event').length;
    this.setSignals([...signals, eventSignal(id, name.slice(0, 24), match, hues[n % hues.length])]);
    this.selSignal = id;
  }

  private copyText(text: string, what: string) {
    navigator.clipboard?.writeText(text).then(
      () => (this.modNote = `${what} copied.`),
      () => (this.modNote = `Could not reach the clipboard; select the text and copy it.`),
    );
  }

  private get strudelSnippet() {
    return `// ShaderRitual: .sr() sends a pattern's events to the visuals
const sr = globalThis.__sr?.readyState < 2 ? globalThis.__sr
  : (globalThis.__sr = new WebSocket('ws://localhost:8787'))
register('sr', (pat) => pat.onTrigger((hap, now, cps, t) => {
  if (sr.readyState !== 1) return
  const v = hap.value
  sr.send(JSON.stringify({ type: 'liveEvent', src: 'strudel', address: '',
    params: v && typeof v === 'object' ? v : { value: v },
    delay: (t - now) * 1000 }))
}, false))

// then: s("bd*4").sr()   or every pattern: all(x => x.sr())`;
  }

  private get scSnippet() {
    return `// ShaderRitual: OSC to the relay, UDP 57121
~sr = NetAddr("127.0.0.1", 57121);

// one message: an address, then name / value pairs
~sr.sendMsg("/sr", "s", "kick", "gain", 1);

// a knob: a Follow signal with Match /sr/cutoff
~sr.sendMsg("/sr/cutoff", 0.7);

// every note of a Pbind, timed to land with the sound
Pbind(\\degree, Pwhite(0, 7), \\dur, 0.25,
  \\finish, { |ev| ~sr.sendBundle(s.latency, ["/sr", "s", "lead", "gain", ev[\\amp] ? 0.1]) }
).play;

// everything SuperDirt plays (Strudel or Tidal through SuperCollider)
OSCdef(\\srDirt, { |msg, time|
  ~sr.sendBundle((time - SystemClock.seconds).max(0), msg)
}, '/dirt/play');`;
  }

  private renderLiveEvents() {
    const a = this.config.audio;
    const off = a.eventOffset || 0;
    const now = performance.now();
    return html`
      <div class="element-card">
        <div class="element-head">
          <span class="element-name">Live events · Strudel, SuperCollider, OSC</span>
          <span style="font-size:0.65rem;opacity:0.8;">
            ${this.wsOk ? html`<span style="color:#7cff6b;">● relay</span>` : html`<span style="color:#ff6b6b;">○ no relay</span>`}
          </span>
        </div>
        <div class="element-desc">
          Notes and messages from your live code become signals, sharp to the
          note and timed to land with the sound. Run the relay
          (<code>npm run relay</code>, or <code>npm run dev:live</code> for both),
          then paste a snippet. Click an event below to make a signal from it.
          ${this.wsOk ? '' : html`<b>Not connected to the relay yet.</b>`}
        </div>
        <div style="display:flex;gap:6px;margin:6px 0;">
          <button class="mini" @click=${() => this.copyText(this.strudelSnippet, 'Strudel snippet')}>COPY STRUDEL</button>
          <button class="mini" @click=${() => this.copyText(this.scSnippet, 'SuperCollider snippet')}>COPY SUPERCOLLIDER</button>
          <button class="mini" @click=${() => this.addEventSignal('*', 'Event')}>+ EVENT SIGNAL</button>
        </div>
        <div class="event-log">
          ${this.eventLog.length === 0
            ? html`<div class="event-row" style="opacity:0.5;cursor:default;">Waiting for events…</div>`
            : this.eventLog.map(({ t, ev }) => html`
                <div class="event-row ${now - t < 250 ? 'fresh' : ''}" title="Make a signal from events like this"
                  @click=${() => this.addEventSignal(suggestMatch(ev), suggestMatch(ev).split('=').pop()!.replace(/[:/]/g, ' ').trim() || 'Event')}>
                  <span class="event-src">${ev.src}</span>${describeEvent(ev)}
                </div>`)}
        </div>
        <div class="control-row">
          <label title="Added to every event: positive if the picture runs ahead of the sound">Offset ${off} ms</label>
          <input type="range" min="-200" max="400" step="5" .value=${live(String(off))}
            @input=${(e: any) => this.updateConfig('audio', { ...this.config.audio, eventOffset: parseInt(e.target.value, 10) })} />
        </div>
      </div>`;
  }

  private addSignal(preset: number) {
    const signals = this.config.audio.signals;
    const id = newSignalId(signals);
    this.setSignals([...signals, { id, ...SIGNAL_PRESETS[preset] }]);
    this.selSignal = id;
  }

  private removeSignal(id: string) {
    this.setSignals(
      this.config.audio.signals.filter((sg) => sg.id !== id),
      this.config.audio.mods.filter((m) => m.source !== id),
    );
    if (this.modSource === id) this.modSource = null;
  }

  private setMods(mods: Modulation[]) {
    this.updateConfig('audio', { ...this.config.audio, mods });
  }

  /** A readable name for a config path: "Neon City · Windows level". */
  private pathLabel(path: string): string {
    const k = path.split('.');
    if (k[0] === 'shaders' && k[2] === 'elements') {
      const def = SHADERS.find((d) => d.id === k[1]);
      const el = def?.elements.find((e) => e.id === k[3]);
      return `${def?.name ?? k[1]} · ${el?.name ?? k[3]} ${k[4] ?? ''}`.trim();
    }
    const head: Record<string, string> = {
      postfx: 'Post FX', camfx: 'Camera FX', strobe: 'Strobe', camera: 'Camera', motion: 'Motion', overlay: 'Overlay',
      video: 'Video', text: 'Text', model: 'Model',
    };
    return [head[k[0]] ?? k[0], ...k.slice(1)].join(' · ');
  }

  private startMapping(id: string) {
    this.modSource = this.modSource === id ? null : id;
    this.learningParam = null;
    const sg = this.config.audio.signals.find((x) => x.id === id);
    this.modNote = this.modSource
      ? `Mapping ${sg?.name}: click the ● next to any slider or amount, anywhere in the panel.`
      : '';
  }

  private finishMapping(path: string) {
    const src = this.modSource!;
    const name = this.config.audio.signals.find((x) => x.id === src)?.name ?? src;
    const v = this.readPath(path);
    if (path.startsWith('!') || typeof v !== 'number' || !modulatable(path)) {
      this.modNote = `${this.pathLabel(path)} can't follow a signal — pick a slider or an amount.`;
      return;
    }
    this.modSource = null;
    const mods = this.config.audio.mods;
    if (mods.some((m) => m.source === src && m.target === path)) {
      this.modNote = `${name} already drives ${this.pathLabel(path)}.`;
      return;
    }
    const id = `m${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    this.setMods([...mods, { id, source: src, target: path, depth: 0.5 }]);
    this.modNote = `${name} → ${this.pathLabel(path)}. Set how far it pushes below.`;
  }

  /** The spectrum editor: live spectrum, each signal's range and level. */
  private drawSpectrum(bands: any) {
    const cv = this.shadowRoot?.querySelector('#spectrumCanvas') as HTMLCanvasElement | null;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(cv.clientWidth * dpr));
    const H = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== W || cv.height !== H) {
      cv.width = W;
      cv.height = H;
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const view = this.isController ? null : (this.shadowRoot?.querySelector('shader-ritual-view') as any);
    const spec: number[] | null = this.isController ? this.remoteSpectrum : view?.getSpectrum?.(160);
    const levels: Record<string, number> = this.isController ? this.remoteLevels : view?.getSignalLevels?.() || {};
    ctx.clearRect(0, 0, W, H);
    // Grid.
    ctx.font = `${10 * dpr}px monospace`;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = freqToX(f) * W;
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(x, 0, dpr, H);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 3 * dpr, H - 4 * dpr);
    }
    // Spectrum.
    if (spec && spec.length) {
      ctx.beginPath();
      ctx.moveTo(0, H);
      spec.forEach((v, i) => ctx.lineTo(((i + 0.5) / spec.length) * W, H - v * (H - 14 * dpr)));
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,255,255,0.13)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = dpr;
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText('Ignite Audio to see the spectrum', 10 * dpr, 20 * dpr);
    }
    // Signals: their range, their level going in (line), their value out (fill).
    for (const sg of this.config.audio?.signals || []) {
      if (sg.kind === 'event') continue;
      const x0 = freqToX(sg.lo) * W;
      const x1 = freqToX(sg.hi) * W;
      const out = Math.min(1, Math.max(0, bands?.[sg.id] || 0));
      const lvl = levels[sg.id] ?? 0;
      const sel = sg.id === this.selSignal;
      ctx.fillStyle = sg.color + (sel ? '30' : '1c');
      ctx.fillRect(x0, 0, x1 - x0, H);
      ctx.fillStyle = sg.color + 'cc';
      ctx.fillRect(x0, H - out * H, x1 - x0, out * H);
      ctx.fillStyle = sg.color;
      ctx.fillRect(x0, H - lvl * (H - 14 * dpr), x1 - x0, 1.5 * dpr);
      const flash = performance.now() - (this.hitAt[sg.id] || 0) < 120;
      ctx.strokeStyle = flash ? '#ffffff' : sg.color;
      ctx.lineWidth = (flash ? 3 : sel ? 2 : 1) * dpr;
      ctx.strokeRect(x0, 0.5, x1 - x0, H - 1);
      ctx.fillStyle = '#fff';
      ctx.fillText(sg.name, x0 + 3 * dpr, 12 * dpr);
    }
  }

  private onSpecDown = (e: PointerEvent) => {
    const cv = e.currentTarget as HTMLCanvasElement;
    const r = cv.getBoundingClientRect();
    const px = e.clientX - r.left;
    const sigs = (this.config.audio?.signals || []).filter((sg) => sg.kind !== 'event');
    // The selected one first, so overlapping ranges pick what you're editing.
    sigs.sort((a, b) => (a.id === this.selSignal ? -1 : b.id === this.selSignal ? 1 : 0));
    for (const sg of sigs) {
      const xl = freqToX(sg.lo) * r.width;
      const xh = freqToX(sg.hi) * r.width;
      const mode = Math.abs(px - xl) < 7 ? 'lo' : Math.abs(px - xh) < 7 ? 'hi' : px > xl && px < xh ? 'move' : null;
      if (mode) {
        this.selSignal = sg.id;
        this.sigDrag = { id: sg.id, mode, x0: px / r.width, lo: sg.lo, hi: sg.hi };
        cv.setPointerCapture(e.pointerId);
        return;
      }
    }
    this.selSignal = null;
  };

  private onSpecMove = (e: PointerEvent) => {
    const cv = e.currentTarget as HTMLCanvasElement;
    const r = cv.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const d = this.sigDrag;
    if (!d) {
      // Show what dragging here would do.
      const px = e.clientX - r.left;
      const near = (this.config.audio?.signals || []).filter((sg) => sg.kind !== 'event').some(
        (sg) => Math.abs(px - freqToX(sg.lo) * r.width) < 7 || Math.abs(px - freqToX(sg.hi) * r.width) < 7,
      );
      cv.style.cursor = near ? 'ew-resize' : 'crosshair';
      return;
    }
    const round = (f: number) => (f < 1000 ? Math.round(f) : Math.round(f / 10) * 10);
    if (d.mode === 'move') {
      const dx = x - d.x0;
      let a = freqToX(d.lo) + dx;
      let b = freqToX(d.hi) + dx;
      if (a < 0) { b -= a; a = 0; }
      if (b > 1) { a -= b - 1; b = 1; }
      this.patchSignal(d.id, { lo: round(xToFreq(a)), hi: round(xToFreq(b)) });
    } else if (d.mode === 'lo') {
      this.patchSignal(d.id, { lo: round(Math.min(xToFreq(x), d.hi * 0.92)) });
    } else {
      this.patchSignal(d.id, { hi: round(Math.max(xToFreq(x), d.lo * 1.08)) });
    }
  };

  private onSpecUp = () => {
    this.sigDrag = null;
  };

  private renderSignalsSection() {
    const a = this.config.audio;
    if (!a) return '';
    const ms = (v: number) => Math.round(v * 1000);
    const slider = (sg: AudioSignal, label: string, key: keyof AudioSignal, min: number, max: number, step: number, scale = 1, unit = '') => html`
      <div class="control-row">
        <label>${label}</label>
        <input type="range" min=${min} max=${max} step=${step} .value=${live(String((sg[key] as number) * scale))}
          @input=${(e: any) => this.patchSignal(sg.id, { [key]: parseFloat(e.target.value) / scale } as any)} />
        <span class="val" style="min-width:44px;text-align:right;font-size:0.7rem;">${
          Math.round((sg[key] as number) * scale * 100) / 100
        }${unit}</span>
      </div>`;
    return html`
      <div class="setting-group">
        <span class="group-title">Audio Signals · draw them on the spectrum</span>
        <div class="element-desc" style="margin-bottom:6px;">
          Each coloured box is a signal: drag it along the spectrum, or drag its
          edges to set its range. The line is its level going in, the fill its
          value coming out. Every Audio band menu in the panel can use a signal,
          and Map wires it to any slider or amount.
        </div>
        <div class="spectrum-wrap">
          <canvas id="spectrumCanvas"
            @pointerdown=${this.onSpecDown}
            @pointermove=${this.onSpecMove}
            @pointerup=${this.onSpecUp}
            @pointercancel=${this.onSpecUp}></canvas>
        </div>
        <div class="mod-note">${this.modNote}</div>
        ${this.renderLiveEvents()}
        ${a.signals.map((sg) => {
          const mods = a.mods.filter((m) => m.source === sg.id);
          return html`
            <div class="element-card sig-card ${sg.id === this.selSignal ? 'sel' : ''}" style="--sig:${sg.color}"
              @pointerdown=${() => (this.selSignal = sg.id)}>
              <div class="element-head" style="gap:6px;">
                <input class="sig-color" type="color" .value=${live(sg.color)}
                  @input=${(e: any) => this.patchSignal(sg.id, { color: e.target.value })} />
                <input class="sig-name" .value=${live(sg.name)}
                  @change=${(e: any) => this.patchSignal(sg.id, { name: e.target.value.slice(0, 24) || sg.name })} />
                <button class="action-btn map-btn ${this.modSource === sg.id ? 'active' : ''}"
                  title="Then click the ● next to any slider or amount"
                  @click=${() => this.startMapping(sg.id)}>${this.modSource === sg.id ? 'Cancel' : 'Map'}</button>
                ${isCore(sg.id)
                  ? ''
                  : html`<button class="icon-btn" title="Remove this signal" @click=${() => this.removeSignal(sg.id)}>&times;</button>`}
              </div>
              ${sg.kind === 'event'
                ? html`
                  <div class="control-row">
                    <label title="Space-separated, and all must match. s=bd a parameter (s=bd|sd either, s=hh* wildcards), /sr/kick an OSC address, strudel: / sc: / dirt: only that sender, a bare word any parameter equal to it, * everything">Match</label>
                    <input class="sig-match" .value=${live(sg.match || '')} placeholder="s=bd  /sr/kick  strudel:"
                      @change=${(e: any) => this.patchSignal(sg.id, { match: e.target.value.trim().slice(0, 120) })} />
                  </div>
                  <div class="control-row">
                    <label title="The parameter whose number is the value: each pulse's height (Trigger) or the level (Follow). Empty: gain, velocity, amp or the first number.">Value from</label>
                    <input class="sig-match" .value=${live(sg.key || '')} placeholder="gain"
                      @change=${(e: any) => this.patchSignal(sg.id, { key: e.target.value.trim().slice(0, 40) })} />
                  </div>
                  <div class="control-row">
                    <label title="Trigger: each event fires a pulse. Follow: the value holds the latest event's number (a knob), eased by Attack and Release.">Mode</label>
                    <select .value=${live(sg.mode || 'trigger')}
                      @change=${(e: any) => this.patchSignal(sg.id, { mode: e.target.value })}>
                      <option value="trigger">Trigger</option>
                      <option value="follow">Follow</option>
                    </select>
                  </div>
                  ${slider(sg, 'Gain', 'gain', 0, 4, 0.05)}
                  ${slider(sg, 'Attack', 'attack', 1, 300, 1, 1000, ' ms')}
                  ${slider(sg, 'Release', 'release', 10, 2000, 5, 1000, ' ms')}
                  ${slider(sg, 'Curve', 'curve', 0.3, 4, 0.05)}`
                : html`
              <div class="control-row">
                <label>Range</label>
                <input class="sig-hz" type="number" min="20" max="20000" .value=${live(String(sg.lo))}
                  @change=${(e: any) => this.patchSignal(sg.id, { lo: Math.max(20, Math.min(sg.hi - 1, +e.target.value || sg.lo)) })} />
                <span style="font-size:0.7rem;">–</span>
                <input class="sig-hz" type="number" min="20" max="20000" .value=${live(String(sg.hi))}
                  @change=${(e: any) => this.patchSignal(sg.id, { hi: Math.min(20000, Math.max(sg.lo + 1, +e.target.value || sg.hi)) })} />
                <span style="font-size:0.7rem;">Hz</span>
              </div>
              <div class="control-row">
                <label title="Scale between the signal's own recent quietest and loudest, so it uses the whole range whatever the mix">Auto-level</label>
                <input type="checkbox" .checked=${sg.auto}
                  @change=${(e: any) => this.patchSignal(sg.id, { auto: e.target.checked })} />
              </div>
              <div class="control-row">
                <label title="Follow: the value follows the level. Trigger: each hit fires a clean envelope (up over Attack, away over Release), however long the sound lasts.">Mode</label>
                <select .value=${live(sg.mode || 'follow')}
                  @change=${(e: any) => this.patchSignal(sg.id, { mode: e.target.value })}>
                  <option value="follow">Follow</option>
                  <option value="trigger">Trigger</option>
                </select>
              </div>
              ${slider(sg, 'Gain', 'gain', 0, 4, 0.05)}
              ${slider(sg, 'Gate', 'gate', 0, 0.9, 0.01)}
              ${slider(sg, 'Attack', 'attack', 1, 300, 1, 1000, ' ms')}
              ${slider(sg, 'Release', 'release', 10, 2000, 5, 1000, ' ms')}
              ${slider(sg, 'Curve', 'curve', 0.3, 4, 0.05)}
              ${slider(sg, 'Hit sensitivity', 'onset', 0, 1, 0.01)}`}
              <div class="control-row">
                <label title="A one-shot action fired on each hit">On hit</label>
                <select .value=${live(sg.action || '')}
                  @change=${(e: any) => this.patchSignal(sg.id, { action: e.target.value })}>
                  <option value="">Nothing</option>
                  ${HIT_ACTIONS.map((a) => html`<option value=${a.id}>${a.label}</option>`)}
                </select>
              </div>
              ${mods.map(
                (m) => html`
                  <div class="mod-row">
                    <span class="mod-label" title=${m.target}>→ ${this.pathLabel(m.target)}</span>
                    <input type="range" min="-1" max="1" step="0.02" .value=${live(String(m.depth))}
                      title="How far it pushes at full signal; negative pushes down"
                      @input=${(e: any) =>
                        this.setMods(a.mods.map((x) => (x.id === m.id ? { ...x, depth: parseFloat(e.target.value) } : x)))} />
                    <span style="min-width:34px;text-align:right;">${m.depth > 0 ? '+' : ''}${Math.round(m.depth * 100)}%</span>
                    <button class="icon-btn" title="Remove this mapping"
                      @click=${() => this.setMods(a.mods.filter((x) => x.id !== m.id))}>&times;</button>
                  </div>`,
              )}
            </div>`;
        })}
        <div class="control-row">
          <label>Add signal</label>
          <select .value=${'-1'}
            @change=${(e: any) => {
              const i = parseInt(e.target.value, 10);
              if (i === 99) this.addEventSignal();
              else if (i >= 0) this.addSignal(i);
              e.target.value = '-1';
            }}>
            <option value="-1">Choose a preset…</option>
            ${SIGNAL_PRESETS.map((p, i) => html`<option value=${String(i)}>${p.name} · ${p.lo}–${p.hi} Hz</option>`)}
            <option value="99">Live event (Strudel / SuperCollider)</option>
          </select>
        </div>
        <div class="element-desc">
          Attack and Release are how fast it follows: a kick wants a few ms up
          and ~150 ms down; a pad wants slow both ways. Curve above 1 makes
          hits punchier. Trigger mode turns each hit into a clean pulse, and On
          hit fires an action with it (a camera cut on the kick, the next
          palette on the snare); the box flashes white on every hit, so you can
          tune Hit sensitivity by eye. Settings driven by a signal have a
          purple ring on their ●; their own slider sets where they rest.
        </div>
      </div>`;
  }

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

      if (!this.isController) this.syncCaptureSource();
      this.pollHits();

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
            cameras: this.cameras,
            // The spectrum editor, for a controller that has the panel open.
            spectrum: view?.getSpectrum?.(160)?.map((v: number) => Math.round(v * 100) / 100) ?? null,
            levels: view?.getSignalLevels?.() ?? {},
            hits: view?.getSignalHits?.() ?? {},
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
      if (!ctx || !data) {
        this.drawSpectrum(null);
        return;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Every signal as a bar in its own colour; a hit flashes its label.
      const sigs = this.config.audio?.signals || [];
      const w = canvas.width / Math.max(1, sigs.length);
      const now = performance.now();
      sigs.forEach((sg, i) => {
        const v = Math.min(1, Math.max(0, data[sg.id] || 0));
        const h = v * (canvas.height - 18);
        ctx.fillStyle = sg.color + '88';
        ctx.fillRect(i * w + 1, canvas.height - h, w - 3, h);
        const hit = now - (this.hitAt[sg.id] || 0) < 120;
        if (hit) {
          ctx.fillStyle = sg.color;
          ctx.fillRect(i * w + 1, 0, w - 3, 3);
        }
        ctx.fillStyle = hit ? '#fff' : v > 0.05 ? '#ffffffcc' : '#ffffff55';
        ctx.font = 'bold 9px monospace';
        ctx.fillText(sg.name.slice(0, Math.max(3, Math.floor(w / 6.5))).toUpperCase(), i * w + 4, 14);
      });
      this.drawSpectrum(data);
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
          class="midi-learn-btn ${this.learningParam === path ? 'active' : ''} ${this.isMapped(path) ? 'mapped' : ''} ${this.isModulated(path) ? 'modulated' : ''}"
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
          ${this.modelInfo ? html`· ${this.modelInfo}` : ''}
          ${this.modelName
            ? html`· <a style="color:#a855f7;cursor:pointer;" @click=${this.resetModelView}>reset view</a>
                   · <a style="color:#a855f7;cursor:pointer;" @click=${this.clearModel}>remove</a>`
            : ''}
        </div>
        <div class="element-desc" style="margin-bottom:8px;">
          The model is centred and scaled to fit the frame, so it appears whatever
          size it was built at. If the name shows but nothing does, check the mesh
          count above — a file with no meshes says so — then hit reset view, which
          puts visibility, opacity, scale, position and mode back where a model can
          be seen. Draco and Meshopt compression are handled offline; KTX2 textures
          are not.
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

      <!-- Capture (screen or camera) is its own layer — it works with or without a model. -->
      <div class="setting-group">
        <span class="group-title">Screen &amp; Camera</span>
        ${this.renderCaptureSection()}
      </div>
    `;
  }

  private renderBandSelect(path: string, value: Band) {
    return html`
      <select .value=${value} @change=${(e: any) => this.updateConfig(path, e.target.value)}>
            ${this.bandOptions(value)}
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

  /** A momentary trigger: learn dot plus a button that fires on press. */
  private vidTrigBtn = (action: string, kind: string, label: string) => html`
    ${this.learnDot(action)}
    <button class="mini" style="margin-right:4px;"
      @click=${() => this.fireVideo(kind)}>${label}</button>
  `;

  /** A latching auto-mode button, lit when it is the active mode. */
  private vidModeBtn = (mode: string, action: string, label: string) => html`
    ${this.learnDot(action)}
    <button class="mini ${this.config.video.sliceMode === mode ? 'on' : ''}"
      style="margin-right:4px;"
      @click=${() => this.updateConfig('video.sliceMode', mode)}>${label}</button>
  `;

  /** An effect button, lit when it is the one running. */
  private textFxBtn = (mode: string, action: string, label: string) => html`
    ${this.learnDot(action)}
    <button class="mini ${this.config.text.effect === mode ? 'on' : ''}"
      style="margin-right:4px;"
      @click=${() => this.updateConfig('text.effect', mode)}>${label}</button>
  `;

  private renderTextSection() {
    const t = this.config.text;
    const used = t.content.length;
    return html`
      <div class="setting-group">
        <span class="group-title">Text · plays under the post filters</span>
        <div class="control-row">
          <label>Show</label>
          ${this.learnDot('!textShow')}
          ${this.learnDot('text.visible')}
          <button class="mini ${t.visible ? 'on' : ''}"
            @click=${() => this.updateConfig('text.visible', !t.visible)}>
            ${t.visible ? 'ON' : 'OFF'}</button>
          ${this.learnDot('!textFire')}
          <button class="mini" style="margin-left:4px;" @click=${this.fireText}>RESTART</button>
        </div>
        <textarea
          maxlength=${TEXT_MAX}
          rows="4"
          placeholder="Type up to ${TEXT_MAX} characters…"
          style="width:100%;box-sizing:border-box;margin:6px 0 2px;background:rgba(0,0,0,0.4);
                 color:#ddd;border:1px solid rgba(255,255,255,0.15);border-radius:4px;
                 padding:6px;font-family:inherit;font-size:12px;resize:vertical;"
          .value=${live(t.content)}
          @input=${(e: any) =>
            this.updateConfig('text.content', String(e.target.value).slice(0, TEXT_MAX))}></textarea>
        <div class="element-desc" style="margin-bottom:8px;">
          ${used} / ${TEXT_MAX} characters. The words are laid out once and the
          effect runs over that image, so typing a full paragraph out costs no
          more per frame than holding one still. It draws in front of the clip
          and before the post filters, so Datamosh and Glitch chew on it too.
        </div>

        <div class="control-row">
          <label>Effect</label>
          ${this.textFxBtn('type', '!textType', 'TYPE')}
          ${this.textFxBtn('word', '!textWord', 'WORD')}
          ${this.textFxBtn('fade', '!textFade', 'FADE')}
        </div>
        <div class="control-row">
          <label></label>
          ${this.textFxBtn('wipe', '!textWipe', 'WIPE')}
          ${this.textFxBtn('scroll', '!textScroll', 'SCROLL')}
          ${this.textFxBtn('glitch', '!textGlitch', 'GLITCH')}
        </div>
        <div class="element-desc" style="margin-bottom:8px;">
          Type runs a character at a time with the cursor lit; Word steps a word
          at a time; Fade brings the block up whole; Wipe sweeps a soft edge
          across it; Scroll is a credits roll; Glitch tears the lines apart and
          lets them settle.
        </div>

        <div class="control-row">
          <label>Run over</label>
          ${this.learnDot('text.beats')}
          <select .value=${live(String(t.beats))}
            @change=${(e: any) => this.updateConfig('text.beats', parseFloat(e.target.value))}>
            <option value="2">2 beats</option>
            <option value="4">1 bar</option>
            <option value="8">2 bars</option>
            <option value="16">4 bars</option>
            <option value="32">8 bars</option>
            <option value="64">16 bars</option>
          </select>
        </div>
        ${this.renderToggle('Loop', 'text.loop')}
        ${t.loop ? '' : this.renderToggle('Hold at end', 'text.hold')}
        <div class="element-desc" style="margin-bottom:8px;">
          One run takes this many beats at the tempo in Camera · Motion, so a
          paragraph lands with the music instead of drifting off it. RESTART
          takes it back to the top — map it to a pad.
        </div>

        ${this.renderSelect('React band', 'text.band', [
          { value: 'none', label: 'None' }, { value: 'low', label: 'Low' },
          { value: 'mid', label: 'Mid' }, { value: 'high', label: 'High' },
        ])}
        ${this.renderSlider('React amount', 'text.amount', 0, 3, 0.05)}
        ${this.renderSlider('Opacity', 'text.opacity', 0, 1, 0.02)}
        ${this.renderSelect('Blend', 'text.blend', [
          { value: 'normal', label: 'Normal' }, { value: 'screen', label: 'Screen' },
          { value: 'add', label: 'Add' }, { value: 'multiply', label: 'Multiply' },
          { value: 'overlay', label: 'Overlay' }, { value: 'difference', label: 'Difference' },
          { value: 'lighten', label: 'Lighten' }, { value: 'darken', label: 'Darken' },
        ])}
        <div class="control-row">
          <label>Colour</label>
          <input type="color" .value=${live(t.color)}
            @input=${(e: any) => this.updateConfig('text.color', e.target.value)} />
        </div>
        ${this.renderSelect('Align', 'text.align', [
          { value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' },
          { value: 'right', label: 'Right' },
        ])}
        ${this.renderSlider('Size', 'text.size', 0.02, 0.3, 0.005)}
        ${this.renderSlider('Line height', 'text.lineHeight', 0.8, 2.5, 0.05)}
        ${this.renderSlider('Wrap width', 'text.wrap', 0.2, 1, 0.02)}
        ${this.renderSlider('Position X', 'text.posX', -1, 1, 0.02)}
        ${this.renderSlider('Position Y', 'text.posY', -1, 1, 0.02)}
      </div>
    `;
  }

  private renderVideoSection() {
    const v = this.config.video;
    return html`
      <div class="setting-group">
        <span class="group-title">Video Clip · plays under the post filters</span>
        <div class="control-row">
          <label>Open clip</label>
          <input type="file" accept="video/*" @change=${this.onVideoFile} />
        </div>
        <div class="element-desc" style="margin-bottom:8px;">
          ${this.videoName || 'No clip loaded'}
          ${this.videoInfo ? html`· ${this.videoInfo}` : ''}
          ${this.videoName && !this.videoName.startsWith('⚠')
            ? html`· <a style="color:#a855f7;cursor:pointer;" @click=${this.clearVideoClip}>remove</a>`
            : ''}
        </div>
        <div class="element-desc" style="margin-bottom:8px;">
          The file is streamed off disk rather than read into memory, so size is
          not a limit — a 4 GB clip opens as fast as a small one. A detached
          panel can open one too: the file is passed to the render window by
          reference, so nothing is copied. H.264 MP4 seeks best, which is what
          beat slicing needs.
        </div>

        ${this.renderToggle('Visible', 'video.visible')}
        <div class="control-row">
          <label>Playing</label>
          ${this.learnDot('!videoPlay')}
          ${this.learnDot('video.playing')}
          <button class="mini ${v.playing ? 'on' : ''}"
            @click=${() => this.updateConfig('video.playing', !v.playing)}>
            ${v.playing ? 'PLAYING' : 'PAUSED'}</button>
        </div>
        ${this.renderToggle('Loop', 'video.loop')}
        ${this.renderSlider('Opacity', 'video.opacity', 0, 1, 0.02)}
        ${this.renderSelect('Blend', 'video.blend', [
          { value: 'normal', label: 'Normal' },
          { value: 'screen', label: 'Screen' },
          { value: 'add', label: 'Add' },
          { value: 'multiply', label: 'Multiply' },
          { value: 'overlay', label: 'Overlay' },
          { value: 'difference', label: 'Difference' },
          { value: 'lighten', label: 'Lighten' },
          { value: 'darken', label: 'Darken' },
        ])}
        ${this.renderSelect('Fit', 'video.fit', [
          { value: 'cover', label: 'Cover (crop)' },
          { value: 'contain', label: 'Contain (bars)' },
          { value: 'stretch', label: 'Stretch' },
        ])}
        ${this.renderSlider('Zoom', 'video.scale', 0.25, 3, 0.05)}

        <span class="group-title" style="margin-top:10px;">Surface · clip onto the shader's form</span>
        ${this.renderSelect('Matte', 'video.surface', [
          { value: 'off', label: 'Off — clip over everything' },
          { value: 'luma', label: 'On the form — where the shader is lit' },
          { value: 'lumaInv', label: 'Around it — where the shader is dark' },
        ])}
        ${this.renderSlider('Cut at', 'video.surfaceThreshold', 0, 1, 0.01)}
        ${this.renderSlider('Edge softness', 'video.surfaceSoftness', 0.01, 0.6, 0.01)}
        ${this.renderSlider('Warp', 'video.warp', 0, 0.35, 0.005)}
        <div class="element-desc" style="margin-bottom:8px;">
          The shader's own brightness is the matte — there is no depth buffer to
          use, and these shaders are lit forms on near black, so luminance is a
          good stand-in for the form. Cut at sets where the edge falls and
          softness how hard it is. Warp bends the clip along the image gradient,
          which is what makes it look painted on rather than punched out; it
          costs four extra texture reads, so it is free at 0.
        </div>

        <span class="group-title" style="margin-top:10px;">Speed</span>
        ${this.renderSlider('Rate', 'video.speed', 0.1, 4, 0.05)}
        <div class="control-row">
          <label>Audio drive</label>
          ${this.renderBandSelect('video.speedBand', v.speedBand)}
        </div>
        ${this.renderSlider('Drive amount', 'video.speedAmount', 0, 3, 0.05)}
        <div class="element-desc" style="margin-bottom:8px;">
          Rate is the resting speed; the band adds to it, so the clip runs fast
          on hits and falls back between them. Clamped to 0.1–4× — outside that
          browsers drop frames rather than play slower.
        </div>

        <span class="group-title" style="margin-top:10px;">Beat Slicing</span>
        <div class="control-row">
          <label>Fire</label>
          ${this.vidTrigBtn('!vidRetrig', 'retrigger', 'RETRIG')}
          ${this.vidTrigBtn('!vidJump', 'jump', 'JUMP')}
          ${this.vidTrigBtn('!vidNext', 'next', 'NEXT')}
          ${this.vidTrigBtn('!vidPrev', 'prev', 'PREV')}
          ${this.vidTrigBtn('!vidHome', 'home', 'HOME')}
        </div>
        <div class="element-desc" style="margin-bottom:8px;">
          One-shots — they move the playhead the moment you hit them, whatever
          the auto mode is doing. Each has its own learn dot, so a pad maps to
          one trigger instead of cycling a list to reach it.
        </div>
        <div class="control-row">
          <label>Auto</label>
          ${this.vidModeBtn('off', '!vidAutoOff', 'OFF')}
          ${this.vidModeBtn('retrigger', '!vidAutoRetrig', 'RETRIG')}
          ${this.vidModeBtn('jump', '!vidAutoJump', 'JUMP')}
          ${this.vidModeBtn('ladder', '!vidAutoLadder', 'LADDER')}
        </div>
        <div class="control-row">
          <label>Slices</label>
          ${this.learnDot('video.slices')}
          <select .value=${live(String(v.slices))}
            @change=${(e: any) => this.updateConfig('video.slices', parseFloat(e.target.value))}>
            <option value="2">2</option>
            <option value="4">4</option>
            <option value="8">8</option>
            <option value="16">16</option>
            <option value="32">32</option>
          </select>
        </div>
        <div class="control-row">
          <label>Every</label>
          ${this.learnDot('video.sliceDiv')}
          <select .value=${live(String(v.sliceDiv))}
            @change=${(e: any) => this.updateConfig('video.sliceDiv', parseFloat(e.target.value))}>
            <option value="0.25">1/16 note</option>
            <option value="0.5">1/8 note</option>
            <option value="1">1 beat</option>
            <option value="2">1/2 bar</option>
            <option value="4">1 bar</option>
          </select>
        </div>
        ${this.renderSlider('Drift', 'video.sliceDrift', 0, 1, 0.01)}
        <div class="element-desc" style="margin-bottom:8px;">
          The clip is cut into equal slices and the playhead is moved on the
          beat, at the tempo in Camera · Motion. Retrigger stutters the slice
          you are already in. Jump and Ladder deal from a shuffled bag — every
          slice plays once per pass, reshuffled on each loop. Drift slides the
          cut points along the clip each pass, so a pass is cut out of new
          material instead of replaying the same fragments in a new order; at 0
          the cuts stay fixed. NEXT is the straight 1-2-3 run.
        </div>

        <div class="control-row">
          <label>Upload rate</label>
          ${this.learnDot('video.fps')}
          <select .value=${live(String(v.fps))}
            @change=${(e: any) => this.updateConfig('video.fps', parseFloat(e.target.value))}>
            <option value="60">60 fps</option>
            <option value="30">30 fps</option>
            <option value="15">15 fps</option>
            <option value="8">8 fps</option>
          </select>
        </div>
        <div class="element-desc" style="margin-bottom:8px;">
          Frames pushed to the GPU per second. Every one is a full texture
          upload, so drop this first if a big clip feels heavy.
        </div>
      </div>
    `;
  }

  private renderCaptureSection() {
    const c = this.config.model.capture;
    return html`
      <div>
        <div class="element-desc" style="margin-bottom:6px;">
          Project a shared window, or a live camera, into the scene. Works on
          its own — no 3D model needed.
        </div>
        <div class="control-row">
          <label>Source</label>
          ${this.learnDot('model.capture.source')}
          <select .value=${live(c.source)}
            @change=${(e: any) => this.updateConfig('model.capture.source', e.target.value)}>
            <option value="screen">Screen</option>
            <option value="camera">Camera</option>
          </select>
        </div>
        ${c.source === 'camera'
          ? html`
              <div class="control-row">
                <label>Camera</label>
                <select .value=${live(c.cameraId)}
                  @change=${(e: any) => this.updateConfig('model.capture.cameraId', e.target.value)}>
                  <option value="">Default camera</option>
                  ${this.cameras
                    .filter((cam) => cam.id)
                    .map((cam) => html`<option value=${cam.id}>${cam.label}</option>`)}
                  ${c.cameraId && !this.cameras.some((cam) => cam.id === c.cameraId)
                    ? html`<option value=${c.cameraId}>Saved camera (not found)</option>`
                    : ''}
                </select>
              </div>
              <div class="control-row">
                <label>Mirror</label>
                ${this.learnDot('model.capture.mirror')}
                <input type="checkbox" .checked=${c.mirror}
                  @change=${(e: any) => this.updateConfig('model.capture.mirror', e.target.checked)} />
              </div>
              <div class="element-desc" style="margin-bottom:8px;">
                Camera names show once the browser has been allowed to use the
                camera. Changing camera while it is live swaps the feed.
              </div>
            `
          : ''}
        <div class="control-row" style="gap:8px;justify-content:flex-start;">
          ${this.learnDot('!capture')}
          <button class="action-btn ${this.isCapturing ? 'active' : ''}" style="font-size:0.72rem;padding:6px 10px;"
            @click=${this.toggleCapture}>${this.isCapturing
              ? c.source === 'camera' ? 'Stop Camera' : 'Stop Capture'
              : c.source === 'camera' ? 'Start Camera' : 'Share a Window'}</button>
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
          sharing feels heavy — restart the capture to apply the new rate.
        </div>
        <div class="control-row">
          <label>Placement</label>
          ${this.learnDot('model.capture.mode')}
          <select .value=${live(c.mode)}
            @change=${(e: any) => this.updateConfig('model.capture.mode', e.target.value)}>
            <option value="background">Full Frame</option>
            <option value="floating">Inset</option>
          </select>
        </div>
        <div class="control-row">
          <label>Blend</label>
          ${this.learnDot('model.capture.blend')}
          <select .value=${live(c.blend)}
            @change=${(e: any) => this.updateConfig('model.capture.blend', e.target.value)}>
            <option value="normal">Normal</option>
            <option value="screen">Screen</option>
            <option value="add">Add</option>
            <option value="multiply">Multiply</option>
            <option value="overlay">Overlay</option>
            <option value="difference">Difference</option>
            <option value="lighten">Lighten</option>
            <option value="darken">Darken</option>
          </select>
        </div>
        <div class="element-desc" style="margin-bottom:8px;">
          How the capture mixes with the shader under it. Screen and Add keep
          the shader visible through the dark parts of the share; Multiply and
          Darken keep it through the bright parts; Difference inverts where
          they overlap. Opacity still fades the whole thing on top.
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

  private renderFx = (name: string, label: string, root: 'postfx' | 'camfx' = 'postfx') => {
    const fx = (this.config[root] as any)[name];
    const onPath = `${root}.${name}.on`;
    const amtPath = `${root}.${name}.amount`;
    const bandPath = `${root}.${name}.band`;
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
            class="midi-learn-btn ${this.learningParam === amtPath ? 'active' : ''} ${this.isMapped(amtPath) ? 'mapped' : ''} ${this.isModulated(amtPath) ? 'modulated' : ''}"
            @click=${() => this.toggleMidiLearn(amtPath)}>●</button>
          <input type="range" min="0" max="1" step="0.02" .value=${fx.amount}
            @input=${(e: any) => this.updateConfig(amtPath, parseFloat(e.target.value))} />
        </div>
        <div class="control-row">
          <label>React band</label>
          ${this.learnDot(bandPath)}
          <select .value=${live(fx.band)}
            @change=${(e: any) => this.updateConfig(bandPath, e.target.value as Band)}>
            ${this.bandOptions(fx.band)}
          </select>
        </div>
      </div>
    `;
  };

  /* ---------------------------- Strobe ---------------------------- */

  @state() private strobeHeld = false;

  /** Hold the strobe on (button, S key, a MIDI pad), from either window. */
  private setStrobeHold(on: boolean) {
    if (this.strobeHeld === on) return;
    this.strobeHeld = on;
    if (this.isController) this.post({ type: 'command', name: on ? 'strobeHold:1' : 'strobeHold:0' });
    else this.viewEl?.setStrobeHold?.(on);
  }

  private strobeFlash = () => {
    if (this.isController) this.post({ type: 'command', name: 'strobeFlash' });
    else this.viewEl?.strobeFlash?.();
  };

  private renderStrobeSection() {
    const s = this.config.strobe;
    const set = (k: string, v: any) => this.updateConfig(`strobe.${k}`, v);
    const drives: [StrobeConfig['drive'], string][] = [
      ['tempo', 'Tempo'], ['free', 'Free'], ['hits', 'Hits'], ['gate', 'Gate'],
    ];
    const styles: [StrobeConfig['style'], string][] = [
      ['white', 'White'], ['colour', 'Colour'], ['black', 'Blackout'], ['invert', 'Invert'],
    ];
    const usesRate = s.drive === 'free' || s.drive === 'gate';
    const usesSource = s.drive === 'hits' || s.drive === 'gate';
    return html`
      <div class="setting-group">
        <span class="group-title">Strobe · all shaders</span>
        <div class="element-desc" style="margin-bottom:10px;">
          A flash over the whole picture. <b>Run</b> latches it on, clocked by
          Drive. <b>Hold</b> (or the S key in the render window) strobes at the
          Rate while pressed; <b>Flash</b> fires one. Each is a MIDI pad.
        </div>
        <div class="control-row" style="gap:6px;flex-wrap:wrap;">
          ${this.learnDot('!strobeOn')}
          <button class="mini ${s.on ? 'on' : ''}" @click=${() => set('on', !s.on)}>RUN</button>
          ${this.learnDot('!strobeHold')}
          <button class="mini ${this.strobeHeld ? 'on' : ''}" style="touch-action:none;"
            @pointerdown=${(e: PointerEvent) => {
              (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
              this.setStrobeHold(true);
            }}
            @pointerup=${() => this.setStrobeHold(false)}
            @pointercancel=${() => this.setStrobeHold(false)}
            @lostpointercapture=${() => this.setStrobeHold(false)}>HOLD</button>
          ${this.learnDot('!strobe')}
          <button class="mini" @click=${this.strobeFlash}>FLASH</button>
        </div>
        <div class="control-row">
          <label>Drive</label>
          ${this.learnDot('strobe.drive')}
          <select @change=${(e: any) => set('drive', e.target.value)}>
            ${drives.map(([v, n]) => html`<option value=${v} ?selected=${s.drive === v}>${n}</option>`)}
          </select>
        </div>
        ${s.drive === 'tempo'
          ? html`<div class="control-row">
              <label>Every</label>
              ${this.learnDot('strobe.division')}
              <select @change=${(e: any) => set('division', parseFloat(e.target.value))}>
                ${[0.25, 0.5, 1, 2, 4].map((d) => html`<option value=${d} ?selected=${s.division === d}>
                  ${d === 0.25 ? '1/16 (¼ beat)' : d === 0.5 ? '1/8 (½ beat)' : d === 1 ? '1 beat' : `${d} beats`}</option>`)}
              </select>
            </div>
            <div class="element-desc" style="margin-bottom:8px;">
              Locked to the tempo in Camera · Motion (${this.config.camera.bpm} BPM).
            </div>`
          : ''}
        ${usesSource
          ? html`<div class="control-row">
              <label>Signal</label>
              ${this.learnDot('strobe.source')}
              <select @change=${(e: any) => set('source', e.target.value)}>
                ${this.bandOptions(s.source)}
              </select>
            </div>`
          : ''}
        ${s.drive === 'gate'
          ? html`<div class="control-row">
              <label>Above</label>
              ${this.learnDot('strobe.threshold')}
              <input type="range" min="0" max="1" step="0.01" .value=${s.threshold}
                @input=${(e: any) => set('threshold', parseFloat(e.target.value))} />
            </div>`
          : ''}
        <div class="control-row">
          <label>Rate ${s.rate.toFixed(1)}/s</label>
          ${this.learnDot('strobe.rate')}
          <input type="range" min="1" max="15" step="0.5" .value=${s.rate}
            @input=${(e: any) => set('rate', parseFloat(e.target.value))} />
        </div>
        ${usesRate ? '' : html`<div class="element-desc" style="margin-bottom:8px;">Rate also sets Hold.</div>`}
        <div class="control-row">
          <label>Style</label>
          ${this.learnDot('strobe.style')}
          <select @change=${(e: any) => set('style', e.target.value)}>
            ${styles.map(([v, n]) => html`<option value=${v} ?selected=${s.style === v}>${n}</option>`)}
          </select>
          ${s.style === 'colour'
            ? html`<input type="color" .value=${s.color} style="margin-left:6px;"
                @input=${(e: any) => set('color', e.target.value)} />`
            : ''}
        </div>
        <div class="control-row">
          <label>Intensity</label>
          ${this.learnDot('strobe.intensity')}
          <input type="range" min="0" max="1" step="0.01" .value=${s.intensity}
            @input=${(e: any) => set('intensity', parseFloat(e.target.value))} />
        </div>
        <div class="control-row">
          <label>Length ${Math.round(s.length)}ms</label>
          ${this.learnDot('strobe.length')}
          <input type="range" min="10" max="250" step="5" .value=${s.length}
            @input=${(e: any) => set('length', parseFloat(e.target.value))} />
        </div>
        <div class="element-desc" style="margin-top:6px;opacity:0.85;">
          ⚠ Flashing light can trigger seizures in people with photosensitive
          epilepsy. Rate is capped at 15 per second; tell the audience when a
          set uses strobe.
        </div>
      </div>
    `;
  }

  private renderCamFxSection() {
    const c = this.config.camfx;
    const live0 = this.isCapturing;
    return html`
      <div class="setting-group">
        <span class="group-title">Camera FX · global</span>
        <div class="element-desc" style="margin-bottom:10px;">
          The live feed from Screen &amp; Camera reshaping whatever shader is
          running. Start the camera there; hide its picture layer to keep only
          the effect. ${live0 ? '' : html`<b>No feed running yet.</b>`}
        </div>
        ${this.renderFx('silhouette', 'Silhouette mask', 'camfx')}
        <div class="control-row">
          <label>Key</label>
          ${this.learnDot('camfx.key')}
          <input type="range" min="0" max="1" step="0.01" .value=${c.key}
            @input=${(e: any) => this.updateConfig('camfx.key', parseFloat(e.target.value))} />
        </div>
        <div class="control-row">
          <label>Invert</label>
          ${this.learnDot('camfx.invert')}
          <input type="checkbox" .checked=${c.invert}
            @change=${(e: any) => this.updateConfig('camfx.invert', e.target.checked)} />
        </div>
        <div class="element-desc" style="margin-bottom:10px;">
          The shader shows only where the camera is brighter than Key — light
          the performer, keep the room dark. Invert shows it around them instead.
        </div>
        ${this.renderFx('displace', 'Displace', 'camfx')}
        ${this.renderFx('colourise', 'Colourise', 'camfx')}
        ${this.renderFx('trails', 'Motion trails', 'camfx')}
        <div class="element-desc" style="margin-bottom:8px;">
          Displace ripples the shader along the shapes in the picture. Colourise
          paints the camera image in the shader's colours. Motion trails keep
          the shader only where something moved; more amount, longer trails.
        </div>
      </div>
    `;
  }

  /** Apply a shader's preset palette. `key` is '<shaderId>:<index>'. */
  private applyPalette(key: string) {
    const cut = key.lastIndexOf(':');
    const shaderId = key.slice(0, cut);
    const def = getShader(shaderId);
    const pal = def.palettes?.[parseInt(key.slice(cut + 1), 10)];
    if (!pal || def.id !== shaderId) return;
    for (const [elId, hex] of Object.entries(pal.colors)) {
      if (this.config.shaders[shaderId]?.elements?.[elId]) {
        this.updateConfig(`shaders.${shaderId}.elements.${elId}.color`, hex);
      }
    }
  }

  /** One button per preset palette, each its own MIDI pad. */
  private renderPalettes(shaderId: string) {
    const def = getShader(shaderId);
    if (!def.palettes?.length) return '';
    const els = this.config.shaders[shaderId]?.elements || {};
    return html`
      <div class="element-card">
        <div class="element-head"><span class="element-name">Palette</span></div>
        <div class="element-desc">
          One press sets every colour below. Each is a MIDI pad, so a cut can
          land with its own colours.
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">
          ${def.palettes.map((pal, i) => {
            const active = Object.entries(pal.colors).every(
              ([id, hex]) => (els[id]?.color || '').toLowerCase() === hex.toLowerCase(),
            );
            const sw = Object.values(pal.colors);
            return html`
              <span style="display:inline-flex;align-items:center;">
                ${this.learnDot(`!pal:${shaderId}:${i}`)}
                <button class="mini ${active ? 'on' : ''}" title=${pal.name}
                  style="display:inline-flex;align-items:center;gap:4px;"
                  @click=${() => this.applyPalette(`${shaderId}:${i}`)}>
                  ${sw.map((c) => html`<span style="width:9px;height:9px;border-radius:2px;
                    background:${c};border:1px solid rgba(255,255,255,0.25);"></span>`)}
                  ${pal.name}
                </button>
              </span>`;
          })}
        </div>
      </div>
    `;
  }

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
        ${meta.options?.length
          ? (() => {
              const n = meta.options!.length;
              const cur = Math.min(n - 1, Math.floor(Math.min(1.999, Math.max(0, setting.level)) * n / 2));
              return html`
                <div class="control-row">
                  <label>${meta.name}</label>
                  ${this.learnDot(levelPath)}
                  <select .value=${live(String(cur))}
                    @change=${(e: any) =>
                      this.updateConfig(levelPath, ((parseInt(e.target.value, 10) + 0.5) * 2) / n)}>
                    ${meta.options!.map((o, i) => html`<option value=${String(i)}>${o}</option>`)}
                  </select>
                </div>`;
            })()
          : ''}
        ${meta.defaultColor
          ? html`
              <div class="control-row">
                <label>Colour</label>
                <input type="color" .value=${live(setting.color || meta.defaultColor)}
                  @input=${(e: any) =>
                    this.updateConfig(`shaders.${shaderId}.elements.${elementId}.color`, e.target.value)} />
              </div>`
          : ''}
        <div class="control-row">
          <label>Audio band</label>
          ${this.learnDot(bandPath)}
          <select
            .value=${live(setting.band)}
            @change=${(e: any) => this.updateConfig(bandPath, e.target.value as Band)}>
            ${this.bandOptions(setting.band)}
          </select>
        </div>
        <div class="control-row">
          <label>Reactive amount</label>
          <button
            class="midi-learn-btn ${this.learningParam === amountPath ? 'active' : ''} ${this.isMapped(amountPath) ? 'mapped' : ''} ${this.isModulated(amountPath) ? 'modulated' : ''}"
            @click=${() => this.toggleMidiLearn(amountPath)}>●</button>
          <input type="range" min="0" max="3" step="0.05" .value=${setting.amount}
            @input=${(e: any) => this.updateConfig(amountPath, parseFloat(e.target.value))} />
        </div>
        <div class="control-row">
          <label title="Manual baseline added to the reactive value — drive this element by hand (set band to None for pure manual control)">${meta.defaultColor ? 'Intensity' : meta.options?.length ? 'Level (sweeps)' : 'Manual level'}</label>
          <button
            class="midi-learn-btn ${this.learningParam === levelPath ? 'active' : ''} ${this.isMapped(levelPath) ? 'mapped' : ''} ${this.isModulated(levelPath) ? 'modulated' : ''}"
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
            ${this.bandOptions(cam.audioBand)}
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
          ${this.renderPalettes(def.id)}
          ${def.elements.map((el) => this.renderElement(def.id, el.id))}
        </div>

        <!-- OVERLAY LAYER (combine elements across shaders) -->
        ${this.renderOverlaySection()}

        <!-- AUDIO SIGNALS (custom bands, mapping) -->
        ${this.renderSignalsSection()}

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
          ${this.renderFx('datamosh', 'Datamosh')}
        </div>

        <!-- CAMERA FX (global, all shaders) -->
        ${this.renderCamFxSection()}
        ${this.renderStrobeSection()}

        <!-- TEXT -->
        ${this.renderTextSection()}

        <!-- VIDEO CLIP -->
        ${this.renderVideoSection()}

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
                Not connected${location.hostname ? html` to <strong>${location.hostname}:8787</strong>` : ''}.
                Run <strong>npm run remote</strong> in the project folder, then open
                the printed URL with <strong>?control</strong> appended here.
                ${location.hostname
                  ? html`<div style="margin-top:6px;">
                      Reachability check:
                      <a style="color:#a855f7;" href="http://${location.hostname}:8787/health" target="_blank">
                        ${location.hostname}:8787/health</a>
                      — if that fails too, the network is blocking the connection
                      (macOS firewall, Local Network privacy, or router client isolation).
                    </div>`
                  : ''}
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
