/**
 * WAVE — React Native / Expo App
 *
 * Setup:
 *   1. Edit API_URL below to point at your Render deployment
 *      (for Termux dev use http://localhost:8765)
 *   2. npm install  (or yarn)
 *   3. npx expo start
 *
 * Downloads are saved directly to your phone's storage via
 * expo-file-system + expo-media-library (appears in WAVE album).
 */

import React, {
  useState, useEffect, useRef, createContext, useContext, useCallback,
} from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, Image,
  StyleSheet, ActivityIndicator, Alert, ScrollView, Keyboard,
  StatusBar, Platform,
} from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer }            from '@react-navigation/native';
import { createBottomTabNavigator }       from '@react-navigation/bottom-tabs';
import { Audio }                          from 'expo-av';
import * as FileSystem                    from 'expo-file-system';
import * as MediaLibrary                  from 'expo-media-library';
import AsyncStorage                       from '@react-native-async-storage/async-storage';
import { WebView }                        from 'react-native-webview';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — change API_URL to your Render URL for production builds
// For Termux dev (server running on same phone): http://localhost:8765
// For Render prod: https://wave-sever.onrender.com
// ─────────────────────────────────────────────────────────────────────────────
const API_URL = 'https://wave-sever.onrender.com';

// ─────────────────────────────────────────────────────────────────────────────
// THEME
// ─────────────────────────────────────────────────────────────────────────────
const C = {
  bg:     '#0a0015',
  card:   '#12002a',
  card2:  '#1c0038',
  border: '#2a0050',
  accent: '#b56bff',
  dim:    '#7c22d8',
  text:   '#f0e8ff',
  sub:    '#9878cc',
  muted:  '#5a3a8a',
  green:  '#4ade80',
  red:    '#f87171',
};

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
const fmtDur = (secs) => {
  if (!secs) return '';
  return `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
};

const safeName = (str) =>
  (str || 'track').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 60);

// ─────────────────────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────────────────────
const api = {
  post: async (path, body) => {
    const r = await fetch(API_URL + path, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Server error ${r.status}`);
    return r.json();
  },
  get: async (path) => {
    const r = await fetch(API_URL + path);
    if (!r.ok) throw new Error(`Server error ${r.status}`);
    return r.json();
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// LOCAL LIBRARY (AsyncStorage)
// ─────────────────────────────────────────────────────────────────────────────
const LIB_KEY = 'wave_library_v1';

const LibStore = {
  get: async () => {
    try { const d = await AsyncStorage.getItem(LIB_KEY); return d ? JSON.parse(d) : []; }
    catch { return []; }
  },
  add: async (track) => {
    const lib     = await LibStore.get();
    const updated = [track, ...lib.filter(t => t.localUri !== track.localUri)];
    await AsyncStorage.setItem(LIB_KEY, JSON.stringify(updated));
    return updated;
  },
  remove: async (localUri) => {
    const lib     = await LibStore.get();
    const updated = lib.filter(t => t.localUri !== localUri);
    await AsyncStorage.setItem(LIB_KEY, JSON.stringify(updated));
    return updated;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// DOWNLOAD MANAGER
// Keeps a global jobs map; screens subscribe to updates.
// Flow: POST /api/download → poll /api/status → FileSystem.downloadAsync
//       → MediaLibrary.createAssetAsync → save to LibStore
// ─────────────────────────────────────────────────────────────────────────────
let _dlJobs     = {};
let _dlListeners = [];

const DLManager = {
  subscribe: (fn) => {
    _dlListeners.push(fn);
    return () => { _dlListeners = _dlListeners.filter(f => f !== fn); };
  },
  notify:  () => _dlListeners.forEach(fn => fn({ ..._dlJobs })),
  getJobs: () => ({ ..._dlJobs }),

  start: async (item, format = 'mp3', quality = '192') => {
    try {
      const data = await api.post('/api/download', {
        url: item.url, format, quality, title: item.title,
      });
      if (data.error) { Alert.alert('Error', data.error); return; }

      const jid = data.job_id;
      _dlJobs[jid] = {
        jid, url: item.url, title: item.title || 'Track',
        format, status: 'queued', progress: 0, thumbnail: item.thumbnail || '',
      };
      DLManager.notify();

      // Ensure local dir exists
      const waveDir = FileSystem.documentDirectory + 'wave/';
      await FileSystem.makeDirectoryAsync(waveDir, { intermediates: true });

      const poll = async () => {
        try {
          const status = await api.get(`/api/status/${jid}`);
          _dlJobs[jid] = { ..._dlJobs[jid], ...status };
          DLManager.notify();

          if (status.status === 'done') {
            // Transfer file from server → phone
            const ext       = status.format || format;
            const localPath = waveDir + safeName(status.title) + '_' + jid + '.' + ext;

            _dlJobs[jid].status = 'transferring';
            DLManager.notify();

            const dl = await FileSystem.downloadAsync(
              `${API_URL}/api/play/${encodeURIComponent(status.filename)}`,
              localPath,
            );

            if (dl.status !== 200) throw new Error('File transfer failed');

            // Add to device media library (creates WAVE album)
            try {
              const { status: perm } = await MediaLibrary.requestPermissionsAsync();
              if (perm === 'granted') {
                const asset = await MediaLibrary.createAssetAsync(dl.uri);
                try {
                  const albums    = await MediaLibrary.getAlbumsAsync();
                  const waveAlbum = albums.find(a => a.title === 'WAVE');
                  if (waveAlbum) {
                    await MediaLibrary.addAssetsToAlbumAsync([asset], waveAlbum, false);
                  } else {
                    await MediaLibrary.createAlbumAsync('WAVE', asset, false);
                  }
                } catch {}
              }
            } catch {}

            // Save metadata to AsyncStorage library
            const saved = {
              localUri:  dl.uri,           // file:// URI — always works with expo-av
              filename:  status.filename,
              title:     status.title     || item.title || 'Track',
              artist:    status.artist    || 'Unknown',
              thumbnail: status.thumbnail || item.thumbnail || '',
              duration:  status.duration  || 0,
              format:    ext,
              url:       item.url,
              savedAt:   Date.now(),
            };
            await LibStore.add(saved);

            _dlJobs[jid] = { ..._dlJobs[jid], status: 'saved', localUri: dl.uri };
            DLManager.notify();
            Alert.alert('✅ Saved to Phone', `"${saved.title}" is ready in Library`);

          } else if (status.status === 'error') {
            _dlJobs[jid] = { ..._dlJobs[jid], status: 'error' };
            DLManager.notify();
            Alert.alert('Download Error', status.error || 'Unknown error');
          } else {
            setTimeout(poll, 2000);
          }
        } catch (e) {
          _dlJobs[jid] = { ..._dlJobs[jid], status: 'error', error: e.message };
          DLManager.notify();
          Alert.alert('Error', e.message);
        }
      };

      setTimeout(poll, 2000);
    } catch (e) {
      Alert.alert('Error', e.message);
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// PLAYER CONTEXT  (expo-av)
// ─────────────────────────────────────────────────────────────────────────────
const PlayerCtx = createContext(null);

function PlayerProvider({ children }) {
  const soundRef          = useRef(null);
  const [track, setTrack] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos]     = useState(0);
  const [dur, setDur]     = useState(0);

  useEffect(() => {
    Audio.setAudioModeAsync({
      allowsRecordingIOS:     false,
      staysActiveInBackground: true,
      playsInSilentModeIOS:   true,
      shouldDuckAndroid:      false,
    });
    return () => { soundRef.current?.unloadAsync(); };
  }, []);

  const play = useCallback(async (t) => {
    try {
      await soundRef.current?.unloadAsync();
      setTrack(t); setPlaying(false); setPos(0); setDur(0);
      const { sound } = await Audio.Sound.createAsync(
        { uri: t.uri },
        { shouldPlay: true },
        (s) => {
          if (!s.isLoaded) return;
          setPlaying(s.isPlaying);
          setPos(s.positionMillis  || 0);
          setDur(s.durationMillis  || 0);
          if (s.didJustFinish) { setPlaying(false); setPos(0); }
        },
      );
      soundRef.current = sound;
      setPlaying(true);
    } catch (e) { Alert.alert('Playback error', e.message); }
  }, []);

  const toggle = useCallback(async () => {
    if (!soundRef.current) return;
    playing
      ? await soundRef.current.pauseAsync()
      : await soundRef.current.playAsync();
  }, [playing]);

  const seek = useCallback(async (ms) => {
    await soundRef.current?.setPositionAsync(ms);
  }, []);

  return (
    <PlayerCtx.Provider value={{ track, playing, pos, dur, play, toggle, seek }}>
      {children}
    </PlayerCtx.Provider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
function Thumb({ uri, size = 48 }) {
  if (uri) {
    return <Image source={{ uri }} style={{ width: size, height: size, borderRadius: 8 }} />;
  }
  return (
    <View style={{
      width: size, height: size, borderRadius: 8,
      backgroundColor: C.card2, alignItems: 'center', justifyContent: 'center',
    }}>
      <Text style={{ fontSize: size * 0.45 }}>🎵</Text>
    </View>
  );
}

function TrackCard({ item, onPlay, onDownload, dlState }) {
  const dur = fmtDur(item.duration);
  return (
    <View style={S.card}>
      <Thumb uri={item.thumbnail} />
      <View style={S.cardBody}>
        <Text style={S.cardTitle} numberOfLines={1}>{item.title || item.filename || 'Unknown'}</Text>
        <Text style={S.cardSub}   numberOfLines={1}>
          {[item.artist, dur].filter(Boolean).join(' · ')}
        </Text>
        {dlState && (
          <View style={{ marginTop: 5 }}>
            <View style={S.progressBg}>
              <View style={[S.progressFg, { width: `${dlState.progress || 0}%` }]} />
            </View>
            <Text style={S.progressLabel}>
              {dlState.status === 'saved'       ? '✅ Saved to phone'
               : dlState.status === 'error'     ? `❌ ${dlState.error || 'Error'}`
               : dlState.status === 'transferring' ? '📲 Transferring…'
               : `${dlState.status}  ${dlState.progress || 0}%${dlState.speed ? '  ' + dlState.speed : ''}`}
            </Text>
          </View>
        )}
      </View>
      <View style={S.cardActions}>
        {onPlay && (
          <TouchableOpacity style={S.iconBtn} onPress={onPlay}>
            <Text style={{ color: C.accent, fontSize: 22 }}>▶</Text>
          </TouchableOpacity>
        )}
        {onDownload && !dlState && (
          <TouchableOpacity style={S.iconBtn} onPress={onDownload}>
            <Text style={{ color: C.green, fontSize: 22 }}>⬇</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function MiniPlayer() {
  const { track, playing, pos, dur, toggle } = useContext(PlayerCtx);
  if (!track) return null;
  const pct = dur > 0 ? (pos / dur) * 100 : 0;
  return (
    <View style={S.mini}>
      <View style={[S.miniProg, { width: `${pct}%` }]} />
      <View style={S.miniRow}>
        <Thumb uri={track.thumbnail} size={34} />
        <View style={{ flex: 1, marginLeft: 10 }}>
          <Text style={S.miniTitle}  numberOfLines={1}>{track.title}</Text>
          <Text style={S.miniArtist} numberOfLines={1}>{track.artist || ''}</Text>
        </View>
        <TouchableOpacity onPress={toggle} style={{ padding: 10 }}>
          <Text style={{ color: C.text, fontSize: 26 }}>{playing ? '⏸' : '▶'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH SCREEN
// ─────────────────────────────────────────────────────────────────────────────
function SearchScreen() {
  const [query, setQuery]   = useState('');
  const [results, setRes]   = useState([]);
  const [loading, setLoad]  = useState(false);
  const [jobs, setJobs]     = useState({});

  useEffect(() => {
    setJobs(DLManager.getJobs());
    return DLManager.subscribe(j => setJobs({ ...j }));
  }, []);

  const search = async () => {
    const q = query.trim(); if (!q) return;
    Keyboard.dismiss(); setLoad(true); setRes([]);
    try {
      const data = await api.post('/api/search', { query: q });
      if (data.error) Alert.alert('Error', data.error);
      else setRes(data.results || []);
    } catch (e) { Alert.alert('Error', e.message); }
    finally { setLoad(false); }
  };

  const getDl = (url) =>
    Object.values(jobs).find(j => j.url === url);

  const askFormat = (item) => {
    Alert.alert(
      'Save to phone',
      item.title || 'Download this track?',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: '🎵 MP3 (audio)', onPress: () => DLManager.start(item, 'mp3', '192') },
        { text: '🎬 MP4 (video)', onPress: () => DLManager.start(item, 'mp4', '720') },
      ],
    );
  };

  return (
    <SafeAreaView style={S.screen} edges={['top']}>
      <View style={S.searchRow}>
        <TextInput
          style={S.input}
          placeholder="Search or paste URL…"
          placeholderTextColor={C.muted}
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={search}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
        />
        <TouchableOpacity style={S.goBtn} onPress={search}>
          <Text style={{ color: '#fff', fontWeight: '700' }}>Go</Text>
        </TouchableOpacity>
      </View>
      {loading ? (
        <ActivityIndicator color={C.accent} style={{ marginTop: 32 }} />
      ) : (
        <FlatList
          data={results}
          keyExtractor={(_, i) => String(i)}
          renderItem={({ item }) => (
            <TrackCard
              item={item}
              onDownload={() => askFormat(item)}
              dlState={getDl(item.url)}
            />
          )}
          contentContainerStyle={{ paddingBottom: 150, paddingTop: 4 }}
          ListEmptyComponent={
            <Text style={S.empty}>Search YouTube or paste any video / music URL</Text>
          }
        />
      )}
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LIBRARY SCREEN
// ─────────────────────────────────────────────────────────────────────────────
function LibraryScreen() {
  const [lib, setLib]       = useState([]);
  const [loading, setLoad]  = useState(true);
  const { play }            = useContext(PlayerCtx);

  const load = async () => {
    setLoad(true); setLib(await LibStore.get()); setLoad(false);
  };

  useEffect(() => { load(); }, []);

  const deleteTrack = (item) => {
    Alert.alert('Remove', `Remove "${item.title}" from library?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive', onPress: async () => {
          try { await FileSystem.deleteAsync(item.localUri, { idempotent: true }); } catch {}
          setLib(await LibStore.remove(item.localUri));
        },
      },
    ]);
  };

  if (loading) {
    return <View style={S.screen}><ActivityIndicator color={C.accent} style={{ marginTop: 48 }} /></View>;
  }

  return (
    <SafeAreaView style={S.screen} edges={['top']}>
      <FlatList
        data={lib}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item }) => (
          <TrackCard
            item={item}
            onPlay={() => play({
              uri:       item.localUri,
              title:     item.title,
              artist:    item.artist,
              thumbnail: item.thumbnail,
            })}
          />
        )}
        contentContainerStyle={{ paddingBottom: 150, paddingTop: 4 }}
        ListEmptyComponent={
          <Text style={S.empty}>
            No tracks yet{'\n'}Search for something and tap ⬇ to download it
          </Text>
        }
        onRefresh={load}
        refreshing={loading}
      />
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DOWNLOADS SCREEN
// ─────────────────────────────────────────────────────────────────────────────
function DownloadsScreen() {
  const [jobs, setJobs] = useState({});

  useEffect(() => {
    setJobs(DLManager.getJobs());
    return DLManager.subscribe(j => setJobs({ ...j }));
  }, []);

  const active = Object.values(jobs).filter(j => !['saved', 'error'].includes(j.status));
  const done   = Object.values(jobs).filter(j =>  ['saved', 'error'].includes(j.status));

  return (
    <SafeAreaView style={S.screen} edges={['top']}>
      <ScrollView contentContainerStyle={{ paddingBottom: 150, paddingTop: 8 }}>
        {active.length === 0 && done.length === 0 && (
          <Text style={S.empty}>No downloads yet{'\n'}Go to Search and tap ⬇ on any track</Text>
        )}

        {active.length > 0 && (
          <>
            <Text style={S.sectionLabel}>Active</Text>
            {active.map(j => (
              <View key={j.jid} style={[S.card, { flexDirection: 'column', alignItems: 'stretch', gap: 8 }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Thumb uri={j.thumbnail} size={40} />
                  <Text style={[S.cardTitle, { flex: 1 }]} numberOfLines={1}>{j.title}</Text>
                </View>
                <View style={S.progressBg}>
                  <View style={[S.progressFg, { width: `${j.progress || 0}%` }]} />
                </View>
                <Text style={S.progressLabel}>
                  {j.status === 'transferring' ? '📲 Transferring to phone…'
                   : `${j.status}  ${j.progress || 0}%${j.speed ? '  ' + j.speed : ''}${j.eta ? '  ETA ' + j.eta : ''}`}
                </Text>
              </View>
            ))}
          </>
        )}

        {done.length > 0 && (
          <>
            <Text style={S.sectionLabel}>Completed</Text>
            {done.map(j => (
              <View key={j.jid} style={S.card}>
                <Thumb uri={j.thumbnail} size={40} />
                <View style={[S.cardBody, { gap: 4 }]}>
                  <Text style={S.cardTitle} numberOfLines={1}>{j.title}</Text>
                  <Text style={{ fontSize: 12, color: j.status === 'error' ? C.red : C.green }}>
                    {j.status === 'error' ? `❌ ${j.error || 'Failed'}` : '✅ Saved to phone'}
                  </Text>
                </View>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ARIA SCREEN  (AI chat)
// ─────────────────────────────────────────────────────────────────────────────
const ARIA_WELCOME = "Hey! I'm **ARIA** ✦ — your AI music companion powered by Claude.\n\nI know your library and what you're listening to. Ask me for recommendations, music facts, or just chat! 🎵";

function AriaScreen() {
  const [msgs, setMsgs]    = useState([{ role: 'assistant', text: ARIA_WELCOME }]);
  const [input, setInput]  = useState('');
  const [loading, setLoad] = useState(false);
  const listRef            = useRef(null);
  const { track }          = useContext(PlayerCtx);

  const send = async () => {
    const text = input.trim(); if (!text || loading) return;
    Keyboard.dismiss(); setInput('');
    const newMsgs = [...msgs, { role: 'user', text }];
    setMsgs(newMsgs); setLoad(true);

    try {
      const lib     = await LibStore.get();
      const history = newMsgs.map(m => ({ role: m.role, content: m.text }));
      const data    = await api.post('/api/ai/chat', {
        messages: history,
        extra: {
          playing_title:  track?.title  || '',
          playing_artist: track?.artist || '',
          lib_size:       lib.length,
        },
      });
      setMsgs(prev => [...prev, {
        role: 'assistant',
        text: data.error ? `⚠️ ${data.error}` : data.reply,
        searches: data.searches || [],
      }]);
    } catch (e) {
      setMsgs(prev => [...prev, { role: 'assistant', text: `⚠️ ${e.message}` }]);
    } finally {
      setLoad(false);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 120);
    }
  };

  const renderMsg = ({ item }) => (
    <View style={[S.bubble, item.role === 'user' ? S.bubbleUser : S.bubbleBot]}>
      {item.role === 'assistant' && (
        <Text style={{ color: C.accent, fontSize: 10, fontWeight: '800', marginBottom: 4 }}>ARIA ✦</Text>
      )}
      <Text style={{ color: item.role === 'user' ? '#fff' : C.sub, fontSize: 13, lineHeight: 20 }}>
        {item.text}
      </Text>
      {item.searches?.length > 0 && item.searches.map((s, i) => (
        <Text key={i} style={{ color: C.accent, fontSize: 12, marginTop: 4 }}>🔍 {s}</Text>
      ))}
    </View>
  );

  return (
    <SafeAreaView style={S.screen} edges={['top']}>
      <FlatList
        ref={listRef}
        data={msgs}
        keyExtractor={(_, i) => String(i)}
        renderItem={renderMsg}
        contentContainerStyle={{ padding: 12, paddingBottom: 20 }}
        onContentSizeChange={() => listRef.current?.scrollToEnd()}
      />
      {loading && (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 6 }}>
          <ActivityIndicator size="small" color={C.accent} />
          <Text style={{ color: C.muted, marginLeft: 8, fontSize: 12 }}>ARIA is thinking…</Text>
        </View>
      )}
      <View style={[S.searchRow, { borderTopWidth: 1, borderTopColor: C.border, paddingTop: 10 }]}>
        <TextInput
          style={[S.input, { borderRadius: 22, paddingVertical: 10, maxHeight: 100 }]}
          placeholder="Ask ARIA anything…"
          placeholderTextColor={C.muted}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={send}
          returnKeyType="send"
          multiline
        />
        <TouchableOpacity style={[S.goBtn, { backgroundColor: C.dim }]} onPress={send}>
          <Text style={{ color: '#fff', fontSize: 20 }}>↑</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// BROWSER SCREEN  (WebView + import button)
// ─────────────────────────────────────────────────────────────────────────────
function BrowserScreen() {
  const [loadUrl, setLoadUrl]   = useState('https://youtube.com');
  const [barText, setBarText]   = useState('https://youtube.com');
  const [currentUrl, setCurrent] = useState('');
  const [showBar, setShowBar]   = useState(false);
  const webRef = useRef(null);

  const navigate = () => {
    let target = barText.trim();
    if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
    setLoadUrl(target); setBarText(target); setShowBar(false); Keyboard.dismiss();
  };

  const importPage = () => {
    const pageUrl = currentUrl || loadUrl;
    Alert.alert(
      '⬇️ Download from this page',
      pageUrl.length > 60 ? pageUrl.slice(0, 60) + '…' : pageUrl,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: '🎵 MP3',
          onPress: () => {
            DLManager.start({ url: pageUrl, title: '', thumbnail: '' }, 'mp3', '192');
            Alert.alert('Queued!', 'Check the Downloads tab for progress.');
          },
        },
        {
          text: '🎬 MP4',
          onPress: () => {
            DLManager.start({ url: pageUrl, title: '', thumbnail: '' }, 'mp4', '720');
            Alert.alert('Queued!', 'Check the Downloads tab for progress.');
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={S.screen} edges={['top']}>
      {/* URL bar */}
      <View style={S.browserBar}>
        <TouchableOpacity onPress={() => webRef.current?.goBack()} style={{ padding: 8 }}>
          <Text style={{ color: C.sub, fontSize: 20 }}>←</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={S.urlBox}
          onPress={() => { setBarText(currentUrl || loadUrl); setShowBar(s => !s); }}
        >
          <Text style={S.urlText} numberOfLines={1}>{currentUrl || loadUrl}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={importPage} style={S.importBtn}>
          <Text style={{ color: '#fff', fontSize: 14, fontWeight: '800' }}>⬇</Text>
        </TouchableOpacity>
      </View>

      {showBar && (
        <View style={[S.searchRow, { backgroundColor: C.card, paddingVertical: 8 }]}>
          <TextInput
            style={S.input}
            value={barText}
            onChangeText={setBarText}
            onSubmitEditing={navigate}
            autoFocus
            autoCorrect={false}
            autoCapitalize="none"
            keyboardType="url"
            returnKeyType="go"
            selectTextOnFocus
          />
          <TouchableOpacity style={S.goBtn} onPress={navigate}>
            <Text style={{ color: '#fff' }}>Go</Text>
          </TouchableOpacity>
        </View>
      )}

      <WebView
        ref={webRef}
        source={{ uri: loadUrl }}
        style={{ flex: 1 }}
        onNavigationStateChange={s => { setCurrent(s.url); setBarText(s.url); }}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
      />
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ROOT — navigation + MiniPlayer overlay
// ─────────────────────────────────────────────────────────────────────────────
const Tab = createBottomTabNavigator();

const tabIcon = (emoji) => () => <Text style={{ fontSize: 20 }}>{emoji}</Text>;

export default function App() {
  return (
    <SafeAreaProvider>
      <PlayerProvider>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <NavigationContainer>
          <View style={{ flex: 1, backgroundColor: C.bg }}>
            <Tab.Navigator
              screenOptions={{
                tabBarStyle: {
                  backgroundColor: C.card,
                  borderTopColor:  C.border,
                  paddingBottom: Platform.OS === 'ios' ? 12 : 4,
                  height: Platform.OS === 'ios' ? 80 : 58,
                },
                tabBarActiveTintColor:   C.accent,
                tabBarInactiveTintColor: C.muted,
                tabBarLabelStyle: { fontSize: 10, marginBottom: 2 },
                headerStyle: {
                  backgroundColor: C.card,
                  elevation: 0, shadowOpacity: 0,
                  borderBottomWidth: 1, borderBottomColor: C.border,
                },
                headerTintColor:     C.text,
                headerTitleStyle:    { color: C.accent, fontWeight: '800', fontSize: 17 },
              }}
            >
              <Tab.Screen name="Search"    component={SearchScreen}
                options={{ tabBarIcon: tabIcon('🔍'), title: 'WAVE' }} />
              <Tab.Screen name="Library"   component={LibraryScreen}
                options={{ tabBarIcon: tabIcon('📚') }} />
              <Tab.Screen name="Downloads" component={DownloadsScreen}
                options={{ tabBarIcon: tabIcon('⬇️') }} />
              <Tab.Screen name="ARIA"      component={AriaScreen}
                options={{ tabBarIcon: tabIcon('✦') }} />
              <Tab.Screen name="Browser"   component={BrowserScreen}
                options={{ tabBarIcon: tabIcon('🌐') }} />
            </Tab.Navigator>

            {/* Persistent mini-player sits above the tab bar */}
            <MiniPlayer />
          </View>
        </NavigationContainer>
      </PlayerProvider>
    </SafeAreaProvider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────
const S = StyleSheet.create({
  screen:        { flex: 1, backgroundColor: C.bg },
  searchRow:     { flexDirection: 'row', alignItems: 'center', padding: 10, gap: 8 },
  input:         { flex: 1, backgroundColor: C.card, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, color: C.text, borderWidth: 1, borderColor: C.border, fontSize: 14 },
  goBtn:         { backgroundColor: C.dim, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10, justifyContent: 'center', alignItems: 'center', minWidth: 48 },
  empty:         { color: C.muted, textAlign: 'center', marginTop: 56, fontSize: 13, paddingHorizontal: 32, lineHeight: 24 },
  sectionLabel:  { color: C.text, fontSize: 13, fontWeight: '700', marginHorizontal: 12, marginTop: 18, marginBottom: 6 },
  // Track card
  card:          { flexDirection: 'row', alignItems: 'center', padding: 10, marginHorizontal: 10, marginVertical: 4, backgroundColor: C.card, borderRadius: 12, borderWidth: 1, borderColor: C.border, gap: 10 },
  cardBody:      { flex: 1, minWidth: 0 },
  cardTitle:     { color: C.text, fontSize: 13, fontWeight: '600' },
  cardSub:       { color: C.sub,  fontSize: 11, marginTop: 2 },
  cardActions:   { flexDirection: 'row', gap: 2 },
  iconBtn:       { padding: 6 },
  // Progress
  progressBg:    { height: 3, backgroundColor: C.border, borderRadius: 2, marginTop: 5 },
  progressFg:    { height: '100%', backgroundColor: C.accent, borderRadius: 2 },
  progressLabel: { color: C.muted, fontSize: 10, marginTop: 3 },
  // Mini player
  mini:          { position: 'absolute', bottom: Platform.OS === 'ios' ? 92 : 62, left: 0, right: 0, backgroundColor: C.card, borderTopWidth: 1, borderTopColor: C.border },
  miniProg:      { height: 2, backgroundColor: C.accent },
  miniRow:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 8 },
  miniTitle:     { color: C.text, fontSize: 13, fontWeight: '600' },
  miniArtist:    { color: C.muted, fontSize: 11 },
  // Chat bubbles
  bubble:        { marginBottom: 10, maxWidth: '88%', padding: 11, borderRadius: 16 },
  bubbleUser:    { alignSelf: 'flex-end', backgroundColor: C.dim },
  bubbleBot:     { alignSelf: 'flex-start', backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  // Browser
  browserBar:    { flexDirection: 'row', alignItems: 'center', padding: 8, backgroundColor: C.card, borderBottomWidth: 1, borderBottomColor: C.border, gap: 6 },
  urlBox:        { flex: 1, backgroundColor: C.bg, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, borderWidth: 1, borderColor: C.border },
  urlText:       { color: C.sub, fontSize: 12 },
  importBtn:     { backgroundColor: C.dim, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
});
