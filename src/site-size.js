// "How big is the site?" for Admin settings > Site size: the database file, what is in
// it (per town), the other files the app keeps in its data folder, the app's own code,
// and the free space on the server disk that holds the data folder.
import fs from 'node:fs';
import path from 'node:path';

/** Bytes and file count under a folder (or one file). Missing = 0. */
export function folderBytes(p) {
  let bytes = 0, files = 0;
  const walk = (f) => {
    let st;
    try { st = fs.lstatSync(f); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) { for (const name of safeList(f)) walk(path.join(f, name)); return; }
    bytes += st.size; files += 1;
  };
  walk(p);
  return { bytes, files };
}
const safeList = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

/** Total and free space on the disk that holds dir (inside Docker: the host disk under the bind mount). */
export function diskSpace(dir) {
  try {
    const s = fs.statfsSync(dir);
    const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { totalBytes: total, freeBytes: free, usedBytes: total - s.bfree * s.bsize };
  } catch { return null; }
}

/**
 * Everything the Site size card shows. dataDir holds buzz.db (+ -wal/-shm), backups/,
 * samples/ (CDOT debugging copies) and vapid.json. appDir is the code (src + public).
 */
export function siteSize({ db, dataDir, appDir, demo = false, appCode } = {}) {
  const stats = db.sizeStats();
  const file = (name) => folderBytes(path.join(dataDir, name)).bytes;
  const dbBytes = demo ? null : file('buzz.db');
  const walBytes = demo ? null : file('buzz.db-wal') + file('buzz.db-shm');
  const known = new Set(['buzz.db', 'buzz.db-wal', 'buzz.db-shm', 'backups', 'samples']);
  const backups = folderBytes(path.join(dataDir, 'backups'));
  const samples = folderBytes(path.join(dataDir, 'samples'));
  let other = 0;
  for (const name of safeList(dataDir)) if (!known.has(name)) other += folderBytes(path.join(dataDir, name)).bytes;
  const code = appCode || appCodeSize(appDir);
  return {
    demo,
    database: { bytes: dbBytes, walBytes, freeBytes: demo ? null : stats.freeBytes },
    files: {
      backups: { bytes: backups.bytes, count: backups.files },
      samples: { bytes: samples.bytes, count: samples.files },
      otherBytes: other,
      dataFolderBytes: demo ? null : folderBytes(dataDir).bytes,
    },
    app: code,
    disk: demo ? null : diskSpace(dataDir),
    totals: stats.totals,
    towns: stats.towns,
  };
}

/** The app's own code and page files (src + public); it only changes on a deploy. */
export function appCodeSize(appDir) {
  const src = folderBytes(path.join(appDir, 'src'));
  const pub = folderBytes(path.join(appDir, 'public'));
  return { bytes: src.bytes + pub.bytes, files: src.files + pub.files, publicBytes: pub.bytes };
}
