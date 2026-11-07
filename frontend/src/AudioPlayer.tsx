import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Pause, Play, RotateCcw, RotateCw } from 'lucide-react';
import { cx } from './ui';

export type PlayerHandle = {
  /** Move the playhead without starting playback. */
  seek: (seconds: number) => void;
};

export const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

const RATES = [1, 1.25, 1.5, 2, 0.75];

const AudioPlayer = forwardRef<PlayerHandle, { src: string; knownDuration?: number; onTime?: (seconds: number) => void; label?: string }>(function AudioPlayer(
  { src, knownDuration, onTime, label = 'Recording' },
  ref,
) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(knownDuration || 0);
  const [rate, setRate] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState(false);
  const timeCb = useRef(onTime);
  timeCb.current = onTime;

  function report(t: number) {
    setTime(t);
    timeCb.current?.(t);
  }

  function seek(t: number) {
    const a = audio.current;
    if (!a) return;
    const target = Math.max(0, Math.min(t, duration || t));
    report(target);
    if (a.readyState >= 1) a.currentTime = target;
    else {
      a.addEventListener('loadedmetadata', () => (a.currentTime = target), { once: true });
      a.preload = 'auto';
      a.load();
    }
  }
  useImperativeHandle(ref, () => ({ seek }), [duration]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    const onMeta = () => {
      // MediaRecorder files can report Infinity until fully read; keep the server-known length then.
      if (Number.isFinite(a.duration) && a.duration > 0) setDuration(a.duration);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onError = () => setError(true);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('durationchange', onMeta);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('ended', onPause);
    a.addEventListener('error', onError);
    return () => {
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('durationchange', onMeta);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('ended', onPause);
      a.removeEventListener('error', onError);
    };
  }, []);

  // Smooth playhead while playing (timeupdate alone is ~4 Hz).
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const a = audio.current;
      if (a && !dragging) report(a.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, dragging]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle() {
    const a = audio.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => setError(true));
    else a.pause();
  }

  const pct = duration ? Math.min(100, (time / duration) * 100) : 0;

  return (
    <div className={cx('player', playing && 'playing')}>
      <audio ref={audio} src={src} preload="metadata" />
      <button type="button" className="player-play" aria-label={playing ? `Pause ${label}` : `Play ${label}`} onClick={toggle} disabled={error}>
        {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
      </button>
      <button type="button" className="icon-button sm" aria-label="Back 10 seconds" title="Back 10 s" onClick={() => seek(time - 10)} disabled={error}>
        <RotateCcw size={15} />
      </button>
      <button type="button" className="icon-button sm" aria-label="Forward 10 seconds" title="Forward 10 s" onClick={() => seek(time + 10)} disabled={error}>
        <RotateCw size={15} />
      </button>
      <span className="player-time">{clock(time)}</span>
      <input
        type="range"
        className="player-scrub"
        aria-label={`${label} position`}
        min={0}
        max={duration || 0}
        step={0.1}
        value={Math.min(time, duration || 0)}
        style={{ ['--pct' as string]: `${pct}%` }}
        disabled={!duration || error}
        onPointerDown={() => setDragging(true)}
        onPointerUp={() => setDragging(false)}
        onChange={e => seek(Number(e.target.value))}
      />
      <span className="player-time muted">{duration ? clock(duration) : '–:––'}</span>
      <button
        type="button"
        className="player-rate"
        title="Playback speed"
        aria-label={`Playback speed ${rate}×`}
        onClick={() => {
          const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
          setRate(next);
          if (audio.current) audio.current.playbackRate = next;
        }}
      >
        {rate}×
      </button>
      {error && <span className="hint danger-text">Audio unavailable</span>}
    </div>
  );
});

export default AudioPlayer;
