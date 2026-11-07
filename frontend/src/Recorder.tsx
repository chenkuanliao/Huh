import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  CircleAlert,
  Ellipsis,
  FileAudio,
  Headphones,
  Laptop,
  Loader2,
  Mic,
  MicOff,
  Monitor,
  RefreshCw,
  Smartphone,
  Square,
  Tablet,
  Upload,
  Usb,
} from 'lucide-react';
import { api, Device, errorText, Meeting, RecordingState, send } from './api';
import { appendChunk, bufferFile, drain, Pending, resumeFile, saveSession, sessions } from './queue';
import { Badge, Callout, cx, Menu, Modal, Popover, Segmented, Select, Spinner, Switch, useToast } from './ui';

type Capture = { rec: MediaRecorder; p: Pending; start: number; chain: Promise<void>; acked: boolean; storageFailed?: boolean; viaGraph: boolean };

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const isMobile = isIOS || /Android/.test(navigator.userAgent);
// Desktop browsers record through a Web Audio graph so the microphone can be swapped mid-recording.
const canUseGraph = !isIOS && typeof window !== 'undefined' && 'AudioContext' in window;

function guessDeviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux PC';
  return 'This browser';
}

export function DeviceIcon({ name, size = 16 }: { name: string; size?: number }) {
  const n = name.toLowerCase();
  if (/iphone|android|\bphone\b/.test(n)) return <Smartphone size={size} />;
  if (/ipad|tablet/.test(n)) return <Tablet size={size} />;
  if (/mac|book|laptop/.test(n)) return <Laptop size={size} />;
  return <Monitor size={size} />;
}

function MicIcon({ label, size = 16 }: { label: string; size?: number }) {
  const n = label.toLowerCase();
  if (/iphone|android|pixel|galaxy/.test(n)) return <Smartphone size={size} />;
  if (/airpods|headphone|headset|buds|beats|bose|sony wh|earbud/.test(n)) return <Headphones size={size} />;
  if (/macbook|built-in|internal|laptop/.test(n)) return <Laptop size={size} />;
  if (/usb|yeti|rode|shure|blue|focusrite|scarlett|interface/.test(n)) return <Usb size={size} />;
  return <Mic size={size} />;
}

const cleanLabel = (label: string) =>
  label
    .replace(/^(Default|Communications)\s*-\s*/i, '')
    .replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)/i, '')
    .trim();

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

function rms(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>) {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}

function LevelMeter({ analyser, active }: { analyser: React.RefObject<AnalyserNode | null>; active: boolean }) {
  const bars = useRef<HTMLSpanElement[]>([]);
  useEffect(() => {
    if (!active) {
      bars.current.forEach(b => b && (b.style.transform = 'scaleY(0.15)'));
      return;
    }
    let raf = 0;
    let buffer: Float32Array<ArrayBuffer> | null = null;
    let smooth = 0;
    const loop = () => {
      const a = analyser.current;
      if (a) {
        if (!buffer || buffer.length !== a.fftSize) buffer = new Float32Array(a.fftSize);
        const level = Math.min(1, rms(a, buffer) * 6);
        smooth = Math.max(level, smooth * 0.85);
        bars.current.forEach((b, i) => {
          if (!b) return;
          const shape = [0.55, 0.8, 1, 0.8, 0.55][i] ?? 1;
          b.style.transform = `scaleY(${Math.max(0.15, Math.min(1, smooth * shape * 1.4))})`;
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active, analyser]);
  return (
    <span className={cx('level-meter', active && 'on')} aria-hidden>
      {[0, 1, 2, 3, 4].map(i => (
        <span key={i} ref={el => void (bars.current[i] = el!)} />
      ))}
    </span>
  );
}

export default function Recorder({
  meeting,
  meetings,
  onChange,
  onOpenMeeting,
  hideWhenIdle = false,
}: {
  meeting: string | null;
  meetings: Meeting[];
  onChange: () => void;
  onOpenMeeting: (id: string) => void;
  /** Keep running (heartbeats, remote commands) but hide the bar when nothing is happening. */
  hideWhenIdle?: boolean;
}) {
  const toast = useToast();
  const [deviceId] = useState(() => {
    let id = sessionStorage.getItem('huh-device');
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem('huh-device', id);
    }
    return id;
  });
  const [name, setName] = useState(() => {
    const stored = localStorage.getItem('huh-device-name');
    return stored && stored !== 'This browser' ? stored : guessDeviceName();
  });
  const [backup, setBackup] = useState(() => localStorage.getItem('huh-backup') === '1');
  const [ready, setReady] = useState(false);
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [mic, setMic] = useState(() => localStorage.getItem('huh-mic') || '');
  const [activeMicLabel, setActiveMicLabel] = useState('');
  const [devices, setDevices] = useState<Device[]>([]);
  const [source, setSource] = useState('');
  const [state, setState] = useState<RecordingState | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [offline, setOffline] = useState(false);
  const [silent, setSilent] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [setupOpen, setSetupOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [permission, setPermission] = useState<PermissionState | 'unknown'>('unknown');

  const stream = useRef<MediaStream | null>(null);
  const capture = useRef<Capture | null>(null);
  const wake = useRef<any>(null);
  const readyRef = useRef(false);
  const graph = useRef<{ ctx: AudioContext; dest: MediaStreamAudioDestinationNode; analyser: AnalyserNode; source: MediaStreamAudioSourceNode | null } | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const sourceChip = useRef<HTMLButtonElement>(null);
  const queueChip = useRef<HTMLButtonElement>(null);
  const tickRef = useRef<() => Promise<void>>(async () => {});
  const latest = useRef({ meeting, backup, name, mic });
  latest.current = { meeting, backup, name, mic };
  const changed = useRef(onChange);
  changed.current = onChange;

  const setReadyBoth = (v: boolean) => {
    readyRef.current = v;
    setReady(v);
  };

  async function refreshQueue() {
    setPending(await sessions());
  }

  const listMics = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const all = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    setMics(all);
  }, []);

  // Populate the microphone list early when permission was granted before.
  useEffect(() => {
    let status: PermissionStatus | null = null;
    (async () => {
      try {
        status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        setPermission(status.state);
        status.onchange = () => setPermission(status!.state);
        if (status.state === 'granted') await listMics();
      } catch {}
    })();
    const onDevices = () => void listMics();
    navigator.mediaDevices?.addEventListener?.('devicechange', onDevices);
    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDevices);
      if (status) status.onchange = null;
    };
  }, [listMics]);

  function ensureGraph() {
    if (!canUseGraph) return null;
    if (graph.current) return graph.current;
    try {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      const a = ctx.createAnalyser();
      a.fftSize = 1024;
      graph.current = { ctx, dest, analyser: a, source: null };
      analyser.current = a;
      return graph.current;
    } catch {
      return null;
    }
  }

  /** Opens (or swaps to) a microphone. Must be called from a user action the first time. */
  async function prepare(id = latest.current.mic, quiet = false): Promise<boolean> {
    const c = capture.current;
    if (c && !c.viaGraph) {
      toast('Stop recording before changing the microphone on this device.', 'error');
      return false;
    }
    const g = ensureGraph(); // created synchronously inside the user gesture
    setPreparing(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Error('Microphone access needs HTTPS and a supported browser.');
      let s: MediaStream;
      try {
        s = await navigator.mediaDevices.getUserMedia({ audio: id ? { deviceId: { exact: id } } : true });
      } catch (e: any) {
        if (id && (e?.name === 'OverconstrainedError' || e?.name === 'NotFoundError')) {
          s = await navigator.mediaDevices.getUserMedia({ audio: true });
          setMic('');
          localStorage.removeItem('huh-mic');
        } else throw e;
      }
      const old = stream.current;
      stream.current = s;
      const track = s.getAudioTracks()[0];
      setActiveMicLabel(cleanLabel(track?.label || ''));
      if (g) {
        if (g.ctx.state !== 'running') await g.ctx.resume().catch(() => {});
        const node = g.ctx.createMediaStreamSource(s);
        node.connect(g.dest);
        node.connect(g.analyser);
        g.source?.disconnect();
        g.source = node;
      }
      old?.getTracks().forEach(t => t.stop());
      s.getAudioTracks().forEach(t => (t.onended = () => void lost(s)));
      setReadyBoth(true);
      setPermission('granted');
      await listMics();
      try {
        await navigator.storage?.persist();
      } catch {}
      return true;
    } catch (e: any) {
      if (e?.name === 'NotAllowedError') {
        setPermission('denied');
        if (!quiet) toast('Microphone access was blocked. Allow it in your browser’s site settings, then try again.', 'error');
      } else if (!quiet) toast(errorText(e), 'error');
      return false;
    } finally {
      setPreparing(false);
    }
  }

  /** A microphone disappeared (unplugged, Continuity iPhone walked away, permission revoked). */
  async function lost(s: MediaStream) {
    if (stream.current !== s) return;
    const label = cleanLabel(s.getAudioTracks()[0]?.label || 'Microphone');
    const c = capture.current;
    if (c?.viaGraph && c.rec.state === 'recording') {
      const ok = await prepare('', true);
      if (ok) {
        setMic('');
        toast(`${label} disconnected — recording continues on the default microphone.`, 'error');
        return;
      }
    }
    setReadyBoth(false);
    toast(`${label} disconnected.`, 'error');
    if (c?.rec.state === 'recording') c.rec.stop();
  }

  function micOff() {
    if (capture.current) return;
    stream.current?.getTracks().forEach(t => t.stop());
    stream.current = null;
    graph.current?.source?.disconnect();
    if (graph.current) graph.current.source = null;
    setReadyBoth(false);
  }

  async function chooseMic(id: string) {
    setMic(id);
    if (id) localStorage.setItem('huh-mic', id);
    else localStorage.removeItem('huh-mic');
    if (readyRef.current || capture.current) {
      const ok = await prepare(id);
      if (ok && capture.current) toast('Switched microphone — recording continues.', 'success');
    }
  }

  async function acknowledge(c: Capture) {
    if (!stream.current?.getAudioTracks().some(t => t.readyState === 'live') || c.rec.state !== 'recording') throw Error('Capture stream is no longer live.');
    await api(`/recordings/${c.p.id}/started`, { method: 'POST', body: JSON.stringify({ token: c.p.token }), signal: AbortSignal.timeout(1800) });
    c.acked = true;
  }

  async function command(cmd: any) {
    if (cmd.type === 'stop') {
      const c = capture.current;
      if (c && c.p.id === cmd.recording_id && c.rec.state !== 'inactive') c.rec.stop();
      return;
    }
    if (capture.current) {
      if (capture.current.p.id === cmd.recording_id && !capture.current.acked) await acknowledge(capture.current);
      return;
    }
    if (!readyRef.current || !stream.current?.getAudioTracks().some(t => t.readyState === 'live')) throw Error('Turn on the microphone on this device first.');
    if (!window.MediaRecorder) throw Error('This browser cannot record audio.');
    let recordStream = stream.current;
    let viaGraph = false;
    const g = graph.current;
    if (g) {
      if (g.ctx.state !== 'running') await g.ctx.resume().catch(() => {});
      if (g.ctx.state === 'running' && g.source) {
        recordStream = g.dest.stream;
        viaGraph = true;
      }
    }
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported(t));
    const rec = mime ? new MediaRecorder(recordStream, { mimeType: mime }) : new MediaRecorder(recordStream);
    const p: Pending = { id: cmd.recording_id, token: cmd.token, mime: rec.mimeType, meeting: cmd.meeting_id, label: latest.current.name, count: 0, closed: false };
    await saveSession(p);
    const c: Capture = { rec, p, start: Date.now(), chain: Promise.resolve(), acked: false, viaGraph };
    capture.current = c;
    rec.ondataavailable = e => {
      if (!e.data.size) return;
      c.chain = c.chain
        .then(async () => {
          await appendChunk(p, e.data);
          void drain(p).catch(() => {});
          await refreshQueue();
        })
        .catch(e => {
          c.storageFailed = true;
          toast(`Couldn’t save audio on this device: ${errorText(e)}`, 'error');
          if (rec.state === 'recording') rec.stop();
        });
    };
    rec.onstop = () => {
      setCapturing(false);
      c.chain = c.chain
        .then(async () => {
          if (c.storageFailed) {
            capture.current = null;
            await wake.current?.release();
            wake.current = null;
            await refreshQueue();
            return;
          }
          p.closed = true;
          p.duration = (Date.now() - c.start) / 1000;
          await saveSession(p);
          try {
            await drain(p);
          } catch {}
          if (capture.current === c) capture.current = null;
          await wake.current?.release();
          wake.current = null;
          await refreshQueue();
          changed.current();
        })
        .catch(e => toast(errorText(e), 'error'));
    };
    rec.onerror = () => {
      toast('The recorder hit an error. Audio saved so far is kept and will upload.', 'error');
      if (rec.state !== 'inactive') rec.stop();
    };
    await new Promise<void>((resolve, reject) => {
      rec.onstart = () => resolve();
      try {
        rec.start(4000);
      } catch (e) {
        reject(e);
      }
    });
    setCapturing(true);
    setSilent(false);
    try {
      if ('wakeLock' in navigator) wake.current = await (navigator as any).wakeLock.request('screen');
    } catch {
      if (isMobile) toast('Keep this screen on while recording — this browser can’t keep it awake automatically.');
    }
    await acknowledge(c);
  }

  // Coordination loop: heartbeat, receive start/stop commands, and refresh shared state.
  useEffect(() => {
    let stopped = false;
    let running = false;
    async function tick() {
      if (running) return;
      running = true;
      try {
        const l = latest.current;
        const c = capture.current;
        const response = await api('/devices/heartbeat', {
          method: 'POST',
          signal: AbortSignal.timeout(1800),
          body: JSON.stringify({
            id: deviceId,
            name: l.name,
            meeting_id: c?.p.meeting || l.meeting,
            ready: readyRef.current && !!stream.current?.getAudioTracks().some(t => t.readyState === 'live'),
            recording_id: c?.p.id || null,
            backup_enabled: l.backup,
            capture_state: c?.rec.state || 'idle',
          }),
        });
        if (response.command) {
          try {
            await command(response.command);
          } catch (e) {
            toast(errorText(e), 'error');
          }
        }
        const m = c?.p.meeting || l.meeting;
        if (m) {
          const [ds, rs] = await Promise.all([
            api<Device[]>(`/meetings/${m}/devices`, { signal: AbortSignal.timeout(1800) }),
            api<RecordingState>(`/meetings/${m}/recording-state`, { signal: AbortSignal.timeout(1800) }),
          ]);
          if (!stopped) {
            setDevices(ds);
            setState(rs);
          }
        }
        for (const p of await sessions()) if (p.closed && p.id !== capture.current?.p.id) void drain(p).catch(() => {});
        if (!stopped) {
          await refreshQueue();
          setOffline(false);
        }
      } catch {
        if (!stopped) setOffline(true);
      } finally {
        running = false;
      }
    }
    tickRef.current = tick;
    void tick();
    const timer = setInterval(tick, 2000);
    const before = (e: BeforeUnloadEvent) => {
      if (capture.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', before);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener('beforeunload', before);
      stream.current?.getTracks().forEach(t => t.stop());
      void graph.current?.ctx.close().catch(() => {});
      graph.current = null;
    };
  }, [deviceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear stale state when switching meetings.
  useEffect(() => {
    if (capture.current) return;
    setDevices([]);
    setState(null);
    setSource('');
    void tickRef.current();
  }, [meeting]);

  // Elapsed clock and "no sound" detection while capturing.
  useEffect(() => {
    if (!capturing) return;
    let quietSince = Date.now();
    let buffer: Float32Array<ArrayBuffer> | null = null;
    const timer = setInterval(() => {
      setNow(Date.now());
      const a = analyser.current;
      if (!a) return;
      if (!buffer) buffer = new Float32Array(a.fftSize);
      if (rms(a, buffer) > 0.004) {
        quietSince = Date.now();
        setSilent(false);
      } else if (Date.now() - quietSince > 15000) setSilent(true);
    }, 500);
    return () => clearInterval(timer);
  }, [capturing]);

  // Allow other parts of the app to open the import dialog.
  useEffect(() => {
    const open = () => setImportOpen(true);
    window.addEventListener('huh:import-audio', open);
    return () => window.removeEventListener('huh:import-audio', open);
  }, []);

  async function heartbeatNow() {
    await api('/devices/heartbeat', {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
      body: JSON.stringify({ id: deviceId, name, meeting_id: capture.current?.p.meeting || meeting, ready: readyRef.current, recording_id: capture.current?.p.id || null, backup_enabled: backup, capture_state: capture.current?.rec.state || 'idle' }),
    });
  }

  async function control(action: 'start' | 'switch' | 'stop', target?: string) {
    const m = capture.current?.p.meeting || meeting;
    if (!m) return;
    setBusy(true);
    try {
      if (action !== 'stop' && (target || deviceId) === deviceId && !readyRef.current) {
        const ok = await prepare();
        if (!ok) return;
        await heartbeatNow();
      }
      setState(await send(`/meetings/${m}/recording-control`, { action, ...(action !== 'stop' ? { device_id: target || deviceId } : {}) }));
      onChange();
      void tickRef.current();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function policy(order: string[], auto = state?.auto_fallback || false) {
    if (!meeting) return;
    try {
      setState(await send(`/meetings/${meeting}/recording-policy`, { backup_order: order, auto_fallback: auto }, 'PATCH'));
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  /* ---------------------------------------------------------- derived */

  const recordingMeeting = capture.current?.p.meeting;
  const elsewhere = capturing && recordingMeeting && recordingMeeting !== meeting;
  const status = state?.status || 'idle';
  const activeId = state?.active_device_id;
  const pendingId = state?.pending_device_id;
  const others = devices.filter(d => d.id !== deviceId);
  const target = source || deviceId;
  const targetDevice = target === deviceId ? null : devices.find(d => d.id === target);
  const activeDevice = activeId === deviceId ? null : devices.find(d => d.id === activeId);
  const isLive = status === 'recording' || status === 'switching' || capturing;
  const isStarting = status === 'starting';

  const micOptions = useMemo(() => {
    const real = mics.filter(m => m.deviceId && m.deviceId !== 'default' && m.deviceId !== 'communications');
    const def = mics.find(m => m.deviceId === 'default');
    return [
      { value: '', label: 'System default', description: def?.label ? cleanLabel(def.label) : 'Whatever your computer is set to use', icon: <Mic size={16} /> },
      ...real.map(m => ({ value: m.deviceId, label: cleanLabel(m.label) || 'Microphone', icon: <MicIcon label={m.label} /> })),
    ];
  }, [mics]);
  // The live capture's own buffer is not "pending" from the user's point of view.
  const waiting = pending.filter(p => p.id !== capture.current?.p.id);
  const micName = mic ? micOptions.find(o => o.value === mic)?.label || activeMicLabel || 'Microphone' : activeMicLabel || 'Default microphone';

  if ((!meeting || hideWhenIdle) && !capturing && !waiting.length && !(hideWhenIdle && meeting && (isLive || isStarting || status === 'paused'))) {
    return <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} meeting={meeting} onDone={() => onChange()} refreshQueue={refreshQueue} />;
  }

  /* ------------------------------------------------------------ view */

  let headline: React.ReactNode;
  let sub: React.ReactNode;
  if (elsewhere) {
    headline = 'Recording another meeting';
    sub = (
      <button type="button" className="link" onClick={() => onOpenMeeting(recordingMeeting!)}>
        {meetings.find(m => m.id === recordingMeeting)?.title || 'Open it'} →
      </button>
    );
  } else if (capturing) {
    headline = (
      <>
        Recording <span className="elapsed">{clock(now - (capture.current?.start || now))}</span>
      </>
    );
    sub = (
      <>
        on this {name} · {micName}
      </>
    );
  } else if (status === 'recording' && activeDevice) {
    headline = 'Recording';
    sub = <>on {activeDevice.name}</>;
  } else if (isStarting || status === 'switching') {
    const d = pendingId === deviceId ? `this ${name}` : devices.find(x => x.id === pendingId)?.name || 'device';
    headline = status === 'switching' ? 'Switching…' : 'Starting…';
    sub = <>on {d}</>;
  } else if (status === 'paused') {
    headline = 'Recording paused';
    sub = state?.message || 'The recording device stopped responding.';
  } else {
    headline = 'Not recording';
    sub = targetDevice ? (
      <>Will record on {targetDevice.name}</>
    ) : ready ? (
      <>Mic on · {micName}</>
    ) : (
      <>Press record to start</>
    );
  }

  const sourceLabel = targetDevice ? targetDevice.name : `This ${name}`;

  return (
    <section className={cx('recorder', isLive && 'live', status === 'paused' && 'paused')} aria-label="Recorder">
      <div className="recorder-status">
        <span className={cx('rec-indicator', capturing && 'live', !capturing && isLive && 'remote', (isStarting || status === 'switching') && 'starting', status === 'paused' && 'paused')}>
          {isStarting || status === 'switching' ? <Loader2 size={16} className="spin" /> : status === 'paused' ? <CircleAlert size={16} /> : isLive ? <span className="rec-dot" /> : <Mic size={16} />}
        </span>
        <span className="recorder-text">
          <strong>{headline}</strong>
          <small>{sub}</small>
        </span>
        {(ready || capturing) && !elsewhere && <LevelMeter analyser={analyser} active={ready} />}
        {silent && capturing && <Badge tone="warn">No sound detected — check the mic</Badge>}
        {offline && <Badge tone="warn">Reconnecting…</Badge>}
      </div>

      <div className="recorder-actions">
        {waiting.length > 0 && (
          <button ref={queueChip} type="button" className="ghost sm queue-chip" onClick={() => setQueueOpen(o => !o)} aria-expanded={queueOpen}>
            <Upload size={14} /> {waiting.length} pending audio upload{waiting.length === 1 ? '' : 's'}
          </button>
        )}
        {meeting && !elsewhere && (
          <button ref={sourceChip} type="button" className="source-chip" aria-label="Recording source" aria-expanded={setupOpen} onClick={() => setSetupOpen(o => !o)}>
            {targetDevice ? <DeviceIcon name={targetDevice.name} /> : <MicIcon label={micName} />}
            <span className="truncate">{targetDevice ? sourceLabel : micName}</span>
            <ChevronDown size={14} className="muted-icon" />
          </button>
        )}
        {meeting && !elsewhere && (isLive || isStarting ? (
          <button type="button" className="stop-button" disabled={busy || status === 'idle'} onClick={() => void control('stop')}>
            <Square size={13} fill="currentColor" /> Stop
          </button>
        ) : (
          <button type="button" className="record-button" disabled={busy || preparing || (targetDevice ? !targetDevice.ready || !targetDevice.online : false)} onClick={() => void control('start', target)}>
            {busy || preparing ? <Spinner size={15} /> : <span className="rec-dot static" />} {status === 'paused' ? 'Resume recording' : 'Start recording'}
          </button>
        ))}
        {elsewhere && (
          <button type="button" className="stop-button" onClick={() => capture.current?.rec.state === 'recording' && void control('stop')}>
            <Square size={13} fill="currentColor" /> Stop
          </button>
        )}
        {meeting && (
          <Menu
            label="Recorder options"
            placement="top-end"
            items={[
              { label: 'Import an audio file…', icon: <FileAudio size={15} />, hint: 'Voice Memos, m4a, mp3, wav…', onSelect: () => setImportOpen(true) },
              { label: 'Recording setup…', icon: <Mic size={15} />, onSelect: () => setSetupOpen(true) },
            ]}
            trigger={p => (
              <button type="button" className="icon-button" aria-label="Recorder options" {...p} ref={p.ref}>
                <Ellipsis size={18} />
              </button>
            )}
          />
        )}
      </div>

      <Popover anchor={sourceChip} open={setupOpen} onClose={() => setSetupOpen(false)} placement="top-end" minWidth={360} maxWidth={440} className="setup-popover" label="Recording setup">
        <div className="setup">
          <div className="setup-section">
            <h3>Record from</h3>
            <div className={cx('source-row', target === deviceId && 'chosen')}>
              <button type="button" role="radio" aria-checked={target === deviceId} className="source-pick" onClick={() => setSource('')} aria-label="Record from this device">
                <span className="radio-dot" />
              </button>
              <div className="source-main">
                <div className="source-head">
                  <DeviceIcon name={name} />
                  <input
                    className="inline-input"
                    aria-label="Device name"
                    value={name}
                    maxLength={60}
                    onChange={e => {
                      setName(e.target.value);
                      localStorage.setItem('huh-device-name', e.target.value);
                    }}
                  />
                  <span className="muted small">this device</span>
                  <span className="spacer" />
                  {capturing ? <Badge tone="live">Recording</Badge> : ready ? <Badge tone="good">Mic on</Badge> : <Badge>Mic off</Badge>}
                </div>
                <div className="mic-row">
                  <Select
                    ariaLabel="Microphone"
                    size="sm"
                    value={mic}
                    options={micOptions}
                    onChange={v => void chooseMic(v)}
                    disabled={!!capture.current && !capture.current.viaGraph}
                    emptyText="No microphones found"
                    footer={permission !== 'granted' ? <span className="hint">Turn on the microphone once to see every input, including your iPhone and AirPods.</span> : <span className="hint">Connected iPhones (Continuity), AirPods and USB mics appear here.</span>}
                  />
                  {ready ? (
                    !capture.current && (
                      <button type="button" className="icon-button bordered sm" title="Turn microphone off" aria-label="Turn microphone off" onClick={micOff}>
                        <MicOff size={15} />
                      </button>
                    )
                  ) : (
                    <button type="button" className="primary sm" disabled={preparing} onClick={() => void prepare()}>
                      {preparing ? <Spinner size={14} /> : <Mic size={14} />} Turn on microphone
                    </button>
                  )}
                </div>
                {capture.current && !capture.current.viaGraph && <p className="hint">This browser can’t switch microphones mid-recording. Stop first to change it.</p>}
                {capture.current?.viaGraph && <p className="hint">You can switch microphones while recording — it won’t interrupt the audio.</p>}
                {permission === 'denied' && <Callout tone="bad">Microphone access is blocked for this site. Allow it in your browser’s site settings.</Callout>}
                {isLive && !capturing && activeId !== deviceId && ready && (
                  <button type="button" className="ghost sm" disabled={busy} onClick={() => void control('switch', deviceId)}>
                    Move recording to this device
                  </button>
                )}
              </div>
            </div>

            {others.map(d => {
              const usable = d.online && d.ready;
              return (
                <div key={d.id} className={cx('source-row', target === d.id && 'chosen', !usable && 'unavailable')}>
                  <button type="button" role="radio" aria-checked={target === d.id} className="source-pick" disabled={!usable} onClick={() => setSource(d.id)} aria-label={`Record from ${d.name}`}>
                    <span className="radio-dot" />
                  </button>
                  <div className="source-main">
                    <div className="source-head">
                      <DeviceIcon name={d.name} />
                      <strong className="truncate">{d.name || 'Unnamed device'}</strong>
                      <span className="spacer" />
                      {d.id === activeId ? <Badge tone="live">Recording</Badge> : !d.online ? <Badge>Offline</Badge> : d.ready ? <Badge tone="good">Ready</Badge> : <Badge tone="warn">Mic off</Badge>}
                    </div>
                    {!d.online ? (
                      <p className="hint">Not connected. Open this meeting on that device.</p>
                    ) : !d.ready ? (
                      <p className="hint">Tap “Turn on microphone” on that device to make it available.</p>
                    ) : isLive && d.id !== activeId ? (
                      <button type="button" className="ghost sm" disabled={busy} onClick={() => void control('switch', d.id)}>
                        Move recording here
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
            <p className="hint setup-tip">
              <Smartphone size={13} /> To record with your phone, open this same meeting on it and turn on its microphone. It will show up here.
            </p>
          </div>

          <details className="setup-section backup">
            <summary>
              <span>If the recording device drops</span>
              <ChevronDown size={14} className="muted-icon chevron" />
            </summary>
            <Switch
              checked={backup}
              onChange={v => {
                setBackup(v);
                localStorage.setItem('huh-backup', v ? '1' : '0');
              }}
              label="Offer this device as a backup"
              description="It can take over if the main recorder disconnects. Its mic must be on."
            />
            <Switch checked={state?.auto_fallback || false} onChange={v => void policy(state?.backup_order || [], v)} label="Switch to a backup automatically" description="Otherwise the recording pauses and waits for you." />
            {(state?.backup_order || []).length > 0 && (
              <ol className="backup-order">
                {state!.backup_order.map((id, i) => (
                  <li key={id}>
                    <span className="truncate">{id === deviceId ? `This ${name}` : devices.find(d => d.id === id)?.name || 'Device'}</span>
                    <button type="button" className="ghost xs" disabled={!i} onClick={() => {
                      const order = [...state!.backup_order];
                      [order[i - 1], order[i]] = [order[i], order[i - 1]];
                      void policy(order);
                    }}>
                      Up
                    </button>
                    <button type="button" className="ghost xs" onClick={() => void policy(state!.backup_order.filter(x => x !== id))}>
                      Remove
                    </button>
                  </li>
                ))}
              </ol>
            )}
            {devices.some(d => d.backup_enabled && !state?.backup_order.includes(d.id)) && (
              <Select
                ariaLabel="Add backup device"
                size="sm"
                value=""
                placeholder="Add a backup device…"
                options={devices.filter(d => d.backup_enabled && !state?.backup_order.includes(d.id)).map(d => ({ value: d.id, label: d.id === deviceId ? `This ${name}` : d.name, icon: <DeviceIcon name={d.name} /> }))}
                onChange={v => void policy([...(state?.backup_order || []), v])}
              />
            )}
          </details>

          {isMobile && (
            <Callout tone="warn">
              Keep this screen on and the browser in front while recording — phones pause web recording when locked. For long meetings, record in Voice Memos and import the file afterwards.
            </Callout>
          )}
        </div>
      </Popover>

      <Popover anchor={queueChip} open={queueOpen} onClose={() => setQueueOpen(false)} placement="top-end" minWidth={320} className="setup-popover" label="Pending uploads">
        <div className="setup">
          <div className="setup-section">
            <h3>Audio waiting to upload</h3>
            <p className="hint">Saved safely on this device. It uploads automatically when the connection allows.</p>
            {waiting.map(p => (
              <div key={p.id} className="queue-item">
                <span className="option-text">
                  <span className="truncate">{p.label}</span>
                  <span className="option-description">
                    {p.count} parts · {p.closed ? 'waiting for server' : p.id === capture.current?.p.id ? 'recording now' : 'incomplete'}
                    {p.error && <span className="danger-text"> · {p.error}</span>}
                  </span>
                </span>
                <button
                  type="button"
                  className="ghost xs"
                  onClick={async () => {
                    try {
                      await drain(p);
                      await refreshQueue();
                    } catch (e) {
                      toast(errorText(e), 'error');
                    }
                  }}
                >
                  <RefreshCw size={13} /> Retry
                </button>
                {!p.closed && p.fileSize !== undefined && (
                  <label className="button ghost xs">
                    Resume file
                    <input
                      hidden
                      type="file"
                      accept="audio/*,.m4a"
                      onChange={async e => {
                        const f = e.target.files?.[0];
                        if (f)
                          try {
                            await resumeFile(p, f);
                            await refreshQueue();
                          } catch (err) {
                            toast(errorText(err), 'error');
                          }
                      }}
                    />
                  </label>
                )}
                {!p.closed && p.fileSize === undefined && p.id !== capture.current?.p.id && (
                  <button
                    type="button"
                    className="ghost xs"
                    onClick={async () => {
                      p.closed = true;
                      await saveSession(p);
                      try {
                        await drain(p);
                      } catch (e) {
                        toast(errorText(e), 'error');
                      }
                      await refreshQueue();
                    }}
                  >
                    Finish recovered audio
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </Popover>

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} meeting={meeting} onDone={() => onChange()} refreshQueue={refreshQueue} />
    </section>
  );
}

function ImportDialog({ open, onClose, meeting, onDone, refreshQueue }: { open: boolean; onClose: () => void; meeting: string | null; onDone: () => void; refreshQueue: () => Promise<void> }) {
  const toast = useToast();
  const [mode, setMode] = useState<'additional' | 'complete'>('additional');
  const [progress, setProgress] = useState('');
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);

  async function upload(file: File) {
    if (!meeting) return;
    setBusy(true);
    setProgress('Preparing…');
    try {
      await bufferFile(file, meeting, mode, setProgress);
      toast('Audio uploaded. Transcription has started.', 'success');
      onDone();
      onClose();
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(false);
      setProgress('');
      await refreshQueue();
    }
  }

  return (
    <Modal open={open} onClose={() => !busy && onClose()} title="Import audio" description="Add a recording made elsewhere — it will be transcribed on this PC.">
      <div className="stack">
        <Segmented
          ariaLabel="Import mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'additional', label: 'Add to this meeting' },
            { value: 'complete', label: 'Replace existing audio' },
          ]}
        />
        <p className="hint">{mode === 'additional' ? 'Keeps any audio already recorded and adds this file as another source.' : 'Use this file as the full recording. Earlier audio is kept but left out of the transcript and AI notes.'}</p>
        <label
          className={cx('dropzone', drag && 'drag', busy && 'busy')}
          onDragOver={e => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={e => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files?.[0];
            if (f && !busy) void upload(f);
          }}
        >
          {busy ? <Spinner size={22} /> : <FileAudio size={26} />}
          <strong>{busy ? progress || 'Uploading…' : 'Choose an audio file'}</strong>
          <span className="hint">{busy ? 'You can keep working — don’t close this tab until it finishes.' : 'or drop it here · m4a, mp3, wav, webm, mp4'}</span>
          <input
            type="file"
            hidden
            aria-label="Audio file"
            accept="audio/*,.m4a,.mp4,.webm,.wav,.mp3"
            disabled={busy}
            onChange={e => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void upload(f);
            }}
          />
        </label>
        <p className="hint">
          <strong>iPhone Voice Memos:</strong> open the memo → Share → Save to Files, then choose it here.
        </p>
      </div>
    </Modal>
  );
}
