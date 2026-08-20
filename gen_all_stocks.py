# -*- coding: utf-8 -*-
"""生成全市场A股清单 all_stocks.json（新浪 Market_Center，约5547只，含沪深+北交所）
用法：python gen_all_stocks.py
用 curl 拉取（绕开 python 环境 SSL 兼容问题）。
"""
import json, subprocess, time

BASE = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page={}&num=100&sort=symbol&asc=1&node=hs_a&symbol=&_s_r_a=page"

def fetch_all():
    all_stocks = []
    for page in range(1, 60):
        try:
            out = subprocess.run(['curl', '-s', '-m', '15', '-A', 'Mozilla/5.0', BASE.format(page)],
                                 capture_output=True, text=True).stdout
            d = json.loads(out)
            if not d:
                break
            all_stocks += [{"code": x["symbol"], "name": x["name"]} for x in d]
            if len(d) < 100:
                break
            time.sleep(0.1)
        except Exception as e:
            print(f"  第{page}页失败: {e}")
            time.sleep(0.5)
            continue
    return all_stocks

if __name__ == "__main__":
    print("拉取全市场A股清单（新浪）...")
    stocks = fetch_all()
    print(f"共 {len(stocks)} 只")
    # 保护：拉取失败（<1000只，说明接口异常/限流）时不覆盖现有清单，避免清空数据
    if len(stocks) < 1000:
        print(f"⚠️ 拉取数量异常（{len(stocks)}只 < 1000），可能被限流，保留现有 all_stocks.json 不覆盖")
    else:
        with open("all_stocks.json", "w", encoding="utf-8") as f:
            json.dump(stocks, f, ensure_ascii=False)
        print("已写入 all_stocks.json")
