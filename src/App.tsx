import { useEffect, useRef, useState } from 'react';
import { openAudioFile } from './audio/loadFile';
import { transport, useStore, type ViewTab } from './state/store';
import { Waveform } from './ui/Waveform';
import { Transport } from './ui/Transport';
import { NowChord } from './ui/NowChord';
import { SpectrumView } from './ui/SpectrumView';
import { LeadSheet } from './ui/LeadSheet';
import { VoicingSheet } from './ui/VoicingSheet';
import { LoopList } from './ui/LoopList';

const TABS: { id: ViewTab; label: string }[] = [
  { id: 'spectrum', label: 'Spectrum & Notes' },
  { id: 'leadsheet', label: 'Lead Sheet' },
  { id: 'voicing', label: 'Voicings (Sheet)' },
  { id: 'loops', label: 'Loops' },
];

function App() {
  const fileName = useStore((s) => s.fileName);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState(false);

  const openFile = async (file: File) => {
    setLoading(true);
    try {
      await openAudioFile(file);
    } catch (err) {
      console.error(err);
      alert(`Could not open ${file.name}: ${err instanceof Error ? err.message : err}`);
    } finally {
      setLoading(false);
    }
  };

  // global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')
        return;
      const s = useStore.getState();
      switch (e.key) {
        case ' ':
          e.preventDefault();
          void transport.togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          transport.nudge(e.shiftKey ? -0.5 : -2);
          break;
        case 'ArrowRight':
          e.preventDefault();
          transport.nudge(e.shiftKey ? 0.5 : 2);
          break;
        case 'l':
        case 'L':
          if (s.loopA !== null) s.setLoopEnabled(!s.loopEnabled);
          break;
        case '[':
          s.setLoopPoints(s.playhead, s.loopB ?? s.duration);
          break;
        case ']':
          s.setLoopPoints(s.loopA ?? 0, s.playhead);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file) void openFile(file);
      }}
    >
      <header className="app-header">
        <h1>Transcribe Clone</h1>
        <button onClick={() => fileInputRef.current?.click()}>
          {loading ? 'Loading…' : 'Open audio file'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a,.aac"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void openFile(file);
            e.target.value = '';
          }}
        />
        {fileName && <span className="file-name">{fileName}</span>}
        <NowChord />
      </header>

      {fileName === null ? (
        <div
          className={`drop-zone${dragOver ? ' drag-over' : ''}`}
          onClick={() => fileInputRef.current?.click()}
        >
          <p style={{ fontSize: 16, margin: '0 0 8px' }}>
            Drop an audio file here (or click to browse)
          </p>
          <p style={{ margin: 0 }}>
            mp3 / wav / ogg / flac — chords, voicings and a lead sheet are analyzed automatically
          </p>
          <div style={{ marginTop: 18, display: 'flex', gap: 8, justifyContent: 'center' }}>
            {(
              [
                ['demo.wav', 'demo (ii-V-I jazz progression).wav', '…or load the built-in demo clip'],
                [
                  'demo-melody.wav',
                  'demo with lead melody.wav',
                  'demo with a lead melody on top',
                ],
              ] as const
            ).map(([url, name, label]) => (
              <button
                key={url}
                onClick={(e) => {
                  e.stopPropagation();
                  void (async () => {
                    setLoading(true);
                    try {
                      const res = await fetch(url);
                      const blob = await res.blob();
                      await openFile(new File([blob], name));
                    } finally {
                      setLoading(false);
                    }
                  })();
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="panel">
            <Waveform />
          </div>
          <Transport />
          <div className="panel">
            <div className="tabs">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  className={view === t.id ? 'active' : ''}
                  onClick={() => setView(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {view === 'spectrum' && <SpectrumView />}
            {view === 'leadsheet' && <LeadSheet />}
            {view === 'voicing' && <VoicingSheet />}
            {view === 'loops' && <LoopList />}
          </div>
          <div className="hint">
            <span className="kbd">Space</span> play/pause · <span className="kbd">←</span>/
            <span className="kbd">→</span> skip 2s (<span className="kbd">Shift</span> = 0.5s) ·{' '}
            <span className="kbd">[</span>/<span className="kbd">]</span> set loop A/B ·{' '}
            <span className="kbd">L</span> toggle loop · drag on waveform = loop region · wheel =
            zoom
          </div>
        </>
      )}
    </div>
  );
}

export default App;
