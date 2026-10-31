import { createReadStream, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GET, POST, DELETE, bad, notFound, denied } from '../http.js';
import { all, one, run, nowIso, idOf, ROOT_DIR } from '../db.js';
import { canModule, canEditRecord } from '../auth.js';
import { MAX_ATTACHMENT, attachmentAllowed } from '../settings.js';

const UPLOAD_DIR = join(ROOT_DIR, 'data', 'uploads');
mkdirSync(UPLOAD_DIR, { recursive: true });

const TARGETS = {
  opportunity: { table: 'opportunities', module: 'opportunity' },
  lead: { table: 'leads', module: 'lead' },
  quotation: { table: 'quotations', module: 'quotation' },
  contract: { table: 'contracts', module: 'contract' },
};

function loadTarget(type, id) {
  const t = TARGETS[type];
  if (!t) throw bad('不支持的附件归属类型');
  const rec = one(`select * from ${t.table} where id = ?`, id);
  if (!rec) throw notFound('附件关联的记录不存在');
  return { rec, module: t.module };
}

function assertView(user, type, id) {
  const { rec, module } = loadTarget(type, id);
  if (!canModule(user, module)) throw denied('无权查看该附件');
  if (!canEditRecord(user, rec)) throw denied('无权查看该附件');
  return rec;
}

function parseBase64(data) {
  const s = String(data || '');
  const m = /^data:([^;,]+);base64,([\s\S]+)$/.exec(s);
  if (m) return { mime: m[1], buf: Buffer.from(m[2], 'base64') };
  return { mime: null, buf: Buffer.from(s, 'base64') };
}

POST('/api/attachments', (ctx) => {
  const b = ctx.body || {};
  const type = String(b.target_type || '');
  const targetId = Number(b.target_id || 0);
  if (!targetId) throw bad('缺少关联记录');
  const rec = assertView(ctx.user, type, targetId);

  const max = MAX_ATTACHMENT();
  const { mime, buf } = parseBase64(b.data);
  if (!buf.length) throw bad('文件内容为空');
  if (buf.length > max) {
    throw bad(`文件超过 ${Math.round(max / 1024)} KB 上限（当前 ${Math.ceil(buf.length / 1024)} KB）`);
  }
  const name = String(b.name || 'attachment').slice(0, 200);
  const finalMime = mime || b.mime || 'application/octet-stream';
  if (!attachmentAllowed(finalMime, name)) throw bad('不支持该文件类型');

  const ext = (extname(name) || '').toLowerCase().slice(0, 10) || guessExt(finalMime);
  const stored = `${randomUUID()}${ext}`;
  writeFileSync(join(UPLOAD_DIR, stored), buf);

  const r = run(
    `insert into attachments(target_type,target_id,stage,name,mime,size,path,uploaded_by,created_at)
     values(?,?,?,?,?,?,?,?,?)`,
    type, targetId, b.stage || null, name, finalMime, buf.length, stored, ctx.user.id, nowIso()
  );
  const id = idOf(r);

  // 阶段证据里留一条痕迹，便于时间线回顾
  if (type === 'opportunity' && b.stage) {
    run(
      `insert into activities(target_type,target_id,type,content,user_id,created_at) values('opportunity',?, 'note', ?, ?, ?)`,
      targetId, `上传附件：${name}`, ctx.user.id, nowIso()
    );
  }
  void rec;
  return { id, name, size: buf.length, mime: finalMime, url: `/api/attachments/${id}/file` };
}, { noAudit: true });

GET('/api/attachments', (ctx) => {
  const type = String(ctx.query.target_type || '');
  const targetId = Number(ctx.query.target_id || 0);
  if (!targetId) throw bad('缺少关联记录');
  assertView(ctx.user, type, targetId);
  const rows = all(
    `select a.id, a.target_type, a.target_id, a.stage, a.name, a.mime, a.size, a.created_at,
            u.name as uploader_name
     from attachments a left join users u on u.id = a.uploaded_by
     where a.target_type = ? and a.target_id = ?
     order by a.created_at desc`,
    type, targetId
  );
  return {
    rows: rows.map((r) => ({
      ...r,
      url: `/api/attachments/${r.id}/file`,
      is_image: /^image\//.test(String(r.mime || '')),
    })),
    maxSize: MAX_ATTACHMENT(),
  };
});

GET('/api/attachments/:id/file', (ctx) => {
  const a = one('select * from attachments where id = ?', ctx.params.id);
  if (!a) throw notFound('附件不存在');
  assertView(ctx.user, a.target_type, a.target_id);
  const full = join(UPLOAD_DIR, a.path);
  if (!existsSync(full)) throw notFound('文件已丢失');

  const inline = /^image\//.test(String(a.mime || '')) || /pdf/.test(String(a.mime || ''));
  ctx.res.writeHead(200, {
    'Content-Type': a.mime || 'application/octet-stream',
    'Content-Length': a.size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`,
    'Cache-Control': 'private, max-age=60',
  });
  createReadStream(full).pipe(ctx.res);
  return null;
}, { noAudit: true });

DELETE('/api/attachments/:id', (ctx) => {
  const a = one('select * from attachments where id = ?', ctx.params.id);
  if (!a) throw notFound('附件不存在');
  if (!canModule(ctx.user, TARGETS[a.target_type]?.module || 'opportunity')) throw denied('无权删除附件');
  const rec = assertView(ctx.user, a.target_type, a.target_id);
  // 只有上传人、管理员、或该记录的负责人可以删
  const isOwner = Number(rec.owner_id) === Number(ctx.user.id);
  if (Number(a.uploaded_by) !== Number(ctx.user.id) && !isOwner && ctx.user.role !== 'admin') {
    throw denied('只能删除自己上传的附件');
  }
  try { unlinkSync(join(UPLOAD_DIR, a.path)); } catch { /* 文件可能已不存在 */ }
  run('delete from attachments where id = ?', a.id);
  return { ok: true };
});

function guessExt(mime) {
  const map = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
    'application/pdf': '.pdf', 'text/plain': '.txt',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  };
  return map[mime] || '';
}
