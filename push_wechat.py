#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
大纵观共识 · 微信推送客户端（WxPusher）
========================================
替代原飞书 bot：无需公众号认证，用户微信扫码关注「大纵观共识」推送应用即可接收简报。

用法（用 managed Python 执行，路径见 daily_maintain.sh）：
  1) 订阅绑定（用户扫码关注后，把其 UID 登记进来，可重复执行追加）：
     python push_wechat.py --add-uid UID_xxxxxxxxxxxx

  2) 发送自定义简报（标题 + 内容，内容支持 markdown）：
     python push_wechat.py --title "收盘复盘" --content "**沪金 AU2609** 收涨..."

  3) 发送默认复盘概览（基于本地 futures.json 生成，不联网不杜撰）：
     python push_wechat.py --summary

  4) 只打印不发送（调试）：
     python push_wechat.py --summary --dry-run

凭证读取优先级：环境变量 > 项目根 .env 文件。
  - WXPUSHER_APP_TOKEN : WxPusher 应用 Token（必填，注册后获得）
  - WXPUSHER_UIDS      : 接收用户 UID，逗号分隔（可选，也可用 --add-uid 写入 wechat_uids.json）
"""

import os
import sys
import json
import argparse

try:
    from urllib import request as urlrequest
except ImportError:  # Python 2 兼容（本环境用 3.13，此分支仅兜底）
    import urllib2 as urlrequest

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(BASE_DIR, '.env')
UIDS_FILE = os.path.join(BASE_DIR, 'wechat_uids.json')
FUTURES_FILE = os.path.join(BASE_DIR, 'futures.json')

WXPUSHER_SEND_MSG = 'https://wxpusher.zjiecode.com/api/send/message'


def load_env():
    """从项目根 .env 读取 KEY=VALUE（简单解析，不覆盖已存在的环境变量）。"""
    env = {}
    if os.path.exists(ENV_FILE):
        try:
            with open(ENV_FILE, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith('#') or '=' not in line:
                        continue
                    k, v = line.split('=', 1)
                    k = k.strip()
                    v = v.strip().strip('"').strip("'")
                    if k:
                        env[k] = v
        except OSError:
            pass
    return env


def get_token():
    file_env = load_env()
    return os.environ.get('WXPUSHER_APP_TOKEN') or file_env.get('WXPUSHER_APP_TOKEN', '')


def load_uids():
    uids = []
    env_val = os.environ.get('WXPUSHER_UIDS') or load_env().get('WXPUSHER_UIDS', '')
    if env_val:
        uids += [s.strip() for s in env_val.split(',') if s.strip()]
    if os.path.exists(UIDS_FILE):
        try:
            with open(UIDS_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, list):
                uids += [str(x).strip() for x in data if str(x).strip()]
        except (OSError, ValueError):
            pass
    # 去重且保持顺序
    seen, out = set(), []
    for u in uids:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def save_uids(uids):
    with open(UIDS_FILE, 'w', encoding='utf-8') as f:
        json.dump(uids, f, ensure_ascii=False, indent=2)


def add_uid(uid):
    uids = load_uids()
    if uid in uids:
        print('[已存在] UID %s 已在订阅列表中，无需重复添加。' % uid)
        return uids
    uids.append(uid)
    save_uids(uids)
    print('[已添加] UID %s 已写入 wechat_uids.json，当前共 %d 个接收人。' % (uid, len(uids)))
    return uids


def build_summary():
    """基于本地 futures.json 生成复盘概览（真实本地数据，不联网、不杜撰）。"""
    if not os.path.exists(FUTURES_FILE):
        return '⚠️ 未找到 futures.json，无法生成复盘概览。'
    try:
        with open(FUTURES_FILE, 'r', encoding='utf-8') as f:
            futures = json.load(f)
    except (OSError, ValueError):
        return '⚠️ futures.json 解析失败，无法生成复盘概览。'
    if not futures:
        return '⚠️ futures.json 为空。'
    lines = []
    for item in futures:
        name = item.get('name', '')
        kind = item.get('kind', '')
        dom = item.get('dominant') or {}
        lines.append('- %s（%s）：主力 %s' % (name, kind, dom.get('name', '—')))
    lines.append('')
    lines.append('数据来源：本地 futures.json（主力合约月）')
    return '\n'.join(lines)


def send(title, content, uids, token, dry_run=False):
    if dry_run:
        print('[dry-run] 未发送。目标 UID（%d 个）：%s' % (len(uids), ', '.join(uids) if uids else '无'))
        print('[dry-run] 内容预览：')
        print('  ' + ('**%s**\n\n%s' % (title, content)).replace('\n', '\n  '))
        return True
    if not token:
        print('[错误] 未配置 WXPUSHER_APP_TOKEN。请先注册 WxPusher 应用，把 Token 写入 .env 或环境变量。')
        return False
    if not uids:
        print('[错误] 无接收 UID。请先用 --add-uid 绑定订阅用户，或设置 WXPUSHER_UIDS 环境变量。')
        return False
    payload = {
        'appToken': token,
        'content': '**%s**\n\n%s' % (title, content),
        'summary': title,
        'contentType': 3,  # markdown
        'uids': uids,
        'verifyPay': False,
    }
    try:
        req = urlrequest.Request(
            WXPUSHER_SEND_MSG,
            data=json.dumps(payload).encode('utf-8'),
            headers={'Content-Type': 'application/json'},
        )
        with urlrequest.urlopen(req, timeout=20) as resp:
            result = json.loads(resp.read().decode('utf-8'))
        code = result.get('code')
        if code == 1000:
            print('[成功] 已推送到 %d 个 UID。' % len(uids))
            return True
        print('[失败] WxPusher 返回 code=%s msg=%s' % (code, result.get('msg', '')))
        return False
    except Exception as e:
        print('[异常] 推送失败：%s' % e)
        return False


def main():
    ap = argparse.ArgumentParser(description='大纵观共识 · 微信推送客户端')
    ap.add_argument('--add-uid', metavar='UID', help='绑定订阅用户 UID（可重复执行）')
    ap.add_argument('--title', default='大纵观共识 · 盯盘提醒', help='推送标题')
    ap.add_argument('--content', help='推送内容（支持 markdown）')
    ap.add_argument('--summary', action='store_true', help='发送基于 futures.json 的复盘概览')
    ap.add_argument('--dry-run', action='store_true', help='只打印不发送')
    args = ap.parse_args()

    if args.add_uid:
        add_uid(args.add_uid.strip())
        return 0

    token = get_token()
    uids = load_uids()

    if args.summary:
        title = '大纵观共识 · 复盘概览'
        content = build_summary()
    else:
        title = args.title
        content = args.content or ''

    if not content.strip():
        print('[提示] 未提供推送内容。请用 --content 指定，或加 --summary 生成默认概览。')
        return 1

    ok = send(title, content, uids, token, dry_run=args.dry_run)
    return 0 if ok else 2


if __name__ == '__main__':
    sys.exit(main())
