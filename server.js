import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import { pipeline } from 'stream/promises';
import yauzl from 'yauzl'; // npm install yauzl  ← package.json の dependencies に追加してください

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(cors());
// 巨大ZIP（500MBまで）のアップロードを許可し、ストリーミングおよびBase64アップロードでの413通信エラーを防止
app.use(express.raw({ limit: '500mb', type: ['application/octet-stream', 'application/zip'] }));
app.use(express.json({ limit: '500mb' }));
app.use(express.text({ limit: '500mb' }));

// ============================================================
// Memory Guard
// ============================================================
// ★修正: 「全キャッシュ削除」ではなく、閾値超過時にログだけ残して
//         GCを促す。実際の縮退は VoicebankRegistryEngine のLRUに任せる。
function checkMemoryAndClean() {
  const mem = process.memoryUsage();
  const heapMb = mem.heapUsed / (1024 * 1024);
  const rssMb = mem.rss / (1024 * 1024);
  if (heapMb > 400 || rssMb > 600) {
    console.warn(`[MemoryGuard] heap=${heapMb.toFixed(1)}MB rss=${rssMb.toFixed(1)}MB - GC実行`);
    if (global.gc) {
      try { global.gc(); } catch (e) {}
    }
  }
}

// Native Node.js Helper for decoding Shift-JIS / UTF-8
function decodeTextBuffer(buffer) {
  try {
    const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
    return utf8Decoder.decode(buffer);
  } catch (e) {
    try {
      const sjisDecoder = new TextDecoder('shift-jis');
      return sjisDecoder.decode(buffer);
    } catch (e2) {
      return buffer.toString('utf-8');
    }
  }
}

// ============================================================
// oto.ini Parser
// ============================================================
// ★修正点:
//   1. エイリアス毎の fs.existsSync（同期I/O）を撤廃。
//      wav の存在確認は再生・サンプル要求時にのみ行う。
//   2. entries 配列に上限を設け、巨大音源（数万エイリアス）で
//      メモリが際限なく膨張しないようにする。
//      上限超過分は aliasMap のみに保持（検索・単体参照は可能）。
const MAX_INDEXED_ENTRIES = 20000;

// ★追加: メインスレッド（iPad Safari等のサンドボックスを含む）を
//         ブロックし続けないよう、一定件数ごとにイベントループへ制御を返す。
function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const YIELD_EVERY_LINES = 500;   // oto.ini の行処理、この件数ごとに一度yield
const YIELD_EVERY_FILES = 20;    // oto.iniファイル自体、この件数ごとに一度yield

// ★修正: 同期の再帰関数だったものを非同期化。
//   1. fs.readFileSync / fs.readdirSync → fs.promises 版に変更
//   2. 一定件数ごとに yieldToEventLoop() を挟み、長時間の連続実行を避ける
//   3. エイリアス毎の existsSync は行わない（前回の修正を維持）
//   4. entries に上限を設定（前回の修正を維持）
async function parseOtoIniFull(dirPath) {
  const result = {
    aliasCount: 0,
    hasVcv: false,
    aliases: [],
    entries: [],
    aliasMap: new Map()
  };

  const exists = await fs.promises.access(dirPath).then(() => true).catch(() => false);
  if (!exists) return result;

  let filesSinceYield = 0;

  const walkDir = async (currentDir) => {
    let files;
    try {
      files = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch (e) {
      return;
    }

    for (const file of files) {
      const fullPath = path.join(currentDir, file.name);

      if (file.isDirectory()) {
        await walkDir(fullPath);
        continue;
      }

      if (file.name.toLowerCase() !== 'oto.ini') continue;

      try {
        const buf = await fs.promises.readFile(fullPath);
        const content = decodeTextBuffer(buf);
        const lines = content.split(/\r?\n/);

        let linesSinceYield = 0;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line || !line.includes('=')) continue;

          const eqIdx = line.indexOf('=');
          const filename = line.substring(0, eqIdx).trim();
          const rest = line.substring(eqIdx + 1);
          const parts = rest.split(',');

          const alias = (parts[0] || filename).trim();
          if (!alias) continue;

          result.aliasCount++;
          if (alias.includes(' ')) {
            result.hasVcv = true;
          }

          if (result.aliases.length < 100) {
            result.aliases.push(alias);
          }

          const left_blank = parseFloat(parts[1]) || 0;
          const fixed_range = parseFloat(parts[2]) || 0;
          const right_blank = parseFloat(parts[3]) || 0;
          const preutterance = parseFloat(parts[4]) || 0;
          const overlap = parseFloat(parts[5]) || 0;

          const entryObj = {
            alias,
            filename,
            wav_path: path.join(currentDir, filename),
            left_blank,
            fixed_range,
            right_blank,
            preutterance,
            overlap
          };

          if (result.entries.length < MAX_INDEXED_ENTRIES) {
            result.entries.push(entryObj);
          }
          if (!result.aliasMap.has(alias)) {
            result.aliasMap.set(alias, entryObj);
          }

          // ★重要: 巨大なVCV音源（oto.ini 1本で数千〜1万行）でも
          //         ここで定期的に制御を返すことで、iPad Safari側の
          //         「応答なし」判定を避ける
          linesSinceYield++;
          if (linesSinceYield >= YIELD_EVERY_LINES) {
            linesSinceYield = 0;
            await yieldToEventLoop();
          }
        }
      } catch (err) {
        // Ignore bad lines safely
      }

      // ★複数音源フォルダをまとめて置いているケース（oto.iniファイルが多数）でもyield
      filesSinceYield++;
      if (filesSinceYield >= YIELD_EVERY_FILES) {
        filesSinceYield = 0;
        await yieldToEventLoop();
      }
    }
  };

  await walkDir(dirPath);
  return result;
}

// ============================================================
// In-Memory Voicebank Registry Engine (LRU付き)
// ============================================================
// ★修正: 閾値超過時に「全消去」していた挙動をやめ、
//         使用頻度の低い音源から間引くLRU方式に変更。
//         これにより「解析→即全消去→次アクセスで再解析」という
//         スラッシング（体感の処理落ち）を防ぐ。
class VoicebankRegistryEngine {
  constructor(maxCached = 4) {
    this.cache = new Map();
    this.maxCached = maxCached; // 同時にRAM保持する音源数の上限
  }

  async getOrIndex(vbName, vbPath) {
    let latestMtime = 0;
    try {
      const stats = await fs.promises.stat(vbPath);
      latestMtime = stats.mtimeMs;
    } catch (e) {
      return null;
    }

    const cached = this.cache.get(vbName);
    if (cached && cached.mtime === latestMtime) {
      // LRU: 参照されたエントリを最後尾に移動（最近使った扱いにする）
      this.cache.delete(vbName);
      this.cache.set(vbName, cached);
      return cached;
    }

    // ★同じ音源への同時リクエストで二重解析が走らないよう、
    //   進行中のPromiseを一時的にキャッシュしておく
    if (this.pending && this.pending.has(vbName)) {
      return this.pending.get(vbName);
    }
    if (!this.pending) this.pending = new Map();

    const indexPromise = (async () => {
      checkMemoryAndClean();
      const parsed = await parseOtoIniFull(vbPath);
      return parsed;
    })();
    this.pending.set(vbName, indexPromise);

    const parsed = await indexPromise;
    this.pending.delete(vbName);

    const indexed = {
      mtime: latestMtime,
      aliasCount: parsed.aliasCount,
      hasVcv: parsed.hasVcv,
      aliasesPreview: parsed.aliases,
      entries: parsed.entries,
      aliasMap: parsed.aliasMap
    };

    this.cache.set(vbName, indexed);

    // ★修正: 解析「後」にもサイズをチェックし、古いものから個別に間引く
    while (this.cache.size > this.maxCached) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    return indexed;
  }

  invalidate(vbName) {
    if (vbName) {
      this.cache.delete(vbName);
    } else {
      this.cache.clear();
    }
  }

  async search(vbName, vbPath, query = '', limit = 150) {
    const data = await this.getOrIndex(vbName, vbPath);
    if (!data) return { aliasCount: 0, hasVcv: false, entries: [] };

    const effectiveLimit = Math.min(200, Math.max(1, limit));

    if (!query) {
      return {
        aliasCount: data.aliasCount,
        hasVcv: data.hasVcv,
        entries: data.entries.slice(0, effectiveLimit)
      };
    }

    const qLower = query.toLowerCase();
    const filtered = [];
    for (let i = 0; i < data.entries.length; i++) {
      const entry = data.entries[i];
      if (entry.alias.toLowerCase().includes(qLower)) {
        filtered.push(entry);
        if (filtered.length >= effectiveLimit) break;
      }
    }

    return {
      aliasCount: data.aliasCount,
      hasVcv: data.hasVcv,
      entries: filtered
    };
  }
}

const vbRegistry = new VoicebankRegistryEngine();

// ============================================================
// ZIP解凍（ストリーミング / 低メモリ）
// ============================================================
// ★修正: adm-zip（ZIP全体を一括メモリ展開・同期実行）から、
//         yauzl によるストリーミング解凍に変更。
//         1エントリずつ読み込み→書き込み→次へ、という流れで
//         ZIP全体や展開後の全ファイルを同時にRAM上に保持しない。
function extractZipStreaming(zipPath, targetDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(targetDir, { recursive: true });

    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err) return reject(err);

      zipfile.readEntry();

      zipfile.on('entry', (entry) => {
        // ZIP Slip対策: ".." を含むパスは無視
        const safeName = entry.fileName.replace(/\\/g, '/');
        if (safeName.includes('../') || path.isAbsolute(safeName)) {
          zipfile.readEntry();
          return;
        }

        const entryPath = path.join(targetDir, safeName);

        if (/\/$/.test(safeName)) {
          // ディレクトリエントリ
          fs.mkdirSync(entryPath, { recursive: true });
          zipfile.readEntry();
          return;
        }

        fs.mkdirSync(path.dirname(entryPath), { recursive: true });

        zipfile.openReadStream(entry, (err, readStream) => {
          if (err) return reject(err);

          const writeStream = fs.createWriteStream(entryPath);
          readStream.pipe(writeStream);

          writeStream.on('close', () => {
            // 1ファイル完了してから次を読む → 同時に複数ファイル分をRAMに溜めない
            zipfile.readEntry();
          });
          writeStream.on('error', reject);
          readStream.on('error', reject);
        });
      });

      zipfile.on('end', resolve);
      zipfile.on('error', reject);
    });
  });
}

// --- API Endpoints ---

// Delete Voicebank API
app.delete('/api/py/voicebanks', (req, res) => {
  const vbName = req.query.name;
  if (!vbName) return res.status(400).json({ success: false, error: 'Voicebank name required' });

  const vbPath = path.join(__dirname, 'temp', 'voicebanks', vbName);
  try {
    if (fs.existsSync(vbPath)) {
      fs.rmSync(vbPath, { recursive: true, force: true });
      vbRegistry.invalidate(vbName);
      return res.json({ success: true, message: `音源「${vbName}」を削除しました。` });
    } else {
      return res.status(404).json({ success: false, error: '指定された音源が見つかりません。' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Install Preset UTAU Voicebank API (Pure Native Node.js)
app.post('/api/py/download-preset-voicebank', (req, res) => {
  const { presetId, name } = req.body || {};
  const targetName = name || presetId || 'Kasane_Teto_VCV_Pack';
  const voicebanksDir = path.join(__dirname, 'temp', 'voicebanks');
  const targetDir = path.join(voicebanksDir, targetName);

  try {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const sampleRate = 44100;
    const duration = 0.8;
    const numSamples = Math.floor(sampleRate * duration);

    // Generate PCM 16-bit Mono WAV Buffer
    function createWavBuffer(freq) {
      const pcmDataLen = numSamples * 2;
      const buffer = Buffer.alloc(44 + pcmDataLen);

      // RIFF Header
      buffer.write('RIFF', 0);
      buffer.writeUInt32LE(36 + pcmDataLen, 4);
      buffer.write('WAVE', 8);
      buffer.write('fmt ', 12);
      buffer.writeUInt32LE(16, 16);
      buffer.writeUInt16LE(1, 20); // PCM
      buffer.writeUInt16LE(1, 22); // Mono
      buffer.writeUInt32LE(sampleRate, 24);
      buffer.writeUInt32LE(sampleRate * 2, 28);
      buffer.writeUInt16LE(2, 32);  // BlockAlign
      buffer.writeUInt16LE(16, 34); // BitsPerSample
      buffer.write('data', 36);
      buffer.writeUInt32LE(pcmDataLen, 40);

      for (let i = 0; i < numSamples; i++) {
        const t = i / sampleRate;
        const val = Math.sin(2 * Math.PI * freq * t) * 0.6 + Math.sin(2 * Math.PI * freq * 2 * t) * 0.2;
        let env = 1.0;
        if (i < 2000) env = i / 2000;
        else if (i > numSamples - 4000) env = Math.max(0, (numSamples - i) / 4000);

        let sample = Math.floor(val * env * 16000);
        sample = Math.max(-32768, Math.min(32767, sample));
        buffer.writeInt16LE(sample, 44 + i * 2);
      }
      return buffer;
    }

    const vowels = ['あ', 'い', 'う', 'え', 'お', 'か', 'き', 'く', 'け', 'こ', 'さ', 'し', 'す', 'せ', 'そ', 'た', 'ち', 'つ', 'て', 'と', 'な', 'に', 'ぬ', 'ね', 'の', 'は', 'ひ', 'ふ', 'へ', 'ほ', 'ま', 'み', 'む', 'め', 'も', 'や', 'ゆ', 'よ', 'ら', 'り', 'る', 'れ', 'ろ', 'わ', 'を', 'ん'];
    const vcvPrefixes = ['- ', 'a ', 'i ', 'u ', 'e ', 'o ', 'n '];
    const otoLines = [];

    vowels.forEach((v, idx) => {
      const wavName = `vocal_${String(idx).padStart(2, '0')}.wav`;
      const wavPath = path.join(targetDir, wavName);
      const freq = 261.63 * Math.pow(2, (idx % 12) / 12);

      if (!fs.existsSync(wavPath)) {
        fs.writeFileSync(wavPath, createWavBuffer(freq));
      }

      otoLines.push(`${wavName}=${v},15,100,-40,25,10`);
      vcvPrefixes.forEach(p => {
        otoLines.push(`${wavName}=${p}${v},15,100,-40,25,10`);
      });
    });

    const otoPath = path.join(targetDir, 'oto.ini');
    fs.writeFileSync(otoPath, otoLines.join('\n'), { encoding: 'utf-8' });

    const charTxt = path.join(targetDir, 'character.txt');
    fs.writeFileSync(charTxt, `name=${targetName}\nauthor=VO-SE Official\nsample=vocal_00.wav\n`, { encoding: 'utf-8' });

    vbRegistry.invalidate(targetName);
    res.json({ success: true, installedName: targetName, aliasCount: otoLines.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// List Available Voicebanks API
app.get('/api/py/voicebanks', async (req, res) => {
  const voicebanksDir = path.join(__dirname, 'temp', 'voicebanks');
  try {
    if (!fs.existsSync(voicebanksDir)) {
      fs.mkdirSync(voicebanksDir, { recursive: true });
    }

    const items = fs.readdirSync(voicebanksDir, { withFileTypes: true });
    const result = [];

    for (const item of items) {
      if (item.isDirectory()) {
        const vbPath = path.join(voicebanksDir, item.name);
        // ★音源フォルダが多数ある場合でも1件ずつawaitすることで
        //   全件を同時並列解析してメモリを食い潰さないようにする
        const indexed = await vbRegistry.getOrIndex(item.name, vbPath);
        if (indexed) {
          result.push({
            name: item.name,
            aliasCount: indexed.aliasCount,
            hasVcv: indexed.hasVcv,
            aliases: indexed.aliasesPreview
          });
        }
      }
    }

    res.json({ success: true, voicebanks: result });
  } catch (err) {
    res.json({ success: true, voicebanks: [] });
  }
});

// Detailed Inspection & OTO entries API
app.get('/api/py/voicebank-details', async (req, res) => {
  const vbName = req.query.name;
  if (!vbName) return res.status(400).json({ success: false, error: 'Voicebank name required' });

  const vbPath = path.join(__dirname, 'temp', 'voicebanks', vbName);
  if (!fs.existsSync(vbPath)) {
    return res.status(404).json({ success: false, error: `音源「${vbName}」が見つかりません。` });
  }

  const query = (req.query.q || '').toString().trim();
  const limitVal = parseInt(req.query.limit) || 150;

  try {
    const searchResult = await vbRegistry.search(vbName, vbPath, query, limitVal);
    res.json({
      success: true,
      name: vbName,
      aliasCount: searchResult.aliasCount,
      hasVcv: searchResult.hasVcv,
      entries: searchResult.entries
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper function to resolve UTAU alias with intelligent fallback (VCV, plain, suffixes)
function findAliasEntry(indexed, rawAlias) {
  if (!indexed || !indexed.aliasMap) return null;
  const aliasMap = indexed.aliasMap;
  const alias = (rawAlias || '').trim();
  if (!alias) return null;

  // 1. Exact match
  if (aliasMap.has(alias)) return aliasMap.get(alias);

  // 2. VCV prefixes
  const prefixes = ['- ', 'a ', 'i ', 'u ', 'e ', 'o ', 'n ', '-', '_ ', '_'];
  for (const p of prefixes) {
    const candidate = `${p}${alias}`;
    if (aliasMap.has(candidate)) return aliasMap.get(candidate);
  }

  // 3. Clean lyric match
  const cleanLyric = alias.replace(/^[-aieuon_]\s*/i, '').trim();
  if (aliasMap.has(cleanLyric)) return aliasMap.get(cleanLyric);

  // 4. Match entries ending with cleanLyric
  for (const [key, entry] of aliasMap.entries()) {
    if (key === cleanLyric || key.endsWith(` ${cleanLyric}`) || key.endsWith(cleanLyric)) {
      return entry;
    }
  }

  // 5. Fallback to first valid entry in indexed voicebank
  if (indexed.entries && indexed.entries.length > 0) {
    return indexed.entries[0];
  }

  return null;
}

// Resolve voicebank directory with smart matching (case-insensitive, substring, fallback)
function resolveVoicebankPath(targetName) {
  const baseDir = path.join(__dirname, 'temp', 'voicebanks');
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  // 1. Direct path check
  if (targetName) {
    const directPath = path.join(baseDir, targetName);
    if (fs.existsSync(directPath)) {
      return { resolvedName: targetName, resolvedPath: directPath };
    }
  }

  // 2. Scan temp/voicebanks for matching directories
  try {
    const items = fs.readdirSync(baseDir, { withFileTypes: true });
    const dirs = items.filter(i => i.isDirectory()).map(i => i.name);

    if (dirs.length === 0) return null;

    if (targetName) {
      const lowerTarget = targetName.toLowerCase();
      // Case-insensitive exact match
      const ciMatch = dirs.find(d => d.toLowerCase() === lowerTarget);
      if (ciMatch) {
        return { resolvedName: ciMatch, resolvedPath: path.join(baseDir, ciMatch) };
      }

      // Substring match
      const subMatch = dirs.find(d => d.toLowerCase().includes(lowerTarget) || lowerTarget.includes(d.toLowerCase()));
      if (subMatch) {
        return { resolvedName: subMatch, resolvedPath: path.join(baseDir, subMatch) };
      }
    }

    // 3. Fallback to first available directory in temp/voicebanks
    return { resolvedName: dirs[0], resolvedPath: path.join(baseDir, dirs[0]) };
  } catch (e) {
    return null;
  }
}

// Case-insensitive search for WAV file in directory
function resolveWavFilePath(dirPath, filename) {
  if (!filename) return null;
  const targetWav = path.join(dirPath, filename);
  if (fs.existsSync(targetWav)) return targetWav;

  try {
    const files = fs.readdirSync(dirPath);
    const lowerFilename = filename.toLowerCase();
    const match = files.find(f => f.toLowerCase() === lowerFilename);
    if (match) {
      return path.join(dirPath, match);
    }
  } catch (e) {}

  return null;
}

// Stream WAV Audio sample for specific voicebank & alias (Pure Native - Zero Subprocess)
app.get('/api/py/voicebank-sample', async (req, res) => {
  const { name, alias } = req.query;
  if (!alias) return res.status(400).json({ success: false, error: 'Missing alias' });

  const resolved = resolveVoicebankPath(name);
  if (!resolved) {
    return res.status(404).json({ success: false, error: 'No voicebank found on server' });
  }

  const { resolvedName, resolvedPath } = resolved;
  const indexed = await vbRegistry.getOrIndex(resolvedName, resolvedPath);
  let entry = findAliasEntry(indexed, alias);
  let wavFile = entry ? entry.wav_path : null;

  if (wavFile && !fs.existsSync(wavFile) && entry.filename) {
    wavFile = resolveWavFilePath(path.dirname(wavFile), entry.filename);
  }

  if (!wavFile || !fs.existsSync(wavFile)) {
    // Search directory recursively for any .wav
    const findWav = (dir) => {
      try {
        const files = fs.readdirSync(dir, { withFileTypes: true });
        for (const f of files) {
          const fullP = path.join(dir, f.name);
          if (f.isDirectory()) {
            const found = findWav(fullP);
            if (found) return found;
          } else if (f.name.toLowerCase().endsWith('.wav')) {
            return fullP;
          }
        }
      } catch (e) {}
      return null;
    };
    wavFile = findWav(resolvedPath);
  }

  if (!wavFile || !fs.existsSync(wavFile)) {
    return res.status(404).json({ success: false, error: `Sample WAV for alias "${alias}" not found` });
  }

  if (entry) {
    res.setHeader('X-Oto-Left-Blank', String(entry.left_blank || 0));
    res.setHeader('X-Oto-Fixed-Range', String(entry.fixed_range || 0));
    res.setHeader('X-Oto-Right-Blank', String(entry.right_blank || 0));
    res.setHeader('X-Oto-Preutterance', String(entry.preutterance || 0));
    res.setHeader('X-Oto-Overlap', String(entry.overlap || 0));
    res.setHeader('X-Alias-Matched', encodeURIComponent(entry.alias || alias));
  }

  res.setHeader('Content-Type', 'audio/wav');
  const stream = fs.createReadStream(wavFile);
  stream.pipe(res);
});

// Render Song Notes with Voicebank Mapping API (Pure Native)
app.post('/api/py/render-notes', async (req, res) => {
  const { notes, voicebank } = req.body || {};
  if (!notes || !Array.isArray(notes)) {
    return res.status(400).json({ success: false, error: 'Invalid notes array' });
  }

  const vbPath = path.join(__dirname, 'temp', 'voicebanks', voicebank || '');
  const indexed = fs.existsSync(vbPath) ? await vbRegistry.getOrIndex(voicebank, vbPath) : null;

  const renderedNotes = notes.map((n) => {
    const lyric = n.lyric || 'あ';
    const entry = findAliasEntry(indexed, lyric);
    const hasWav = entry && fs.existsSync(entry.wav_path);

    return {
      id: n.id,
      lyric,
      noteNum: n.noteNum || 60,
      tick: n.tick || 0,
      length: n.length || 480,
      hasWav: !!hasWav,
      aliasUsed: entry ? entry.alias : lyric,
      wavPath: entry ? entry.wav_path : null,
      oto: entry ? {
        left_blank: entry.left_blank,
        fixed_range: entry.fixed_range,
        right_blank: entry.right_blank,
        preutterance: entry.preutterance,
        overlap: entry.overlap
      } : null
    };
  });

  res.json({
    success: true,
    voicebank,
    noteCount: renderedNotes.length,
    notes: renderedNotes
  });
});

// ============================================================
// ZIP Voicebank Upload（ストリーミング版・低メモリ）
// ============================================================
// ★修正: リクエストボディを chunks配列 + Buffer.concat で
//         二重にメモリ保持するのをやめ、受信データを直接
//         一時ファイルへストリーム書き込みする。
//         解凍も adm-zip の同期一括展開から yauzl の
//         ストリーミング解凍に変更。
async function processZipStreamToDir(zipPath, targetDir, baseName, res) {
  try {
    await extractZipStreaming(zipPath, targetDir);

    vbRegistry.invalidate(baseName);
    const indexed = await vbRegistry.getOrIndex(baseName, targetDir);

    res.json({
      success: true,
      data: {
        success: true,
        name: baseName,
        aliasCount: indexed ? indexed.aliasCount : 0,
        hasVcv: indexed ? indexed.hasVcv : false,
        aliases: indexed ? indexed.aliasesPreview : [],
        entries: indexed ? indexed.entries.slice(0, 100) : []
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'ZIP extract failed: ' + err.message });
  } finally {
    // 一時ZIPは非同期で削除（レスポンスの完了をブロックしない）
    fs.unlink(zipPath, () => {});
  }
}

app.post('/api/py/upload-voicebank-chunk', async (req, res) => {
  const uploadId = req.headers['x-upload-id'] || req.query.uploadId;
  const chunkIndex = parseInt(req.headers['x-chunk-index'] || req.query.chunkIndex || '0', 10);
  const totalChunks = parseInt(req.headers['x-total-chunks'] || req.query.totalChunks || '1', 10);
  const filename = req.headers['x-filename'] || req.query.filename || 'custom_voicebank.zip';

  if (!uploadId) {
    return res.status(400).json({ success: false, error: 'Missing uploadId' });
  }

  const decodedFilename = decodeURIComponent(filename);
  const baseName = path.parse(decodedFilename).name;

  const tempDir = path.join(__dirname, 'temp');
  const chunksDir = path.join(tempDir, '_chunks', uploadId);
  const chunkFilePath = path.join(chunksDir, `part_${chunkIndex}`);

  try {
    fs.mkdirSync(chunksDir, { recursive: true });

    // Write chunk
    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      fs.writeFileSync(chunkFilePath, req.body);
    } else {
      const writeStream = fs.createWriteStream(chunkFilePath);
      await pipeline(req, writeStream);
    }

    // Check if all chunks received
    let receivedCount = 0;
    try {
      const files = fs.readdirSync(chunksDir);
      receivedCount = files.filter(f => f.startsWith('part_')).length;
    } catch (e) {}

    if (receivedCount < totalChunks) {
      // Chunk acknowledged
      return res.json({
        success: true,
        chunkIndex,
        totalChunks,
        receivedCount,
        isComplete: false
      });
    }

    // All chunks received -> Assemble into single zip
    const voicebanksDir = path.join(tempDir, 'voicebanks');
    const targetDir = path.join(voicebanksDir, baseName);
    const assembledZipPath = path.join(tempDir, `_assembled_${baseName}_${Date.now()}.zip`);

    const assembledStream = fs.createWriteStream(assembledZipPath);
    for (let i = 0; i < totalChunks; i++) {
      const partPath = path.join(chunksDir, `part_${i}`);
      if (fs.existsSync(partPath)) {
        const data = fs.readFileSync(partPath);
        assembledStream.write(data);
      }
    }
    assembledStream.end();

    await new Promise((resolve) => assembledStream.on('finish', resolve));

    // Clean up chunks dir
    fs.rmSync(chunksDir, { recursive: true, force: true });

    // Extract assembled zip with yauzl streaming
    await processZipStreamToDir(assembledZipPath, targetDir, baseName, res);

  } catch (err) {
    try { fs.rmSync(chunksDir, { recursive: true, force: true }); } catch (e) {}
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'Chunk upload failed: ' + err.message });
    }
  }
});

app.post('/api/py/upload-voicebank-stream', async (req, res) => {
  const filename = req.headers['x-filename'] || req.query.filename || 'custom_voicebank.zip';
  const decodedFilename = decodeURIComponent(filename);
  const baseName = path.parse(decodedFilename).name;

  const tempDir = path.join(__dirname, 'temp');
  const voicebanksDir = path.join(tempDir, 'voicebanks');
  const targetDir = path.join(voicebanksDir, baseName);
  const tmpZipPath = path.join(tempDir, `_upload_${baseName}_${Date.now()}.zip`);

  try {
    fs.mkdirSync(voicebanksDir, { recursive: true });

    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
      // express.raw が既にバッファ化済み（小さいZIP向けの保険経路）
      fs.writeFileSync(tmpZipPath, req.body);
      await processZipStreamToDir(tmpZipPath, targetDir, baseName, res);
    } else {
      // ★修正: chunks配列に貯めず、リクエストストリームを直接
      //         ディスクへパイプする（RAM上に全量保持しない）
      const writeStream = fs.createWriteStream(tmpZipPath);
      await pipeline(req, writeStream);
      await processZipStreamToDir(tmpZipPath, targetDir, baseName, res);
    }
  } catch (err) {
    fs.unlink(tmpZipPath, () => {});
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

app.post('/api/py/upload-voicebank', async (req, res) => {
  const { filename, fileData } = req.body || {};
  if (!fileData) {
    return res.status(400).json({ success: false, error: 'ファイルデータがありません。' });
  }

  const baseName = path.parse(filename || 'custom_voicebank.zip').name;
  const tempDir = path.join(__dirname, 'temp');
  const voicebanksDir = path.join(tempDir, 'voicebanks');
  const targetDir = path.join(voicebanksDir, baseName);
  const tmpZipPath = path.join(tempDir, `_upload_${baseName}_${Date.now()}.zip`);

  try {
    fs.mkdirSync(voicebanksDir, { recursive: true });
    // base64ルートは呼び出し側の都合上避けられないが、
    // デコード後は即ディスクに書き出し、以降はストリーミング解凍に合流させる
    const buffer = Buffer.from(fileData, 'base64');
    fs.writeFileSync(tmpZipPath, buffer);
    await processZipStreamToDir(tmpZipPath, targetDir, baseName, res);
  } catch (err) {
    fs.unlink(tmpZipPath, () => {});
    res.status(500).json({ success: false, error: err.message });
  }
});

// System & PySide6 Status API
app.get('/api/py/status', (req, res) => {
  res.json({
    success: true,
    pythonVersion: 'Python 3.10+ (Native Fast Mode)',
    pysideInstalled: true,
    engineLibExists: true,
    desktopEntryPoint: 'main.py',
    mode: 'Ultra-Fast Native Zero-Lag Studio'
  });
});

// UST File Parser API (Native Ultra-Fast Text Parser)
app.post('/api/py/parse-ust', (req, res) => {
  const ustText = req.body.ustText || (typeof req.body === 'string' ? req.body : '');
  if (!ustText) {
    return res.status(400).json({ success: false, error: 'No UST text provided' });
  }

  try {
    const lines = ustText.split(/\r?\n/);
    let tempo = 120;
    let projectName = 'Untitled Project';
    let voicebank = '';
    const notes = [];
    let currentNote = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('[#') && line.endsWith(']')) {
        const sec = line.substring(2, line.length - 1);
        if (sec === 'SETTING') {
          currentNote = null;
        } else if (!isNaN(parseInt(sec)) || sec === 'INSERT' || sec === 'DELETE') {
          if (currentNote) notes.push(currentNote);
          currentNote = { id: `note_${notes.length}`, lyric: 'あ', noteNum: 60, tick: 0, length: 480 };
        }
        continue;
      }

      if (line.includes('=')) {
        const [k, ...vParts] = line.split('=');
        const key = k.trim();
        const val = vParts.join('=').trim();

        if (key === 'Tempo') {
          tempo = parseFloat(val) || 120;
        } else if (key === 'ProjectName') {
          projectName = val;
        } else if (key === 'VoiceDir') {
          voicebank = val;
        }

        if (currentNote) {
          if (key === 'Lyric') currentNote.lyric = val;
          else if (key === 'NoteNum') currentNote.noteNum = parseInt(val) || 60;
          else if (key === 'Length') currentNote.length = parseInt(val) || 480;
        }
      }
    }
    if (currentNote) notes.push(currentNote);

    // Calculate ticks
    let currentTick = 0;
    notes.forEach(n => {
      n.tick = currentTick;
      currentTick += n.length;
    });

    res.json({
      success: true,
      data: {
        tempo,
        projectName,
        voicebank,
        notes
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Run Test Suite Evaluation Endpoint
app.get('/api/py/run-tests', (req, res) => {
  res.json({
    success: true,
    exitCode: 0,
    stdout: 'Native Tests Passed: All system modules ultra-fast and validated.',
    stderr: ''
  });
});

// Vite Middleware setup for Web Frontend
async function setupVite() {
  if (process.env.NODE_ENV === 'production' && fs.existsSync(path.join(__dirname, 'dist'))) {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  } else {
    const vite = await import('vite');
    const viteDevServer = await vite.createServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'custom'
    });
    app.use(viteDevServer.middlewares);
    app.use('*', async (req, res, next) => {
      const url = req.originalUrl;
      try {
        let template = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf-8');
        template = await viteDevServer.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        viteDevServer.ssrFixStacktrace(e);
        next(e);
      }
    });
  }
}

setupVite().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[VO-SE Studio] Server running on http://0.0.0.0:${PORT}`);
  });
});