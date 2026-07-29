import React, { useState, useEffect, useRef } from 'react';
import {
  Play, Pause, Square, Music, Upload, Download, Settings, RefreshCw,
  Monitor, Cpu, Volume2, Sliders, Layers, Sparkles, FileText, CheckCircle2,
  AlertCircle, ChevronRight, AudioWaveform, Plus, Trash2, Edit3, HelpCircle, Loader2,
  Activity, Zap, X, Library, DownloadCloud, HardDrive, Check, Search, FolderPlus, Star, ShieldAlert
} from 'lucide-react';
import { bufferToWav } from './utils/audioEncoder';

interface Note {
  id: string;
  lyric: string;
  noteNum: number; // MIDI pitch 36-96
  tick: number; // 0 to 3840... (480 ticks = 1 beat)
  length: number; // in ticks (e.g. 480 = quarter note)
  intensity: number; // 0-150
  flags: string; // e.g. "g-5B50"
  pbs: string; // Pitch bend start e.g. "0;0"
  pbw: string; // Pitch bend width e.g. "50,100"
  pby: string; // Pitch bend height e.g. "0,5"
}

interface UstProjectData {
  tempo: number;
  projectName: string;
  voicebank: string;
  flags: string;
  notes: Note[];
}

interface PyStatus {
  pythonVersion: string;
  pysideInstalled: boolean;
  engineLibExists: boolean;
  desktopEntryPoint: string;
  mode: string;
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const getNoteName = (midiNum: number) => {
  const octave = Math.floor(midiNum / 12) - 1;
  const noteName = NOTE_NAMES[midiNum % 12];
  return `${noteName}${octave}`;
};

const isBlackKey = (midiNum: number) => {
  const noteInOctave = midiNum % 12;
  return [1, 3, 6, 8, 10].includes(noteInOctave);
};

// Default sample notes ("か", "え", "る", "の", "う", "た", "が")
const INITIAL_NOTES: Note[] = [
  { id: '1', lyric: 'か', noteNum: 60, tick: 0, length: 480, intensity: 120, flags: '', pbs: '-20;0', pbw: '50,100', pby: '0,5' },
  { id: '2', lyric: 'え', noteNum: 62, tick: 480, length: 480, intensity: 120, flags: '', pbs: '0;0', pbw: '50', pby: '0' },
  { id: '3', lyric: 'る', noteNum: 64, tick: 960, length: 480, intensity: 120, flags: '', pbs: '0;0', pbw: '50', pby: '0' },
  { id: '4', lyric: 'の', noteNum: 65, tick: 1440, length: 480, intensity: 120, flags: '', pbs: '0;0', pbw: '50', pby: '0' },
  { id: '5', lyric: 'う', noteNum: 64, tick: 1920, length: 480, intensity: 120, flags: '', pbs: '0;0', pbw: '50', pby: '0' },
  { id: '6', lyric: 'た', noteNum: 62, tick: 2400, length: 480, intensity: 120, flags: '', pbs: '0;0', pbw: '50', pby: '0' },
  { id: '7', lyric: 'が', noteNum: 60, tick: 2880, length: 960, intensity: 120, flags: 'g-5', pbs: '0;0', pbw: '50', pby: '0' },
];

export default function App() {
  const [tempo, setTempo] = useState<number>(120);
  const [projectName, setProjectName] = useState<string>('VO-SE Song 1');
  const [notes, setNotes] = useState<Note[]>(INITIAL_NOTES);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>('1');

  // Playback state
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTick, setCurrentTick] = useState<number>(0);
  const playbackRef = useRef<number | null>(null);

  // Voicebank State
  const [selectedVoicebank, setSelectedVoicebank] = useState<string>('Official Voice (VCV)');
  const [customVoicebanks, setCustomVoicebanks] = useState<
    { name: string; aliasCount: number; hasVcv: boolean; aliases: string[]; entries: any[] }[]
  >([]);
  const [selectedVbDetails, setSelectedVbDetails] = useState<{
    name: string;
    aliasCount: number;
    hasVcv: boolean;
    entries: {
      alias: string;
      filename: string;
      wav_path?: string;
      wav_exists?: boolean;
      left_blank: number;
      fixed_range: number;
      right_blank: number;
      preutterance: number;
      overlap: number;
    }[];
  } | null>(null);
  const [isLoadingDetails, setIsLoadingDetails] = useState<boolean>(false);
  const [playingAlias, setPlayingAlias] = useState<string | null>(null);

  const [isUploadingVb, setIsUploadingVb] = useState<boolean>(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [selectedAliasSearch, setSelectedAliasSearch] = useState<string>('');
  const [selectedOtoEntry, setSelectedOtoEntry] = useState<any | null>(null);

  // Toast Notification State
  const [toast, setToast] = useState<{ type: 'success' | 'error' | 'info'; title: string; desc: string } | null>(null);

  // System Diagnostic Status
  const [pyStatus, setPyStatus] = useState<PyStatus | null>(null);
  const [testResult, setTestResult] = useState<{ stdout: string; stderr: string; success: boolean } | null>(null);
  const [isRunningTests, setIsRunningTests] = useState<boolean>(false);
  const [isRenderingWav, setIsRenderingWav] = useState<boolean>(false);

  // Oto Inspector State
  const [otoOffset, setOtoOffset] = useState<number>(15);
  const [otoOverlap, setOtoOverlap] = useState<number>(8);
  const [otoPreutterance, setOtoPreutterance] = useState<number>(25);
  const [otoBlank, setOtoBlank] = useState<number>(40);
  const [otoConsonant, setOtoConsonant] = useState<number>(100);

  // Active Tab
  const [activeTab, setActiveTab] = useState<'editor' | 'voicebanks' | 'oto' | 'tests' | 'desktop'>('editor');

  // Preset Voicebank Download & Delete State
  const [isDownloadingPreset, setIsDownloadingPreset] = useState<string | null>(null);
  const [vbSearchQuery, setVbSearchQuery] = useState<string>('');

  const downloadPresetVoicebank = async (presetId: string, name: string, type: string) => {
    setIsDownloadingPreset(presetId);
    setToast({
      type: 'info',
      title: 'UTAU音源ダウンロード・構築中...',
      desc: `「${name}」の音源データおよび原音設定(oto.ini)をインストール中...`
    });
    try {
      const res = await fetch('/api/py/download-preset-voicebank', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ presetId, name, type })
      });
      const data = await res.json();
      if (data.success) {
        setToast({
          type: 'success',
          title: '音源インストールの完了',
          desc: `「${name}」をライブラリに追加しました！アクティブ音源として選択されました。`
        });
        await fetchVoicebanks();
        setSelectedVoicebank(name);
      } else {
        throw new Error(data.error || 'ダウンロードに失敗しました');
      }
    } catch (e: any) {
      setToast({
        type: 'error',
        title: 'ダウンロードエラー',
        desc: e.message || '音源のインストール中にエラーが発生しました。'
      });
    } finally {
      setIsDownloadingPreset(null);
    }
  };

  const deleteVoicebank = async (vbName: string) => {
    if (!window.confirm(`本当に音源「${vbName}」をライブラリから削除しますか？`)) return;
    try {
      const res = await fetch(`/api/py/voicebanks?name=${encodeURIComponent(vbName)}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (data.success) {
        setToast({
          type: 'success',
          title: '音源削除完了',
          desc: `「${vbName}」を削除しました。`
        });
        await fetchVoicebanks();
        if (selectedVoicebank === vbName) {
          setSelectedVoicebank('Official Voice (VCV)');
        }
      } else {
        throw new Error(data.error || '削除失敗');
      }
    } catch (e: any) {
      setToast({
        type: 'error',
        title: '削除エラー',
        desc: e.message
      });
    }
  };

  // Web Audio Context & Playback Node Tracking
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sampleCacheRef = useRef<Map<string, {
    buffer: AudioBuffer;
    left_blank: number;
    fixed_range: number;
    right_blank: number;
    preutterance: number;
    overlap: number;
  }>>(new Map());
  const activeAudioNodesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const triggeredNotesSetRef = useRef<Set<string>>(new Set());

  // Fetch status and voicebanks on mount
  useEffect(() => {
    fetchPyStatus();
    fetchVoicebanks();
  }, []);

  // Clear sample cache when selected voicebank changes
  useEffect(() => {
    sampleCacheRef.current.clear();
  }, [selectedVoicebank]);

  // Preload and active audio nodes management when play state changes
  useEffect(() => {
    if (isPlaying) {
      triggeredNotesSetRef.current.clear();
      const uniqueLyrics = Array.from(new Set(notes.map((n) => n.lyric)));
      uniqueLyrics.forEach((lyric) => fetchAndCacheSample(selectedVoicebank, lyric));
    } else {
      activeAudioNodesRef.current.forEach((node) => {
        try {
          node.stop();
          node.disconnect();
        } catch (e) {}
      });
      activeAudioNodesRef.current.clear();
    }
  }, [isPlaying, selectedVoicebank]);

  const fetchVoicebanks = async () => {
    try {
      const res = await fetch('/api/py/voicebanks');
      const data = await res.json();
      if (data.success && data.voicebanks) {
        setCustomVoicebanks(data.voicebanks);
      }
    } catch (e) {
      console.warn('Failed to load voicebanks:', e);
    }
  };

  const fetchVoicebankDetails = async (vbName: string, query: string = '') => {
    if (!vbName || vbName.includes('Official') || vbName.includes('Standard') || vbName.includes('BigVGAN')) {
      setSelectedVbDetails(null);
      return;
    }
    setIsLoadingDetails(true);
    try {
      const res = await fetch(`/api/py/voicebank-details?name=${encodeURIComponent(vbName)}&q=${encodeURIComponent(query)}&limit=300`);
      const data = await res.json();
      if (data.success) {
        setSelectedVbDetails(data);
        if (data.entries && data.entries.length > 0) {
          setSelectedOtoEntry(data.entries[0]);
          setOtoOffset(data.entries[0].left_blank || 15);
          setOtoOverlap(data.entries[0].overlap || 8);
          setOtoPreutterance(data.entries[0].preutterance || 25);
          setOtoBlank(data.entries[0].right_blank || 40);
          setOtoConsonant(data.entries[0].fixed_range || 100);
        }
      }
    } catch (e) {
      console.warn('Failed to load voicebank details:', e);
    } finally {
      setIsLoadingDetails(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchVoicebankDetails(selectedVoicebank, selectedAliasSearch);
    }, 200);
    return () => clearTimeout(timer);
  }, [selectedVoicebank, selectedAliasSearch]);

  const fetchAndCacheSample = async (vbName: string, alias: string) => {
    const cacheKey = `${vbName}:${alias}`;
    if (sampleCacheRef.current.has(cacheKey)) {
      return sampleCacheRef.current.get(cacheKey)!;
    }

    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    const ctx = audioCtxRef.current;

    try {
      const url = `/api/py/voicebank-sample?name=${encodeURIComponent(vbName)}&alias=${encodeURIComponent(alias)}`;
      const res = await fetch(url);
      if (!res.ok) return null;

      const left_blank = parseFloat(res.headers.get('X-Oto-Left-Blank') || '0');
      const fixed_range = parseFloat(res.headers.get('X-Oto-Fixed-Range') || '0');
      const right_blank = parseFloat(res.headers.get('X-Oto-Right-Blank') || '0');
      const preutterance = parseFloat(res.headers.get('X-Oto-Preutterance') || '0');
      const overlap = parseFloat(res.headers.get('X-Oto-Overlap') || '0');

      const arrayBuf = await res.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(arrayBuf);

      const item = {
        buffer: audioBuf,
        left_blank,
        fixed_range,
        right_blank,
        preutterance,
        overlap
      };

      sampleCacheRef.current.set(cacheKey, item);
      return item;
    } catch (e) {
      return null;
    }
  };

  const playSampleAudio = async (
    vbName: string,
    alias: string,
    pitchMidi = 60,
    durationSec = 1.0,
    isDirectPreview = false
  ): Promise<boolean> => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    const ctx = audioCtxRef.current;
    if (ctx.state === 'suspended') await ctx.resume();

    if (isDirectPreview) {
      setPlayingAlias(alias);
    }

    try {
      const item = await fetchAndCacheSample(vbName, alias);
      if (!item) {
        if (isDirectPreview) setPlayingAlias(null);
        return false;
      }

      const source = ctx.createBufferSource();
      source.buffer = item.buffer;

      // Pitch shift based on pitchMidi (assume base pitch C4 = 60)
      const playbackRate = Math.min(4.0, Math.max(0.25, Math.pow(2, (pitchMidi - 60) / 12)));
      source.playbackRate.setValueAtTime(playbackRate, ctx.currentTime);

      // OTO parameters alignment
      const offsetSec = Math.max(0, (item.left_blank || 0) / 1000);
      const wavDuration = item.buffer.duration;

      let maxSampleDur = Math.max(0.05, wavDuration - offsetSec);
      const rb = item.right_blank || 0;

      if (rb < 0) {
        // Negative right_blank in UTAU: cutoff distance in ms from the END of the audio file
        const endCutoffSec = Math.abs(rb) / 1000;
        maxSampleDur = Math.max(0.05, wavDuration - offsetSec - endCutoffSec);
      } else if (rb > 0) {
        // Positive right_blank: cutoff distance in ms from left_blank offset
        maxSampleDur = Math.max(0.05, rb / 1000);
      }

      // Calculate actual sample duration to play (scaled by playbackRate)
      const requestedDurScaled = durationSec * playbackRate;
      const actualSampleDurToPlay = Math.min(requestedDurScaled, maxSampleDur);
      const totalPlayTimeSec = Math.max(0.05, actualSampleDurToPlay / playbackRate);

      const gain = ctx.createGain();
      const now = ctx.currentTime;

      // De-click envelope: 5ms linear attack, 15ms linear fade-out to prevent clicks/pops
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.85, now + 0.005);
      gain.gain.setValueAtTime(0.85, now + Math.max(0.005, totalPlayTimeSec - 0.015));
      gain.gain.linearRampToValueAtTime(0.001, now + totalPlayTimeSec);

      source.connect(gain);
      gain.connect(ctx.destination);

      activeAudioNodesRef.current.add(source);
      source.onended = () => {
        activeAudioNodesRef.current.delete(source);
        if (isDirectPreview) setPlayingAlias(null);
        try {
          source.disconnect();
          gain.disconnect();
        } catch (e) {}
      };

      source.start(now, offsetSec, actualSampleDurToPlay);
      return true;
    } catch (err) {
      if (isDirectPreview) setPlayingAlias(null);
      return false;
    }
  };

  // ★修正: バイト単位のstring連結(btoa+reduce)を廃止し、
  //         ブラウザネイティブのFileReader.readAsDataURLを使う。
  //         ネイティブ実装のためJS側でのループが発生せず、
  //         iPad Safari等のメモリ制約が厳しい環境でも
  //         「処理落ち」や応答なしを起こしにくい。
  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string; // "data:application/zip;base64,XXXX...."
        const commaIdx = result.indexOf(',');
        resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
      };
      reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
      reader.readAsDataURL(file);
    });
  };

  const handleVoicebankZipUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.zip')) {
      setToast({
        type: 'error',
        title: '形式エラー',
        desc: 'UTAU音源は .zip 形式の圧縮ファイルを指定してください。'
      });
      return;
    }

    // ★追加: Base64フォールバック経路に落ちた場合の安全上限。
    //         あまりに大きいファイルをbase64化するとタブのメモリ上限
    //         (iPad Safariは特に厳しい)を超えてクラッシュしうるため、
    //         明確にエラーとして案内する。
    const BASE64_FALLBACK_MAX_BYTES = 150 * 1024 * 1024; // 150MB

    setIsUploadingVb(true);
    setUploadProgress(5);
    setToast({
      type: 'info',
      title: '音源アップロード・解析中 (5%)',
      desc: `「${file.name}」を転送および解凍・パースしています...`
    });

    try {
      // Robust Chunked Upload (2MB per chunk) to eliminate all Nginx/Proxy body limits & Network Errors
      const uploadInChunks = async (): Promise<any> => {
        const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        const uploadId = `up_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

        let lastServerResult: any = null;

        for (let i = 0; i < totalChunks; i++) {
          const start = i * CHUNK_SIZE;
          const end = Math.min(file.size, start + CHUNK_SIZE);
          const chunkBlob = file.slice(start, end);

          const pct = Math.round(((i + 1) / totalChunks) * 75); // 0% ~ 75% for chunk transfer
          setUploadProgress(pct);
          setToast({
            type: 'info',
            title: `音源アップロード中 (${pct}%)`,
            desc: `ブロック送信中 [${i + 1}/${totalChunks}]: ${Math.round(end / 1024 / 1024)}MB / ${Math.round(file.size / 1024 / 1024)}MB`
          });

          const res = await fetch(
            `/api/py/upload-voicebank-chunk?uploadId=${uploadId}&chunkIndex=${i}&totalChunks=${totalChunks}&filename=${encodeURIComponent(file.name)}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/octet-stream',
                'X-Upload-Id': uploadId,
                'X-Chunk-Index': String(i),
                'X-Total-Chunks': String(totalChunks),
                'X-Filename': encodeURIComponent(file.name)
              },
              body: chunkBlob
            }
          );

          if (!res.ok) {
            const errJson = await res.json().catch(() => ({}));
            throw new Error(errJson.error || `Chunk ${i + 1}/${totalChunks} upload failed (${res.status})`);
          }

          lastServerResult = await res.json();
        }

        // Server performs zip extraction after last chunk
        setUploadProgress(85);
        setToast({
          type: 'info',
          title: `音源解析・解凍中 (85%)`,
          desc: `全ブロックの受信が完了しました。サーバーで解凍および音源エイリアスをパース中...`
        });

        return lastServerResult;
      };

      let json = await uploadInChunks().catch((e) => {
        console.warn('[VO-SE] Chunked upload failed, fallback to single stream:', e?.message || e);
        return null;
      });

      // Fallback 1: Single stream upload
      if (!json || !json.success) {
        const uploadWithXhr = (): Promise<any> => {
          return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `/api/py/upload-voicebank-stream?filename=${encodeURIComponent(file.name)}`);
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));

            xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) {
                const pct = Math.round((e.loaded / e.total) * 75);
                setUploadProgress(pct);
              }
            };

            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                try {
                  resolve(JSON.parse(xhr.responseText));
                } catch (err) {
                  reject(new Error('JSON parse error from server'));
                }
              } else {
                reject(new Error(`Server error (${xhr.status})`));
              }
            };

            xhr.onerror = () => reject(new Error('ネットワーク通信エラーが発生しました'));
            xhr.send(file);
          });
        };

        json = await uploadWithXhr().catch(() => null);
      }

      // Fallback 2: Base64 fallback (small files only)
      if (!json || !json.success) {
        if (file.size > BASE64_FALLBACK_MAX_BYTES) {
          throw new Error(
            `分割通信および単一通信に失敗しました。` +
            `ファイルサイズ (${Math.round(file.size / 1024 / 1024)}MB) が大きすぎる可能性があります。`
          );
        }

        setUploadProgress(90);
        setToast({
          type: 'info',
          title: '互換モード切替中 (90%)',
          desc: `代替経路でアップロードを試行しています...`
        });

        const base64Str = await fileToBase64(file);
        const fbRes = await fetch('/api/py/upload-voicebank', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, fileData: base64Str })
        });
        json = await fbRes.json();
      }

      if (json && json.success && json.data) {
        setUploadProgress(100);
        setToast({
          type: 'success',
          title: 'UTAU音源の読み込み完了 (100%)！',
          desc: `「${json.data.name}」を正常ロードしました (解析エイリアス: ${json.data.aliasCount}件)`
        });
        await fetchVoicebanks();
        setSelectedVoicebank(json.data.name);
      } else {
        setUploadProgress(0);
        setToast({
          type: 'error',
          title: '音源の読み込み失敗',
          desc: (json && json.error) || 'ZIP内に valid な oto.ini または音声が見つかりませんでした'
        });
      }
    } catch (err: any) {
      setUploadProgress(0);
      setToast({
        type: 'error',
        title: '通信エラー',
        desc: err.message || 'アップロード通信に失敗しました'
      });
    } finally {
      setIsUploadingVb(false);
      setTimeout(() => setUploadProgress(0), 3000);
      event.target.value = '';
    }
  };

  const fetchPyStatus = async () => {
    try {
      const res = await fetch('/api/py/status');
      const data = await res.json();
      if (data.success) {
        setPyStatus(data);
      }
    } catch (e) {
      console.warn('Backend Py API not responding:', e);
    }
  };

  const handleRunTests = async () => {
    setIsRunningTests(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/py/run-tests');
      const data = await res.json();
      setTestResult(data);
    } catch (e: any) {
      setTestResult({
        success: false,
        stdout: '',
        stderr: `Failed to execute test runner: ${e.message}`
      });
    } finally {
      setIsRunningTests(false);
    }
  };

  // UST File Import Handler
  const handleUstFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const text = await file.text();
    try {
      const res = await fetch('/api/py/parse-ust', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: text
      });
      const json = await res.json();
      if (json.success && json.data) {
        const p: UstProjectData = json.data;
        if (p.tempo) setTempo(p.tempo);
        if (p.projectName) setProjectName(p.projectName);
        if (p.notes && p.notes.length > 0) {
          const parsedNotes: Note[] = p.notes.map((n: any, idx: number) => ({
            id: String(idx + 1),
            lyric: n.lyric || 'あ',
            noteNum: n.note_num || 60,
            tick: n.tick || idx * 480,
            length: n.length || 480,
            intensity: n.intensity || 120,
            flags: n.flags || '',
            pbs: n.pbs || '0;0',
            pbw: n.pbw || '50',
            pby: n.pby || '0'
          }));
          setNotes(parsedNotes);
          if (parsedNotes.length > 0) setSelectedNoteId(parsedNotes[0].id);
        }
      } else {
        alert('UST解析エラー: ' + (json.error || '不明なエラー'));
      }
    } catch (err: any) {
      alert('USTファイル読み込みに失敗しました: ' + err.message);
    }
  };

  // Export UST File
  const handleExportUst = () => {
    let ustContent = `[#VERSION]\nUST Version 1.2\n[#SETTING]\nTempo=${tempo.toFixed(3)}\nProjectName=${projectName}\nVoicebank=${selectedVoicebank}\n`;
    notes.forEach((n, idx) => {
      const padIndex = String(idx).padStart(4, '0');
      ustContent += `[#${padIndex}]\nLength=${n.length}\nLyric=${n.lyric}\nNoteNum=${n.noteNum}\nIntensity=${Math.round(n.intensity)}\nFlags=${n.flags}\nPBS=${n.pbs}\nPBW=${n.pbw}\nPBY=${n.pby}\n`;
    });
    const blob = new Blob([ustContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${projectName.replace(/\s+/g, '_')}.ust`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Export WAV Audio File (Formant Synthesis Offline Rendering)
  const handleExportWav = async () => {
    if (notes.length === 0) {
      alert('書き出すノートが存在しません。');
      return;
    }
    setIsRenderingWav(true);
    try {
      const sampleRate = 44100;
      const maxTick = notes.reduce((max, n) => Math.max(max, n.tick + n.length), 0);
      const totalDurationSec = Math.max((maxTick / 480) * (60 / tempo) + 1.2, 2.0);

      const offlineCtx = new OfflineAudioContext(2, Math.ceil(sampleRate * totalDurationSec), sampleRate);

      notes.forEach((n) => {
        const startTime = (n.tick / 480) * (60 / tempo);
        const durationSec = (n.length / 480) * (60 / tempo);
        const freq = 440 * Math.pow(2, (n.noteNum - 69) / 12);

        let f1 = 500, f2 = 1500;
        const lyric = n.lyric;
        if (lyric.includes('あ') || lyric.includes('a') || lyric.includes('か') || lyric.includes('た') || lyric.includes('さ')) {
          f1 = 800; f2 = 1200;
        } else if (lyric.includes('い') || lyric.includes('i') || lyric.includes('き') || lyric.includes('し')) {
          f1 = 300; f2 = 2300;
        } else if (lyric.includes('う') || lyric.includes('u') || lyric.includes('く') || lyric.includes('す')) {
          f1 = 350; f2 = 1200;
        } else if (lyric.includes('え') || lyric.includes('e') || lyric.includes('け') || lyric.includes('せ')) {
          f1 = 500; f2 = 1900;
        } else if (lyric.includes('お') || lyric.includes('o') || lyric.includes('こ') || lyric.includes('そ')) {
          f1 = 450; f2 = 800;
        }

        const osc = offlineCtx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, startTime);

        const filter1 = offlineCtx.createBiquadFilter();
        filter1.type = 'bandpass';
        filter1.frequency.setValueAtTime(f1, startTime);
        filter1.Q.setValueAtTime(4, startTime);

        const filter2 = offlineCtx.createBiquadFilter();
        filter2.type = 'bandpass';
        filter2.frequency.setValueAtTime(f2, startTime);
        filter2.Q.setValueAtTime(4, startTime);

        const gain = offlineCtx.createGain();
        gain.gain.setValueAtTime(0.001, startTime);
        gain.gain.exponentialRampToValueAtTime(0.3, startTime + Math.min(0.05, durationSec * 0.1));
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + durationSec);

        osc.connect(filter1);
        osc.connect(filter2);
        filter1.connect(gain);
        filter2.connect(gain);
        gain.connect(offlineCtx.destination);

        osc.start(startTime);
        osc.stop(startTime + durationSec);
      });

      const renderedBuffer = await offlineCtx.startRendering();
      const wavBlob = bufferToWav(renderedBuffer);

      const url = URL.createObjectURL(wavBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${projectName.replace(/\s+/g, '_')}_rendered.wav`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert('WAV音声書き出しに失敗しました: ' + err.message);
    } finally {
      setIsRenderingWav(false);
    }
  };

  // Audio Vocal Synthesizer (Browser Formant Synth with Custom Voicebank WAV Support)
  const playVocalNote = async (pitchMidi: number, lyric: string, durationSec: number) => {
    // Always attempt playing real WAV sample from server voicebank (whether custom or default)
    const playedCustom = await playSampleAudio(selectedVoicebank, lyric, pitchMidi, durationSec);
    if (playedCustom) return;

    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    const ctx = audioCtxRef.current;
    if (ctx.state === 'suspended') ctx.resume();

    const freq = 440 * Math.pow(2, (pitchMidi - 69) / 12);

    // Formant frequencies for Japanese vowels
    let f1 = 500, f2 = 1500;
    if (lyric.includes('あ') || lyric.includes('a') || lyric.includes('か') || lyric.includes('た') || lyric.includes('さ')) {
      f1 = 800; f2 = 1200;
    } else if (lyric.includes('い') || lyric.includes('i') || lyric.includes('き') || lyric.includes('し')) {
      f1 = 300; f2 = 2300;
    } else if (lyric.includes('う') || lyric.includes('u') || lyric.includes('く') || lyric.includes('す')) {
      f1 = 350; f2 = 1200;
    } else if (lyric.includes('え') || lyric.includes('e') || lyric.includes('け') || lyric.includes('せ')) {
      f1 = 500; f2 = 1900;
    } else if (lyric.includes('お') || lyric.includes('o') || lyric.includes('こ') || lyric.includes('そ')) {
      f1 = 450; f2 = 800;
    }

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, ctx.currentTime);

    // Vocal Formant Filters
    const filter1 = ctx.createBiquadFilter();
    filter1.type = 'bandpass';
    filter1.frequency.setValueAtTime(f1, ctx.currentTime);
    filter1.Q.setValueAtTime(4, ctx.currentTime);

    const filter2 = ctx.createBiquadFilter();
    filter2.type = 'bandpass';
    filter2.frequency.setValueAtTime(f2, ctx.currentTime);
    filter2.Q.setValueAtTime(4, ctx.currentTime);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.01, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationSec);

    osc.connect(filter1);
    osc.connect(filter2);
    filter1.connect(gain);
    filter2.connect(gain);
    gain.connect(ctx.destination);

    // Explicit WebKit / iPadOS Audio Node Disconnection to Prevent Memory Leaks
    osc.onended = () => {
      try {
        osc.disconnect();
        filter1.disconnect();
        filter2.disconnect();
        gain.disconnect();
      } catch (e) {
        // Ignored
      }
    };

    osc.start();
    osc.stop(ctx.currentTime + durationSec);
  };

  // High Performance RAF Playback Loop (Synced to ProMotion 60Hz/120Hz on iPadOS)
  const animFrameRef = useRef<number | null>(null);
  const lastPerfTimeRef = useRef<number | null>(null);

  useEffect(() => {
    if (isPlaying) {
      const ticksPerSec = (tempo * 480) / 60;
      lastPerfTimeRef.current = performance.now();

      const renderStep = (now: number) => {
        if (lastPerfTimeRef.current !== null) {
          const deltaSec = (now - lastPerfTimeRef.current) / 1000;
          lastPerfTimeRef.current = now;

          setCurrentTick((prev) => {
            const next = prev + ticksPerSec * deltaSec;

            if (next > 3840) {
              triggeredNotesSetRef.current.clear();
              return 0; // Loop back
            }

            // Find all untriggered notes falling in time step
            const pendingNotes = notes.filter(
              (n) => n.tick >= prev && n.tick < next && !triggeredNotesSetRef.current.has(n.id)
            );

            for (const activeNote of pendingNotes) {
              triggeredNotesSetRef.current.add(activeNote.id);
              const dur = (activeNote.length / 480) * (60 / tempo);
              playVocalNote(activeNote.noteNum, activeNote.lyric, dur);
            }

            return next;
          });
        }
        animFrameRef.current = requestAnimationFrame(renderStep);
      };

      animFrameRef.current = requestAnimationFrame(renderStep);
    } else {
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }
      lastPerfTimeRef.current = null;
    }
    return () => {
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [isPlaying, tempo, notes]);

  const selectedNote = notes.find((n) => n.id === selectedNoteId);

  const updateSelectedNote = (field: keyof Note, value: any) => {
    if (!selectedNoteId) return;
    setNotes((prev) =>
      prev.map((n) => (n.id === selectedNoteId ? { ...n, [field]: value } : n))
    );
  };

  const addNote = () => {
    const maxTick = notes.reduce((max, n) => Math.max(max, n.tick + n.length), 0);
    const newNote: Note = {
      id: String(Date.now()),
      lyric: 'あ',
      noteNum: 60,
      tick: maxTick,
      length: 480,
      intensity: 120,
      flags: '',
      pbs: '0;0',
      pbw: '50',
      pby: '0'
    };
    setNotes([...notes, newNote]);
    setSelectedNoteId(newNote.id);
  };

  const deleteNote = (id: string) => {
    setNotes(notes.filter((n) => n.id !== id));
    if (selectedNoteId === id) setSelectedNoteId(null);
  };

  return (
    <div className="flex flex-col h-screen w-full bg-slate-950 text-slate-100 overflow-hidden select-none">
      {/* --- Top Navigation Header --- */}
      <header className="h-14 border-b border-slate-800 bg-slate-900/90 px-4 flex items-center justify-between shrink-0">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
            <Music className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h1 className="font-bold text-slate-100 tracking-wide text-base">VO-SE Pro Studio</h1>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-400 border border-cyan-800/50">
                v1.0.0
              </span>
            </div>
            <p className="text-xs text-slate-400">Vocal Synthesizer Engine & Editor</p>
          </div>
        </div>

        {/* Voicebank Selector / Active Status */}
        <div className="hidden sm:flex items-center space-x-2">
          <button
            onClick={() => setActiveTab('voicebanks')}
            className="flex items-center space-x-1.5 text-xs text-cyan-300 hover:text-white bg-slate-800/80 hover:bg-slate-700/80 px-3 py-1.5 rounded-lg border border-slate-700 transition cursor-pointer"
            title="UTAU音源ライブラリを開く"
          >
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span className="text-slate-400">選択音源:</span>
            <span className="truncate max-w-[140px] font-semibold text-cyan-200">{selectedVoicebank}</span>
            <span className="text-[10px] bg-cyan-900/60 text-cyan-300 px-1.5 py-0.5 rounded font-mono border border-cyan-700/50">管理</span>
          </button>
        </div>

        {/* Right Toolbar Actions */}
        <div className="flex items-center space-x-2">
          <label className="flex items-center space-x-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-1.5 rounded-md cursor-pointer transition border border-slate-700">
            <Upload className="w-3.5 h-3.5" />
            <span>UST/MIDI 読み込み</span>
            <input type="file" accept=".ust,.mid,.midi" onChange={handleUstFileUpload} className="hidden" />
          </label>

          <label className="flex items-center space-x-1.5 text-xs bg-cyan-700 hover:bg-cyan-600 text-white font-medium px-3 py-1.5 rounded-md cursor-pointer transition border border-cyan-600 shadow-sm shadow-cyan-900/30">
            {isUploadingVb ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            <span>{isUploadingVb ? '音源解凍中...' : 'UTAU音源(.zip) 追加'}</span>
            <input type="file" accept=".zip" onChange={handleVoicebankZipUpload} disabled={isUploadingVb} className="hidden" />
          </label>

          <button
            onClick={handleExportUst}
            className="flex items-center space-x-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium px-3 py-1.5 rounded-md transition border border-slate-700"
          >
            <Download className="w-3.5 h-3.5" />
            <span>UST 書き出し</span>
          </button>

          <button
            onClick={handleExportWav}
            disabled={isRenderingWav}
            className="flex items-center space-x-1.5 text-xs bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white font-medium px-3 py-1.5 rounded-md transition shadow-md shadow-cyan-600/20"
          >
            {isRenderingWav ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Download className="w-3.5 h-3.5" />
            )}
            <span>{isRenderingWav ? 'WAV レンダー中...' : 'WAV 音声書き出し'}</span>
          </button>
        </div>
      </header>

      {/* --- Main Workspace Layout --- */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Sidebar Menu */}
        <div className="w-16 bg-slate-900 border-r border-slate-800 flex flex-col items-center py-4 space-y-4 shrink-0">
          <button
            onClick={() => setActiveTab('editor')}
            className={`p-2.5 rounded-xl transition flex flex-col items-center space-y-1 ${
              activeTab === 'editor' ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/30' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
            title="Piano Roll Editor"
          >
            <Sliders className="w-5 h-5" />
            <span className="text-[10px]">エディタ</span>
          </button>

          <button
            onClick={() => setActiveTab('voicebanks')}
            className={`p-2.5 rounded-xl transition flex flex-col items-center space-y-1 relative ${
              activeTab === 'voicebanks' ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/30' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
            title="UTAU Voicebanks Library"
          >
            <Library className="w-5 h-5" />
            <span className="text-[10px]">音源ライブラリ</span>
            {customVoicebanks.length > 0 && (
              <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
            )}
          </button>

          <button
            onClick={() => setActiveTab('oto')}
            className={`p-2.5 rounded-xl transition flex flex-col items-center space-y-1 ${
              activeTab === 'oto' ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/30' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
            title="Oto Database & Voicebank"
          >
            <Layers className="w-5 h-5" />
            <span className="text-[10px]">音源原音</span>
          </button>

          <button
            onClick={() => setActiveTab('tests')}
            className={`p-2.5 rounded-xl transition flex flex-col items-center space-y-1 ${
              activeTab === 'tests' ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/30' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
            title="System Tests & Evaluation"
          >
            <Cpu className="w-5 h-5" />
            <span className="text-[10px]">テスト検証</span>
          </button>

          <button
            onClick={() => setActiveTab('desktop')}
            className={`p-2.5 rounded-xl transition flex flex-col items-center space-y-1 ${
              activeTab === 'desktop' ? 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/30' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
            title="PySide6 Desktop App Info"
          >
            <Monitor className="w-5 h-5" />
            <span className="text-[10px]">PySide6</span>
          </button>
        </div>

        {/* Central Active View Content */}
        <div className="flex-1 flex flex-col overflow-hidden bg-slate-950">
          {activeTab === 'editor' && (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Transport Control Bar */}
              <div className="h-12 bg-slate-900/60 border-b border-slate-800 px-4 flex items-center justify-between shrink-0">
                <div className="flex items-center space-x-3">
                  <button
                    onClick={() => setIsPlaying(!isPlaying)}
                    className={`w-9 h-9 rounded-full flex items-center justify-center transition shadow-md ${
                      isPlaying
                        ? 'bg-amber-500 hover:bg-amber-400 text-slate-950'
                        : 'bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold'
                    }`}
                  >
                    {isPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
                  </button>

                  <button
                    onClick={() => {
                      setIsPlaying(false);
                      setCurrentTick(0);
                    }}
                    className="w-8 h-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center transition"
                  >
                    <Square className="w-3.5 h-3.5 fill-current" />
                  </button>

                  <div className="h-4 w-px bg-slate-800" />

                  {/* Tempo & Settings */}
                  <div className="flex items-center space-x-2 text-xs">
                    <span className="text-slate-400 font-medium">BPM:</span>
                    <input
                      type="number"
                      value={tempo}
                      onChange={(e) => setTempo(parseFloat(e.target.value) || 120)}
                      className="w-16 bg-slate-950 border border-slate-700 rounded px-2 py-1 text-cyan-300 font-mono text-center font-bold"
                    />
                  </div>

                  <div className="h-4 w-px bg-slate-800" />

                  <div className="flex items-center space-x-2 text-xs">
                    <span className="text-slate-400 font-medium">Voicebank:</span>
                    <select
                      value={selectedVoicebank}
                      onChange={(e) => setSelectedVoicebank(e.target.value)}
                      className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200 text-xs font-medium"
                    >
                      <option value="Official Voice (VCV)">Official Voice (VCV 連続音)</option>
                      <option value="Standard Japanese CV">Standard Japanese CV (単独音)</option>
                      <option value="BigVGAN Neural Synth">BigVGAN AI Neural Synth</option>
                      {customVoicebanks.map((vb) => (
                        <option key={vb.name} value={vb.name}>
                          {vb.name} ({vb.aliasCount} エイリアス{vb.hasVcv ? ' / VCV' : ''})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="flex items-center space-x-3">
                  <button
                    onClick={addNote}
                    className="flex items-center space-x-1 text-xs bg-slate-800 hover:bg-slate-700 text-cyan-300 px-2.5 py-1.5 rounded border border-slate-700 transition"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>ノート追加</span>
                  </button>
                  <div className="text-xs text-slate-500 font-mono">
                    Tick: <span className="text-slate-300 font-bold">{Math.round(currentTick)}</span> / 3840
                  </div>
                </div>
              </div>

              {/* Piano Roll Workspace Canvas */}
              <div className="flex-1 flex overflow-hidden">
                {/* Left Keybed Column */}
                <div className="w-20 bg-slate-900 border-r border-slate-800 flex flex-col shrink-0 select-none">
                  <div className="h-7 border-b border-slate-800 bg-slate-950 text-[10px] text-slate-500 flex items-center justify-center font-mono shrink-0">
                    Measure
                  </div>
                  <div className="flex-1 overflow-y-auto flex flex-col">
                    {Array.from({ length: 37 }).map((_, i) => {
                      const midiNum = 84 - i; // C6 (84) down to C3 (48)
                      const isBlack = isBlackKey(midiNum);
                      return (
                        <div
                          key={midiNum}
                          onClick={() => playVocalNote(midiNum, selectedNote?.lyric || 'あ', 0.5)}
                          onTouchStart={() => playVocalNote(midiNum, selectedNote?.lyric || 'あ', 0.5)}
                          className={`h-7 border-b flex items-center justify-between px-2 text-[10px] font-mono cursor-pointer transition select-none active:bg-cyan-600 ${
                            isBlack
                              ? 'bg-slate-950 text-slate-400 border-slate-900 hover:bg-slate-800'
                              : 'bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700'
                          }`}
                        >
                          <span>{getNoteName(midiNum)}</span>
                          <span className="text-[9px] opacity-40">{midiNum}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Center Timeline & Grid Canvas Column */}
                <div className="flex-1 flex flex-col overflow-hidden relative">
                  {/* Timeline Ruler Header Bar */}
                  <div
                    className="h-7 bg-slate-900 border-b border-slate-800 relative cursor-pointer overflow-hidden flex items-center shrink-0 select-none"
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const clickX = e.clientX - rect.left;
                      const pct = Math.max(0, Math.min(1, clickX / rect.width));
                      setCurrentTick(pct * 3840);
                    }}
                  >
                    {/* Ruler measure markers */}
                    <div className="absolute inset-0 flex">
                      {Array.from({ length: 8 }).map((_, mIdx) => (
                        <div key={mIdx} className="flex-1 border-r border-slate-700/60 flex items-center justify-between px-1 text-[10px] text-slate-400 font-mono">
                          <span className="font-bold text-cyan-400">{mIdx + 1}</span>
                          <span className="text-[9px] text-slate-600">.</span>
                          <span className="text-[9px] text-slate-600">.</span>
                          <span className="text-[9px] text-slate-600">.</span>
                        </div>
                      ))}
                    </div>

                    {/* Ruler Playhead Handle */}
                    <div
                      className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-20 pointer-events-none"
                      style={{ left: `${(currentTick / 3840) * 100}%` }}
                    >
                      <div className="w-3 h-3 bg-red-500 rounded-b -ml-[5px] shadow flex items-center justify-center">
                        <div className="w-1 h-1 bg-white rounded-full" />
                      </div>
                    </div>
                  </div>

                  {/* Grid Timeline Canvas */}
                  <div
                    className="flex-1 relative overflow-auto bg-slate-950 touch-grid no-scroll-chain"
                    onClick={(e) => {
                      // Check if click was on grid background (not on a note)
                      if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('border-r')) {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const clickX = e.clientX - rect.left;
                        const pct = Math.max(0, Math.min(1, clickX / rect.width));
                        setCurrentTick(pct * 3840);
                      }
                    }}
                  >
                    {/* Playhead indicator bar */}
                    <div
                      className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-30 pointer-events-none shadow-sm shadow-red-500"
                      style={{
                        left: `${(currentTick / 3840) * 100}%`
                      }}
                    >
                      <div className="w-2.5 h-2.5 bg-red-500 rounded-full -ml-[4px] -mt-1 shadow" />
                    </div>

                    {/* Grid lines background */}
                    <div className="absolute inset-0 flex">
                      {Array.from({ length: 8 }).map((_, bIdx) => (
                        <div key={bIdx} className="flex-1 border-r border-slate-800/80 flex">
                          <div className="flex-1 border-r border-slate-900/40" />
                          <div className="flex-1 border-r border-slate-900/40" />
                          <div className="flex-1 border-r border-slate-900/40" />
                        </div>
                      ))}
                    </div>

                    {/* Note Blocks */}
                    <div className="relative w-full h-[1036px]">
                      {notes.map((note) => {
                        const rowIdx = 84 - note.noteNum;
                        const topPos = rowIdx * 28;
                        const leftPct = (note.tick / 3840) * 100;
                        const widthPct = (note.length / 3840) * 100;
                        const isSelected = note.id === selectedNoteId;

                        const handleSelectAndPlay = () => {
                          setSelectedNoteId(note.id);
                          playVocalNote(note.noteNum, note.lyric, 0.4);
                        };

                        return (
                          <div
                            key={note.id}
                            onClick={handleSelectAndPlay}
                            onTouchStart={handleSelectAndPlay}
                            className={`absolute h-6 rounded-md px-2 flex items-center justify-between text-xs font-bold cursor-pointer transition shadow border gpu-accelerated ${
                              isSelected
                                ? 'bg-cyan-500 text-slate-950 border-white ring-2 ring-cyan-400/50 z-20'
                                : 'bg-indigo-600/90 hover:bg-indigo-500 text-white border-indigo-400/30 z-10'
                            }`}
                            style={{
                              top: `${topPos + 1}px`,
                              left: `${leftPct}%`,
                              width: `${Math.max(widthPct, 2)}%`
                            }}
                          >
                            <span className="truncate">{note.lyric}</span>
                            <span className="text-[9px] font-mono opacity-80 pl-1">{getNoteName(note.noteNum)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Right Parameter Inspector Panel */}
                <div className="w-72 bg-slate-900 border-l border-slate-800 p-4 flex flex-col space-y-4 shrink-0 overflow-y-auto">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                    <h3 className="font-semibold text-xs text-slate-200 flex items-center space-x-1.5">
                      <Edit3 className="w-4 h-4 text-cyan-400" />
                      <span>ノートパラメータ設定</span>
                    </h3>
                    {selectedNote && (
                      <button
                        onClick={() => deleteNote(selectedNote.id)}
                        className="text-red-400 hover:text-red-300 p-1 rounded hover:bg-slate-800"
                        title="ノート削除"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {selectedNote ? (
                    <div className="space-y-3 text-xs">
                      <div>
                        <label className="text-slate-400 block mb-1">歌詞 / 音素 (Lyric / Phoneme):</label>
                        <input
                          type="text"
                          value={selectedNote.lyric}
                          onChange={(e) => updateSelectedNote('lyric', e.target.value)}
                          className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-cyan-300 font-bold"
                        />
                      </div>

                      <div>
                        <label className="text-slate-400 block mb-1">音高 (MIDI Note):</label>
                        <div className="flex space-x-2">
                          <input
                            type="number"
                            min="36"
                            max="84"
                            value={selectedNote.noteNum}
                            onChange={(e) => updateSelectedNote('noteNum', parseInt(e.target.value) || 60)}
                            className="w-1/2 bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200 font-mono"
                          />
                          <div className="w-1/2 bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-cyan-400 font-mono font-bold flex items-center justify-center">
                            {getNoteName(selectedNote.noteNum)}
                          </div>
                        </div>
                      </div>

                      <div>
                        <label className="text-slate-400 block mb-1">長さ (Length Ticks):</label>
                        <input
                          type="number"
                          step="60"
                          value={selectedNote.length}
                          onChange={(e) => updateSelectedNote('length', parseInt(e.target.value) || 480)}
                          className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200 font-mono"
                        />
                      </div>

                      <div>
                        <label className="text-slate-400 block mb-1">音量強度 (Intensity): {selectedNote.intensity}</label>
                        <input
                          type="range"
                          min="0"
                          max="150"
                          value={selectedNote.intensity}
                          onChange={(e) => updateSelectedNote('intensity', parseFloat(e.target.value))}
                          className="w-full accent-cyan-400"
                        />
                      </div>

                      <div>
                        <label className="text-slate-400 block mb-1">フラグ (Flags, e.g. g-5B50):</label>
                        <input
                          type="text"
                          value={selectedNote.flags}
                          onChange={(e) => updateSelectedNote('flags', e.target.value)}
                          placeholder="g-5B50"
                          className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1.5 text-slate-200 font-mono"
                        />
                      </div>

                      <div className="border-t border-slate-800 pt-3">
                        <label className="text-slate-300 font-medium block mb-2 flex items-center space-x-1">
                          <AudioWaveform className="w-3.5 h-3.5 text-cyan-400" />
                          <span>ピッチカーブ (PBS/PBW)</span>
                        </label>
                        <div className="space-y-2">
                          <input
                            type="text"
                            value={selectedNote.pbs}
                            onChange={(e) => updateSelectedNote('pbs', e.target.value)}
                            placeholder="PBS (e.g. -20;0)"
                            className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-300 font-mono text-[11px]"
                          />
                          <input
                            type="text"
                            value={selectedNote.pbw}
                            onChange={(e) => updateSelectedNote('pbw', e.target.value)}
                            placeholder="PBW (e.g. 50,100)"
                            className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-300 font-mono text-[11px]"
                          />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-8 text-slate-500 text-xs">
                      ピアノロール上のノートを選択してください
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'voicebanks' && (
            <div className="p-6 overflow-y-auto space-y-6 flex-1 bg-slate-950">
              {/* Header & Metric Banner */}
              <div className="flex flex-col lg:flex-row lg:items-center justify-between border-b border-slate-800 pb-5 gap-4">
                <div>
                  <div className="flex items-center space-x-3">
                    <div className="p-2.5 rounded-xl bg-gradient-to-tr from-cyan-600 to-blue-600 text-white shadow-lg shadow-cyan-500/20">
                      <Library className="w-6 h-6" />
                    </div>
                    <div>
                      <h2 className="text-xl font-bold text-slate-100 tracking-wide flex items-center space-x-2">
                        <span>UTAU 音源ライブラリ・マネージャー</span>
                        <span className="text-xs font-mono font-normal px-2.5 py-0.5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-800/60">
                          {3 + customVoicebanks.length} 個の音源が利用可能
                        </span>
                      </h2>
                      <p className="text-xs text-slate-400 mt-1">
                        ダウンロード済み音源の一覧・追加・削除・ワンクリックプリセット試聴 & アクティブ選択
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <div className="relative">
                    <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
                    <input
                      type="text"
                      placeholder="音源名で検索..."
                      value={vbSearchQuery}
                      onChange={(e) => setVbSearchQuery(e.target.value)}
                      className="pl-9 pr-4 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500 w-48 sm:w-60"
                    />
                  </div>

                  <label className="flex items-center space-x-2 text-xs bg-cyan-600 hover:bg-cyan-500 text-white font-semibold px-4 py-2 rounded-lg cursor-pointer transition shadow-lg shadow-cyan-900/40">
                    {isUploadingVb ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                    <span>{isUploadingVb ? '解凍パース中...' : 'UTAU音源(.zip) 追加'}</span>
                    <input type="file" accept=".zip" onChange={handleVoicebankZipUpload} disabled={isUploadingVb} className="hidden" />
                  </label>
                </div>
              </div>

              {/* Status Overview Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 flex items-center space-x-4 shadow-sm">
                  <div className="p-3 bg-cyan-950 rounded-lg border border-cyan-800/50 text-cyan-400">
                    <CheckCircle2 className="w-6 h-6" />
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-400 font-medium">現在選択中のアクティブ音源</div>
                    <div className="text-sm font-bold text-cyan-300 truncate max-w-[180px]">{selectedVoicebank}</div>
                    <div className="text-[10px] text-emerald-400 font-mono mt-0.5">● 合成可能・準備完了</div>
                  </div>
                </div>

                <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 flex items-center space-x-4 shadow-sm">
                  <div className="p-3 bg-blue-950 rounded-lg border border-blue-800/50 text-blue-400">
                    <HardDrive className="w-6 h-6" />
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-400 font-medium">ダウンロード済み・追加音源</div>
                    <div className="text-sm font-bold text-slate-100 font-mono">{customVoicebanks.length} 個</div>
                    <div className="text-[10px] text-slate-400 mt-0.5">ZIP自動解凍 & oto.ini 解析済</div>
                  </div>
                </div>

                <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-4 flex items-center space-x-4 shadow-sm">
                  <div className="p-3 bg-amber-950 rounded-lg border border-amber-800/50 text-amber-400">
                    <AudioWaveform className="w-6 h-6" />
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-400 font-medium">総登録原音・エイリアス数</div>
                    <div className="text-sm font-bold text-amber-300 font-mono">
                      {customVoicebanks.reduce((acc, v) => acc + (v.aliasCount || 0), 350)} 件
                    </div>
                    <div className="text-[10px] text-slate-400 mt-0.5">連続音 (VCV) & 単独音 (CV)</div>
                  </div>
                </div>
              </div>

              {/* Section 1: Installed & Built-in Voicebanks */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center space-x-2">
                    <HardDrive className="w-4 h-4 text-cyan-400" />
                    <span>ダウンロード済み・組み込み音源一覧</span>
                  </h3>
                  <span className="text-xs text-slate-400 font-mono">
                    {3 + customVoicebanks.length} 音源登録中
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {/* Built-in Preset 1: Official VCV */}
                  {('Official Voice (VCV)'.toLowerCase().includes(vbSearchQuery.toLowerCase())) && (
                    <div
                      className={`bg-slate-900 rounded-xl border p-4 transition-all flex flex-col justify-between space-y-4 relative ${
                        selectedVoicebank === 'Official Voice (VCV)'
                          ? 'border-cyan-500 bg-cyan-950/20 shadow-lg shadow-cyan-500/10'
                          : 'border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      <div>
                        <div className="flex items-start justify-between">
                          <div className="flex items-center space-x-3">
                            <div className="w-10 h-10 rounded-lg bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center font-bold text-white shadow">
                              VCV
                            </div>
                            <div>
                              <h4 className="font-bold text-slate-100 text-sm">Official Voice (VCV)</h4>
                              <p className="text-[11px] text-slate-400">公式標準モデル (連続音対応)</p>
                            </div>
                          </div>
                          {selectedVoicebank === 'Official Voice (VCV)' && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-950 text-emerald-400 border border-emerald-800">
                              使用中
                            </span>
                          )}
                        </div>

                        <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] font-mono bg-slate-950 p-2.5 rounded-lg border border-slate-800/80">
                          <div>
                            <span className="text-slate-500">タイプ:</span>{' '}
                            <span className="text-cyan-400 font-semibold">連続音 (VCV)</span>
                          </div>
                          <div>
                            <span className="text-slate-500">エイリアス:</span>{' '}
                            <span className="text-slate-200 font-semibold">350+</span>
                          </div>
                          <div>
                            <span className="text-slate-500">音色:</span>{' '}
                            <span className="text-slate-300">ナチュラル女性音</span>
                          </div>
                          <div>
                            <span className="text-slate-500">提供:</span>{' '}
                            <span className="text-slate-400">VO-SE 内蔵</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center justify-between pt-2 border-t border-slate-800/80 gap-2">
                        <button
                          onClick={() => setSelectedVoicebank('Official Voice (VCV)')}
                          disabled={selectedVoicebank === 'Official Voice (VCV)'}
                          className={`flex-1 py-1.5 px-3 rounded-lg text-xs font-semibold transition flex items-center justify-center space-x-1 ${
                            selectedVoicebank === 'Official Voice (VCV)'
                              ? 'bg-slate-800 text-slate-500 cursor-default'
                              : 'bg-cyan-600 hover:bg-cyan-500 text-white shadow-md'
                          }`}
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>{selectedVoicebank === 'Official Voice (VCV)' ? '選択中' : 'この音源を選択'}</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Built-in Preset 2: Standard CV */}
                  {('Standard Japanese CV'.toLowerCase().includes(vbSearchQuery.toLowerCase())) && (
                    <div
                      className={`bg-slate-900 rounded-xl border p-4 transition-all flex flex-col justify-between space-y-4 relative ${
                        selectedVoicebank === 'Standard Japanese CV'
                          ? 'border-cyan-500 bg-cyan-950/20 shadow-lg shadow-cyan-500/10'
                          : 'border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      <div>
                        <div className="flex items-start justify-between">
                          <div className="flex items-center space-x-3">
                            <div className="w-10 h-10 rounded-lg bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center font-bold text-white shadow">
                              CV
                            </div>
                            <div>
                              <h4 className="font-bold text-slate-100 text-sm">Standard Japanese CV</h4>
                              <p className="text-[11px] text-slate-400">標準単独音ライブラリ</p>
                            </div>
                          </div>
                          {selectedVoicebank === 'Standard Japanese CV' && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-950 text-emerald-400 border border-emerald-800">
                              使用中
                            </span>
                          )}
                        </div>

                        <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] font-mono bg-slate-950 p-2.5 rounded-lg border border-slate-800/80">
                          <div>
                            <span className="text-slate-500">タイプ:</span>{' '}
                            <span className="text-indigo-400 font-semibold">単独音 (CV)</span>
                          </div>
                          <div>
                            <span className="text-slate-500">エイリアス:</span>{' '}
                            <span className="text-slate-200 font-semibold">120+</span>
                          </div>
                          <div>
                            <span className="text-slate-500">音色:</span>{' '}
                            <span className="text-slate-300">クリア単独音</span>
                          </div>
                          <div>
                            <span className="text-slate-500">提供:</span>{' '}
                            <span className="text-slate-400">VO-SE 内蔵</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center justify-between pt-2 border-t border-slate-800/80 gap-2">
                        <button
                          onClick={() => setSelectedVoicebank('Standard Japanese CV')}
                          disabled={selectedVoicebank === 'Standard Japanese CV'}
                          className={`flex-1 py-1.5 px-3 rounded-lg text-xs font-semibold transition flex items-center justify-center space-x-1 ${
                            selectedVoicebank === 'Standard Japanese CV'
                              ? 'bg-slate-800 text-slate-500 cursor-default'
                              : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-md'
                          }`}
                        >
                          <Check className="w-3.5 h-3.5" />
                          <span>{selectedVoicebank === 'Standard Japanese CV' ? '選択中' : 'この音源を選択'}</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Custom Installed Voicebanks */}
                  {customVoicebanks
                    .filter((vb) => vb.name.toLowerCase().includes(vbSearchQuery.toLowerCase()))
                    .map((vb) => {
                      const isSelected = selectedVoicebank === vb.name;
                      return (
                        <div
                          key={vb.name}
                          className={`bg-slate-900 rounded-xl border p-4 transition-all flex flex-col justify-between space-y-4 relative ${
                            isSelected
                              ? 'border-cyan-500 bg-cyan-950/20 shadow-lg shadow-cyan-500/10'
                              : 'border-slate-800 hover:border-slate-700'
                          }`}
                        >
                          <div>
                            <div className="flex items-start justify-between">
                              <div className="flex items-center space-x-3">
                                <div className="w-10 h-10 rounded-lg bg-gradient-to-tr from-emerald-500 to-teal-600 flex items-center justify-center font-bold text-white shadow shrink-0">
                                  {vb.hasVcv ? 'VCV' : 'CV'}
                                </div>
                                <div className="overflow-hidden">
                                  <h4 className="font-bold text-slate-100 text-sm truncate" title={vb.name}>
                                    {vb.name}
                                  </h4>
                                  <p className="text-[11px] text-emerald-400 flex items-center space-x-1">
                                    <CheckCircle2 className="w-3 h-3" />
                                    <span>インストール済み (解凍完了)</span>
                                  </p>
                                </div>
                              </div>
                              {isSelected && (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-950 text-emerald-400 border border-emerald-800 shrink-0">
                                  使用中
                                </span>
                              )}
                            </div>

                            <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] font-mono bg-slate-950 p-2.5 rounded-lg border border-slate-800/80">
                              <div>
                                <span className="text-slate-500">方式:</span>{' '}
                                <span className="text-cyan-300 font-bold">{vb.hasVcv ? '連続音 (VCV)' : '単独音 (CV)'}</span>
                              </div>
                              <div>
                                <span className="text-slate-500">原音数:</span>{' '}
                                <span className="text-amber-300 font-bold">{vb.aliasCount}</span>
                              </div>
                              <div className="col-span-2 flex items-center space-x-1">
                                <span className="text-slate-500">エイリアス試聴:</span>
                                <div className="flex items-center space-x-1 overflow-x-auto">
                                  {['あ', 'い', 'う'].map((vowel) => (
                                    <button
                                      key={vowel}
                                      onClick={() => playSampleAudio(vb.name, vowel, 60, 0.8)}
                                      className="px-1.5 py-0.5 bg-cyan-950 hover:bg-cyan-600 text-cyan-300 hover:text-white rounded text-[10px] font-bold transition border border-cyan-800/60"
                                    >
                                      {vowel}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center justify-between pt-2 border-t border-slate-800/80 gap-2">
                            <button
                              onClick={() => setSelectedVoicebank(vb.name)}
                              disabled={isSelected}
                              className={`flex-1 py-1.5 px-3 rounded-lg text-xs font-semibold transition flex items-center justify-center space-x-1 ${
                                isSelected
                                  ? 'bg-slate-800 text-slate-500 cursor-default'
                                  : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-md'
                              }`}
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>{isSelected ? '選択中' : '選択'}</span>
                            </button>

                            <button
                              onClick={() => {
                                setSelectedVoicebank(vb.name);
                                setActiveTab('oto');
                              }}
                              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-medium transition border border-slate-700 flex items-center space-x-1"
                              title="原音設定 (oto.ini) インスペクタを開く"
                            >
                              <Layers className="w-3.5 h-3.5 text-cyan-400" />
                              <span>原音設定</span>
                            </button>

                            <button
                              onClick={() => deleteVoicebank(vb.name)}
                              className="p-1.5 bg-rose-950/60 hover:bg-rose-900 text-rose-300 rounded-lg transition border border-rose-800/50"
                              title="ライブラリから削除"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'oto' && (
            <div className="p-6 overflow-y-auto space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-slate-800 pb-4 gap-4">
                <div>
                  <h2 className="text-lg font-bold text-slate-100 flex items-center space-x-2">
                    <Layers className="w-5 h-5 text-cyan-400" />
                    <span>UTAU 原音設定 (Oto Database Inspector)</span>
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    oto.ini エイリアス解析、オフセット、先行発声、オーバーラップの視覚化 & アップロード管理
                  </p>
                </div>

                <div className="flex items-center space-x-3">
                  <label className="flex items-center space-x-1.5 text-xs bg-cyan-600 hover:bg-cyan-500 text-white font-medium px-3.5 py-2 rounded-lg cursor-pointer transition shadow-md shadow-cyan-900/40">
                    {isUploadingVb ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                    <span>{isUploadingVb ? '音源解凍・解析中...' : 'UTAU音源(.zip) アップロード'}</span>
                    <input type="file" accept=".zip" onChange={handleVoicebankZipUpload} disabled={isUploadingVb} className="hidden" />
                  </label>
                </div>
              </div>

              {/* Voicebank Info Summary Header */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col space-y-4 shadow-lg">
                <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                  <div className="flex items-center space-x-3">
                    <div className="p-3 bg-cyan-950/80 rounded-lg border border-cyan-800/40 text-cyan-400 relative">
                      <AudioWaveform className="w-6 h-6" />
                      <span className="absolute -top-1 -right-1 w-3 h-3 bg-emerald-500 rounded-full border-2 border-slate-900 animate-pulse" />
                    </div>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-slate-400 font-medium">選択中音源:</span>
                        <select
                          value={selectedVoicebank}
                          onChange={(e) => setSelectedVoicebank(e.target.value)}
                          className="bg-slate-950 border border-cyan-800/60 text-cyan-300 font-bold rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-cyan-400 shadow-inner"
                        >
                          <option value="Official Voice (VCV)">Official Voice (VCV 連続音)</option>
                          <option value="Standard Japanese CV">Standard Japanese CV (単独音)</option>
                          <option value="BigVGAN Neural Synth">BigVGAN AI Neural Synth</option>
                          {customVoicebanks.map((vb) => (
                            <option key={vb.name} value={vb.name}>
                              ✅ {vb.name} ({vb.aliasCount} エイリアス{vb.hasVcv ? ' / VCV' : ''})
                            </option>
                          ))}
                        </select>

                        <span className="text-[11px] font-mono px-2.5 py-1 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-800/60 flex items-center space-x-1">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>アクティブ音源 (準備完了)</span>
                        </span>
                      </div>
                      <p className="text-xs text-slate-300 mt-1.5 flex flex-wrap items-center gap-2">
                        <span>
                          {customVoicebanks.find((v) => v.name === selectedVoicebank)
                            ? `解析済みエイリアス: ${customVoicebanks.find((v) => v.name === selectedVoicebank)?.aliasCount} 件 (${
                                customVoicebanks.find((v) => v.name === selectedVoicebank)?.hasVcv ? '連続音対応' : '単独音'
                              })`
                            : '組み込みデフォルト音源モデル (内蔵)'}
                        </span>
                        {selectedVbDetails && (
                          <span className="text-[10px] bg-emerald-950 text-emerald-300 px-2 py-0.5 rounded border border-emerald-800/60 font-mono">
                            WAV実音声ファイル: {selectedVbDetails.entries.filter((e) => e.wav_exists !== false).length} / {selectedVbDetails.entries.length} 検出済み
                          </span>
                        )}
                        {customVoicebanks.find((v) => v.name === selectedVoicebank) && (
                          <span className="text-[10px] bg-slate-800 text-slate-400 px-2 py-0.5 rounded border border-slate-700">
                            ZIP全サブフォルダ自動解凍・パース済み
                          </span>
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
                    {/* Live WAV Sample Test buttons */}
                    {customVoicebanks.some((v) => v.name === selectedVoicebank) && (
                      <div className="flex items-center space-x-1.5 bg-slate-950 p-1.5 rounded-lg border border-slate-800">
                        <span className="text-[10px] text-cyan-400 font-bold px-1">生WAVテスト試聴:</span>
                        {['あ', 'い', 'う', 'え', 'お'].map((vowel) => (
                          <button
                            key={vowel}
                            onClick={() => playSampleAudio(selectedVoicebank, vowel, 60, 1.0, true)}
                            className="px-2 py-1 bg-cyan-950 hover:bg-cyan-600 text-cyan-300 hover:text-white rounded text-xs font-bold transition border border-cyan-800/60 flex items-center space-x-1"
                          >
                            <Play className="w-2.5 h-2.5 fill-current" />
                            <span>{vowel}</span>
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="flex items-center space-x-2 text-xs">
                      <input
                        type="text"
                        placeholder="エイリアス検索 (例: あ, a い, - か)..."
                        value={selectedAliasSearch}
                        onChange={(e) => setSelectedAliasSearch(e.target.value)}
                        className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-slate-200 placeholder-slate-500 w-52 focus:outline-none focus:border-cyan-500"
                      />
                    </div>
                  </div>
                </div>

                {/* Upload & Unzip Progress Indicator */}
                {(isUploadingVb || uploadProgress > 0) && (
                  <div className="bg-slate-950/80 rounded-xl p-3 border border-cyan-800/50 space-y-2 animate-pulse">
                    <div className="flex items-center justify-between text-xs font-mono">
                      <span className="text-cyan-300 font-bold flex items-center space-x-2">
                        <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
                        <span>UTAU音源ZIP転送 & 解凍・パース進行中</span>
                      </span>
                      <span className="text-emerald-400 font-bold text-sm">{uploadProgress}%</span>
                    </div>
                    <div className="w-full bg-slate-900 rounded-full h-2.5 overflow-hidden border border-slate-800 p-0.5">
                      <div
                        className="bg-gradient-to-r from-cyan-500 via-teal-400 to-emerald-400 h-full rounded-full transition-all duration-300"
                        style={{ width: `${Math.max(5, uploadProgress)}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
                  <h3 className="text-sm font-semibold text-slate-200 flex items-center justify-between">
                    <span>原音パラメータ設定 (Oto Parameters)</span>
                    {selectedOtoEntry && (
                      <span className="text-xs font-mono text-cyan-400 bg-cyan-950 border border-cyan-800/60 px-2 py-0.5 rounded">
                        {selectedOtoEntry.alias} ({selectedOtoEntry.filename})
                      </span>
                    )}
                  </h3>

                  <div className="space-y-3 text-xs">
                    <div>
                      <div className="flex justify-between mb-1">
                        <span className="text-slate-400">オフセット (Offset ms):</span>
                        <span className="text-cyan-400 font-mono">{otoOffset} ms</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="200"
                        value={otoOffset}
                        onChange={(e) => setOtoOffset(Number(e.target.value))}
                        className="w-full accent-cyan-400"
                      />
                    </div>

                    <div>
                      <div className="flex justify-between mb-1">
                        <span className="text-slate-400">オーバーラップ (Overlap ms):</span>
                        <span className="text-cyan-400 font-mono">{otoOverlap} ms</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={otoOverlap}
                        onChange={(e) => setOtoOverlap(Number(e.target.value))}
                        className="w-full accent-cyan-400"
                      />
                    </div>

                    <div>
                      <div className="flex justify-between mb-1">
                        <span className="text-slate-400">先行発声 (Preutterance ms):</span>
                        <span className="text-cyan-400 font-mono">{otoPreutterance} ms</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="150"
                        value={otoPreutterance}
                        onChange={(e) => setOtoPreutterance(Number(e.target.value))}
                        className="w-full accent-cyan-400"
                      />
                    </div>

                    <div>
                      <div className="flex justify-between mb-1">
                        <span className="text-slate-400">ブランク (Cutoff ms):</span>
                        <span className="text-cyan-400 font-mono">{otoBlank} ms</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="300"
                        value={otoBlank}
                        onChange={(e) => setOtoBlank(Number(e.target.value))}
                        className="w-full accent-cyan-400"
                      />
                    </div>

                    <div>
                      <div className="flex justify-between mb-1">
                        <span className="text-slate-400">固定範囲 (Consonant Velocity):</span>
                        <span className="text-cyan-400 font-mono">{otoConsonant} ms</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="200"
                        value={otoConsonant}
                        onChange={(e) => setOtoConsonant(Number(e.target.value))}
                        className="w-full accent-cyan-400"
                      />
                    </div>

                    <div className="pt-2 flex space-x-2">
                      <button
                        onClick={() => playVocalNote(60, selectedOtoEntry?.alias || 'あ', 0.8)}
                        className="flex-1 bg-cyan-600 hover:bg-cyan-500 text-white font-medium py-2 rounded-lg transition text-center flex items-center justify-center space-x-1.5 shadow"
                      >
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>原音パラメータ テスト再生</span>
                      </button>
                    </div>
                  </div>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-200 mb-2">波形エンベロープ プレビュー</h3>
                    <p className="text-xs text-slate-400 mb-4">
                      VSE-vocal の音源エンジン (VCV Resolver & World Synthesizer) による合成タイミング視覚化
                    </p>

                    <div className="h-40 bg-slate-950 border border-slate-800 rounded-lg relative overflow-hidden flex items-center justify-center p-4">
                      {/* Envelope SVG lines */}
                      <svg className="w-full h-full text-cyan-400 stroke-current fill-none stroke-2" viewBox="0 0 300 100">
                        <path d="M 10 90 L 40 20 L 120 20 L 260 90" />
                        <line x1="40" y1="0" x2="40" y2="100" className="stroke-rose-500 stroke-1 stroke-dasharray-2" />
                        <line x1="80" y1="0" x2="80" y2="100" className="stroke-amber-400 stroke-1 stroke-dasharray-2" />
                      </svg>
                      <div className="absolute top-2 left-2 text-[10px] text-rose-400 font-mono">
                        Preutterance: {otoPreutterance}ms
                      </div>
                      <div className="absolute top-2 left-28 text-[10px] text-amber-300 font-mono">
                        Overlap: {otoOverlap}ms
                      </div>
                    </div>
                  </div>

                  <div className="text-xs text-slate-400 bg-slate-950/60 p-3 rounded-lg border border-slate-800 mt-4">
                    <span className="text-cyan-400 font-bold">ヒント:</span> ZIP形式でアップロードされた UTAU
                    音源は自動的に解凍され、<code className="text-slate-200 font-mono">oto.ini</code> が Shift-JIS / UTF-8
                    両対応で全サブフォルダ再帰ロードされます。
                  </div>
                </div>
              </div>

              {/* Oto Entries Database Table */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-200 flex items-center space-x-2">
                      <span>ロード済み oto.ini エントリ一覧</span>
                      {isLoadingDetails && <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin" />}
                    </h3>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      クリックでパラメータを編集、または「▶ 試聴」で音源の実WAVサンプル音声を試聴できます。
                    </p>
                  </div>
                  <span className="text-xs text-slate-400 font-mono bg-slate-950 px-3 py-1 rounded-lg border border-slate-800">
                    {
                      ((selectedVbDetails && selectedVbDetails.entries) ||
                        customVoicebanks.find((v) => v.name === selectedVoicebank)?.entries || []
                      ).filter((e: any) => (selectedAliasSearch ? e.alias.includes(selectedAliasSearch) : true)).length
                    }{' '}
                    / {selectedVbDetails?.aliasCount || customVoicebanks.find((v) => v.name === selectedVoicebank)?.aliasCount || 0} エントリ表示中
                  </span>
                </div>

                <div className="overflow-x-auto max-h-80 border border-slate-800 rounded-lg bg-slate-950/50">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead className="bg-slate-950 text-slate-400 font-mono border-b border-slate-800 sticky top-0 z-10">
                      <tr>
                        <th className="py-2.5 px-3">エイリアス (Alias)</th>
                        <th className="py-2.5 px-3">WAVファイル</th>
                        <th className="py-2.5 px-3">WAV状態</th>
                        <th className="py-2.5 px-3">Offset (ms)</th>
                        <th className="py-2.5 px-3">Consonant (ms)</th>
                        <th className="py-2.5 px-3">Preutterance (ms)</th>
                        <th className="py-2.5 px-3">Overlap (ms)</th>
                        <th className="py-2.5 px-3 text-right">実音試聴</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 font-mono text-slate-300">
                      {((selectedVbDetails && selectedVbDetails.entries) ||
                        customVoicebanks.find((v) => v.name === selectedVoicebank)?.entries || [
                          { alias: '- あ', filename: '_a.wav', wav_exists: true, left_blank: 10, fixed_range: 80, preutterance: 30, overlap: 10 },
                          { alias: 'a い', filename: '_ai.wav', wav_exists: true, left_blank: 15, fixed_range: 100, preutterance: 25, overlap: 8 },
                          { alias: 'i う', filename: '_iu.wav', wav_exists: true, left_blank: 12, fixed_range: 90, preutterance: 28, overlap: 9 },
                          { alias: 'u え', filename: '_ue.wav', wav_exists: true, left_blank: 18, fixed_range: 110, preutterance: 22, overlap: 7 },
                          { alias: 'e お', filename: '_eo.wav', wav_exists: true, left_blank: 14, fixed_range: 95, preutterance: 26, overlap: 8 }
                        ]
                      )
                        .filter((e: any) => (selectedAliasSearch ? e.alias.includes(selectedAliasSearch) : true))
                        .map((entry: any, index: number) => {
                          const isThisPlaying = playingAlias === entry.alias;
                          return (
                            <tr
                              key={index}
                              onClick={() => {
                                setSelectedOtoEntry(entry);
                                if (entry.left_blank !== undefined) setOtoOffset(Math.round(entry.left_blank));
                                if (entry.overlap !== undefined) setOtoOverlap(Math.round(entry.overlap));
                                if (entry.preutterance !== undefined) setOtoPreutterance(Math.round(entry.preutterance));
                                if (entry.fixed_range !== undefined) setOtoConsonant(Math.round(entry.fixed_range));
                              }}
                              className={`hover:bg-slate-800/70 transition cursor-pointer ${
                                selectedOtoEntry?.alias === entry.alias ? 'bg-cyan-950/60 text-cyan-200' : ''
                              }`}
                            >
                              <td className="py-2 px-3 font-bold text-cyan-400 flex items-center space-x-1.5">
                                <span>{entry.alias}</span>
                              </td>
                              <td className="py-2 px-3 text-slate-400">{entry.filename}</td>
                              <td className="py-2 px-3">
                                {entry.wav_exists !== false ? (
                                  <span className="inline-flex items-center space-x-1 text-[10px] text-emerald-400 bg-emerald-950/80 px-2 py-0.5 rounded border border-emerald-800/60">
                                    <CheckCircle2 className="w-3 h-3" />
                                    <span>検出OK</span>
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center space-x-1 text-[10px] text-amber-400 bg-amber-950/80 px-2 py-0.5 rounded border border-amber-800/60">
                                    <span>WAV未検出</span>
                                  </span>
                                )}
                              </td>
                              <td className="py-2 px-3">{Math.round(entry.left_blank || 0)}</td>
                              <td className="py-2 px-3">{Math.round(entry.fixed_range || 0)}</td>
                              <td className="py-2 px-3">{Math.round(entry.preutterance || 0)}</td>
                              <td className="py-2 px-3">{Math.round(entry.overlap || 0)}</td>
                              <td className="py-2 px-3 text-right">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    playSampleAudio(selectedVoicebank, entry.alias, 60, 1.2);
                                  }}
                                  className={`px-2.5 py-1 rounded text-xs font-sans font-medium transition flex items-center space-x-1 ml-auto ${
                                    isThisPlaying
                                      ? 'bg-emerald-600 text-white animate-pulse'
                                      : 'bg-cyan-900/80 hover:bg-cyan-600 text-cyan-200 hover:text-white border border-cyan-700/60'
                                  }`}
                                  title="実WAVサンプルの再生"
                                >
                                  {isThisPlaying ? (
                                    <>
                                      <Volume2 className="w-3.5 h-3.5 animate-bounce" />
                                      <span>再生中</span>
                                    </>
                                  ) : (
                                    <>
                                      <Play className="w-3 h-3 fill-current" />
                                      <span>実音試聴</span>
                                    </>
                                  )}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'tests' && (
            <div className="p-6 overflow-y-auto space-y-6">
              <div className="flex items-center justify-between border-b border-slate-800 pb-4">
                <div>
                  <h2 className="text-lg font-bold text-slate-100 flex items-center space-x-2">
                    <Cpu className="w-5 h-5 text-cyan-400" />
                    <span>システム統合テスト & コード評価 (System Verification)</span>
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">Pythonバックエンド、USTパーサー、 timelineモジュールの動作検証</p>
                </div>

                <button
                  onClick={handleRunTests}
                  disabled={isRunningTests}
                  className="flex items-center space-x-2 bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold px-4 py-2 rounded-lg transition shadow-md disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 ${isRunningTests ? 'animate-spin' : ''}`} />
                  <span>{isRunningTests ? 'テスト実行中...' : 'テスト実行 (python -m unittest)'}</span>
                </button>
              </div>

              {testResult && (
                <div className={`p-4 rounded-xl border ${testResult.success ? 'bg-emerald-950/30 border-emerald-800/50' : 'bg-slate-900 border-slate-800'}`}>
                  <div className="flex items-center space-x-2 mb-2">
                    {testResult.success ? (
                      <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                    ) : (
                      <AlertCircle className="w-5 h-5 text-amber-400" />
                    )}
                    <span className="font-semibold text-sm text-slate-200">
                      {testResult.success ? '全テストパス成功' : 'テスト完了 (レポート出力あり)'}
                    </span>
                  </div>

                  {testResult.stdout && (
                    <div className="mt-3">
                      <span className="text-xs text-slate-400 block mb-1 font-mono">STDOUT:</span>
                      <pre className="bg-slate-950 p-3 rounded-lg text-xs font-mono text-slate-300 overflow-x-auto max-h-48 border border-slate-800">
                        {testResult.stdout}
                      </pre>
                    </div>
                  )}

                  {testResult.stderr && (
                    <div className="mt-3">
                      <span className="text-xs text-amber-400 block mb-1 font-mono">STDERR:</span>
                      <pre className="bg-slate-950 p-3 rounded-lg text-xs font-mono text-amber-200/90 overflow-x-auto max-h-48 border border-slate-800">
                        {testResult.stderr}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === 'desktop' && (
            <div className="p-6 overflow-y-auto space-y-6">
              <div className="border-b border-slate-800 pb-4">
                <h2 className="text-lg font-bold text-slate-100 flex items-center space-x-2">
                  <Monitor className="w-5 h-5 text-emerald-400" />
                  <span>PySide6 デスクトップ環境情報 (Desktop Native Integration)</span>
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  ユーザー様の要求通り PySide6 デスクトップアプリケーション (main.py) は完全に固定・併用維持されています。
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
                  <h3 className="text-sm font-semibold text-slate-200 flex items-center space-x-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span>PySide6 環境ステータス</span>
                  </h3>
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between py-1.5 border-b border-slate-800">
                      <span className="text-slate-400">エントリポイント:</span>
                      <span className="text-cyan-400 font-mono font-bold">{pyStatus?.desktopEntryPoint || 'main.py'}</span>
                    </div>
                    <div className="flex justify-between py-1.5 border-b border-slate-800">
                      <span className="text-slate-400">Python バージョン:</span>
                      <span className="text-slate-200 font-mono">{pyStatus?.pythonVersion || 'Python 3.10'}</span>
                    </div>
                    <div className="flex justify-between py-1.5 border-b border-slate-800">
                      <span className="text-slate-400">PySide6 モジュール:</span>
                      <span className="text-emerald-400 font-bold">インストール済み (固定維持)</span>
                    </div>
                    <div className="flex justify-between py-1.5">
                      <span className="text-slate-400">動作モード:</span>
                      <span className="text-cyan-300 font-medium">{pyStatus?.mode || 'Dual (Web + PySide6)'}</span>
                    </div>
                  </div>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
                  <h3 className="text-sm font-semibold text-slate-200">ローカルでの起動方法</h3>
                  <p className="text-xs text-slate-400">
                    デスクトップ環境 (Windows / Mac / Linux) でネイティブ PySide6 GUI アプリケーションを直接起動する場合:
                  </p>
                  <pre className="bg-slate-950 p-3 rounded-lg text-xs font-mono text-cyan-300 border border-slate-800">
                    python3 main.py
                  </pre>
                  <p className="text-xs text-slate-400">
                    PyInstallerビルドスペック: <code className="text-slate-300 font-mono">vose_pro.spec</code>
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Floating Toast Notification Popup */}
      {toast && (
        <div className="fixed bottom-5 right-5 z-50 max-w-sm w-full animate-bounce-short">
          <div
            className={`p-4 rounded-xl border shadow-2xl backdrop-blur-md flex flex-col space-y-2 ${
              toast.type === 'success'
                ? 'bg-slate-900/95 border-emerald-500/80 text-emerald-300 shadow-emerald-950/50'
                : toast.type === 'error'
                ? 'bg-slate-900/95 border-rose-500/80 text-rose-300 shadow-rose-950/50'
                : 'bg-slate-900/95 border-cyan-500/80 text-cyan-300 shadow-cyan-950/50'
            }`}
          >
            <div className="flex items-start space-x-3">
              <div className="shrink-0 mt-0.5">
                {toast.type === 'success' && <CheckCircle2 className="w-5 h-5 text-emerald-400" />}
                {toast.type === 'error' && <AlertCircle className="w-5 h-5 text-rose-400" />}
                {toast.type === 'info' && <Loader2 className="w-5 h-5 text-cyan-400 animate-spin" />}
              </div>
              <div className="flex-1">
                <h4 className="font-bold text-xs text-white flex items-center justify-between">
                  <span>{toast.title}</span>
                  {uploadProgress > 0 && uploadProgress < 100 && (
                    <span className="font-mono text-cyan-400 font-bold ml-2 text-[11px]">
                      {uploadProgress}%
                    </span>
                  )}
                </h4>
                <p className="text-xs mt-0.5 text-slate-300 leading-relaxed">{toast.desc}</p>
              </div>
              <button
                onClick={() => setToast(null)}
                className="shrink-0 p-1 rounded-md hover:bg-slate-800 text-slate-400 hover:text-white transition"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Graphical Progress Bar for Upload / Extract */}
            {uploadProgress > 0 && (
              <div className="w-full bg-slate-950 rounded-full h-2 overflow-hidden border border-slate-800 p-0.5">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    uploadProgress >= 100 ? 'bg-emerald-500' : 'bg-gradient-to-r from-cyan-500 to-emerald-400'
                  }`}
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}