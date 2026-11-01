#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { issueLicense, verifyLicense, machineId, entitlementsOf } from '../src/license-core.js';

/**
 * 商业授权签发工具（只在 AIEMY 侧使用，**不要**随产品分发私钥）。
 *
 * 用法：
 *   node scripts/license.mjs machine
 *   node scripts/license.mjs issue --to "某某科技有限公司" --users 0 --expire 2027-11-01
 *   node scripts/license.mjs verify <授权码 或 文件>
 *   node scripts/license.mjs keygen            # 首次生成密钥对（会打印公钥，替换 src/license-core.js 里的）
 *
 * 参数：
 *   --to       被授权方名称（会显示在后台，写清楚公司全称）
 *   --users    用户数上限，0 或省略 = 不限
 *   --edition  版本标识，默认 commercial
 *   --expire   到期日 YYYY-MM-DD，省略 = 永久
 *   --id       授权编号，默认自动生成（AUTH-年月日-随机）
 *   --machine  绑定机器指纹（可选，留空则不绑机器）
 *   --features 附加能力，逗号分隔（可选，预留）
 *   --key      私钥路径，默认 $AIEMY_LICENSE_KEY 或 ~/.aiemy-license/private-key.pem
 *   --out      把授权码写入文件
 */

const DEFAULT_KEY = join(homedir(), '.aiemy-license', 'private-key.pem');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const fmtDate = d => new Date(d).toISOString().slice(0, 10);

function usage() {
  console.log(`AIEMY 商业授权签发工具

  node scripts/license.mjs machine                              打印本机指纹（绑机器时用）
  node scripts/license.mjs issue --to "公司名" [选项]            签发授权码
  node scripts/license.mjs verify <授权码|文件>                  校验授权码
  node scripts/license.mjs keygen [--out-dir 目录]               生成新的签名密钥对

issue 选项：
  --users <n>       用户数上限，0 = 不限（默认 0）
  --edition <名>    版本标识（默认 commercial）
  --expire <日期>   到期日 YYYY-MM-DD，省略 = 永久
  --id <编号>       授权编号（默认自动生成）
  --machine <指纹>  绑定机器（默认不绑，换服务器需重签）
  --features <列表> 附加能力，逗号分隔
  --key <路径>      私钥路径（默认 ${DEFAULT_KEY}）
  --out <文件>      同时写入文件
`);
}

const cmd = process.argv[2];
const args = parseArgs(process.argv.slice(3));

if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
  usage();
  process.exit(0);
}

try {
  if (cmd === 'machine') {
    console.log(machineId());
    process.exit(0);
  }

  if (cmd === 'keygen') {
    const dir = String(args['out-dir'] || join(homedir(), '.aiemy-license'));
    mkdirSync(dir, { recursive: true });
    const privPath = join(dir, 'private-key.pem');
    if (existsSync(privPath) && !args.force) {
      console.error(`私钥已存在：${privPath}\n如确需覆盖请加 --force（覆盖后旧授权码仍可用，但新授权必须用新公钥验签）`);
      process.exit(1);
    }
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    writeFileSync(privPath, privateKey, { mode: 0o600 });
    writeFileSync(join(dir, 'public-key.pem'), publicKey);
    console.log(`私钥已写入：${privPath}`);
    console.log('公钥（请替换 src/license-core.js 里的 PUBLIC_KEY_PEM）：');
    console.log(publicKey);
    process.exit(0);
  }

  if (cmd === 'issue') {
    const keyPath = String(args.key || process.env.AIEMY_LICENSE_KEY || DEFAULT_KEY);
    if (!existsSync(keyPath)) {
      console.error(`找不到私钥：${keyPath}\n先运行 keygen，或用 --key 指定路径`);
      process.exit(1);
    }
    const to = String(args.to || '').trim();
    if (!to) {
      console.error('缺少 --to（被授权方名称）');
      process.exit(1);
    }

    const users = args.users === undefined ? 0 : Math.max(0, Number(args.users) || 0);
    const expire = args.expire ? String(args.expire) : null;
    if (expire && !/^\d{4}-\d{2}-\d{2}$/.test(expire)) {
      console.error('到期日格式应为 YYYY-MM-DD');
      process.exit(1);
    }
    const machine = args.machine ? String(args.machine).toUpperCase() : null;
    const id = String(args.id || `AUTH-${fmtDate(Date.now()).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`);
    const features = args.features ? String(args.features).split(',').map(s => s.trim()).filter(Boolean) : [];

    const payload = {
      id, to,
      edition: String(args.edition || 'commercial'),
      users,
      expire,
      issued: fmtDate(Date.now()),
      machine,
      features,
    };

    const code = issueLicense(payload, readFileSync(keyPath, 'utf8'));
    const check = verifyLicense(code, { machine: machine || machineId() });
    if (!check.valid) {
      console.error('自检失败，签发结果不可用：' + check.reason);
      process.exit(1);
    }

    if (args.out) writeFileSync(String(args.out), code + '\n');

    console.log('─'.repeat(64));
    console.log('授权码（一行，可直接贴进后台或 .env）：');
    console.log('');
    console.log(code);
    console.log('');
    console.log('─'.repeat(64));
    console.log(`被授权方   ${to}`);
    console.log(`授权编号   ${id}`);
    console.log(`版本       ${payload.edition}`);
    console.log(`用户上限   ${users === 0 ? '不限' : users + ' 个在职用户'}`);
    console.log(`有效期     ${expire || '永久'}`);
    console.log(`绑定机器   ${machine || '不绑定（换服务器无需重签）'}`);
    if (features.length) console.log(`附加能力   ${features.join(', ')}`);
    console.log('');
    console.log('激活方式二选一：');
    console.log('  A. 写进 .env 后重启：  CRM_LICENSE=' + code.slice(0, 24) + '…');
    console.log('  B. 后台「系统设置 → 商业授权」粘贴保存（存库，重启不丢）');
    process.exit(0);
  }

  if (cmd === 'verify') {
    const input = args._[0];
    if (!input) {
      console.error('用法：node scripts/license.mjs verify <授权码|文件>');
      process.exit(1);
    }
    let code = input;
    if (existsSync(input)) code = readFileSync(input, 'utf8').trim();
    const r = verifyLicense(code);
    if (!r.valid) {
      console.error(`✗ 无效：${r.reason}`);
      process.exit(1);
    }
    const e = entitlementsOf(r.payload);
    console.log('✓ 授权有效');
    console.log(`被授权方   ${e.customer}`);
    console.log(`授权编号   ${e.licenseId}`);
    console.log(`版本       ${e.edition}`);
    console.log(`用户上限   ${e.usersLimit === 0 ? '不限' : e.usersLimit + ' 个在职用户'}`);
    console.log(`有效期     ${e.expire || '永久'}`);
    console.log(`绑定机器   ${e.machine || '不绑定'}`);
    console.log(`签发日期   ${e.issuedAt || '—'}`);
    process.exit(0);
  }

  console.error(`未知命令：${cmd}`);
  usage();
  process.exit(1);
} catch (err) {
  console.error('执行失败：' + err.message);
  process.exit(1);
}
