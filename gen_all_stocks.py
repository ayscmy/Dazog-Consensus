# -*- coding: utf-8 -*-
"""生成全市场A股清单 all_stocks.json（新浪 Market_Center，约5547只，含沪深+北交所）
用法：python gen_all_stocks.py
"""
import json, urllib.request, time

UA = {'User-Agent': 'Mozilla/5.0'}
BASE = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page={}&num=100&sort=symbol&asc=1&node=hs_a&symbol=&_s_r_a=page"

def fetch_all():
    all_stocks = []
    for page in range(1, 60):
        try:
            req = urllib.request.Request(BASE.format(page), headers=UA)
            d = json.loads(urllib.request.urlopen(req, timeout=15).read().decode('utf-8'))
            if not d:
                break
            all_stocks += [{"code": x["symbol"], "name": x["name"]} for x in d]
            if len(d) < 100:
                break
            time.sleep(0.15)
        except Exception as e:
            print(f"  第{page}页失败: {e}")
            break
    return all_stocks

if __name__ == "__main__":
    print("拉取全市场A股清单（新浪）...")
    stocks = fetch_all()
    print(f"共 {len(stocks)} 只")
    with open("all_stocks.json", "w", encoding="utf-8") as f:
        json.dump(stocks, f, ensure_ascii=False)
    print("已写入 all_stocks.json")
