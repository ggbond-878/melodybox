// ================================================================
//  MelodyBox — 音乐播放器前端核心与沉浸式交互层 (终极解耦版)
// ================================================================

// ================================================================
//  NetEase Cloud Music API — 常量与工具
// ================================================================
const NETEASE_API = 'http://localhost:3000';
const COOKIE_KEY = 'melodybox_netease_cookie';

function getCookie() { try { return localStorage.getItem(COOKIE_KEY) || ''; } catch(e) { return ''; } }
function setCookie(c) { try { localStorage.setItem(COOKIE_KEY, c); } catch(e) {} }
function clearCookie() { try { localStorage.removeItem(COOKIE_KEY); } catch(e) {} }

/** 将网易云 track 对象映射为 MelodyBox song 格式 */
function mapNeteaseSong(track) {
  return {
    id: 'ne_' + track.id,
    neteaseId: track.id,
    title: track.name || '未知歌曲',
    artist: (track.ar || []).map(a => a.name).join(' / ') || '未知艺术家',
    album: (track.al && track.al.name) || '',
    duration: Math.round((track.dt || 0) / 1000),
    coverUrl: (track.al && track.al.picUrl) ? track.al.picUrl.replace(/^http:/, 'https:') : '',
    unsupported: false
  };
}

/** 异步获取网易云歌曲播放 URL，失败返回 null */
async function resolveNeteaseUrl(songId) {
  const cookie = getCookie();
  if (!cookie) return null;
  try {
    const resp = await fetch(`${NETEASE_API}/song/url/v1?id=${songId}&level=standard&cookie=${encodeURIComponent(cookie)}`);
    const data = await resp.json();
    if (data.code === 200 && data.data && data.data[0] && data.data[0].url) {
      console.log('[MelodyBox] got stream URL:', data.data[0].url.substring(0, 80));
      return data.data[0].url;
    }
    return null;
  } catch(e) { return null; }
}

// ================================================================
//  QR 码登录系统
// ================================================================
let _loginPollTimer = null;
let _loginUnikey = null;

function openLoginModal() {
  const overlay = $('loginModalOverlay');
  if (!overlay) return;
  overlay.classList.add('on');
  refreshQr();
}

function closeLoginModal() {
  const overlay = $('loginModalOverlay');
  if (!overlay) return;
  overlay.classList.remove('on');
  stopLoginPoll();
}

async function refreshQr() {
  const qrImg = $('qrImg'), qrMask = $('qrMask'), statusEl = $('loginStatus');
  if (!qrImg || !statusEl) return;
  stopLoginPoll();
  if (qrMask) qrMask.style.display = 'none';
  statusEl.textContent = '正在生成二维码...';

  try {
    const keyResp = await fetch(`${NETEASE_API}/login/qr/key?timestamp=${Date.now()}`);
    const keyData = await keyResp.json();
    if (keyData.code !== 200 || !keyData.data.unikey) {
      statusEl.textContent = '获取二维码失败，请稍后重试';
      return;
    }
    _loginUnikey = keyData.data.unikey;

    const qrResp = await fetch(`${NETEASE_API}/login/qr/create?key=${_loginUnikey}&qrimg=true`);
    const qrData = await qrResp.json();
    if (qrData.code !== 200 || !qrData.data.qrimg) {
      statusEl.textContent = '生成二维码失败';
      return;
    }
    qrImg.src = qrData.data.qrimg;
    statusEl.textContent = '等待扫码...';
    startLoginPoll();
  } catch(e) {
    statusEl.textContent = '网络错误，请检查 API 服务';
  }
}

function startLoginPoll() {
  stopLoginPoll();
  _loginPollTimer = setInterval(async () => {
    if (!_loginUnikey) return;
    try {
      const resp = await fetch(`${NETEASE_API}/login/qr/check?key=${_loginUnikey}&timestamp=${Date.now()}`);
      const data = await resp.json();
      const statusEl = $('loginStatus');
      if (!statusEl) return;
      switch (data.code) {
        case 800:
          statusEl.textContent = '二维码已失效';
          if ($('qrMask')) $('qrMask').style.display = 'flex';
          stopLoginPoll();
          break;
        case 801:
          statusEl.textContent = '等待扫码...';
          break;
        case 802:
          statusEl.textContent = '已扫描，请在手机上确认';
          break;
        case 803:
          statusEl.textContent = '登录成功！';
          stopLoginPoll();
          setCookie(data.cookie);
          closeLoginModal();
          toast('登录成功，正在加载歌单...');
          updateLoginButtonState();
          loadNeteaseLibrary();
          break;
      }
    } catch(e) { /* 网络抖动，继续轮询 */ }
  }, 2000);
}

function stopLoginPoll() {
  if (_loginPollTimer) { clearInterval(_loginPollTimer); _loginPollTimer = null; }
}

function updateLoginButtonState() {
  const btn = $('neteaseLoginBtn');
  if (!btn) return;
  if (getCookie()) {
    btn.textContent = '✅ 已登录';
    btn.onclick = logout;
    btn.title = '点击退出登录';
  } else {
    btn.textContent = '🔐 登录网易云';
    btn.onclick = openLoginModal;
    btn.title = '登录网易云音乐账号';
  }
}

async function logout() {
  const cookie = getCookie();
  if (cookie) {
    try { await fetch(`${NETEASE_API}/logout?cookie=${encodeURIComponent(cookie)}`); } catch(e) {}
  }
  clearCookie();
  updateLoginButtonState();
  _neteasePlaylists = [];
  _playlistTracksCache = {};
  _currentPlaylistId = null;
  renderPlaylistSelector();
  core.updateState({ allSongs: [], playlist: [] });
  if ($('libList')) $('libList').innerHTML = '';
  if ($('libCount')) $('libCount').textContent = '0';
  if ($('libEmpty')) $('libEmpty').classList.add('on');
  toast('已退出登录');
}

/**
 * MelodyCore - 音频与状态管理核心
 * 纯粹的数据和状态管理器，不触碰任何 DOM
 */
class MelodyCore {
  constructor(audioElement) {
    this.audio = audioElement;
    
    // 集中管理播放器状态
    this.state = {
      playlist: [],
      allSongs: [],
      curIdx: -1,
      curSong: null,
      isPlaying: false,
      volume: 0.6,
      currentTime: 0,
      duration: 0,
      shuffleOn: false,
      repeatOn: false,
      playbackRate: 1.0,
      lyricOffset: 0
    };

    this.listeners = [];
    this._playId = 0;          // 播放 ID，每次 play() 递增，作废旧的异步回调
    this._errorTimer = null;   // error 事件防重入，避免连锁 next() 积压
    this._playTimer = null;    // play() 防抖定时器，快速连点只执行最后一次
    this._initAudioEvents();
  }

  _initAudioEvents() {
    this.audio.addEventListener('play', () => {
      this.updateState({ isPlaying: true });
      if (typeof startSpectrumAnim === 'function') startSpectrumAnim();
    });
    this.audio.addEventListener('pause', () => {
      this.updateState({ isPlaying: false });
      if (typeof stopSpectrumAnim === 'function') stopSpectrumAnim();
      if (typeof saveState === 'function') saveState(); 
    });
    this.audio.addEventListener('timeupdate', () => {
      this.updateState({ currentTime: this.audio.currentTime });
    });
    this.audio.addEventListener('loadedmetadata', () => {
      this.updateState({ duration: this.audio.duration });
    });
    this.audio.addEventListener('ended', () => {
      this.next();
    });
    this.audio.addEventListener('error', async () => {
      if (this._errorTimer) return;
      // NetEase 链接过期 — 尝试重取一次
      const song = this.state.curSong;
      if (song && (song.neteaseId || song.id)) {
        const freshUrl = await resolveNeteaseUrl(song.neteaseId || song.id);
        if (freshUrl) {
          this.audio.src = freshUrl;
          this.audio.play().catch(() => {});
          return;
        }
      }
      if (typeof toast === 'function') toast('播放出错，切换下一首');
      this._errorTimer = setTimeout(() => {
        this._errorTimer = null;
        this.next();
      }, 1500);
    });
  }

  updateState(newState) {
    this.state = { ...this.state, ...newState };
    this.listeners.forEach(callback => callback(this.state));
  }

  subscribe(callback) {
    this.listeners.push(callback);
    callback(this.state);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }

  play(index) {
    if (index < 0 || index >= this.state.playlist.length) return;
    const song = this.state.playlist[index];

    // 检查格式是否支持
    if (song.unsupported) {
        if (typeof toast === 'function') toast('该音频格式暂不支持播放');
        return;
    }

    // 清除积压的 error 连锁定时器
    if (this._errorTimer) {
        clearTimeout(this._errorTimer);
        this._errorTimer = null;
    }

    // 递增播放 ID，作废所有进行中的异步回调
    const playId = ++this._playId;

    // 取消之前的待执行定时器
    if (this._playTimer) { clearTimeout(this._playTimer); this._playTimer = null; }

    this._executePlay(index, playId);
  }

  _executePlay(index, playId) {
    const song = this.state.playlist[index];
    if (!song || song.unsupported) return;

    // 1. 数据即时更新，UI 立即响应
    this.updateState({ curIdx: index, curSong: song });

    // 2. 异步获取网易云播放地址
    (async () => {
      const url = await resolveNeteaseUrl(song.neteaseId || song.id);
      if (playId !== this._playId) return;

      if (!url) {
        if (typeof toast === 'function') {
          if (!getCookie()) toast('请先登录网易云音乐');
          else toast(song.title + ' - 暂无版权或需VIP');
        }
        return;
      }

      this.audio.crossOrigin = 'anonymous';
      this.audio.src = url;
      this.audio.load();
      initSpectrum();
      this.audio.playbackRate = this.state.playbackRate;

      this.audio.play().then(() => {
        if (playId !== this._playId) return;
      }).catch(err => {
        if (playId !== this._playId) return;
        if (err && err.name === 'AbortError') return;
        console.warn('[MelodyBox] play failed:', err.message);
        if (typeof toast === 'function') toast('播放失败: ' + err.message);
      });
    })();
  }

  togglePlay() {
    if (!this.audio.src) {
      if (this.state.playlist.length > 0) {
        // 找到第一首可播放的歌曲
        const firstPlayable = this.state.playlist.findIndex(s => !s.unsupported);
        if (firstPlayable >= 0) this.play(firstPlayable);
        else if (typeof toast === 'function') toast('曲库中没有可播放的歌曲');
      }
      else if (typeof toast === 'function') toast('请先添加音乐');
      return;
    }
    this.audio.paused ? this.audio.play() : this.audio.pause();
  }

  prev() {
    if (!this.state.playlist.length) return;
    if (this.state.shuffleOn) {
      const playable = this.state.playlist.filter(s => !s.unsupported);
      if (!playable.length) { if (typeof toast === 'function') toast('曲库中没有可播放的歌曲'); return; }
      this.play(Math.floor(Math.random() * this.state.playlist.length));
      return;
    }
    let idx = this.state.curIdx;
    for (let attempt = 0; attempt < this.state.playlist.length; attempt++) {
      idx = idx <= 0 ? this.state.playlist.length - 1 : idx - 1;
      if (!this.state.playlist[idx].unsupported) { this.play(idx); return; }
    }
    if (typeof toast === 'function') toast('曲库中没有可播放的歌曲');
  }

  next() {
    if (!this.state.playlist.length) return;
    if (this.state.shuffleOn) {
      const playable = this.state.playlist.filter(s => !s.unsupported);
      if (!playable.length) { if (typeof toast === 'function') toast('曲库中没有可播放的歌曲'); return; }
      this.play(Math.floor(Math.random() * this.state.playlist.length));
      return;
    }
    let idx = this.state.curIdx;
    for (let attempt = 0; attempt < this.state.playlist.length; attempt++) {
      if (this.state.repeatOn && idx === this.state.playlist.length - 1) idx = 0;
      else idx = idx >= this.state.playlist.length - 1 ? 0 : idx + 1;
      if (!this.state.playlist[idx].unsupported) { this.play(idx); return; }
    }
    if (typeof toast === 'function') toast('曲库中没有可播放的歌曲');
  }

  seek(time) {
    this.audio.currentTime = time;
  }

  setVolume(v) {
    this.audio.volume = v;
    this.updateState({ volume: v });
  }
}

// ================================================================
// 全局状态句柄初始化
const audio = document.getElementById('audio');
const core = new MelodyCore(audio);

var playlist = [], allSongs = [], curIdx = -1, curSong = null;
let lyrics = [], currentBgUrl = '';
let lyricOffset = 0;
let shuffleOn = false, repeatOn = false;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
let speedIdx = 2;

// 频谱
let audioCtx = null, analyser = null, spectrumAnimId = null;
let spectrumBars = [];
let audioUnlocked = false;

var $ = id => document.getElementById(id);

// ============ 进度条拖拽状态 ============
let dragging = false;
let dragBar = null, dragTip = null;

// ============ localStorage 持久化 ============
const STORAGE_KEY = 'melodybox_state';

function saveState() {
  const state = {
    volume: audio.volume,
    shuffle: core.state.shuffleOn,
    repeat: core.state.repeatOn,
    rate: SPEEDS[speedIdx],
    lyricOffset: core.state.lyricOffset,
    playlistIds: core.state.playlist.map(s => s.id),
    curIdx: core.state.curIdx,
    currentTime: audio.currentTime || 0
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {}
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function applySavedState(state) {
  if (!state) return;

  if (typeof state.volume === 'number') {
    audio.volume = state.volume;
    core.updateState({ volume: state.volume });
    if ($('lpVolSlider')) $('lpVolSlider').value = Math.round(state.volume * 100);
    updateVolIcon(state.volume * 100);
  }
  if (state.shuffle) {
    core.updateState({ shuffleOn: true });
    if ($('lpShuffleBtn')) {
      $('lpShuffleBtn').classList.remove('dim');
      $('lpShuffleBtn').style.opacity = '1';
    }
  }
  if (state.repeat) {
    core.updateState({ repeatOn: true });
    if ($('lpRepeatBtn')) {
      $('lpRepeatBtn').classList.remove('dim');
      $('lpRepeatBtn').style.opacity = '1';
    }
  }
  if (typeof state.rate === 'number') {
    const idx = SPEEDS.indexOf(state.rate);
    if (idx >= 0) {
      speedIdx = idx;
      audio.playbackRate = SPEEDS[speedIdx];
      core.updateState({ playbackRate: SPEEDS[speedIdx] });
      if ($('rpSpeedLabel')) $('rpSpeedLabel').textContent = SPEEDS[speedIdx] + '×';
    }
  }
  if (typeof state.lyricOffset === 'number') {
    core.updateState({ lyricOffset: state.lyricOffset });
    if ($('rpOffsetLabel')) {
      $('rpOffsetLabel').textContent = (state.lyricOffset >= 0 ? '+' : '') + state.lyricOffset.toFixed(1) + 's';
      $('rpOffsetLabel').style.color = state.lyricOffset !== 0 ? '#64d2ff' : 'rgba(255,255,255,0.5)';
    }
  }
  return state;
}

// ============ Utilities ============
function fmtTime(s) {
  if (isNaN(s) || s < 0) return '00:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function escAttr(s) { return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\'").replace(/"/g,'&quot;'); }
function toast(msg) {
  const t = $('toast');
  if(!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), 2200);
}

// ============ 极致超清毛玻璃全屏背景系统 ============
function updateBackground(url) {
  if (url === currentBgUrl) return;
  currentBgUrl = url;
  const colorEl = $('bg-color');
  if(!colorEl) return;
  const defaultBg = 'linear-gradient(135deg, rgba(30,30,35,1), rgba(15,15,20,1))';
  
  if (!url) {
    colorEl.style.backgroundImage = 'none';
    colorEl.style.background = defaultBg;
    return;
  }

  const img1 = new Image();
  img1.onload = () => {
    colorEl.style.background = 'none';
    colorEl.style.backgroundImage = `url('${url}')`;
    colorEl.style.backgroundSize = 'cover';
    colorEl.style.backgroundPosition = 'center';
    colorEl.style.filter = 'blur(100px) saturate(120%) brightness(0.4)';
    colorEl.style.transform = 'scale(1.2)'; 
    colorEl.style.transition = 'background-image 0.8s cubic-bezier(0.25, 1, 0.5, 1)';
  };
  img1.onerror = () => {
    colorEl.style.backgroundImage = 'none';
    colorEl.style.background = defaultBg;
    currentBgUrl = '';
  };
  img1.src = url;
}

function openSidebar()  { if($('sidebarOverlay')) $('sidebarOverlay').classList.add('on'); }
function closeSidebar() { if($('sidebarOverlay')) $('sidebarOverlay').classList.remove('on'); }

// ============ 左侧边缘悬停自动弹出 ============
const EDGE_WIDTH = 10;        // 左边缘检测宽度 (px)
const EDGE_OPEN_DELAY = 180;  // 悬停多久后弹出 (ms)
const EDGE_CLOSE_DELAY = 350; // 鼠标离开侧边栏多久后关闭 (ms)
let edgeOpenTimer = null;
let edgeCloseTimer = null;
let sidebarHoverOpen = false;  // 是否由边缘悬停打开（区别于按钮点击）

function initEdgePeek() {
  const overlay = $('sidebarOverlay');
  const sidebar = overlay ? overlay.querySelector('.sidebar') : null;
  if (!overlay || !sidebar) return;

  document.addEventListener('mousemove', function (e) {
    const isOpen = overlay.classList.contains('on');

    // —— 左边缘触发 ——
    if (e.clientX <= EDGE_WIDTH && !isOpen) {
      if (edgeCloseTimer) { clearTimeout(edgeCloseTimer); edgeCloseTimer = null; }  // 取消待关闭
      if (!edgeOpenTimer) {
        edgeOpenTimer = setTimeout(function () {
          openSidebar();
          sidebarHoverOpen = true;
          edgeOpenTimer = null;
        }, EDGE_OPEN_DELAY);
      }
      return;
    }

    // 离开边缘、侧边栏未开 → 取消待打开
    if (!isOpen && edgeOpenTimer) {
      clearTimeout(edgeOpenTimer);
      edgeOpenTimer = null;
    }

    // —— 侧边栏已由悬停打开，检测鼠标是否还在侧边栏内 ——
    if (isOpen && sidebarHoverOpen) {
      var r = sidebar.getBoundingClientRect();
      if (e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
        // 鼠标在侧边栏外
        if (!edgeCloseTimer) {
          edgeCloseTimer = setTimeout(function () {
            closeSidebar();
            sidebarHoverOpen = false;
            edgeCloseTimer = null;
          }, EDGE_CLOSE_DELAY);
        }
      } else {
        // 鼠标在侧边栏内
        if (edgeCloseTimer) { clearTimeout(edgeCloseTimer); edgeCloseTimer = null; }
      }
    }
  });

  // 侧边栏关闭时重置悬停状态（可能是点击遮罩关闭的）
  var observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (m) {
      if (m.attributeName === 'class') {
        if (!overlay.classList.contains('on')) {
          sidebarHoverOpen = false;
          if (edgeCloseTimer) { clearTimeout(edgeCloseTimer); edgeCloseTimer = null; }
        }
      }
    });
  });
  observer.observe(overlay, { attributes: true });

  // 按钮点击打开时，取消悬停标记（进入手动模式）
  var clickOpenBtns = document.querySelectorAll('.idle-btn, #playerLibBtn');
  clickOpenBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      sidebarHoverOpen = false;
      if (edgeCloseTimer) { clearTimeout(edgeCloseTimer); edgeCloseTimer = null; }
    });
  });
}

// ============ 加载曲库 (网易云 API) ============
// ---- 歌单缓存与切换 ----
let _neteasePlaylists = [];          // [{id, name, coverImgUrl, trackCount}]
let _playlistTracksCache = {};       // { [id]: songs[] }
let _currentPlaylistId = null;

async function selectPlaylist(playlistId) {
  if (_currentPlaylistId === playlistId && _playlistTracksCache[playlistId]) return;

  // 即时反馈：显示加载状态
  if($('libList')) $('libList').innerHTML = '<div class="lib-loading">加载中…</div>';
  if($('libEmpty')) $('libEmpty').classList.remove('on');

  let tracks = _playlistTracksCache[playlistId];
  if (!tracks) {
    try {
      const cookie = getCookie();
      const resp = await fetch(`${NETEASE_API}/playlist/track/all?id=${playlistId}&cookie=${encodeURIComponent(cookie)}&timestamp=${Date.now()}`);
      const data = await resp.json();
      if (data.code !== 200 || !data.songs) {
        if($('libList')) $('libList').innerHTML = '<div class="lib-loading">加载失败，请重试</div>';
        return;
      }
      tracks = data.songs.map(mapNeteaseSong);
      _playlistTracksCache[playlistId] = tracks;
      // 后台预加载相邻歌单
      preloadAdjacentPlaylists(playlistId);
    } catch(e) {
      if($('libList')) $('libList').innerHTML = '<div class="lib-loading">网络错误，请重试</div>';
      return;
    }
  }

  _currentPlaylistId = playlistId;
  if($('libCount')) $('libCount').textContent = tracks.length;
  core.updateState({ allSongs: tracks, playlist: [...tracks] });
  invalidateAlbumCache();
  _prevActiveSongIdx = -1;
  _prevActiveAlbumEl = null;

  // 分块渲染大列表，避免卡顿
  if (tracks.length > 300) {
    renderLibListChunked(tracks);
  } else {
    renderLibList();
  }

  if ($('playlistSelect')) $('playlistSelect').value = playlistId;
  switchTab('songs');
}

function preloadAdjacentPlaylists(currentId) {
  const idx = _neteasePlaylists.findIndex(p => p.id == currentId);
  if (idx < 0) return;
  // 预加载下一个歌单
  const next = _neteasePlaylists[idx + 1];
  if (next && !_playlistTracksCache[next.id]) {
    const cookie = getCookie();
    fetch(`${NETEASE_API}/playlist/track/all?id=${next.id}&cookie=${encodeURIComponent(cookie)}&timestamp=${Date.now()}`)
      .then(r => r.json())
      .then(data => {
        if (data.code === 200 && data.songs) {
          _playlistTracksCache[next.id] = data.songs.map(mapNeteaseSong);
        }
      }).catch(() => {});
  }
}

/** 分块渲染：先渲染前 100 首，剩余用 rAF 分批插入 */
let _renderChunkTimer = null;
function renderLibListChunked(tracks) {
  if (_renderChunkTimer) { cancelAnimationFrame(_renderChunkTimer); _renderChunkTimer = null; }
  const container = $('libList');
  if (!container) return;

  const CHUNK = 100;
  // 先渲染第一块
  container.innerHTML = tracks.slice(0, CHUNK).map((s, i) => songRowHTML(s, i)).join('');

  let offset = CHUNK;
  function nextChunk() {
    if (offset >= tracks.length) { _renderChunkTimer = null; return; }
    const end = Math.min(offset + CHUNK, tracks.length);
    const frag = document.createDocumentFragment();
    const div = document.createElement('div');
    div.innerHTML = tracks.slice(offset, end).map((s, i) => songRowHTML(s, offset + i)).join('');
    while (div.firstChild) frag.appendChild(div.firstChild);
    container.appendChild(frag);
    offset = end;
    _renderChunkTimer = requestAnimationFrame(nextChunk);
  }
  _renderChunkTimer = requestAnimationFrame(nextChunk);
}

/** 单首歌曲行 HTML，供 renderLibList 和 chunked render 共用 */
function songRowHTML(s, i) {
  const active = core.state.curSong && core.state.curSong.id === s.id;
  const cls = active ? ' lib-song active' : ' lib-song';
  return `<div class="${cls}" onclick="playSong(${i})" data-idx="${i}">
    <div class="s-thumb"><img src="${s.coverUrl || ''}" loading="lazy" onerror="this.style.display='none'" alt=""></div>
    <span class="s-idx">${active ? '▶' : String(i+1)}</span>
    <span class="s-info"><div class="s-title">${esc(s.title)}</div><div class="s-artist">${esc(s.artist)}${s.album?' · '+esc(s.album):''}</div></span>
    <span class="s-dur">${fmtTime(s.duration)}</span>
  </div>`;
}

async function loadNeteaseLibrary() {
  const cookie = getCookie();
  // 即时显示加载状态
  if($('libList')) $('libList').innerHTML = '<div class="lib-loading">正在加载歌单…</div>';
  if($('libEmpty')) $('libEmpty').classList.remove('on');

  if (!cookie) {
    _neteasePlaylists = [];
    _playlistTracksCache = {};
    _currentPlaylistId = null;
    renderPlaylistSelector();
    if($('libEmpty')) $('libEmpty').classList.add('on');
    if($('libEmpty')) {
      const hint = $('libEmpty').querySelector('.empty-hint');
      if (hint) hint.innerHTML = '点击下方「登录网易云」开始使用';
    }
    if($('libList')) $('libList').innerHTML = '';
    if($('libCount')) $('libCount').textContent = '0';
    core.updateState({ allSongs: [], playlist: [] });
    return;
  }

  try {
    // 1. 获取用户 UID
    const accResp = await fetch(`${NETEASE_API}/user/account?cookie=${encodeURIComponent(cookie)}&timestamp=${Date.now()}`);
    const accData = await accResp.json();
    if (accData.code !== 200 || !accData.account) {
      toast('登录已过期，请重新登录');
      clearCookie();
      updateLoginButtonState();
      if($('libEmpty')) $('libEmpty').classList.add('on');
      return;
    }
    const uid = accData.account.id;

    // 2. 获取用户歌单列表
    const resp = await fetch(`${NETEASE_API}/user/playlist?uid=${uid}&cookie=${encodeURIComponent(cookie)}&timestamp=${Date.now()}`);
    const data = await resp.json();

    if (data.code !== 200) {
      toast('登录已过期，请重新登录');
      clearCookie();
      updateLoginButtonState();
      if($('libEmpty')) $('libEmpty').classList.add('on');
      return;
    }

    _neteasePlaylists = data.playlist || [];
    _playlistTracksCache = {};

    if (_neteasePlaylists.length === 0) {
      if($('libEmpty')) $('libEmpty').classList.add('on');
      if($('libList')) $('libList').innerHTML = '';
      if($('libCount')) $('libCount').textContent = '0';
      core.updateState({ allSongs: [], playlist: [] });
      renderPlaylistSelector();
      return;
    }

    // 3. 渲染歌单选择器，默认加载第一个歌单
    renderPlaylistSelector();
    await selectPlaylist(_neteasePlaylists[0].id);

    if ($('albumView') && $('albumView').style.display !== 'none') {
      if (currentAlbumKey) openAlbumDetail(currentAlbumKey);
      else renderAlbumGrid();
    }
    tryRestorePlayback();
  } catch(e) {
    toast('加载歌单失败，请检查网络');
    core.updateState({ allSongs: [], playlist: [] });
  }
}

function renderPlaylistSelector() {
  const wrap = $('playlistSelectWrap');
  if (!wrap) return;
  if (!_neteasePlaylists.length) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  const sel = $('playlistSelect');
  if (!sel) return;
  sel.innerHTML = _neteasePlaylists.map(pl =>
    `<option value="${pl.id}">${esc(pl.name)} (${pl.trackCount})</option>`
  ).join('');
  if (_currentPlaylistId) sel.value = _currentPlaylistId;
}

async function loadLibrary(showToastFlag) {
  await loadNeteaseLibrary();
}

async function refreshLib() {
  const btn = $('refreshBtn');
  if(btn) btn.disabled = true;
  toast('正在刷新歌单…');
  try {
    await loadNeteaseLibrary();
    toast('歌单已刷新');
  } catch(e) { toast('刷新失败，请检查网络'); }
  if(btn) btn.disabled = false;
}

function renderLibList() {
  const container = $('libList');
  if(!container) return;
  const tracks = core.state.playlist;
  if (!tracks.length) {
    container.innerHTML = '';
    if($('libEmpty')) $('libEmpty').classList.add('on');
    return;
  }
  if($('libEmpty')) $('libEmpty').classList.remove('on');

  container.innerHTML = tracks.map((s, i) => songRowHTML(s, i)).join('');
}

let _prevActiveSongIdx = -1;
let _prevActiveAlbumEl = null;

function updateActiveInLib() {
  // 侧边栏歌曲列表 — 只更新前一行和当前行
  if ($('libList') && core.state.curSong) {
    const curIdx = core.state.playlist.findIndex(s => s.id === core.state.curSong.id);
    if (curIdx !== _prevActiveSongIdx) {
      _updateSongRow(_prevActiveSongIdx);
      _updateSongRow(curIdx);
      _prevActiveSongIdx = curIdx;
    }
  }

  // 专辑详情 — 同上
  if (currentAlbumKey && $('albumDetailView') && $('albumDetailView').style.display !== 'none') {
    const rows = $('albumDetailView').querySelectorAll('.album-track-row');
    // 只在首次或行数变化时全量扫描建立索引
    let curActiveEl = null;
    rows.forEach(el => {
      const ti = parseInt(el.dataset.trackIdx || -1);
      const albums = groupByAlbum();
      const songs = albums.find(([k]) => k === currentAlbumKey)?.[1] || [];
      const s = songs[ti];
      const active = core.state.curSong && s && s.id === core.state.curSong.id;
      if (active) curActiveEl = el;
    });
    // 高效方式：只改前后两行
    if (curActiveEl !== _prevActiveAlbumEl) {
      if (_prevActiveAlbumEl) {
        _prevActiveAlbumEl.classList.remove('active');
        const prevNum = _prevActiveAlbumEl.querySelector('.track-num');
        if (prevNum) prevNum.textContent = _prevActiveAlbumEl.dataset.trackIdx;
      }
      if (curActiveEl) {
        curActiveEl.classList.add('active');
        const curNum = curActiveEl.querySelector('.track-num');
        if (curNum) curNum.textContent = '▶';
      }
      _prevActiveAlbumEl = curActiveEl;
    }
  }
}

function _updateSongRow(idx) {
  if (idx < 0 || idx >= core.state.playlist.length) return;
  const el = $('libList').querySelector(`.lib-song[data-idx="${idx}"]`);
  if (!el) return;
  const active = core.state.curSong && core.state.playlist[idx] && core.state.playlist[idx].id === core.state.curSong.id;
  el.classList.toggle('active', active);
  const idxEl = el.querySelector('.s-idx');
  if (idxEl) idxEl.textContent = active ? '▶' : String(idx + 1);
}

function tryRestorePlayback() {
  const saved = loadState();
  if (!saved || !saved.playlistIds || !saved.playlistIds.length) return;

  const idMap = {};
  for (const s of core.state.allSongs) { idMap[s.id] = s; }

  const savedSong = idMap[saved.playlistIds[saved.curIdx || 0]];
  if (!savedSong || savedSong.unsupported) return;

  core.updateState({ curSong: savedSong, curIdx: core.state.playlist.findIndex(s => s.id === savedSong.id) });
  if (core.state.curIdx < 0) core.updateState({ curIdx: 0 });

  // 触发一次UI恢复（假装切歌了）
  const tempCur = core.state.curSong;
  core.updateState({ curSong: null });
  core.updateState({ curSong: tempCur });

  // 异步获取网易云播放地址
  (async () => {
    const url = await resolveNeteaseUrl(savedSong.neteaseId || savedSong.id);
    if (!url) return; // 获取失败，静默跳过（用户可手动点击播放）
    audio.crossOrigin = 'anonymous';
    audio.src = url;
    audio.load();

    if (saved.currentTime > 0) {
      const seekTo = saved.currentTime;
      audio.addEventListener('loadedmetadata', function seekOnce() {
        audio.currentTime = seekTo;
        audio.removeEventListener('loadedmetadata', seekOnce);
      });
    }
  })();
}

// ============ 专辑系统 ============
let _albumCache = null;
let _albumCacheKey = '';

function groupByAlbum() {
  // 缓存：数据没变就直接返回
  const songs = core.state.allSongs;
  const key = songs.length + '|' + (songs[0] && songs[0].id) + '|' + (songs[songs.length-1] && songs[songs.length-1].id);
  if (_albumCache && _albumCacheKey === key) return _albumCache;

  const map = new Map();
  for (const s of songs) {
    const k = s.album || '__unknown__';
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(s);
  }
  for (const tracks of map.values()) {
    tracks.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  }
  _albumCache = [...map.entries()].sort((a, b) => {
    if (a[0] === '__unknown__') return 1;
    if (b[0] === '__unknown__') return -1;
    return a[0].localeCompare(b[0], 'zh');
  });
  _albumCacheKey = key;
  return _albumCache;
}

// 歌单切换时使缓存失效
let currentAlbumKey = null;
function invalidateAlbumCache() { _albumCache = null; _albumCacheKey = ''; }

function switchTab(tab) {
  const songView = $('songView');
  const albumView = $('albumView');
  const isSongs = tab === 'songs';

  if(songView) songView.style.display = isSongs ? '' : 'none';
  if(albumView) albumView.style.display = isSongs ? 'none' : '';

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });

  if (!isSongs) {
    if($('searchInput')) $('searchInput').value = '';
    renderAlbumGrid();
  } else {
    // 切回歌曲 Tab 时重置过滤状态
    if($('searchInput')) $('searchInput').value = '';
    core.updateState({ playlist: [...core.state.allSongs] });
    renderLibList();
  }
}

function renderAlbumGrid() {
  currentAlbumKey = null;
  if($('albumGridView')) $('albumGridView').style.display = '';
  if($('albumDetailView')) $('albumDetailView').style.display = 'none';
  const albums = groupByAlbum();

  if (!albums.length) {
    if($('albumGridView')) $('albumGridView').innerHTML = '';
    if($('albumEmpty')) $('albumEmpty').style.display = '';
    return;
  }
  if($('albumEmpty')) $('albumEmpty').style.display = 'none';

  if($('albumGridView')) $('albumGridView').innerHTML = albums.map(([key, songs]) => {
    const coverUrl = songs[0].coverUrl || '';
    const displayName = key === '__unknown__' ? '未知专辑' : key;
    const artistName = songs[0].artist;
    return `<div class="album-card" onclick="openAlbumDetail('${escAttr(key)}')">
      <img class="card-art" src="${coverUrl}" loading="lazy"
        onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" alt="">
      <div class="card-no-art" style="display:none">💿</div>
      <div class="card-text">
        <div class="card-title">${esc(displayName)}</div>
        <div class="card-sub">${esc(artistName)} · ${songs.length} 首</div>
      </div>
    </div>`;
  }).join('');
}

function openAlbumDetail(albumKey) {
  currentAlbumKey = albumKey;
  const albums = groupByAlbum();
  const songs = albums.find(([k]) => k === albumKey)?.[1] || [];

  if (!songs.length) return;

  const displayName = albumKey === '__unknown__' ? '未知专辑' : albumKey;
  const artistName = songs[0].artist;
  const totalDur = songs.reduce((a, s) => a + (s.duration || 0), 0);
  const coverUrl = songs[0].coverUrl || '';

  if($('albumGridView')) $('albumGridView').style.display = 'none';
  if($('albumDetailView')) {
    $('albumDetailView').style.display = '';
    $('albumDetailView').innerHTML = `
      <div class="detail-back" onclick="backToAlbums()">← 资料库</div>
      <div class="album-detail-header">
        <img class="detail-art" src="${coverUrl}" loading="lazy"
          onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" alt="">
        <div class="detail-art-placeholder" style="display:none">💿</div>
        <div class="detail-album-name">${esc(displayName)}</div>
        <div class="detail-album-artist">${esc(artistName)}</div>
      </div>
      <div class="album-detail-meta">${songs.length} 首 · ${fmtTime(totalDur)}</div>
      <div class="album-action-row">
        <button class="btn-play-all" onclick="playAlbum('${escAttr(albumKey)}', 0)">▶ 播放全部</button>
        <button class="btn-shuffle" onclick="shuffleAlbum('${escAttr(albumKey)}')">🔀 随机</button>
      </div>
      <div class="album-detail-tracks">
        ${songs.map((s, i) => {
          const isActive = core.state.curSong && core.state.curSong.id === s.id;
          const isUnsupported = s.unsupported;
          return `
          <div class="album-track-row${isActive ? ' active' : ''}${isUnsupported ? ' unsupported' : ''}"
               data-track-idx="${i}"
               onclick="${isUnsupported ? 'if(typeof toast===\'function\')toast(\'该音频格式暂不支持播放\')' : 'playAlbum(\'' + escAttr(albumKey) + '\', ' + i + ')'}">
            <span class="track-num">${isActive ? '▶' : (isUnsupported ? '🚫' : i+1)}</span>
            <span class="track-info">
              <span class="track-title">${esc(s.title)}${isUnsupported ? ' <span class="s-unsupported-badge">暂不支持</span>' : ''}</span>
            </span>
            <span class="track-dur">${fmtTime(s.duration)}</span>
          </div>`;
        }).join('')}
      </div>`;
  }
}

function backToAlbums() {
  currentAlbumKey = null;
  if($('albumGridView')) $('albumGridView').style.display = '';
  if($('albumDetailView')) $('albumDetailView').style.display = 'none';
}

function playAlbum(albumKey, startIdx) {
  const albums = groupByAlbum();
  const songs = albums.find(([k]) => k === albumKey)?.[1] || [];
  if (!songs.length) return;
  core.updateState({ playlist: songs });
  core.play(startIdx);
  closeSidebar();
}

function shuffleAlbum(albumKey) {
  const albums = groupByAlbum();
  const songs = albums.find(([k]) => k === albumKey)?.[1] || [];
  if (!songs.length) return;
  const shuffled = [...songs];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  core.updateState({ playlist: shuffled });
  core.play(0);
  closeSidebar();
  toast('🔀 随机播放');
}

// ============ 搜索 ============
if($('searchInput')) {
  $('searchInput').addEventListener('input', () => {
    const kw = $('searchInput').value.trim().toLowerCase();
    const filtered = kw
      ? core.state.allSongs.filter(s => s.title.toLowerCase().includes(kw) || s.artist.toLowerCase().includes(kw) || s.album.toLowerCase().includes(kw))
      : [...core.state.allSongs];
    core.updateState({ playlist: filtered });
    renderLibList();
  });
}

// ============ 桥接方法 ============
// HTML 事件 onclick="playSong(idx)" 绑定的就是这里
function playSong(idx) {
    core.play(idx);
}

// ============ 歌词解析 ============
/**
 * 合并网易云原文歌词 (lrc.lyric) 和翻译歌词 (tlyric.lyric)
 * 策略：将相同时戳的翻译行插入到原文行之后，
 * parseBilingualLyric 会将相邻同时间戳的两行识别为双语配对。
 */
function mergeLyricTranslations(lrc, tlyric) {
  if (!tlyric) return lrc;
  const transMap = new Map();
  for (const line of tlyric.split('\n')) {
    const m = line.match(/\[(\d+):(\d+(?:\.\d+)?)\](.*)/);
    if (!m) continue;
    const t = parseInt(m[1]) * 60 + parseFloat(m[2]);
    const txt = m[3].trim();
    if (txt) transMap.set(t.toFixed(2), txt);
  }

  const result = [];
  for (const line of lrc.split('\n')) {
    const m = line.match(/(\[(\d+):(\d+(?:\.\d+)?)\].*)/);
    if (!m) { result.push(line); continue; }
    const t = parseInt(m[2]) * 60 + parseFloat(m[3]);
    result.push(line);
    const trans = transMap.get(t.toFixed(2));
    if (trans) {
      const ts = m[1].match(/\[.*?\]/)[0];
      result.push(ts + trans);
    }
  }
  return result.join('\n');
}

function parseBilingualLyric(raw) {
  const result = [];
  const lines = raw.split('\n');
  let prevTime = -1;
  let prevText = '';

  for (const line of lines) {
    const m = line.match(/\[(\d+):(\d+(?:\.\d+)?)\](.*)/);
    if (!m) continue;
    const t = parseInt(m[1]) * 60 + parseFloat(m[2]);
    const txt = m[3].trim();
    if (!txt) continue;

    // 内联双语格式："Hello / 你好"（要求空格包围，避免 "AC/DC" 误判）
    if (txt.includes(' / ')) {
      const parts = txt.split(' / ');
      result.push({ time: t, text: parts[0].trim(), transText: parts.slice(1).join(' / ').trim() });
      continue;
    }

    if (t === prevTime && prevText) {
      result.push({ time: t, text: prevText, transText: txt });
      prevTime = -1; prevText = '';
      continue;
    }

    if (prevText && prevTime >= 0) {
      result.push({ time: prevTime, text: prevText, transText: '' });
    }
    prevTime = t;
    prevText = txt;
  }
  if (prevText && prevTime >= 0) {
    result.push({ time: prevTime, text: prevText, transText: '' });
  }
  return result;
}

function processLyric(raw) {
  lyrics = [];
  lyricLineEls = [];
  _lastActiveIdx = -1;
  const savedOffset = loadState()?.lyricOffset || 0;
  core.updateState({ lyricOffset: savedOffset });
  if($('rpOffsetLabel')) {
    $('rpOffsetLabel').textContent = (savedOffset >= 0 ? '+' : '') + savedOffset.toFixed(1) + 's';
    $('rpOffsetLabel').style.color = savedOffset !== 0 ? '#64d2ff' : 'rgba(255,255,255,0.5)';
  }
  if($('rpLyricsScroll')) $('rpLyricsScroll').innerHTML = '';
  if($('rpLyricsEmpty')) $('rpLyricsEmpty').style.display = 'flex';
  if($('rpLyricsScroll')) $('rpLyricsScroll').style.transform = 'translateY(0px)';

  const msgEl = $('rpLyricsEmpty') ? $('rpLyricsEmpty').querySelector('span:last-child') : null;
  if (!raw) { if (msgEl) msgEl.textContent = '暂无歌词'; return; }

  lyrics = parseBilingualLyric(raw);
  if (!lyrics.length) { if (msgEl) msgEl.textContent = '暂无歌词'; return; }

  if($('rpLyricsEmpty')) $('rpLyricsEmpty').style.display = 'none';
  if($('rpLyricsScroll')) {
    $('rpLyricsScroll').innerHTML = lyrics.map((l, i) =>
      `<div class="rp-lyric-line" data-i="${i}" onclick="seekLyric(${l.time})">
        <span class="lyric-en">${esc(l.text)}</span>
        ${l.transText ? '<span class="lyric-zh">' + esc(l.transText) + '</span>' : ''}
      </div>`
    ).join('');
    // 缓存 DOM 引用，避免每帧 querySelectorAll
    lyricLineEls = Array.from($('rpLyricsScroll').querySelectorAll('.rp-lyric-line'));
  }

  if (audio.currentTime) syncLyric(audio.currentTime);
}

// ---- 歌词同步性能优化：二分查找 + rAF 节流 + DOM 缓存 ----
let lyricLineEls = [];
let _lyricSyncPending = false;
let _lastActiveIdx = -1;

function _lyricBinarySearch(time) {
  let lo = 0, hi = lyrics.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lyrics[mid].time <= time) { ans = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  return ans;
}

function syncLyric(now, instant) {
  if (!lyrics.length || !lyricLineEls.length) return;
  const t = now + core.state.lyricOffset;
  const active = _lyricBinarySearch(t);

  if (active === _lastActiveIdx) return;
  _lastActiveIdx = active;

  if (!_lyricSyncPending) {
    _lyricSyncPending = true;
    requestAnimationFrame(() => {
      _lyricSyncPending = false;
      _applyLyricSync();
    });
  }
}

function _applyLyricSync() {
  const active = _lastActiveIdx;
  for (let i = 0; i < lyricLineEls.length; i++) {
    lyricLineEls[i].classList.toggle('active', i === active);
  }

  // 手动滚动模式下不干预，让用户自由浏览
  if (_lyricManualMode) return;

  if (active >= 0 && lyricLineEls[active]) {
    const container = $('rpLyricsContainer');
    const scroll = $('rpLyricsScroll');
    if (container && scroll) {
      const line = lyricLineEls[active];
      const target = line.offsetTop - container.clientHeight / 2 + line.clientHeight / 2;
      scroll.style.transform = `translateY(${-target}px)`;
    }
  }
}

function seekLyric(t) {
  _exitLyricManualMode();
  if (audio.src) { audio.currentTime = t; if (audio.paused) audio.play().catch(() => {}); }
}

// ---- 歌词手动滚动（鼠标滚轮浏览，歌曲正常播放） ----
let _lyricManualMode = false;
let _lyricManualTimer = null;
const LYRIC_MANUAL_TIMEOUT = 2500;

function _exitLyricManualMode() {
  _lyricManualMode = false;
  if (_lyricManualTimer) { clearTimeout(_lyricManualTimer); _lyricManualTimer = null; }
  const scroll = $('rpLyricsScroll');
  if (scroll) scroll.style.transition = '';
  // 恢复自动跟随
  _lastActiveIdx = -1;
  if (audio.currentTime || audio.currentTime === 0) syncLyric(audio.currentTime);
}

function initLyricWheel() {
  const container = $('rpLyricsContainer');
  if (!container) return;

  container.addEventListener('wheel', (e) => {
    if (!lyricLineEls.length) return;
    e.preventDefault();

    const scroll = $('rpLyricsScroll');
    if (!scroll) return;

    // 进入手动模式：关掉 CSS transition 获得即时跟手响应
    if (!_lyricManualMode) {
      _lyricManualMode = true;
      scroll.style.transition = 'none';
    }

    // 重置自动恢复计时
    if (_lyricManualTimer) clearTimeout(_lyricManualTimer);
    _lyricManualTimer = setTimeout(_exitLyricManualMode, LYRIC_MANUAL_TIMEOUT);

    // 解析当前偏移
    const match = scroll.style.transform.match(/-?[\d.]+/);
    const currentY = match ? -parseFloat(match[0]) : 0;
    const newY = currentY + e.deltaY;

    // 边界：不超出歌词范围
    const containerH = container.clientHeight;
    const firstTop = lyricLineEls[0].offsetTop;
    const last = lyricLineEls[lyricLineEls.length - 1];
    const lastBottom = last.offsetTop + last.clientHeight;
    const minY = 0;
    const maxY = Math.max(0, lastBottom - containerH / 2);

    scroll.style.transform = `translateY(${-Math.max(minY, Math.min(maxY, newY))}px)`;
  }, { passive: false });
}

function adjustLyricOffset(delta) {
  let offset = core.state.lyricOffset;
  if (delta === 0) { offset = 0; }
  else {
    offset = Math.round((offset + delta) * 10) / 10;
    offset = Math.max(-10, Math.min(10, offset));
  }
  core.updateState({ lyricOffset: offset });
  if($('rpOffsetLabel')) {
    $('rpOffsetLabel').textContent = (offset >= 0 ? '+' : '') + offset.toFixed(1) + 's';
    $('rpOffsetLabel').style.color = offset !== 0 ? '#64d2ff' : 'rgba(255,255,255,0.5)';
  }
  if (lyrics.length > 0) syncLyric(audio.currentTime || 0);
  toast(offset === 0 ? '歌词偏移已重置' : '歌词偏移：' + (offset >= 0 ? '+' : '') + offset.toFixed(1) + 's');
  saveState();
}

function toggleRpMenu() { if($('rpMenuDropdown')) $('rpMenuDropdown').classList.toggle('on'); }

// ============ 控制行为 ============
function togglePlay() { core.togglePlay(); }
function prevSong() { core.prev(); }
function nextSong() { core.next(); }

function shuffleToggle() {
  const current = !core.state.shuffleOn;
  core.updateState({ shuffleOn: current });
  if($('lpShuffleBtn')) {
    $('lpShuffleBtn').classList.toggle('dim', !current);
    $('lpShuffleBtn').style.opacity = current ? '1' : '';
  }
  toast(current ? '随机播放：开' : '随机播放：关');
  saveState();
}

function repeatToggle() {
  const current = !core.state.repeatOn;
  core.updateState({ repeatOn: current });
  if($('lpRepeatBtn')) {
    $('lpRepeatBtn').classList.toggle('dim', !current);
    $('lpRepeatBtn').style.opacity = current ? '1' : '';
  }
  toast(current ? '循环播放：开' : '循环播放：关');
  saveState();
}

function cycleSpeed() {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  const rate = SPEEDS[speedIdx];
  audio.playbackRate = rate;
  core.updateState({ playbackRate: rate });
  if($('rpSpeedLabel')) $('rpSpeedLabel').textContent = rate + '×';
  toast('播放速度：' + rate + '×');
  saveState();
}

// ============ 单向响应更新订阅流 (核心 UI 驱动) ============
let lastSongId = null;

// DOM 缓存 — subscribe 高频调用，避免重复查询
let _cachedProgressFill = null;
let _cachedProgressThumb = null;
let _cachedCurTime = null;
let _cachedDurTime = null;
let _cachedPlayIcon = null;

core.subscribe((state) => {
  // 1. 切歌触发的全套 UI 更新
  if (state.curSong && state.curSong.id !== lastSongId) {
    lastSongId = state.curSong.id;

    if($('idleState')) $('idleState').style.display = 'none';
    if($('playerUI')) $('playerUI').style.display = 'flex';

    if($('lpTitle')) $('lpTitle').textContent = state.curSong.title;
    const artistParts = [state.curSong.artist];
    if (state.curSong.album) artistParts.push(state.curSong.album);
    if($('lpArtist')) $('lpArtist').textContent = artistParts.join(' · ');

    updateActiveInLib();

    if($('lpCover')) $('lpCover').classList.add('switching');

    const coverUrl = state.curSong.coverUrl || '';
    const finishSwitch = () => {
      if($('lpCover')) $('lpCover').classList.remove('switching');
    };
    if (coverUrl) {
      const testImg = new Image();
      testImg.onload = () => {
        updateBackground(coverUrl);
        if($('lpCover')) $('lpCover').innerHTML = `<img id="lpCoverImg" src="${coverUrl}" alt="cover">`;
        finishSwitch();
      };
      testImg.onerror = () => {
        updateBackground(null);
        if($('lpCover')) $('lpCover').innerHTML = '<div class="no-cover">🎵</div>';
        finishSwitch();
      };
      testImg.src = coverUrl;
    } else {
      updateBackground(null);
      if($('lpCover')) $('lpCover').innerHTML = '<div class="no-cover">🎵</div>';
      finishSwitch();
    }

    // 获取网易云歌词（含翻译合并）
    (async () => {
      const neteaseId = state.curSong.neteaseId;
      if (!neteaseId) { processLyric(''); return; }
      try {
        const resp = await fetch(`${NETEASE_API}/lyric?id=${neteaseId}&timestamp=${Date.now()}`);
        const data = await resp.json();
        if (data.code === 200) {
          const lrc = (data.lrc && data.lrc.lyric) ? data.lrc.lyric : '';
          const tlyric = (data.tlyric && data.tlyric.lyric) ? data.tlyric.lyric : '';
          processLyric(tlyric ? mergeLyricTranslations(lrc, tlyric) : lrc);
        } else {
          processLyric('');
        }
      } catch(e) { processLyric(''); }
    })();

    closeSidebar();
    saveState();

    // 系统媒体信息同步（锁屏 / 任务栏 / 耳机线控显示）
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: state.curSong.title,
        artist: state.curSong.artist,
        album: state.curSong.album || 'MelodyBox',
        artwork: state.curSong.coverUrl ? [
          { src: state.curSong.coverUrl, sizes: '512x512', type: 'image/jpeg' }
        ] : []
      });
    }

    // 刷新 DOM 缓存
    _cachedProgressFill = $('lpProgressFill');
    _cachedProgressThumb = $('lpProgressThumb');
    _cachedCurTime = $('lpCurTime');
    _cachedDurTime = $('lpDurTime');
  }

  // 2. 播放/暂停控制状态图标自适应更新
  if (!_cachedPlayIcon) _cachedPlayIcon = document.getElementById('lpPlayIcon');
  if (_cachedPlayIcon) {
    if (state.isPlaying) {
      _cachedPlayIcon.innerHTML = '<rect x="6" y="3" width="4" height="18" rx="1.2"/><rect x="14" y="3" width="4" height="18" rx="1.2"/>';
      document.body.classList.add('playing');
    } else {
      _cachedPlayIcon.innerHTML = '<polygon points="8,5 19,12 8,19"/>';
      document.body.classList.remove('playing');
    }
  }

  // 2.5 同步系统播放状态
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = state.isPlaying ? 'playing' : 'paused';
  }

  // 3. 进度条 — 拖拽时跳过，避免与用户操作冲突
  if (state.duration && !dragging) {
    if (!_cachedProgressFill) _cachedProgressFill = $('lpProgressFill');
    if (!_cachedProgressThumb) _cachedProgressThumb = $('lpProgressThumb');
    if (!_cachedCurTime) _cachedCurTime = $('lpCurTime');
    if (!_cachedDurTime) _cachedDurTime = $('lpDurTime');

    const pct = state.currentTime / state.duration * 100;
    if (_cachedProgressFill) _cachedProgressFill.style.width = pct + '%';
    if (_cachedProgressThumb) _cachedProgressThumb.style.left = pct + '%';
    if (_cachedCurTime) _cachedCurTime.textContent = fmtTime(state.currentTime);
    if (_cachedDurTime) _cachedDurTime.textContent = fmtTime(state.duration);

    syncLyric(state.currentTime);
  }
});

// ============ 进度条拖拽系统 ============
let _seekPending = false;
let _seekEvent = null;

function seekTo(e) {
  if (!audio.duration) return;
  const r = dragBar.getBoundingClientRect();
  const pct = Math.max(0, Math.min((e.clientX - r.left) / r.width, 1));
  const time = pct * audio.duration;

  // 即时视觉反馈 — 不等 timeupdate
  if (_cachedProgressFill) _cachedProgressFill.style.width = (pct * 100) + '%';
  if (_cachedProgressThumb) _cachedProgressThumb.style.left = (pct * 100) + '%';
  if (_cachedCurTime) _cachedCurTime.textContent = fmtTime(time);
  if (dragTip) {
    dragTip.textContent = fmtTime(time);
    dragTip.style.left = (pct * 100) + '%';
  }
}

function onProgressMouseDown(e) {
  if (!audio.duration) return;
  e.preventDefault();
  dragging = true;
  dragBar = e.currentTarget;
  dragTip = dragBar.querySelector('.lp-progress-tooltip');
  if (dragTip) dragTip.classList.add('visible');

  // 确保 DOM 缓存已初始化
  if (!_cachedProgressFill) _cachedProgressFill = $('lpProgressFill');
  if (!_cachedProgressThumb) _cachedProgressThumb = $('lpProgressThumb');
  if (!_cachedCurTime) _cachedCurTime = $('lpCurTime');

  _seekPending = false;
  _seekEvent = null;
  seekTo(e);
  document.addEventListener('mousemove', onProgressMouseMove);
  document.addEventListener('mouseup', onProgressMouseUp);
}

function onProgressMouseMove(e) {
  _seekEvent = e;
  if (_seekPending) return;
  _seekPending = true;
  requestAnimationFrame(() => {
    _seekPending = false;
    if (_seekEvent) { seekTo(_seekEvent); _seekEvent = null; }
  });
}

function onProgressMouseUp(e) {
  document.removeEventListener('mousemove', onProgressMouseMove);
  document.removeEventListener('mouseup', onProgressMouseUp);
  if (dragTip) dragTip.classList.remove('visible');
  dragging = false;

  // 松手时才真正 seek 音频
  if (audio.duration && dragBar) {
    const r = dragBar.getBoundingClientRect();
    const pct = Math.max(0, Math.min((e.clientX - r.left) / r.width, 1));
    audio.currentTime = pct * audio.duration;
  }
  saveState();
}

// ============ 音量控制 ============
function setVol(v) { core.setVolume(v / 100); if($('lpVolSlider')) $('lpVolSlider').value = v; updateVolIcon(v); saveState(); }
function toggleVolPopover() { if($('lpVolPopover')) $('lpVolPopover').classList.toggle('on'); if($('rpMenuDropdown')) $('rpMenuDropdown').classList.remove('on'); }
function toggleMute() {
  if (audio.volume > 0) { audio._pv = audio.volume; core.setVolume(0); if($('lpVolSlider')) $('lpVolSlider').value = 0; updateVolIcon(0); }
  else { const v = audio._pv || 0.6; core.setVolume(v); if($('lpVolSlider')) $('lpVolSlider').value = v * 100; updateVolIcon(v * 100); }
  saveState();
}
function updateVolIcon(v) {
  const n = parseInt(v);
  const btn = $('lpVolBtn');
  if(!btn) return;
  const svg = btn.querySelector('svg');
  if (!svg) return;
  const wave1 = svg.querySelector('.vol-wave-1');
  const wave2 = svg.querySelector('.vol-wave-2');
  const muteX1 = svg.querySelector('.vol-mute-x1');
  const muteX2 = svg.querySelector('.vol-mute-x2');
  const muted = n === 0;

  if (wave1) wave1.style.display = muted ? 'none' : '';
  if (wave2) wave2.style.display = n >= 30 ? '' : 'none';
  if (muteX1) muteX1.style.display = muted ? '' : 'none';
  if (muteX2) muteX2.style.display = muted ? '' : 'none';
}

// ============ 音频频谱渲染 ============
function initSpectrum() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.8;
    const source = audioCtx.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
    spectrumBars = new Array(32).fill(2);
  } catch (e) {}
}

function unlockAudioContext() {
  if (audioUnlocked) return;

  initSpectrum();

  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume()
      .then(() => {
        console.log('[MelodyBox Audio] AudioContext 强制激活成功。');
      })
      .catch(err => {
        console.warn('[MelodyBox Audio] 唤醒 AudioContext 失败:', err);
      });
  }

  audioUnlocked = true;

  document.removeEventListener('mousedown', unlockAudioContext);
  document.removeEventListener('keydown', unlockAudioContext);
  document.removeEventListener('touchstart', unlockAudioContext);
}

function startSpectrumAnim() {
  if (!analyser || spectrumAnimId) return;
  drawSpectrum();
}

function stopSpectrumAnim() {
  if (spectrumAnimId) { cancelAnimationFrame(spectrumAnimId); spectrumAnimId = null; }
  decaySpectrum();
}

function drawSpectrum() {
  if (!analyser) return;
  spectrumAnimId = requestAnimationFrame(drawSpectrum);

  const canvas = $('lpSpectrumCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const N = 32;
  const barW = 4, gap = 5; 
  const totalW = N * barW + (N - 1) * gap;
  const startX = (W - totalW) / 2;

  ctx.clearRect(0, 0, W, H);
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);

  for (let i = 0; i < N; i++) {
    const val = data[i] / 255;
    const targetH = Math.max(2, val * H * 0.9);
    spectrumBars[i] = spectrumBars[i] * 0.65 + targetH * 0.35;
    const h = spectrumBars[i];
    const x = startX + i * (barW + gap);
    const y = H - h;

    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.beginPath();
    ctx.roundRect(x, y, barW, h, 2);
    ctx.fill();
  }
}

function decaySpectrum() {
  const canvas = $('lpSpectrumCanvas');
  if (!canvas) return;
  if (spectrumBars.every(b => b <= 2)) return;

  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const N = 32;
  const barW = 4, gap = 5;
  const totalW = N * barW + (N - 1) * gap;
  const startX = (W - totalW) / 2;

  ctx.clearRect(0, 0, W, H);
  let anyVisible = false;
  for (let i = 0; i < N; i++) {
    spectrumBars[i] *= 0.85;
    if (spectrumBars[i] < 2) spectrumBars[i] = 2;
    else anyVisible = true;
    const h = spectrumBars[i];
    const x = startX + i * (barW + gap);
    const y = H - h;

    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.roundRect(x, y, barW, h, 2);
    ctx.fill();
  }
  if (anyVisible) requestAnimationFrame(decaySpectrum);
}

function initProgressTooltip() {
  const bar = document.querySelector('.lp-progress-bar');
  if (!bar) return;
  const tip = document.createElement('div');
  tip.className = 'lp-progress-tooltip';
  tip.textContent = '0:00';
  bar.appendChild(tip);

  bar.addEventListener('mouseenter', () => tip.classList.add('visible'));
  bar.addEventListener('mouseleave', () => tip.classList.remove('visible'));
  bar.addEventListener('mousemove', (e) => {
    var r = bar.getBoundingClientRect();
    var p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    tip.textContent = fmtTime(p * (audio.duration || 0));
    tip.style.left = (p * 100) + '%';
  });
}

// ============ 全局事件与键盘绑定 ============
document.addEventListener('click', (e) => {
  const dd = $('rpMenuDropdown'), btn = $('rpMenuBtn');
  if (dd && dd.classList.contains('on') && !dd.contains(e.target) && e.target !== btn && (!btn || !btn.contains(e.target))) {
    dd.classList.remove('on');
  }
  const vp = $('lpVolPopover'), vb = $('lpVolBtn');
  if (vp && vp.classList.contains('on') && !vp.contains(e.target) && e.target !== vb && (!vb || !vb.contains(e.target))) {
    vp.classList.remove('on');
  }
});

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  switch (e.code) {
    case 'Space': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': core.seek(audio.currentTime - 5); break;
    case 'ArrowRight': core.seek(audio.currentTime + 5); break;
    case 'ArrowUp': setVol(Math.min(100, (audio.volume * 100) + 5)); break;
    case 'ArrowDown': setVol(Math.max(0, (audio.volume * 100) - 5)); break;
  }
});

window.addEventListener('beforeunload', () => saveState());

document.addEventListener('mousedown', unlockAudioContext);
document.addEventListener('keydown', unlockAudioContext);
document.addEventListener('touchstart', unlockAudioContext);

function init() {
  const saved = loadState();
  applySavedState(saved);
  initProgressTooltip();

  // 进度条拖拽监听
  const progressBar = $('lpProgressBar');
  if (progressBar) progressBar.addEventListener('mousedown', onProgressMouseDown);

  document.querySelectorAll('.idle-btn').forEach(btn => btn.addEventListener('click', openSidebar));
  if ($('playerLibBtn')) $('playerLibBtn').addEventListener('click', openSidebar);
  if ($('sidebarBackdrop')) $('sidebarBackdrop').addEventListener('click', closeSidebar);

  initEdgePeek();
  initLyricWheel();

  // 系统媒体控制（耳机线控 / 键盘媒体键 / 锁屏控制）
  if ('mediaSession' in navigator && !window._mediaSessionInit) {
    window._mediaSessionInit = true;
    navigator.mediaSession.setActionHandler('play', () => core.togglePlay());
    navigator.mediaSession.setActionHandler('pause', () => core.togglePlay());
    navigator.mediaSession.setActionHandler('previoustrack', () => core.prev());
    navigator.mediaSession.setActionHandler('nexttrack', () => core.next());
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.fastSeek && audio.fastSeek) {
        audio.fastSeek(details.seekTime);
      } else {
        audio.currentTime = details.seekTime;
      }
    });
  }

  updateLoginButtonState();
  loadLibrary();
}

document.addEventListener('DOMContentLoaded', init);
