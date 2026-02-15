import Dexie, { type Table } from 'dexie';
import type { Song, Playlist, FocusSession, FocusSettings } from './types';

const db = new Dexie('ReactPodDatabase') as Dexie & {
  songs: Table<Song, number>;
  playlists: Table<Playlist, number>;
  focusSessions: Table<FocusSession, number>;
  focusSettings: Table<FocusSettings, number>;
};

db.version(1).stores({
  songs: '++id, title, artist, album, rating',
  playlists: '++id, &name',
});

db.version(2).stores({
  songs: '++id, title, artist, album, rating',
  playlists: '++id, &name',
  focusSessions: '++id, endTimestamp',
  focusSettings: 'id',
}).upgrade(tx => {
  // This upgrade function can be used for data migration if needed in the future.
  // For now, it ensures a smooth upgrade path for existing users.
});


export { db };