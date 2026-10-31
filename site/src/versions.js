import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename, extname, resolve } from 'node:path';
import { one, all, run, nowIso, idOf, SITE_ROOT } from './db.js';

// 相对路径按 site/ 目录解析；也可直接写绝对路径
export const RELEASE_DIR = process.env.SITE_RELEASE_DIR
  ? resolve(SITE_ROOT, process.env.SITE_RELEASE_DIR)
  : join(SITE_ROOT, '..', 'release');

export const DAILY_LIMIT = Number(process.env.SITE_DAILY_DOWNLOAD_LIMIT || 20);

/** 只允许下载这些类型，防止误把源码或密钥发出去 */
const ALLOWED_EXT = new Set(['.db', '.zip', '.gz', '.tar', '.7z']);

export function listVersions({ includeDraft = false } = {}) {
  const rows = includeDraft
    ? all('select * from versions order by released_at desc, id desc')
    : all("select * from versions where status = 'published' order by released_at desc, id desc");
  return rows.map(publicView);
}

export function publicView(v) {
  return {
    id: v.id,
    version: v.version,
    title: v.title,
    notes: v.notes,
    channel: v.channel,
    size: v.file_size,
    sizeText: fmtSize(v.file_size),
    sha256: v.sha256,
    fileName: v.file_name,
    releasedAt: v.released_at,
    downloads: v.downloads,
    status: v.status,
  };
}

export function fmtSize(n) {
  const v = Number(n || 0);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** 扫描 release 目录，供后台选择已存在的安装包 */
export function scanReleaseDir() {
  if (!existsSync(RELEASE_DIR)) return [];
  return readdirSync(RELEASE_DIR)
    .filter((f) => ALLOWED_EXT.has(extname(f).toLowerCase()))
    .filter((f) => !f.startsWith('.'))
    .map((f) => {
      const st = statSync(join(RELEASE_DIR, f));
      return {
        fileName: f,
        size: st.size,
        sizeText: fmtSize(st.size),
        mtime: st.mtime.toISOString(),
        registered: !!one('select 1 from versions where file_name = ?', f),
      };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

/**
 * 登记/更新一个版本。文件必须已经在 release 目录里（上传接口会先落盘）。
 * 同一版本号重复登记时更新元信息，不改下载计数。
 */
export function registerVersion({ version, title, notes, fileName, channel = 'stable', status = 'published' }) {
  const file = basename(String(fileName || ''));
  if (!ALLOWED_EXT.has(extname(file).toLowerCase())) throw new Error('只支持 .db / .zip / .tar.gz / .7z 安装包');
  const full = join(RELEASE_DIR, file);
  if (!existsSync(full)) throw new Error('安装包不存在，请先上传或放入 release 目录');
  const st = statSync(full);
  const sha = sha256File(full);
  const now = nowIso();

  const exists = one('select * from versions where version = ?', version);
  if (exists) {
    run(
      `update versions set title=?, notes=?, file_name=?, file_size=?, sha256=?, channel=?, status=?, released_at=?
       where id=?`,
      title || exists.title, notes ?? exists.notes, file, st.size, sha, channel, status, now, exists.id
    );
    return one('select * from versions where id = ?', exists.id);
  }

  const r = run(
    `insert into versions(version, title, notes, file_name, file_size, sha256, channel, status, released_at, downloads, created_at)
     values(?,?,?,?,?,?,?,?,?,0,?)`,
    version, title || `MSERM CRM ${version}`, notes || '', file, st.size, sha, channel, status, now, now
  );
  return one('select * from versions where id = ?', idOf(r));
}

export function getVersion(id) {
  return one('select * from versions where id = ?', id);
}

export function downloadPath(v) {
  return join(RELEASE_DIR, basename(v.file_name));
}

export function todayDownloads(memberId) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return Number(
    one('select count(*) c from downloads where member_id = ? and created_at >= ?', memberId, start.toISOString()).c
  );
}

export function recordDownload(member, version, ip, ua) {
  run(
    'insert into downloads(member_id, version_id, version, ip, ua, created_at) values(?,?,?,?,?,?)',
    member.id, version.id, version.version, ip || '', String(ua || '').slice(0, 200), nowIso()
  );
  run('update versions set downloads = downloads + 1 where id = ?', version.id);
  run('update members set downloads = downloads + 1 where id = ?', member.id);
}

export function streamFile(req, res, file, downloadName) {
  const st = statSync(file);
  const range = req.headers.range;
  // filename= 用 ASCII 兜底，filename*= 才是中文/原始名
  const ascii = String(downloadName).replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  };

  // 断点续传：4~10MB 的库文件在网络抖动时很有用
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : st.size - 1;
      if (start >= 0 && end < st.size && start <= end) {
        res.writeHead(206, {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Content-Length': end - start + 1,
        });
        createReadStream(file, { start, end }).pipe(res);
        return;
      }
    }
  }

  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  createReadStream(file).pipe(res);
}

export function memberDownloads(memberId, limit = 30) {
  return all(
    `select id, version, ip, created_at from downloads where member_id = ? order by id desc limit ?`,
    memberId, limit
  );
}
